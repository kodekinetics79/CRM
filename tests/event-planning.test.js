import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const START=Date.parse('2026-09-13T12:00:00.000Z');

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-event-planning-'));
 let app,server,base,tenantActive=true,time=START;
 async function open(){
  app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',isTenantActive:()=>tenantActive,extensions:{eventPlanning:{worker:false,clock:()=>time},volunteerPortal:{worker:false,clock:()=>time}}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 }
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:r.status,json:await r.json().catch(()=>({}))};
 }
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};
 }
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function record(collection,body,session=staff){const r=await request('/records/'+collection,{method:'POST',session,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const event=(changes={})=>record('events',{name:'Spring benefit',date:'2026-11-14',location:'Synthetic hall',capacity:120,ticketPrice:0,sponsorGoal:0,notes:'',...changes});
 async function account(name,email,role='staff'){
  const r=await request('/users',{method:'POST',session:admin,body:{name,email,password:'SyntheticStaff!2026',role}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.user;
 }
 const users=async()=>(await request('/users',{session:admin})).json.users;
 return {request,record,event,account,users,login,admin,staff,viewer,
  advance:ms=>{time+=ms;},at:()=>time,
  run:()=>app.locals.extensions.services.eventPlanning.runTaskFollowUp(time),
  suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},
  restart:async()=>{await close();await open();},
  get db(){return app.locals.db;}};
}

test('planning reads allow board viewers, but every change needs staff access and CSRF',async t=>{
 const f=await fixture(t),e=await f.event();
 assert.equal((await f.request('/event-planning')).status,401);
 assert.equal((await f.request('/event-planning',{session:f.viewer})).status,200);
 assert.equal((await f.request('/event-planning',{session:f.viewer})).json.canWrite,false);
 assert.equal((await f.request('/event-planning',{session:f.staff})).json.canWrite,true);
 const body={eventId:e.id,eventVersion:e.version,name:'Run of show',templateKey:null};
 assert.equal((await f.request('/event-planning/checklists',{method:'POST',session:f.viewer,body})).status,403);
 assert.equal((await f.request('/event-planning/checklists',{method:'POST',session:f.staff,csrf:false,body})).status,403);
 assert.equal((await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{...body,eventVersion:e.version+1}})).status,409);
 for(const invalid of [{...body,name:''},{...body,templateKey:'unknown-template'},{...body,extra:true}])
  assert.equal((await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:invalid})).status,400,JSON.stringify(invalid));
 const created=await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body});
 assert.equal(created.status,201,JSON.stringify(created.json));
 assert.equal(created.json.checklist.name,'Run of show');
 assert.deepEqual(created.json.items,[]);
});

test('a template creates dated responsibilities that the event then owns',async t=>{
 const f=await fixture(t),e=await f.event({date:'2026-11-14'});
 const created=await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,name:'Dinner plan',templateKey:'fundraising-dinner'}});
 assert.equal(created.status,201,JSON.stringify(created.json));
 assert.equal(created.json.items.length,6);
 assert.equal(created.json.items[0].title,'Confirm venue contract and insurance');
 assert.equal(created.json.items[0].dueDate,'2026-09-30');
 assert.equal(created.json.items.at(-1).dueDate,'2026-11-17');
 assert.ok(created.json.items.every(item=>item.status==='Open'&&item.assignee===null&&item.unresolved));
 const overview=(await f.request('/event-planning?eventId='+e.id,{session:f.staff})).json;
 assert.equal(overview.unresolved.length,6);
 assert.deepEqual(overview.templates.map(x=>x.key).sort(),['fundraising-dinner','school-celebration','volunteer-day']);
 const history=(await f.request('/event-planning/items/'+created.json.items[0].id,{session:f.staff})).json.history;
 assert.equal(history[0].action,'Created from template');
 assert.throws(()=>f.db.prepare('UPDATE event_plan_item_history SET reason=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM event_plan_items').run());
});

test('assignment pins the account version and a changed authority reopens the responsibility',async t=>{
 const f=await fixture(t),e=await f.event();
 const checklist=(await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,name:'Volunteer plan',templateKey:null}})).json.checklist;
 const helper=await f.account('Synthetic Coordinator','coordinator@foundation.example','staff');
 const board=(await f.users()).find(u=>u.role==='viewer');
 const add=await f.request('/event-planning/checklists/'+checklist.id+'/items',{method:'POST',session:f.staff,body:{version:checklist.version,title:'Confirm supply pickup',detail:'',dueDate:'2026-11-01',assigneeId:null,assigneeVersion:null}});
 assert.equal(add.status,201,JSON.stringify(add.json));
 const item=add.json.item;
 assert.equal(item.unresolved,true);
 assert.deepEqual(item.unresolvedReasons,['No one is responsible yet']);
 assert.equal((await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:item.version,assigneeId:board.id,assigneeVersion:board.version,reason:'Viewers cannot own work'}})).status,400);
 assert.equal((await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:item.version,assigneeId:helper.id,assigneeVersion:helper.version+3,reason:'Stale account version'}})).status,409);
 assert.equal((await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:item.version+9,assigneeId:helper.id,assigneeVersion:helper.version,reason:'Stale item version'}})).status,409);
 const assigned=await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:item.version,assigneeId:helper.id,assigneeVersion:helper.version,reason:'Coordinator owns supplies'}});
 assert.equal(assigned.status,200,JSON.stringify(assigned.json));
 assert.equal(assigned.json.item.assignee.id,helper.id);
 assert.equal(assigned.json.item.unresolved,false);
 const suspended=await f.request('/users/'+helper.id,{method:'PATCH',session:f.admin,body:{version:helper.version,role:'staff',active:false}});
 assert.equal(suspended.status,200,JSON.stringify(suspended.json));
 const after=(await f.request('/event-planning/unresolved?eventId='+e.id,{session:f.staff})).json;
 assert.equal(after.unresolved.length,1);
 assert.equal(after.counts.changedAuthority,1);
 assert.match(after.unresolved[0].unresolvedReasons.join(' '),/no longer active staff/);
 assert.equal(after.unresolved[0].assignmentCurrent,false);
});

test('completion needs a recorded owner and completed work is retained as recorded',async t=>{
 const f=await fixture(t),e=await f.event();
 const checklist=(await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,name:'Setup',templateKey:null}})).json.checklist;
 let item=(await f.request('/event-planning/checklists/'+checklist.id+'/items',{method:'POST',session:f.staff,body:{version:checklist.version,title:'Confirm chairs',detail:'Ten rows',dueDate:'2026-11-10',assigneeId:null,assigneeVersion:null}})).json.item;
 assert.equal((await f.request('/event-planning/items/'+item.id+'/status',{method:'POST',session:f.staff,body:{version:item.version,status:'Done',reason:'No owner recorded'}})).status,409);
 const owner=(await f.request('/event-planning',{session:f.staff})).json.assignableUsers.find(u=>u.id===f.staff.user.id);
 item=(await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:item.version,assigneeId:owner.id,assigneeVersion:owner.version,reason:'Staff owns setup'}})).json.item;
 const progressed=await f.request('/event-planning/items/'+item.id+'/status',{method:'POST',session:f.staff,body:{version:item.version,status:'In progress',reason:'Chairs ordered'}});
 assert.equal(progressed.status,200);
 item=progressed.json.item;
 assert.equal((await f.request('/event-planning/items/'+item.id+'/status',{method:'POST',session:f.staff,body:{version:item.version,status:'In progress',reason:'Same status'}})).status,409);
 const done=await f.request('/event-planning/items/'+item.id+'/status',{method:'POST',session:f.staff,body:{version:item.version,status:'Done',reason:'Chairs delivered and counted'}});
 assert.equal(done.status,200);
 assert.equal(done.json.item.unresolved,false);
 assert.deepEqual(done.json.item.unresolvedReasons,[]);
 assert.equal((await f.request('/event-planning/items/'+item.id,{method:'PATCH',session:f.staff,body:{version:done.json.item.version,title:'Rewrite history',detail:'',dueDate:'2026-11-10',reason:'Not allowed'}})).status,409);
 assert.equal((await f.request('/event-planning/items/'+item.id+'/assign',{method:'POST',session:f.staff,body:{version:done.json.item.version,assigneeId:null,assigneeVersion:null,reason:'Not allowed'}})).status,409);
 const history=(await f.request('/event-planning/items/'+item.id,{session:f.staff})).json.history;
 assert.deepEqual(history.map(h=>h.action),['Created','Assigned','Status In progress','Status Done']);
 assert.equal(history.at(-1).reason,'Chairs delivered and counted');
});

test('overdue open work is unresolved, and planning amounts never create revenue',async t=>{
 const f=await fixture(t),e=await f.event();
 const financial=()=>f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();
 const before=financial();
 const checklist=(await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,name:'Budget review',templateKey:null}})).json.checklist;
 const owner=(await f.request('/event-planning',{session:f.staff})).json.assignableUsers[0];
 const item=(await f.request('/event-planning/checklists/'+checklist.id+'/items',{method:'POST',session:f.staff,body:{version:checklist.version,title:'Book caterer',detail:'',dueDate:'2026-09-12',assigneeId:owner.id,assigneeVersion:owner.version}})).json.item;
 assert.equal(item.overdue,true);
 assert.deepEqual(item.unresolvedReasons,['The agreed date has passed']);
 for(const invalid of [{plannedCents:12.5},{plannedCents:-1},{kind:'Gift'}])
  assert.equal((await f.request('/event-planning/budget-lines',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,kind:'Expense estimate',category:'Catering',description:'',plannedCents:100,...invalid}})).status,400,JSON.stringify(invalid));
 const expense=await f.request('/event-planning/budget-lines',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,kind:'Expense estimate',category:'Catering',description:'Plated dinner estimate',plannedCents:450075}});
 assert.equal(expense.status,201,JSON.stringify(expense.json));
 assert.equal(expense.json.budgetLine.plannedCents,450075);
 assert.match(expense.json.budgetLine.meaning,/No gift, pledge, receipt/);
 await f.request('/event-planning/budget-lines',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,kind:'Income estimate',category:'Tickets',description:'Estimated ticket income',plannedCents:800000}});
 const overview=(await f.request('/event-planning?eventId='+e.id,{session:f.staff})).json;
 assert.deepEqual(overview.budgetTotals,{expenseEstimate:450075,incomeEstimate:800000,currency:'USD',meaning:overview.budgetTotals.meaning});
 assert.deepEqual(financial(),before,'planning never posts, changes or duplicates revenue');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='pledges'").get().n,1);
});

test('vendors are a planning list, never a constituent identity or an agreement',async t=>{
 const f=await fixture(t),e=await f.event();
 const constituents=()=>f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='constituents'").get().n;
 const before=constituents();
 const body={eventId:e.id,eventVersion:e.version,name:'Synthetic Catering Co',service:'Catering',contactName:'Robin Vendor',contactEmail:'robin@vendor.test',phone:'555-0100',status:'Considering',notes:'Quote requested'};
 assert.equal((await f.request('/event-planning/vendors',{method:'POST',session:f.viewer,body})).status,403);
 assert.equal((await f.request('/event-planning/vendors',{method:'POST',session:f.staff,body:{...body,contactEmail:'not-an-email'}})).status,400);
 assert.equal((await f.request('/event-planning/vendors',{method:'POST',session:f.staff,body:{...body,status:'Paid'}})).status,400);
 const created=await f.request('/event-planning/vendors',{method:'POST',session:f.staff,body});
 assert.equal(created.status,201,JSON.stringify(created.json));
 assert.equal(constituents(),before,'a vendor is never created as a constituent identity');
 const {eventId,eventVersion,...fields}=body;
 const confirmed=await f.request('/event-planning/vendors/'+created.json.vendor.id,{method:'PATCH',session:f.staff,body:{...fields,version:1,status:'Confirmed'}});
 assert.equal(confirmed.status,200,JSON.stringify(confirmed.json));
 assert.equal(confirmed.json.vendor.status,'Confirmed');
 assert.equal((await f.request('/event-planning/vendors/'+created.json.vendor.id,{method:'PATCH',session:f.staff,body:{...fields,version:1,status:'Declined'}})).status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts' AND json_extract(data,'$.notes') LIKE '%Vendor%'").get().n,0);
});

test('planning history survives a restart and protects its event from deletion',async t=>{
 const f=await fixture(t),e=await f.event();
 const checklist=(await f.request('/event-planning/checklists',{method:'POST',session:f.staff,body:{eventId:e.id,eventVersion:e.version,name:'Dinner plan',templateKey:'volunteer-day'}})).json.checklist;
 assert.equal((await f.request('/records/events/'+e.id,{method:'DELETE',session:f.staff,body:{version:e.version}})).status,409);
 await f.restart();
 const fresh=await f.login('staff@foundation.example');
 const overview=(await f.request('/event-planning?eventId='+e.id,{session:fresh})).json;
 assert.equal(overview.checklists.length,1);
 assert.equal(overview.checklists[0].id,checklist.id);
 assert.equal(overview.items.length,5);
 assert.equal(overview.unresolved.length,5);
 assert.throws(()=>f.db.prepare('DELETE FROM event_plan_checklists').run());
});
