import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';

const criteria=(changes={})=>({segmentTokens:['AudienceX'],segmentMatch:'All',types:[],preferences:[],...changes});
const definition=(changes={})=>({name:'Reviewed saved audience',filters:criteria(),...changes});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-audiences-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:''});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',session:staff,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 async function person(name,extra={}){return create('constituents',{name,type:'Individual',email:name.replace(/[^a-z]/gi,'').toLowerCase()+'@example.test',segments:'AudienceX',preference:'Email',notes:'PRIVATE_SOURCE_NOTE',...extra});}
 const alice=await person('Alice Audience'),bob=await person('Bob Audience',{segments:'AudienceX,SecondToken'}),blocked=await person('Suppressed Audience',{preference:'Do not contact'}),postal=await person('Postal Audience',{preference:'Post',email:''}),badEmail=await person('No Primary Email',{email:'',contacts:[{name:'Secondary only',email:'secondary@example.test',role:'Contact'}]});
 async function audience(body=definition()){const r=await request('/audiences',{method:'POST',session:staff,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.audience;}
 async function preview(a,channel='Print',query=''){return request('/audiences/'+a.id+'/preview?version='+a.version+'&channel='+encodeURIComponent(channel)+query,{session:viewer});}
 async function editPerson(p,changes){const r=await request('/records/constituents/'+p.id,{method:'PATCH',session:staff,body:{version:p.version,...changes}});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.record;}
 async function template(kind='Messaging'){const r=await request('/correspondence/templates',{method:'POST',session:staff,body:{name:'Audience wording',kind,subject:'Hello {{recipientName}}',body:'A reviewed message for {{recipientName}} from {{organizationName}}.'}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.template;}
 async function prepare(a,p,selectedIds,channel='Print',tpl){tpl=tpl||await template();return request('/correspondence/prepare',{method:'POST',session:staff,body:{templateId:tpl.id,templateVersion:tpl.version,channel,constituentIds:selectedIds,audience:{id:a.id,version:a.version,sourceDigest:p.sourceDigest}}});}
 async function finalize(c){return request('/correspondence/'+c.id+'/finalize',{method:'POST',session:staff,body:{version:1,preparationDigest:c.preparationDigest,confirmed:true}});}
 return {request,login,admin,staff,viewer,create,person,alice,bob,blocked,postal,badEmail,audience,preview,editPerson,template,prepare,finalize,restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('saved filters are native, exact-token, any/all, type and preference based without implicit expansion',async t=>{
 const f=await fixture(t);await f.person('Substring only',{segments:'AudienceXYZ'});await f.person('Case different',{segments:'audiencex'});
 const a=await f.audience(),p=(await f.preview(a)).json;assert.equal(p.matchedCount,5);assert.equal(p.eligibleCount,4);assert.equal(p.reasonCounts['Do not contact'],1);assert.equal(Object.values(p.reasonCounts).reduce((sum,n)=>sum+n,0),p.excludedCount);assert.equal(p.totalCount,p.eligibleCount+p.excludedCount);
 assert.deepEqual(new Set(p.recipients.map(r=>r.id)),new Set([f.alice.id,f.bob.id,f.postal.id,f.badEmail.id]));assert.ok(!JSON.stringify(p.recipients).includes('PRIVATE_SOURCE_NOTE'));assert.deepEqual(Object.keys(p.recipients[0]).sort(),['id','name','preference','version']);
 const all=await f.audience(definition({filters:criteria({segmentTokens:['AudienceX','SecondToken']})}));assert.deepEqual((await f.preview(all)).json.recipients.map(r=>r.id),[f.bob.id]);
 const any=await f.audience(definition({filters:criteria({segmentTokens:['SecondToken','MissingToken'],segmentMatch:'Any'})}));assert.deepEqual((await f.preview(any)).json.recipients.map(r=>r.id),[f.bob.id]);
 const post=await f.audience(definition({filters:criteria({types:['Individual'],preferences:['Post']})}));assert.deepEqual((await f.preview(post)).json.recipients.map(r=>r.id),[f.postal.id]);
});

test('channel eligibility has disjoint reasons, primary-email requirements and no contact/tag consent inference',async t=>{
 const f=await fixture(t),a=await f.audience(),p=(await f.preview(a,'Email draft')).json;assert.equal(p.matchedCount,5);assert.equal(p.eligibleCount,2);assert.equal(p.reasonCounts['Do not contact'],1);assert.equal(p.reasonCounts['Email preference required'],1);assert.equal(p.reasonCounts['Invalid primary email'],1);assert.deepEqual(new Set(p.recipients.map(r=>r.id)),new Set([f.alice.id,f.bob.id]));
 const print=(await f.preview(a)).json;assert.ok(print.recipients.some(r=>r.id===f.postal.id));assert.ok(print.recipients.some(r=>r.id===f.badEmail.id));assert.ok(!print.recipients.some(r=>r.id===f.blocked.id));
 const mixed=await f.prepare(a,p,[f.alice.id,f.blocked.id],'Email draft');assert.equal(mixed.status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM correspondence_preparations').get().n,0);
});

test('definitions, history, permissions, strict bounds and retirement are enforced atomically',async t=>{
 const f=await fixture(t),a=await f.audience(),path='/audiences/'+a.id;
 assert.equal((await f.request('/audiences')).status,401);assert.equal((await f.request(path,{session:f.viewer})).status,200);
 for(const options of [{session:f.viewer},{session:f.staff,csrf:false}])assert.equal((await f.request('/audiences',{...options,method:'POST',body:definition()})).status,403);
 for(const body of [definition({unknown:true}),definition({filters:criteria({types:['Unknown']})}),definition({filters:criteria({segmentTokens:['AudienceX',' AudienceX ']})}),definition({filters:criteria({segmentTokens:['AudienceX,SecondToken']})}),definition({filters:criteria({preferences:['Email','Email']})})])assert.equal((await f.request('/audiences',{session:f.staff,method:'POST',body})).status,400);
 const update=await f.request(path,{method:'PATCH',session:f.staff,body:{...definition({name:'Revised audience'}),version:1,status:'Active'}});assert.equal(update.status,200);assert.equal(update.json.audience.version,2);
 assert.equal((await f.request(path,{method:'PATCH',session:f.staff,body:{...definition(),version:1,status:'Active'}})).status,409);
 assert.equal((await f.request(path,{method:'PATCH',session:f.staff,body:{...definition(),version:2,status:'Retired',reason:' '}})).status,400);
 const retired=await f.request(path,{method:'PATCH',session:f.staff,body:{...definition(),version:2,status:'Retired',reason:'Audience no longer used'}});assert.equal(retired.status,200);assert.equal((await f.preview(retired.json.audience)).status,409);
 assert.equal((await f.request(path,{method:'PATCH',session:f.staff,body:{...definition(),version:3,status:'Active'}})).status,409);
 const history=(await f.request(path,{session:f.viewer})).json;assert.equal(history.revisions.length,3);assert.equal(history.revisions[0].reason,'Audience no longer used');assert.equal(history.revisionCount,3);assert.throws(()=>f.db.prepare('DELETE FROM audience_revisions WHERE audience_id=?').run(a.id));assert.throws(()=>f.db.prepare('UPDATE audience_revisions SET reason=? WHERE audience_id=?').run('tamper',a.id));assert.throws(()=>f.db.prepare('DELETE FROM audience_definitions WHERE id=?').run(a.id));
});

test('explicit Messaging preparation pins audience provenance and rechecks source corpus during finalization',async t=>{
 const f=await fixture(t),a=await f.audience(),p=(await f.preview(a)).json;
 const prepared=await f.prepare(a,p,[f.alice.id]);assert.equal(prepared.status,201,JSON.stringify(prepared.json));const c=prepared.json.correspondence;assert.equal(c.delivery,'Not sent');assert.deepEqual(c.audience.selectedConstituentIds,[f.alice.id]);assert.equal(c.audience.sourceDigest,p.sourceDigest);assert.equal(c.audience.definitionDigest,p.audience.definitionDigest);assert.equal(c.items.length,1);assert.equal(c.items[0].recipient.id,f.alice.id);
 const oldData=f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all();assert.equal((await f.finalize(c)).status,200);assert.deepEqual(f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all(),oldData);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='communications' AND json_extract(data,'$.status')='Sent'").get().n,0);
 const second=(await f.prepare(a,p,[f.bob.id])).json.correspondence;await f.person('New matching profile');assert.equal((await f.finalize(second)).status,409);assert.equal((await f.prepare(a,p,[f.alice.id])).status,409);
 const retained=(await f.request('/correspondence/'+second.id,{session:f.viewer})).json.correspondence;assert.equal(retained.items.length,1);assert.equal(retained.items[0].recipient.id,f.bob.id);assert.equal(retained.status,'Prepared');
});

test('changed criteria and preference invalidate selected preparation without skipping or replacing recipients',async t=>{
 const f=await fixture(t),a=await f.audience(),p=(await f.preview(a)).json,tpl=await f.template(),c=(await f.prepare(a,p,[f.alice.id,f.bob.id],'Print',tpl)).json.correspondence;
 await f.editPerson(f.alice,{preference:'Do not contact'});assert.equal((await f.finalize(c)).status,409);assert.equal((await f.prepare(a,p,[f.alice.id],'Print',tpl)).status,409);
 const fresh=(await f.preview(a)).json;assert.equal((await f.prepare(a,fresh,[f.alice.id,f.bob.id],'Print',tpl)).status,409);
 const next=(await f.prepare(a,fresh,[f.bob.id],'Print',tpl)).json.correspondence;
 const edited=await f.request('/audiences/'+a.id,{method:'PATCH',session:f.staff,body:{...definition({filters:criteria({segmentTokens:['SecondToken']})}),version:1,status:'Active'}});assert.equal(edited.status,200);assert.equal((await f.finalize(next)).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM correspondence_finalizations').get().n,0);
});

test('preview pagination is explicit and bounded, and audience preparation rejects non-Messaging templates',async t=>{
 const f=await fixture(t),a=await f.audience(),first=(await f.preview(a,'Print','&limit=1')).json;assert.equal(first.recipients.length,1);assert.equal(first.nextCursor,first.recipients[0].id);const second=(await f.preview(a,'Print','&limit=1&after='+first.nextCursor)).json;assert.notEqual(first.recipients[0].id,second.recipients[0].id);assert.equal(first.sourceDigest,second.sourceDigest);
 for(const query of ['&limit=101','&after=bad','&unexpected=true'])assert.equal((await f.preview(a,'Print',query)).status,400);
 assert.equal((await f.preview({...a,version:2})).status,409);
 const acknowledgement=await f.template('Acknowledgment');assert.equal((await f.prepare(a,first,[f.alice.id],'Print',acknowledgement)).status,400);
 const repeated=Array(101).fill(f.alice.id);assert.equal((await f.prepare(a,first,repeated)).status,400);
});

test('audit failure rolls back definition revisions and retirement, and retained audiences survive restart',async t=>{
 const f=await fixture(t),a=await f.audience();f.db.exec("CREATE TRIGGER synthetic_audience_audit_failure BEFORE INSERT ON audit WHEN NEW.action='retire_audience' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 const failed=await f.request('/audiences/'+a.id,{method:'PATCH',session:f.staff,body:{...definition(),version:1,status:'Retired',reason:'Retiring unused criteria'}});assert.equal(failed.status,500);assert.equal(f.db.prepare('SELECT version FROM audience_definitions WHERE id=?').get(a.id).version,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audience_revisions WHERE audience_id=?').get(a.id).n,1);
 await f.restart();const viewer=await f.login('board@foundation.example');const detail=await f.request('/audiences/'+a.id,{session:viewer});assert.equal(detail.status,200);assert.equal(detail.json.audience.status,'Active');assert.equal(detail.json.revisionCount,1);
});

test('retirement releases bounded active capacity while retained history stays directly reachable',async t=>{
 const f=await fixture(t),a=await f.audience(),at=new Date().toISOString(),body=JSON.stringify(definition());
 // Synthetic established native history at the allowed capacity boundary.
 f.db.exec('BEGIN IMMEDIATE');try{for(let i=0;i<199;i++){const key=randomUUID();f.db.prepare('INSERT INTO audience_definitions VALUES(?,1,?,?,?,?)').run(key,'Active',body,at,at);f.db.prepare('INSERT INTO audience_revisions VALUES(?,1,?,?,?,?,?)').run(key,'Active',body,'',f.admin.user.id,at);}f.db.exec('COMMIT');}catch(e){f.db.exec('ROLLBACK');throw e;}
 assert.equal((await f.request('/audiences',{method:'POST',session:f.staff,body:definition()})).status,409);
 assert.equal((await f.request('/audiences/'+a.id,{method:'PATCH',session:f.staff,body:{...definition(),version:1,status:'Retired',reason:'Retire unused capacity'}})).status,200);
 assert.equal((await f.request('/audiences',{method:'POST',session:f.staff,body:definition({name:'New active audience'})})).status,201);
 const listed=(await f.request('/audiences',{session:f.viewer})).json;assert.equal(listed.audiences.length,200);assert.ok(listed.audiences.every(row=>row.status==='Active'));
 const retained=(await f.request('/audiences/'+a.id,{session:f.viewer})).json;assert.equal(retained.audience.status,'Retired');assert.equal(retained.revisionCount,2);assert.equal(retained.revisions[0].reason,'Retire unused capacity');
});
