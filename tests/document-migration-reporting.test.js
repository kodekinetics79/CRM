import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
import {backupWorkspace,restoreWorkspace} from '../server/backup.js';
import {createDocumentRecoveryAdapter} from '../server/documentRecovery.js';

const password='SyntheticContractReporting!2026',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalBytes=Buffer.from('PRIVATE_CONTRACT_BODY\nOriginal UTF-8 clause café\n');
function privateStorage(){
 const objects=new Map();
 return {scope:{provider:'s3',bucket:'synthetic-contract-reporting',namespace:'synthetic-contract-lineage'},async verifyReadiness(){return {verified:true};},stage(input){return {...input,...this.scope,key:'synthetic/'+input.tenantId+'/'+input.documentId+'/'+input.revision+'/'+input.attemptId,version:null};},async put(reference,bytes){const saved={...reference,version:randomUUID(),encryption:'AES256'};objects.set(saved.key,{reference:saved,bytes:Buffer.from(bytes)});return saved;},async get(reference){const saved=objects.get(reference.key);if(!saved||saved.reference.version!==reference.version||saved.reference.tenantId!==reference.tenantId)throw Object.assign(new Error('Synthetic exact private version unavailable'),{status:503});return saved.bytes;},async deleteStaged(reference){objects.delete(reference.key);}};
}
async function fixture(t,{external=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-contract-reporting-')),dbPath=join(dir,'workspace.sqlite'),tenantId=randomUUID(),storage=privateStorage();
 const operator={name:'Synthetic contract reporting operator',email:'contract.reporting@example.test',password};let app,server,base,sessions={};
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 async function request(path,{method='GET',body,session=sessions.admin}={}){const response=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {status:response.status,json,text,headers:response.headers};}
 async function login(email=operator.email){const result=await request('/auth/login',{method:'POST',body:{email,password},session:null});assert.equal(result.status,200,result.text);return {...result.json,cookie:result.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
 async function open(path=dbPath,provider=external?storage:null){app=createApp({dbPath:path,seed:false,tenantId,initialAdmin:operator,mfaKey:'',reminderWorker:false,documentStorage:provider,documentTenantId:tenantId});server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;sessions.admin=await login();}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 for(const role of ['staff','viewer','event-helper']){const email=role+'.contract.reporting@example.test';assert.equal((await request('/users',{method:'POST',body:{name:'Synthetic '+role,email,password,role}})).status,201);sessions[role]=await login(email);}
 const target=await request('/records/tasks',{method:'POST',body:{title:'Contract source target',dueDate:'2026-09-13',status:'Open'}});assert.equal(target.status,201,target.text);
 const payload=(changes={})=>({source:{namespace:'SyntheticContractInventory',documentId:'source-contract-1',revisionId:'source-revision-1',visibility:'Administrators',originalDate:'2016-09-13'},document:{collection:'tasks',recordId:target.json.record.id,recordVersion:1,title:'PRIVATE_CONTRACT_TITLE',category:'Agreement',status:'Final',visibility:'Administrators',evidenceDate:null,filename:'PRIVATE_CONTRACT_FILENAME.txt',contentBase64:originalBytes.toString('base64')},sha256:sha(originalBytes),size:originalBytes.length,...changes});
 async function commit(input=payload()){const preview=await request('/document-migration/preview',{method:'POST',body:input});assert.equal(preview.status,200,preview.text);assert.equal(preview.json.valid,true,preview.text);return request('/document-migration/commit',{method:'POST',body:{...input,proof:preview.json.proof}});}
 async function run(entity,columns,session=sessions.admin,extra={}){return request('/custom-reports/run',{method:'POST',session,body:{name:'Contract conversion report',entity,columns,...extra}});}
 return {dir,tenantId,storage,originalBytes,target:target.json.record,payload,commit,request,run,login,open,close,get db(){return app.locals.db;},get app(){return app;},get sessions(){return sessions;}};
}

const sources=['documentMigrationMappings','documentMigrationReconciliations'];
test('contract inventory reporting is administrator-only, curated and linked to the native business source',async t=>{
 const f=await fixture(t),saved=await f.commit();assert.equal(saved.status,201,saved.text);
 const catalog=await f.request('/custom-reports/catalog');assert.equal(catalog.status,200,catalog.text);
 for(const source of sources){const entity=catalog.json.entities.find(e=>e.id===source);assert.ok(entity,source);assert.equal(entity.requiredRole,'admin');assert.equal(entity.fields.find(field=>field.key==='sourceBytes').unit,'bytes');assert.equal(entity.fields.find(field=>field.key==='originalDate').type,'date');assert.equal(entity.fields.find(field=>field.key==='importedAt').type,'date');
  const current=await f.run(source,['sourceNamespace','sourceDocumentId','sourceRevisionId','documentId','documentRevision','recordRevision','sourceVisibility','originalDate','importedAt','sourceBytes','nativeBytes']);assert.equal(current.status,200,current.text);assert.equal(current.json.requiredRole,'admin');assert.equal(current.json.rows.length,1);assert.deepEqual(current.json.rows[0].slice(0,8),['SyntheticContractInventory','source-contract-1','source-revision-1',saved.json.document.id,1,1,'Administrators','2016-09-13']);assert.equal(current.json.rows[0][8],saved.json.reconciliation.at);assert.deepEqual(current.json.rows[0].slice(9),[originalBytes.length,originalBytes.length]);assert.deepEqual(current.json.recordReferences,[{collection:'tasks',id:f.target.id}]);assert.doesNotMatch(JSON.stringify(current.json),/PRIVATE_CONTRACT_BODY|PRIVATE_CONTRACT_FILENAME|PRIVATE_CONTRACT_TITLE|source_hash|native_hash|contentBase64|proof|token_hash|object_key/);
  for(const field of ['contentBase64','filename','metadata','source_hash','native_hash','proof'])assert.equal((await f.run(source,[field])).status,400,field);
 }
 for(const role of ['staff','viewer','event-helper']){const session=f.sessions[role],catalog=await f.request('/custom-reports/catalog',{session});if(role==='event-helper')assert.equal(catalog.status,403);else{assert.equal(catalog.status,200);for(const source of sources)assert.equal(catalog.json.entities.some(entity=>entity.id===source),false);assert.doesNotMatch(JSON.stringify(catalog.json),/PRIVATE_CONTRACT_BODY|PRIVATE_CONTRACT_FILENAME|PRIVATE_CONTRACT_TITLE/);}
  for(const source of sources)assert.equal((await f.run(source,['sourceNamespace'],session)).status,403);
 }
});

test('append and replay retain exact original chronology and reconcile historical counts without adding replay bytes',async t=>{
 const f=await fixture(t),first=await f.commit();assert.equal(first.status,201,first.text);const secondBytes=Buffer.from('Second original contract revision\n'),input=f.payload();input.source={...input.source,revisionId:'source-revision-2',originalDate:'2017-09-13'};input.document={...input.document,targetDocumentId:first.json.document.id,targetVersion:1,filename:'second.txt',contentBase64:secondBytes.toString('base64')};input.sha256=sha(secondBytes);input.size=secondBytes.length;
 const second=await f.commit(input);assert.equal(second.status,201,second.text);assert.equal(second.json.document.version,2);
 const replay=await f.commit();assert.equal(replay.status,200,replay.text);assert.equal(replay.json.replayed,true);
 const detail=await f.run('documentMigrationReconciliations',['sourceRevisionId','documentRevision','requestedDocumentRevision','operation','originalDate','importedAt','importedStatus','importedEvidenceDate'],undefined,{filters:[{field:'sourceRevisionId',op:'eq',value:'source-revision-2'}]});assert.equal(detail.status,200,detail.text);assert.deepEqual(detail.json.rows[0].slice(0,5),['source-revision-2',2,1,'Append','2017-09-13']);assert.equal(detail.json.rows[0][5],second.json.reconciliation.at);assert.deepEqual(detail.json.rows[0].slice(6),['Final',null]);assert.ok(Date.parse(detail.json.rows[0][5])>Date.parse(detail.json.rows[0][4]));
 for(const source of sources){const totals=await f.run(source,['sourceNamespace'],undefined,{aggregates:[{op:'sum',field:'sourceRevisionCount'},{op:'sum',field:'nativeRevisionCount'},{op:'sum',field:'sourceBytes'},{op:'sum',field:'nativeBytes'}]});assert.equal(totals.status,200,totals.text);assert.deepEqual(totals.json.rows,[[2,2,originalBytes.length+secondBytes.length,originalBytes.length+secondBytes.length]]);}
 assert.equal(f.db.prepare('SELECT count(*) n FROM document_revisions').get().n,2);
});

test('scheduled conversion reports retain administrator authorization after account downgrade',async t=>{
 const f=await fixture(t);assert.equal((await f.commit()).status,201);
 const report=await f.request('/custom-reports',{method:'POST',body:{name:'Retained contract lineage',entity:'documentMigrationReconciliations',columns:['sourceNamespace','originalDate','sourceBytes']}});assert.equal(report.status,201,report.text);
 const startAt=new Date(Date.now()+30000).toISOString(),scheduled=await f.request('/report-schedules',{method:'POST',body:{name:'Retained contract lineage',reportId:report.json.report.id,cadence:'Daily',startAt}});assert.equal(scheduled.status,201,scheduled.text);assert.equal(f.app.locals.runDueReports(Date.parse(startAt)+1).produced,1);
 const delivery=f.db.prepare('SELECT id,result FROM report_deliveries WHERE schedule_id=?').get(scheduled.json.schedule.id);assert.equal(JSON.parse(delivery.result).requiredRole,'admin');
 for(const role of ['staff','viewer','event-helper'])assert.equal((await f.request('/report-deliveries/'+delivery.id,{session:f.sessions[role]})).status,403);
 assert.equal((await f.request('/users',{method:'POST',body:{name:'Second synthetic administrator',email:'second.contract.reporting@example.test',password,role:'admin'}})).status,201);
 const access=await f.request('/users/'+f.sessions.admin.user.id,{method:'PATCH',body:{version:1,role:'staff',active:true}});assert.equal(access.status,200,access.text);const downgraded=await f.login();assert.equal(downgraded.user.role,'staff');assert.equal((await f.request('/report-deliveries/'+delivery.id,{session:downgraded})).status,403);assert.equal((await f.request('/custom-reports/'+report.json.report.id+'/run',{session:downgraded})).status,403);
});

test('cross-tenant or mismatched retained lineage fails closed before it can be reported as reconciled',async t=>{
 const f=await fixture(t);assert.equal((await f.commit()).status,201);const reconciliation=f.db.prepare('SELECT * FROM document_migration_reconciliations').get();
 const reconciliationGuard=f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='document_migration_reconciliation_no_update'").get().sql;f.db.exec('DROP TRIGGER document_migration_reconciliation_no_update');f.db.prepare('UPDATE document_migration_reconciliations SET tenant_id=?').run(randomUUID());
 for(const source of sources){const poisoned=await f.run(source,['sourceNamespace','sourceBytes']);assert.equal(poisoned.status,503,poisoned.text);assert.doesNotMatch(poisoned.text,/PRIVATE_CONTRACT|source_hash|native_hash/);assert.equal((await f.run(source,['sourceNamespace'],f.sessions.staff)).status,403);}
 f.db.prepare('UPDATE document_migration_reconciliations SET tenant_id=?').run(f.tenantId);f.db.exec(reconciliationGuard);
 const mappingGuard=f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='document_migration_mapping_no_update'").get().sql;f.db.exec('DROP TRIGGER document_migration_mapping_no_update');f.db.prepare('UPDATE document_migration_mappings SET native_hash=?').run('0'.repeat(64));const changed=await f.run('documentMigrationMappings',['sourceNamespace']);assert.equal(changed.status,503,changed.text);f.db.prepare('UPDATE document_migration_mappings SET native_hash=?').run(reconciliation.native_hash);f.db.exec(mappingGuard);assert.equal((await f.run('documentMigrationMappings',['sourceNamespace'])).status,200);
});

test('full encrypted offline recovery preserves contract lineage, exact external bytes, immutable guards and mounted replay',async t=>{
 const f=await fixture(t,{external:true}),source=f.payload(),saved=await f.commit(source);assert.equal(saved.status,201,saved.text);assert.equal(f.db.prepare('SELECT length(bytes) n FROM document_revisions').get().n,0);
 const tables=['document_migration_mappings','document_migration_reconciliations'],before=Object.fromEntries(tables.map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));const columns=['sourceNamespace','sourceRevisionId','documentRevision','originalDate','importedAt','sourceBytes','nativeBytes'],reported=await f.run('documentMigrationReconciliations',columns);assert.equal(reported.status,200,reported.text);
 const key=randomBytes(32).toString('hex'),archivePath=join(f.dir,'source.wbackup'),destinationPath=join(f.dir,'recovered.sqlite');const backup=await backupWorkspace({db:f.db,tenantId:f.tenantId,encryptionKey:key,outputPath:archivePath,documentStorage:createDocumentRecoveryAdapter({db:f.db,tenantId:f.tenantId,objectStorage:f.storage})});for(const table of tables)assert.equal(backup.tables.find(row=>row.name===table).count,1);
 await assert.rejects(restoreWorkspace({archivePath,destinationPath:join(f.dir,'wrong-tenant.sqlite'),expectedTenantId:randomUUID(),encryptionKey:key}),/expected tenant/);
 const restored=await restoreWorkspace({archivePath,destinationPath,expectedTenantId:f.tenantId,encryptionKey:key});assert.equal(restored.sourceSha256,backup.sourceSha256);const copy=new DatabaseSync(destinationPath);try{for(const table of tables){assert.deepEqual(copy.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),before[table]);assert.throws(()=>copy.exec('DELETE FROM '+table),/retained/);}assert.deepEqual(Buffer.from(copy.prepare('SELECT bytes FROM document_revisions').get().bytes),originalBytes);assert.equal(copy.prepare('SELECT count(*) n FROM sessions').get().n,0);}finally{copy.close();}
 const oldSession=f.sessions.admin;await f.close();await f.open(destinationPath,null);assert.equal((await f.request('/custom-reports/catalog',{session:oldSession})).status,401);const after=await f.run('documentMigrationReconciliations',columns);assert.equal(after.status,200,after.text);assert.deepEqual(after.json.rows,reported.json.rows);const replay=await f.commit(source);assert.equal(replay.status,200,replay.text);assert.equal(replay.json.replayed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM document_migration_mappings').get().n,1);
 const staff=await f.login('staff.contract.reporting@example.test');assert.equal((await f.run('documentMigrationReconciliations',['sourceNamespace'],staff)).status,403);assert.equal((await f.request('/documents/'+saved.json.document.id+'/revisions/1/content',{session:staff})).status,404);
});
