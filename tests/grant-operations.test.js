import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
const encode=id=>'%'+id.charCodeAt(0).toString(16)+id.slice(1);
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-grant-operations-')),dbPath=join(dir,'workspace.sqlite');let app,server,base;
 async function open(){app=createApp({dbPath,seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){await new Promise(resolve=>server.close(resolve));app.locals.close();}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrfToken;}const res=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};}
 async function login(email){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 const workspace=async()=>(await request('/workspace',{session:admin})).json.data;
 const grant=(await workspace()).grants[0];
 const createBody=changes=>({grantId:grant.id,grantVersion:grant.version,name:'Grant report delivery evidence',kind:'Report',dueDate:'2026-09-01',ownerId:staff.user.id,ownerVersion:1,...changes});
 async function create(changes={}){const r=await request('/grant-operations',{method:'POST',session:staff,body:createBody(changes)});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.milestone;}
 async function document(changes={}){const r=await request('/documents',{method:'POST',session:admin,body:{collection:'grants',recordId:grant.id,title:'Final grant report',category:'Report',visibility:'Workspace',status:'Final',evidenceDate:'2026-09-01',filename:'report.txt',contentBase64:Buffer.from('Immutable source report evidence').toString('base64'),...changes}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.document;}
 const completion=(m,d,changes={})=>({version:m.version,grantVersion:grant.version,ownerVersion:1,documentId:d.id,documentVersion:d.version,revision:1,completedDate:'2026-09-02',reference:'Staff verified source submission reference QA-001',confirmed:true,...changes});
 async function complete(m,d,changes={},session=staff){return request('/grant-operations/'+m.id+'/complete',{method:'POST',session,body:completion(m,d,changes)});}
 return {request,admin,staff,viewer,grant,workspace,createBody,create,document,completion,complete,get db(){return app.locals.db;},restart:async()=>{await close();await open();}};
}

test('grant milestone API requires auth, writable role, CSRF and current active source/owner versions',async t=>{
 const f=await fixture(t),body=f.createBody();assert.equal((await f.request('/grant-operations')).status,401);
 for(const options of [{},{session:f.viewer},{session:f.staff,csrf:false}])assert.equal((await f.request('/grant-operations',{method:'POST',body,...options})).status,options.session?403:401);
 for(const changes of [{grantVersion:99},{ownerVersion:99}])assert.equal((await f.request('/grant-operations',{method:'POST',session:f.staff,body:{...body,...changes}})).status,409);
 for(const changes of [{dueDate:'2026-02-30'},{name:' '},{kind:'Government compliance'},{ownerId:f.viewer.user.id},{status:'Completed'}])assert.equal((await f.request('/grant-operations',{method:'POST',session:f.staff,body:{...body,...changes}})).status,400);
 const m=await f.create(),r=await f.request('/grant-operations',{session:f.viewer});assert.equal(r.status,200);assert.equal(r.json.milestones[0].id,m.id);assert.equal(r.json.owners.every(u=>['admin','staff'].includes(u.role)),true);assert.equal(JSON.stringify(r.json).includes('password_hash'),false);
});

test('completion pins immutable document revision/source/owner history without changing grant money or gifts',async t=>{
 const f=await fixture(t),before=await f.workspace(),m=await f.create(),d=await f.document(),r=await f.complete(m,d);assert.equal(r.status,200,JSON.stringify(r.json));const done=r.json.milestone;
 assert.equal(done.status,'Completed');assert.equal(done.version,2);assert.equal(done.completion.staffConfirmed,true);assert.equal(done.completion.document.sha256,d.revisions[0].sha256);assert.equal(done.source.version,f.grant.version);assert.equal(done.owner.name,f.staff.user.name);assert.equal(done.history.length,2);assert.equal(done.history[1].snapshot.completion.reference,'Staff verified source submission reference QA-001');assert.equal(JSON.stringify(done).includes('contentBase64'),false);
 assert.deepEqual((await f.workspace()).grants,before.grants);assert.deepEqual((await f.workspace()).gifts,before.gifts);
 assert.throws(()=>f.db.prepare('UPDATE grant_milestone_history SET action=? WHERE milestone_id=?').run('rewrite',m.id),/immutable/);assert.throws(()=>f.db.prepare('DELETE FROM grant_milestone_history WHERE milestone_id=?').run(m.id),/retained/);
 assert.equal((await f.complete(m,d,{version:2})).status,409);
});

test('new completions reject missing, draft, wrong category/link, future dates and stale evidence',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document();
 for(const [changes,status] of [[{documentVersion:99},409],[{revision:99},400],[{grantVersion:99},409],[{ownerVersion:99},409],[{reference:' '},400],[{confirmed:false},400],[{completedDate:'2099-01-01'},400],[{completedDate:'2026-08-31'},400],[{documentId:'missing'},404]])assert.equal((await f.complete(m,d,changes)).status,status);
 for(const changes of [{status:'Draft'},{category:'Agreement'}]){const invalid=await f.document(changes);assert.equal((await f.complete(m,invalid)).status,400);}
 const other=(await f.workspace()).constituents[0],wrong=await f.document({collection:'constituents',recordId:other.id});assert.equal((await f.complete(m,wrong)).status,400);
 assert.equal((await f.request('/grant-operations/'+m.id+'/complete',{method:'POST',session:f.viewer,body:f.completion(m,d)})).status,403);assert.equal((await f.request('/grant-operations/'+m.id+'/complete',{method:'POST',session:f.staff,csrf:false,body:f.completion(m,d)})).status,403);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grant_milestones WHERE json_extract(data,'$.status')='Completed'").get().n,0);
});

test('private evidence and retained completion snapshots remain administrator-only across reopen and document changes',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document({visibility:'Administrators'});assert.equal((await f.request('/grant-operations?grantId='+f.grant.id,{session:f.staff})).json.documents.some(x=>x.id===d.id),false);assert.equal((await f.complete(m,d)).status,404);
 const r=await f.complete(m,d,{},f.admin);assert.equal(r.status,200);assert.equal(r.json.milestone.requiredRole,'admin');
 for(const session of [f.staff,f.viewer]){assert.equal((await f.request('/grant-operations/'+encode(m.id),{session})).status,404);assert.equal((await f.request('/grant-operations',{session})).json.milestones.some(x=>x.id===m.id),false);assert.equal((await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session,body:{version:2,reason:'Cannot expose private history'}})).status,session===f.viewer?403:404);}
 assert.equal((await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.admin,body:{version:2,reason:'Evidence needs an amended report'}})).status,200);
 const revision=await f.request('/documents/'+d.id+'/revisions',{method:'POST',session:f.admin,body:{version:1,title:'Now public metadata',category:'Report',visibility:'Workspace',status:'Final',evidenceDate:'2026-09-01',filename:'public.txt',contentBase64:Buffer.from('New public report').toString('base64')}});assert.equal(revision.status,200);
 assert.equal((await f.request('/grant-operations/'+m.id,{session:f.staff})).status,404);assert.equal((await f.request('/grant-operations?grantId='+f.grant.id,{session:f.staff})).json.documents.find(x=>x.id===d.id).revisions.some(x=>x.revision===1),false);
});

test('archiving/revising evidence invalidates stale completion but preserves already completed history and restart',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document();assert.equal((await f.request('/documents/'+d.id+'/archive',{method:'POST',session:f.admin,body:{version:1,reason:'Source withdrawn before completion'}})).status,200);assert.equal((await f.complete(m,d)).status,409);assert.equal((await f.complete(m,d,{documentVersion:2})).status,409);
 const fresh=await f.document();assert.equal((await f.complete(m,fresh)).status,200);assert.equal((await f.request('/documents/'+fresh.id+'/archive',{method:'POST',session:f.admin,body:{version:1,reason:'Retain old completed evidence'}})).status,200);
 const r=await f.request('/grant-operations/'+m.id,{session:f.admin});assert.equal(r.json.milestone.history[1].documentArchived,true);const before=r.json.milestone;await f.restart();assert.deepEqual((await f.request('/grant-operations/'+m.id,{session:f.admin})).json.milestone,before);
});

test('milestone edits/reopen are versioned, stale source and concurrent completion fail; decoded deletion retains history',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document(),before=await f.workspace();
 const outcomes=await Promise.all([1,2].map(()=>f.complete(m,d)));assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
 assert.equal((await f.request('/grant-operations/'+m.id,{method:'PATCH',session:f.admin,body:{...f.createBody(),grantId:undefined,version:2}})).status,409);
 assert.equal((await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.staff,body:{version:2,reason:''}})).status,400);
 const reopened=await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.staff,body:{version:2,reason:'Buyer revised submission requirements'}});assert.equal(reopened.status,200);assert.equal(reopened.json.milestone.history[2].reason,'Buyer revised submission requirements');
 assert.equal((await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.staff,body:{version:2,reason:'Stale reopen'}})).status,409);
 const patch={name:'Amended report',kind:'Report',dueDate:'2026-10-01',ownerId:f.staff.user.id,ownerVersion:1,grantVersion:f.grant.version,version:3};assert.equal((await f.request('/grant-operations/'+encode(m.id),{method:'PATCH',session:f.staff,body:patch})).status,200);
 assert.equal((await f.request('/records/grants/'+encode(f.grant.id),{method:'DELETE',session:f.admin,body:{version:f.grant.version}})).status,409);assert.equal((await f.request('/grant-operations/'+encode(m.id),{method:'DELETE',session:f.admin})).status,403);assert.equal((await f.request('/documents/'+encode(d.id),{method:'DELETE',session:f.admin})).status,403);
 const changed=await f.request('/records/grants/'+f.grant.id,{method:'PATCH',session:f.admin,body:{version:f.grant.version,notes:'New source notes'}});assert.equal(changed.status,200);assert.equal((await f.complete(m,d,{version:4})).status,409);
 assert.deepEqual((await f.workspace()).gifts,before.gifts);assert.equal((await f.workspace()).grants.find(g=>g.id===f.grant.id).amount,f.grant.amount);
});

test('calendar filters, actual revision races and inactive owners do not fabricate completion',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document();
 assert.equal((await f.request('/grant-operations?kind=Report&status=Open&from=2026-09-01&to=2026-09-01',{session:f.viewer})).json.milestones.length,1);assert.equal((await f.request('/grant-operations?from=2026-10-01',{session:f.viewer})).json.milestones.length,0);assert.equal((await f.request('/grant-operations?from=2026-10-01&to=2026-09-01',{session:f.viewer})).status,400);
 const revised=await f.request('/documents/'+d.id+'/revisions',{method:'POST',session:f.admin,body:{version:1,title:'Amended final report',category:'Report',visibility:'Workspace',status:'Final',evidenceDate:'2026-09-02',filename:'amendment.txt',contentBase64:Buffer.from('Amended report evidence').toString('base64')}});assert.equal(revised.status,200);assert.equal((await f.complete(m,d)).status,409);
 assert.equal((await f.request('/users/'+f.staff.user.id,{method:'PATCH',session:f.admin,body:{version:1,active:false,role:'staff'}})).status,200);
 assert.equal((await f.complete(m,revised.json.document,{revision:2},f.admin)).status,400);
 assert.equal((await f.request('/grant-operations',{session:f.admin})).json.milestones[0].status,'Open');assert.equal((await f.request('/grant-operations',{session:f.admin})).json.owners.some(o=>o.id===f.staff.user.id),false);
});

test('document digest corruption fails completion atomically without retained false evidence',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document(),before=await f.workspace();f.db.exec('DROP TRIGGER document_revision_no_update');f.db.prepare('UPDATE document_revisions SET bytes=? WHERE document_id=? AND revision=1').run(Buffer.from('Corrupted source evidence'),d.id);
 assert.equal((await f.complete(m,d)).status,503);assert.equal((await f.request('/grant-operations/'+m.id,{session:f.admin})).json.milestone.history.length,1);assert.deepEqual((await f.workspace()).grants,before.grants);assert.deepEqual((await f.workspace()).gifts,before.gifts);
});

test('workspace grant queue projection follows completion/reopen and excludes retained private evidence for unauthorized roles',async t=>{
 const f=await fixture(t),m=await f.create(),d=await f.document();
 async function queue(session=f.admin){const r=await f.request('/workspace',{session});assert.equal(r.status,200);assert.ok(Array.isArray(r.json.grantMilestones),'Workspace must include top-level authorized grantMilestones');return r.json.grantMilestones;}
 const expected={id:m.id,grantId:f.grant.id,name:m.name,kind:'Report',dueDate:'2026-09-01',status:'Open',owner:{id:f.staff.user.id,name:f.staff.user.name}};assert.deepEqual((await queue(f.viewer)).find(r=>r.id===m.id),expected);
 assert.equal((await f.complete(m,d)).status,200);assert.equal((await queue(f.staff)).find(r=>r.id===m.id).status,'Completed');
 assert.equal((await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.staff,body:{version:2,reason:'Queue must return reopened obligation'}})).status,200);assert.equal((await queue(f.viewer)).find(r=>r.id===m.id).status,'Open');
 const privateMilestone=await f.create({name:'Restricted milestone',dueDate:'2026-10-01'}),privateDoc=await f.document({visibility:'Administrators',title:'Private completion source'});assert.equal((await f.complete(privateMilestone,privateDoc,{},f.admin)).status,200);
 for(const session of [f.staff,f.viewer]){const projected=await queue(session);assert.equal(projected.some(r=>r.id===privateMilestone.id),false);assert.equal(JSON.stringify(projected).includes(privateDoc.id),false);assert.equal(JSON.stringify(projected).includes('QA-001'),false);}
 const adminItem=(await queue()).find(r=>r.id===privateMilestone.id);assert.equal(adminItem.status,'Completed');assert.equal(adminItem.dueDate,'2026-10-01');assert.deepEqual(Object.keys(adminItem).sort(),['dueDate','grantId','id','kind','name','owner','status']);assert.deepEqual(Object.keys(adminItem.owner).sort(),['id','name']);
 assert.equal((await f.request('/grant-operations/'+privateMilestone.id+'/reopen',{method:'POST',session:f.admin,body:{version:2,reason:'Reopen restricted evidence without disclosure'}})).status,200);
 assert.equal((await queue()).find(r=>r.id===privateMilestone.id).status,'Open');assert.equal((await queue(f.viewer)).some(r=>r.id===privateMilestone.id),false);
 await f.restart();assert.equal((await queue()).find(r=>r.id===privateMilestone.id).status,'Open');assert.equal((await queue(f.staff)).some(r=>r.id===privateMilestone.id),false);
});
