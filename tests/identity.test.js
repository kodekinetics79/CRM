import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { recognitionReport } from '../src/phaseTwo.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-identity-')),dbPath=join(dir,'identity.sqlite');let app,server,base;
 async function open(){app=createApp({dbPath,seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session)headers.Cookie=session.cookie;if(session&&csrf)headers['X-CSRF-Token']=session.csrfToken;const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(collection,body){const r=await request('/api/records/'+collection,{method:'POST',session:admin,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const target=await create('constituents',{name:'Surviving person',type:'Individual',email:'target@example.test',segments:'Donor',contacts:[{name:'Contact one',email:'one@example.test',role:'Family'}]}),source=await create('constituents',{name:'Duplicate person',type:'Individual',email:'source@example.test',phone:'555-0101',segments:'Donor,Volunteer',contacts:[{name:'Contact two',email:'two@example.test',role:'Friend'}]});
 async function workspace(){const r=await request('/api/workspace',{session:admin});assert.equal(r.status,200);return r.json.data;}
 async function pair(changes={}){const data=await workspace(),a=data.constituents.find(c=>c.id===target.id),b=data.constituents.find(c=>c.id===source.id);return {targetId:a.id,sourceId:b.id,targetVersion:a.version,sourceVersion:b.version,reason:'Verified duplicate constituent correction',...changes};}
 async function preview(body,options={}){return request('/api/identity/merge/preview',{method:'POST',session:admin,body,...options});}
 async function commit(body,options={}){const r=await preview(body);assert.equal(r.status,200,JSON.stringify(r.json));return request('/api/identity/merge',{method:'POST',session:admin,body:{...body,previewDigest:r.json.preview.previewDigest},...options});}
 return {request,admin,staff,viewer,create,target,source,workspace,pair,preview,commit,get db(){return app.locals.db;},restart:async()=>{await close();await open();}};
}
const gift=(donor,fund,changes={})=>({constituentId:donor.id,amount:25000,type:'Cash',method:'Check',date:'2026-08-01',allocations:[{designationId:fund.id,amount:25000}],...changes});
const household=(ids,changes={})=>({name:'Managed family',address:'Synthetic household address',memberIds:ids,...changes});

test('merge preview is read-only; commit conserves records, cash and rewires financial parents atomically',async t=>{
 const f=await fixture(t),fund=(await f.workspace()).designations[0];
 const pledge=await f.create('pledges',{name:'Duplicate pledge',constituentId:f.source.id,amount:50000,startDate:'2026-08-01',installments:2,frequency:'Monthly'});
 const receipt=await f.create('gifts',gift(f.source,fund,{pledgeId:pledge.id,softCreditId:f.target.id}));
 const grant=await f.create('grants',{name:'Community award',funderId:f.source.id,amount:40000,awardedAmount:40000,awardDate:'2026-08-01',stage:'Awarded',deadline:'2026-08-01'});
 const grantGift=await f.create('gifts',gift(f.source,fund,{type:'Grant',grantId:grant.id}));
 const task=await f.create('tasks',{title:'Follow-up',dueDate:'2026-09-13',status:'Open',constituentId:f.source.id});
 const volunteer=await f.create('volunteers',{constituentId:f.source.id});
 const child=await f.create('constituents',{name:'Related person',type:'Individual',parentId:f.source.id});
 const event=await f.create('events',{name:'Benefit',date:'2026-10-01',location:'Hall',capacity:10});
 assert.equal((await f.request(`/api/events/${event.id}/register`,{method:'POST',session:f.admin,body:{constituentId:f.source.id}})).status,200);
 const before=await f.workspace(),body=await f.pair(),auditCount=f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
 const p=await f.preview(body);assert.equal(p.status,200);assert.deepEqual(p.json.preview.blockers,[]);assert.deepEqual(await f.workspace(),before);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,auditCount);
 const merged=await f.request('/api/identity/merge',{method:'POST',session:f.admin,body:{...body,previewDigest:p.json.preview.previewDigest}});assert.equal(merged.status,200,JSON.stringify(merged.json));
 const after=await f.workspace();for(const collection of Object.keys(before))assert.equal(after[collection].length,before[collection].length,collection);
 assert.equal(after.gifts.reduce((n,g)=>n+g.amount,0),before.gifts.reduce((n,g)=>n+g.amount,0));
 for(const id of [receipt.id,grantGift.id])assert.equal(after.gifts.find(g=>g.id===id).constituentId,f.target.id);
 assert.equal(after.pledges.find(p=>p.id===pledge.id).constituentId,f.target.id);assert.equal(after.grants.find(g=>g.id===grant.id).funderId,f.target.id);
 assert.equal(after.tasks.find(r=>r.id===task.id).constituentId,f.target.id);assert.equal(after.volunteers.find(r=>r.id===volunteer.id).constituentId,f.target.id);assert.equal(after.constituents.find(r=>r.id===child.id).parentId,f.target.id);assert.equal(after.events.find(r=>r.id===event.id).registrations[0].constituentId,f.target.id);
 assert.equal(merged.json.target.name,f.target.name);assert.equal(merged.json.target.email,f.target.email);assert.equal(merged.json.target.phone,'555-0101');assert.equal(merged.json.target.contacts.length,2);assert.equal(merged.json.target.segments,'Donor,Volunteer');assert.equal(merged.json.source.mergedInto,f.target.id);
 const stored=f.db.prepare('SELECT * FROM identity_aliases WHERE source_id=?').get(f.source.id);assert.deepEqual(JSON.parse(stored.source_snapshot),f.source);assert.equal(stored.actor,f.admin.user.id);assert.equal(stored.reason,body.reason);
 assert.throws(()=>f.db.prepare('DELETE FROM identity_aliases WHERE source_id=?').run(f.source.id),/retained/);
 const report=recognitionReport({...after,gifts:after.gifts.filter(g=>[receipt.id,grantGift.id].includes(g.id))},{report:'Soft-credit recognition'});const group=report.groups.find(g=>g.id===f.target.id);assert.equal(group.gifts,2);assert.equal(group.directMonetary,50000);assert.equal(group.softMonetary,0);
});

test('merge requires administrator, CSRF, current pair versions and fresh graph preview',async t=>{
 const f=await fixture(t),body=await f.pair();
 assert.equal((await f.preview(body,{session:undefined})).status,401);for(const session of [f.staff,f.viewer])assert.equal((await f.preview(body,{session})).status,403);assert.equal((await f.preview(body,{csrf:false})).status,403);assert.equal((await f.preview({...body,sourceVersion:99})).status,409);
 const p=await f.preview(body),commitBody={...body,previewDigest:p.json.preview.previewDigest};for(const session of [f.staff,f.viewer])assert.equal((await f.request('/api/identity/merge',{method:'POST',session,body:commitBody})).status,403);
 assert.equal((await f.request('/api/identity/merge',{method:'POST',session:f.admin,csrf:false,body:commitBody})).status,403);
 await f.create('tasks',{title:'New linkage after preview',dueDate:'2026-09-13',status:'Open',constituentId:f.source.id});assert.equal((await f.request('/api/identity/merge',{method:'POST',session:f.admin,body:commitBody})).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,0);
});

test('simultaneous commits have one winner and aliases cannot be edited or referenced',async t=>{
 const f=await fixture(t),body=await f.pair(),p=await f.preview(body),commitBody={...body,previewDigest:p.json.preview.previewDigest};
 const responses=await Promise.all([1,2].map(()=>f.request('/api/identity/merge',{method:'POST',session:f.admin,body:commitBody})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal((await f.request(`/api/records/constituents/${f.source.id}`,{method:'PATCH',session:f.admin,body:{version:2,name:'Reactivated'}})).status,409);assert.equal((await f.request(`/api/records/constituents/${f.source.id}`,{method:'DELETE',session:f.admin,body:{version:2}})).status,409);
 assert.equal((await f.request('/api/records/tasks',{method:'POST',session:f.admin,body:{title:'Stale donor selection',dueDate:'2026-09-13',status:'Open',constituentId:f.source.id}})).status,409);
 assert.equal((await f.request('/api/identity/aliases',{session:f.staff})).status,403);assert.equal((await f.request('/api/identity/aliases',{session:f.admin})).json.aliases[0].targetId,f.target.id);
});

test('opt-out is preserved and unsent drafts block a merge until reconciled',async t=>{
 const f=await fixture(t);assert.equal((await f.request(`/api/records/constituents/${f.source.id}`,{method:'PATCH',session:f.admin,body:{version:1,preference:'Do not contact'}})).status,200);
 const draft=await f.create('communications',{constituentId:f.target.id,subject:'Unsent appeal',channel:'Email',status:'Draft',date:'2026-09-13'});let body=await f.pair(),p=await f.preview(body);assert.ok(p.json.preview.blockers.some(b=>b.recordId===draft.id));assert.equal((await f.commit(body)).status,409);
 assert.equal((await f.request(`/api/records/communications/${draft.id}`,{method:'DELETE',session:f.admin,body:{version:1}})).status,200);body=await f.pair();const merged=await f.commit(body);assert.equal(merged.status,200);assert.equal(merged.json.target.preference,'Do not contact');
});

test('acknowledged, voided and timed volunteer history blocks rather than mutating retained identity',async t=>{
 for(const history of ['acknowledged','voided','volunteer']){
  const f=await fixture(t),fund=(await f.workspace()).designations[0];let protectedId,protectedCollection;
  if(history==='volunteer'){const v=await f.create('volunteers',{constituentId:f.source.id,hours:2});protectedId=v.id;protectedCollection='volunteers';}
  else{const g=await f.create('gifts',gift(f.source,fund));protectedId=g.id;protectedCollection='gifts';const path=history==='acknowledged'?`/api/gifts/${g.id}/acknowledge`:`/api/gifts/${g.id}/void`;const body=history==='acknowledged'?{version:1,date:'2026-09-13',channel:'Email',notes:'Completed manual acknowledgment'}:{version:1,reason:'Duplicate'};assert.equal((await f.request(path,{method:'POST',session:f.admin,body})).status,200);}
  const before=await f.workspace(),body=await f.pair(),p=await f.preview(body);assert.ok(p.json.preview.blockers.length,history);assert.equal((await f.commit(body)).status,409);assert.deepEqual(await f.workspace(),before);assert.ok(before[protectedCollection].some(r=>r.id===protectedId));
 }
});

test('parent conflicts require explicit resolution and cycle selections remain blocked',async t=>{
 const f=await fixture(t),parent=await f.create('constituents',{name:'Parent organization',type:'Business'});
 assert.equal((await f.request(`/api/records/constituents/${f.source.id}`,{method:'PATCH',session:f.admin,body:{version:1,parentId:parent.id}})).status,200);
 let body=await f.pair(),p=await f.preview(body);assert.ok(p.json.preview.blockers.some(b=>/explicit parentId/.test(b.reason)));
 p=await f.preview({...body,parentId:f.source.id});assert.ok(p.json.preview.blockers.some(b=>/cycle/.test(b.reason)));
 const merged=await f.commit({...body,parentId:parent.id});assert.equal(merged.status,200);assert.equal(merged.json.target.parentId,parent.id);
});

test('managed household membership is atomic, versioned, personal-only and resettable',async t=>{
 const f=await fixture(t),body=household([f.target.id,f.source.id]);
 for(const session of [f.staff,f.viewer])assert.equal((await f.request('/api/households',{method:'POST',session,body})).status,403);assert.equal((await f.request('/api/households',{method:'POST',session:f.admin,csrf:false,body})).status,403);
 const created=await f.request('/api/households',{method:'POST',session:f.admin,body});assert.equal(created.status,201,JSON.stringify(created.json));const h=created.json.household;assert.equal(h.version,1);assert.deepEqual(new Set(h.memberIds),new Set(body.memberIds));
 let data=await f.workspace();for(const id of body.memberIds)assert.equal(data.constituents.find(c=>c.id===id).household,h.name);
 assert.equal((await f.request('/api/households',{session:f.viewer})).json.households[0].id,h.id);
 assert.equal((await f.request('/api/households',{method:'POST',session:f.admin,body:household([f.target.id],{name:'Other household'})})).status,409);
 assert.equal((await f.request(`/api/records/constituents/${f.target.id}`,{method:'PATCH',session:f.admin,body:{version:2,household:'Bypass'}})).status,409);
 assert.equal((await f.request(`/api/records/constituents/${f.target.id}`,{method:'DELETE',session:f.admin,body:{version:2}})).status,409);
 assert.equal((await f.request(`/api/households/${h.id}`,{method:'PATCH',session:f.admin,body:{...body,version:99}})).status,409);
 const before=await f.workspace();const update=await f.request(`/api/households/${h.id}`,{method:'PATCH',session:f.admin,body:{...household([f.target.id],{name:'Renamed family'}),version:1}});assert.equal(update.status,200);data=await f.workspace();assert.equal(data.constituents.find(c=>c.id===f.target.id).household,'Renamed family');assert.equal(data.constituents.find(c=>c.id===f.source.id).household,'');assert.deepEqual(data.gifts,before.gifts);
 const reset=await f.request(`/api/households/${h.id}`,{method:'PATCH',session:f.admin,body:{...household([],{name:'Renamed family'}),version:2}});assert.equal(reset.status,200);assert.equal((await f.workspace()).constituents.find(c=>c.id===f.target.id).household,'');
 const business=await f.create('constituents',{name:'Not a household member',type:'Business'});assert.equal((await f.request('/api/households',{method:'POST',session:f.admin,body:household([business.id],{name:'Invalid family'})})).status,400);
 assert.equal((await f.request('/api/households',{method:'POST',session:f.admin,body:household([f.target.id,f.target.id],{name:'Repeated family'})})).status,400);
});

test('household merge and recognition conserve unique gifts and persist membership and source snapshot',async t=>{
 const f=await fixture(t),fund=(await f.workspace()).designations[0],g=await f.create('gifts',gift(f.source,fund,{softCreditId:f.target.id}));
 const created=await f.request('/api/households',{method:'POST',session:f.admin,body:household([f.target.id,f.source.id])});assert.equal(created.status,201);const h=created.json.household;
 const before=await f.workspace(),report=recognitionReport({...before,gifts:[g]},{report:'Household rollup'});assert.equal(report.groups[0].gifts,1);assert.equal(report.groups[0].directMonetary,25000);assert.equal(report.groups[0].softMonetary,0);
 assert.equal((await f.commit(await f.pair())).status,200);const after=await f.workspace();const recognition=recognitionReport({...after,gifts:after.gifts.filter(gift=>gift.id===g.id)},{report:'Household rollup'});assert.equal(recognition.groups[0].gifts,1);assert.equal(recognition.groups[0].directMonetary,25000);
 await f.restart();assert.deepEqual(await f.workspace(),after);const saved=(await f.request('/api/households',{session:f.admin})).json.households.find(x=>x.id===h.id);assert.deepEqual(saved.memberIds,[f.target.id]);assert.equal(saved.version,2);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,1);
});

test('retained reservations and checked-in attendance block merges with named evidence',async t=>{
 for(const kind of ['reservation','attendance']){
  const f=await fixture(t);
  if(kind==='reservation'){
   const shift=await f.create('volunteerShifts',{name:'Volunteer service',date:'2026-10-01',startTime:'10:00',endTime:'11:00',capacity:5});
   await f.create('shiftReservations',{shiftId:shift.id,constituentId:f.source.id,status:'Reserved'});
  }else{
   const event=await f.create('events',{name:'Attendance evidence',date:'2026-10-01',location:'Hall',capacity:5});
   for(const action of ['register','checkin'])assert.equal((await f.request(`/api/events/${event.id}/${action}`,{method:'POST',session:f.admin,body:{constituentId:f.source.id}})).status,200);
  }
  const before=await f.workspace(),body=await f.pair(),p=await f.preview(body);assert.ok(p.json.preview.blockers.some(b=>b.collection===(kind==='reservation'?'shiftReservations':'events')));assert.equal((await f.commit(body)).status,409);assert.deepEqual(await f.workspace(),before);
 }
});

test('distinct household memberships and constituent types cannot be silently combined',async t=>{
 const f=await fixture(t);
 for(const [person,name] of [[f.target,'Target family'],[f.source,'Source family']])assert.equal((await f.request('/api/households',{method:'POST',session:f.admin,body:household([person.id],{name})})).status,201);
 let body=await f.pair(),p=await f.preview(body);assert.ok(p.json.preview.blockers.some(b=>/different managed household/.test(b.reason)));assert.equal((await f.commit(body)).status,409);
 const before=await f.workspace();assert.equal((await f.request(`/api/records/constituents/${f.target.id}`,{method:'PATCH',session:f.admin,body:{version:2,type:'Business'}})).status,409);assert.deepEqual(await f.workspace(),before);
 const business=await f.create('constituents',{name:'Business identity',type:'Business'});p=await f.preview({...body,targetId:business.id,targetVersion:1});assert.ok(p.json.preview.blockers.some(b=>/Different constituent types/.test(b.reason)));
});

test('a survivor with existing retained aliases cannot form an unsupported alias chain',async t=>{
 const f=await fixture(t);assert.equal((await f.commit(await f.pair())).status,200);
 const other=await f.create('constituents',{name:'Another canonical identity',type:'Individual'}),before=await f.workspace(),survivor=before.constituents.find(c=>c.id===f.target.id);
 const body={targetId:other.id,sourceId:survivor.id,targetVersion:1,sourceVersion:survivor.version,reason:'Proposed second canonical merge'};
 const p=await f.preview(body);assert.ok(p.json.preview.blockers.some(b=>/already has retained aliases/.test(b.reason)));assert.equal((await f.commit(body)).status,409);assert.deepEqual(await f.workspace(),before);
});


test('an otherwise unreferenced merge survivor cannot be deleted or leave retained aliases orphaned after restart',async t=>{
 const f=await fixture(t),result=await f.commit(await f.pair());assert.equal(result.status,200);
 const denied=await f.request('/api/records/constituents/'+f.target.id,{method:'DELETE',session:f.admin,body:{version:result.json.target.version}});assert.equal(denied.status,409);assert.match(denied.json.error,/retained merged identities/);
 await f.restart();const current=await f.workspace();assert.equal(current.constituents.find(p=>p.id===f.source.id).mergedInto,f.target.id);assert.ok(current.constituents.some(p=>p.id===f.target.id));
 const aliases=await f.request('/api/identity/aliases',{session:f.admin});assert.equal(aliases.status,200);assert.equal(aliases.json.aliases.find(a=>a.sourceId===f.source.id).targetId,f.target.id);
 assert.equal((await f.request('/api/records/constituents/'+f.target.id,{method:'DELETE',session:f.admin,body:{version:result.json.target.version}})).status,409);
});
