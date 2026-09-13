import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const password='SyntheticDocumentConversion!2026',bytes=Buffer.from('Original synthetic agreement bytes\n'),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{object=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-contract-conversion-')),tenantId=randomUUID(),objects=new Map(),deleted=[];let putHook=null,getHook=null,cleanupFails=false;
 const storage={kind:'object',scope:{provider:'s3',bucket:'synthetic-private-contracts',namespace:'conversion'},async verifyReadiness(){return {verified:true};},stage(p){return {...p,...this.scope,key:`tenants/${p.tenantId}/${p.documentId}/${p.revision}/${p.attemptId}`};},async put(ref,data){await putHook?.();const stored={...ref,version:randomUUID(),encryption:'AES256'};objects.set(ref.key,{reference:stored,bytes:Buffer.from(data)});return stored;},async get(ref){await getHook?.();const o=objects.get(ref.key);if(!o||o.reference.version!==ref.version)throw Object.assign(new Error('Exact private revision unavailable'),{status:503});return o.bytes;},async deleteStaged(ref){if(cleanupFails)throw new Error('Synthetic cleanup unavailable');deleted.push(ref);objects.delete(ref.key);}};
 const app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:false,tenantId,documentTenantId:tenantId,documentStorage:object?storage:null,initialAdmin:{name:'Contract conversion administrator',email:'admin.contracts@example.test',password},mfaKey:'',reminderWorker:false}),db=app.locals.db,server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();await rm(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}/api`;
 async function request(path,{body,method='GET',session=admin,csrf=true}={}){const r=await fetch(base+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,json,text};}
 async function login(email){const r=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 const admin=await login('admin.contracts@example.test');async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',body});assert.equal(r.status,201,r.text);return r.json.record;}
 const task=await create('tasks',{title:'Source-linked agreement task',status:'Open',dueDate:'2025-01-01'});
 const payload=(changes={})=>({source:{namespace:'SyntheticContracts',documentId:'contract-1',revisionId:'revision-1',visibility:'Administrators',originalDate:'2024-02-29'},document:{collection:'tasks',recordId:task.id,recordVersion:1,title:' Original agreement ',category:'Agreement',status:'Final',visibility:'Administrators',evidenceDate:null,filename:' original.txt ',contentBase64:bytes.toString('base64')},sha256:sha(bytes),size:bytes.length,...changes});
 const preview=p=>request('/document-migration/preview',{method:'POST',body:p});const commit=(p,proof)=>request('/document-migration/commit',{method:'POST',body:{...p,proof}});async function importRevision(p=payload()){const r=await preview(p);assert.equal(r.status,200,r.text);const c=await commit(p,r.json.proof);assert.equal(c.status,201,c.text);return c.json;}
 const snapshot=()=>Object.fromEntries(['documents','document_revisions','document_revision_storage','document_migration_mappings','document_migration_reconciliations'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()]));
 return {app,db,admin,request,task,create,payload,preview,commit,importRevision,snapshot,objects,deleted,setPutHook:fn=>putHook=fn,setGetHook:fn=>getHook=fn,setCleanupFailure:()=>cleanupFails=true};
}

test('Agreement review uses native normalized metadata and exact byte/create accounting without writing evidence',async t=>{
 const f=await fixture(t),before=f.snapshot(),p=f.payload(),r=await f.preview(p);assert.equal(r.status,200,r.text);assert.equal(r.json.operation,'Create');assert.deepEqual(r.json.reconciliation,{sourceRevisions:1,sourceBytes:bytes.length,nativeRevisions:1,nativeBytes:bytes.length});assert.equal(r.json.metadata.title,'Original agreement');assert.equal(r.json.file.filename,'original.txt');assert.equal(r.json.file.sha256,sha(bytes));assert.match(r.json.proof,/^[a-f0-9]{64}$/);assert.deepEqual(f.snapshot(),before);
 for(const changed of [{...p,sha256:'0'.repeat(64)},{...p,size:bytes.length+1},{...p,source:{...p.source,originalDate:'2025-02-29'}},{...p,source:{...p.source,visibility:undefined}},{...p,document:{...p.document,category:'Report'}},{...p,document:{...p.document,filename:'script.html'}},{...p,document:{...p.document,status:'Submitted',evidenceDate:null}},{...p,unknown:true},{...p,document:{...p.document,targetDocumentId:randomUUID()}}])assert.equal((await f.preview(changed)).status,400);
 assert.deepEqual(f.snapshot(),before);
});

test('native conversion retains exact original chronology separately, replays once, and explicitly appends immutable revision lineage',async t=>{
 const f=await fixture(t),p=f.payload(),c=await f.importRevision(p),d=c.document;assert.equal(d.version,1);assert.equal(c.reconciliation.source.originalDate,'2024-02-29');assert.equal(d.revisions[0].at,c.reconciliation.at);assert.equal(d.revisions[0].actor,f.admin.user.id);assert.notEqual(d.revisions[0].at.slice(0,10),'2024-02-29');assert.equal(d.revisions[0].metadata.sourceConversion.originalDate,'2024-02-29');assert.equal(d.revisions[0].metadata.title,'Original agreement');
 const review=await f.preview(p);assert.equal(review.json.operation,'Replay');assert.deepEqual(review.json.reconciliation,{sourceRevisions:1,sourceBytes:bytes.length,nativeRevisions:0,nativeBytes:0});const prior=f.snapshot(),replay=await f.commit(p,review.json.proof);assert.equal(replay.status,200,replay.text);assert.equal(replay.json.replayed,true);assert.equal(replay.json.document.id,d.id);assert.equal(replay.json.document.revisions.length,1);assert.deepEqual(f.snapshot(),prior);
 const later=Buffer.from('Later original source amendment\n'),append={...p,source:{...p.source,revisionId:'revision-2',originalDate:'2024-03-01'},document:{...p.document,targetDocumentId:d.id,targetVersion:1,title:'Amended agreement',contentBase64:later.toString('base64')},sha256:sha(later),size:later.length};const amended=await f.importRevision(append);assert.equal(amended.document.version,2);assert.equal(amended.reconciliation.revision,2);assert.equal(amended.reconciliation.requestedDocumentVersion,1);assert.equal(amended.document.revisions[1].sha256,sha(bytes));assert.equal(amended.document.revisions[0].metadata.sourceConversion.sourceRevisionId,'revision-2');
 const fresh=await f.preview(append);assert.equal(fresh.status,200,fresh.text);assert.equal((await f.commit(append,fresh.json.proof)).status,200);const originalReplay=await f.preview(p);assert.equal(originalReplay.status,200);assert.equal((await f.commit(p,originalReplay.json.proof)).json.document.version,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM document_migration_mappings').get().n,2);
});

test('source identity conflicts and private chains cannot silently relink, rewrite or relax historical access',async t=>{
 const f=await fixture(t),p=f.payload(),c=await f.importRevision(p),prior=f.snapshot(),other=await f.create('tasks',{title:'Other source link',status:'Open',dueDate:'2025-01-01'});
 for(const changed of [{...p,source:{...p.source,originalDate:null}},{...p,document:{...p.document,title:'Different original source title'}},{...p,document:{...p.document,recordId:other.id}},{...p,source:{...p.source,revisionId:'revision-2'}},{...p,source:{...p.source,revisionId:'revision-2',visibility:'Workspace'},document:{...p.document,visibility:'Workspace',targetDocumentId:c.document.id,targetVersion:1}}])assert.equal((await f.preview(changed)).status,409);
 assert.equal((await f.preview({...p,document:{...p.document,visibility:'Workspace'}})).status,400);assert.deepEqual(f.snapshot(),prior);
 for(const table of ['document_migration_mappings','document_migration_reconciliations']){assert.throws(()=>f.db.exec('DELETE FROM '+table),/retained/);assert.throws(()=>f.db.exec('UPDATE '+table+" SET native_hash='corrupt'"),/immutable/);}
 const history=await f.request('/document-migration/history?limit=1');assert.equal(history.status,200);assert.equal(history.json.reconciliations[0].id,c.reconciliation.id);assert.equal(history.json.nextCursor,null);
});

test('review pins exact source payload/current linked version and administrative CSRF access',async t=>{
 const f=await fixture(t),p=f.payload(),r=await f.preview(p),before=f.snapshot();assert.equal((await f.commit({...p,document:{...p.document,title:'Changed after review'}},r.json.proof)).status,409);
 assert.equal((await f.request('/document-migration/commit',{method:'POST',csrf:false,body:{...p,proof:r.json.proof}})).status,403);assert.equal((await f.request('/records/tasks/'+f.task.id,{method:'PATCH',body:{version:1,title:'Changed native link'}})).status,200);assert.equal((await f.commit(p,r.json.proof)).status,409);assert.deepEqual(f.snapshot(),before);
});

test('source-map audit fault and after-insert native corruption roll back the SAME validated inline transaction',async t=>{
 const f=await fixture(t),p=f.payload(),r=await f.preview(p),before=f.snapshot();f.db.exec("CREATE TRIGGER synthetic_contract_audit_fault BEFORE INSERT ON audit WHEN NEW.action='import_document_revision' BEGIN SELECT RAISE(ABORT,'Synthetic source-map audit failure'); END;");assert.equal((await f.commit(p,r.json.proof)).status,500);assert.deepEqual(f.snapshot(),before);f.db.exec('DROP TRIGGER synthetic_contract_audit_fault');
 f.db.exec("CREATE TRIGGER synthetic_contract_corrupt AFTER INSERT ON documents BEGIN UPDATE documents SET title='Corrupted native title' WHERE id=NEW.id; END;");assert.equal((await f.commit(p,r.json.proof)).status,409);assert.deepEqual(f.snapshot(),before);f.db.exec('DROP TRIGGER synthetic_contract_corrupt');assert.equal((await f.commit(p,r.json.proof)).status,201);
});

test('exact private staging/readback preserves source hashes and cleans rejection with durable orphan visibility',async t=>{
 const f=await fixture(t,{object:true}),p=f.payload(),r=await f.preview(p);f.setPutHook(async()=>{f.db.prepare("UPDATE records SET data=json_set(data,'$.version',2) WHERE collection='tasks' AND id=?").run(f.task.id);});const rejected=await f.commit(p,r.json.proof);assert.equal(rejected.status,409,rejected.text);assert.equal(f.objects.size,0);assert.equal(f.deleted.length,1);assert.equal(f.db.prepare('SELECT state FROM document_upload_attempts').get().state,'Failed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM document_migration_reconciliations').get().n,0);
 f.setPutHook(null);const p2={...p,document:{...p.document,recordVersion:2}},fresh=await f.preview(p2);f.db.exec("CREATE TRIGGER synthetic_contract_map_fault BEFORE INSERT ON document_migration_mappings BEGIN SELECT RAISE(ABORT,'Synthetic mapping failure'); END;");f.setCleanupFailure();assert.equal((await f.commit(p2,fresh.json.proof)).status,500);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM document_upload_attempts WHERE state='Orphaned'").get().n,1);assert.equal(f.objects.size,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM documents').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM document_revision_storage').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM document_migration_mappings').get().n,0);
});

test('private successful native conversion returns exact bytes and no private object references',async t=>{
 const f=await fixture(t,{object:true}),c=await f.importRevision();assert.equal(f.objects.size,1);assert.equal(f.db.prepare('SELECT state FROM document_upload_attempts').get().state,'Committed');assert.equal(f.db.prepare('SELECT length(bytes) n FROM document_revisions').get().n,0);assert.equal(c.reconciliation.file.size,bytes.length);assert.doesNotMatch(JSON.stringify(c),/synthetic-private-contracts|tenants\//);
 const content=await f.request(`/documents/${c.document.id}/revisions/1/content`);assert.equal(content.status,200);assert.deepEqual(Buffer.from(content.json.contentBase64,'base64'),bytes);assert.equal(content.json.sha256,sha(bytes));assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection IN ('gifts','communications','grants')").get().n,0);
});


test('replay review rechecks the linked source after awaiting exact private bytes',async t=>{
 const f=await fixture(t,{object:true}),p=f.payload();await f.importRevision(p);const before=f.snapshot();f.setGetHook(async()=>{f.db.prepare("UPDATE records SET data=json_set(data,'$.title','Changed during exact replay read','$.version',2) WHERE collection='tasks' AND id=?").run(f.task.id);});const review=await f.preview(p);assert.equal(review.status,409,review.text);assert.deepEqual(f.snapshot(),before);
});
