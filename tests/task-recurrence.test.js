import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const START=Date.parse('2026-09-13T12:00:00.000Z');

async function fixture(t,{outbox=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-task-recurrence-'));
 let app,server,base,tenantActive=true,time=START;
 const prepared=[];let response={accepted:true,reference:'fake-outbox'},faulty=false;
 const planning={worker:false,clock:()=>time,...(outbox?{sendReminder:envelope=>{prepared.push(envelope);if(faulty)throw new Error('Synthetic outbox fault');return response;}}:{})};
 async function open(){
  app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',isTenantActive:()=>tenantActive,reminderWorker:false,reminderClock:()=>time,extensions:{eventPlanning:planning,volunteerPortal:{worker:false,clock:()=>time}}});
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
 async function task(session=staff,changes={}){
  const r=await request('/records/tasks',{method:'POST',session,body:{title:'Weekly pantry restock',dueDate:'2026-09-14',status:'Open',ownerId:session.user.id,notes:'Synthetic recurring work',...changes}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;
 }
 async function complete(record,session=staff){
  const r=await request('/records/tasks/'+record.id,{method:'PATCH',session,body:{version:record.version,status:'Completed'}});
  assert.equal(r.status,200,JSON.stringify(r.json));return r.json.record;
 }
 const accountVersion=id=>app.locals.db.prepare('SELECT version FROM users WHERE id=?').get(id).version;
 async function account(name,email,role='staff'){
  const r=await request('/users',{method:'POST',session:admin,body:{name,email,password:'SyntheticStaff!2026',role}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.user;
 }
 const tasks=()=>app.locals.db.prepare("SELECT id,json_extract(data,'$.title') title,json_extract(data,'$.dueDate') due,json_extract(data,'$.status') status FROM records WHERE collection='tasks' ORDER BY json_extract(data,'$.createdAt'),id").all();
 return {request,login,admin,staff,viewer,task,complete,account,accountVersion,tasks,prepared,
  set outbox(value){response=value;},set fault(value){faulty=value;},
  advance:ms=>{time+=ms;},at:()=>time,set now(value){time=value;},
  run:()=>app.locals.extensions.services.eventPlanning.runTaskFollowUp(time),
  suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},
  restart:async()=>{await close();await open();},
  get db(){return app.locals.db;}};
}

test('recurrence needs staff access, CSRF, an owned task and exact current versions',async t=>{
 const f=await fixture(t),record=await f.task();
 const body={taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Weekly',intervalCount:1,occurrences:3};
 assert.equal((await f.request('/task-recurrence')).status,401);
 assert.equal((await f.request('/task-recurrence',{session:f.viewer})).status,403);
 assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.viewer,body})).status,403);
 assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.staff,csrf:false,body})).status,403);
 for(const invalid of [{...body,taskVersion:99},{...body,ownerVersion:99}])
  assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.staff,body:invalid})).status,409,JSON.stringify(invalid));
 for(const invalid of [{...body,cadence:'Hourly'},{...body,intervalCount:0},{...body,occurrences:0},{...body,occurrences:600},{...body,extra:true}])
  assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.staff,body:invalid})).status,400,JSON.stringify(invalid));
 const created=await f.request('/task-recurrence',{method:'POST',session:f.staff,body});
 assert.equal(created.status,201,JSON.stringify(created.json));
 assert.equal(created.json.recurrence.nextDue,'2026-09-21');
 assert.equal(created.json.recurrence.remaining,3);
 assert.deepEqual(created.json.recurrence.occurrences.map(o=>o.sequence),[0]);
 assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.staff,body})).status,409);
 const done=await f.complete(record);
 assert.equal((await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{...body,taskId:done.id,taskVersion:done.version}})).status,409);
});

test('a completed occurrence creates exactly one dated follow-up until the schedule is used up',async t=>{
 const f=await fixture(t);let record=await f.task(f.staff,{dueDate:'2026-09-14',title:'Weekly pantry restock'});
 const created=await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Weekly',intervalCount:1,occurrences:2}});
 assert.equal(created.status,201);
 assert.deepEqual(f.run(),{created:0,recurrencesClosed:0,escalated:0,escalationsClosed:0,failed:0,suspended:false},'an open task never repeats early');
 record=await f.complete(record);
 assert.equal(f.run().created,1);
 assert.equal(f.run().created,0,'one completion creates exactly one follow-up');
 let listed=(await f.request('/task-recurrence',{session:f.staff})).json.recurrences[0];
 assert.equal(listed.remaining,1);
 assert.deepEqual(listed.occurrences.map(o=>o.dueDate),['2026-09-14','2026-09-21']);
 const second=f.tasks().find(x=>x.due==='2026-09-21');
 assert.equal(second.status,'Open');
 assert.equal(second.title,'Weekly pantry restock');
 const secondRecord=(await f.request('/workspace',{session:f.staff})).json.data.tasks.find(x=>x.id===second.id);
 assert.equal(secondRecord.ownerId,f.staff.user.id);
 await f.complete(secondRecord);
 const final=f.run();
 assert.equal(final.created,1);assert.equal(final.recurrencesClosed,1);
 listed=(await f.request('/task-recurrence',{session:f.staff})).json.recurrences[0];
 assert.equal(listed.status,'Completed');
 assert.deepEqual(listed.occurrences.map(o=>o.dueDate),['2026-09-14','2026-09-21','2026-09-28']);
 assert.equal(f.run().created,0);
 assert.throws(()=>f.db.prepare('UPDATE task_recurrence_occurrences SET due_date=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM task_recurrence_occurrences').run());
});

test('monthly recurrence clamps a short month and never drifts past the end of it',async t=>{
 const f=await fixture(t);let record=await f.task(f.staff,{dueDate:'2026-01-31',title:'Monthly reconciliation'});
 await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Monthly',intervalCount:1,occurrences:2}});
 record=await f.complete(record);
 assert.equal(f.run().created,1);
 const next=f.tasks().find(x=>x.title==='Monthly reconciliation'&&x.due!=='2026-01-31');
 assert.equal(next.due,'2026-02-28');
});

test('a changed owner account or a reassignment stops the recurrence instead of retargeting it',async t=>{
 for(const [label,change] of [['account version',async f=>{f.db.prepare('UPDATE users SET version=version+1 WHERE id=?').run(f.staff.user.id);}],
  ['reassignment',async f=>{const record=f.db.prepare("SELECT id,data FROM records WHERE collection='tasks' AND json_extract(data,'$.title')='Reassigned work'").get();const next={...JSON.parse(record.data),ownerId:f.admin.user.id};f.db.prepare("UPDATE records SET data=? WHERE collection='tasks' AND id=?").run(JSON.stringify(next),record.id);}]]){
  const f=await fixture(t);
  let record=await f.task(f.staff,{title:label==='reassignment'?'Reassigned work':'Owned work'});
  await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Daily',intervalCount:1,occurrences:5}});
  record=await f.complete(record);
  const before=f.tasks().length;
  await change(f);
  const run=f.run();
  assert.equal(run.created,0,label);
  assert.equal(run.recurrencesClosed,1,label);
  assert.equal(f.tasks().length,before,label);
  const listed=(await f.request('/task-recurrence',{session:f.admin})).json.recurrences[0];
  assert.equal(listed.status,'Suppressed',label);
 }
});

test('cancellation is versioned, terminal and keeps the created occurrences',async t=>{
 const f=await fixture(t),record=await f.task();
 const created=(await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Weekly',intervalCount:1,occurrences:4}})).json.recurrence;
 const path='/task-recurrence/'+created.id+'/cancel';
 assert.equal((await f.request(path,{method:'POST',session:f.viewer,body:{version:1,reason:'Denied'}})).status,403);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:{version:9,reason:'Stale'}})).status,409);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:{version:1,reason:' '}})).status,400);
 const cancelled=await f.request(path,{method:'POST',session:f.staff,body:{version:1,reason:'Programme ended'}});
 assert.equal(cancelled.status,200);
 assert.equal(cancelled.json.recurrence.status,'Cancelled');
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:{version:2,reason:'Repeat'}})).status,409);
 await f.complete(record);
 assert.equal(f.run().created,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_recurrence_occurrences').get().n,1);
 assert.equal((await f.request('/records/tasks/'+record.id,{method:'DELETE',session:f.staff,body:{version:2}})).status,409);
});

test('escalation prepares once after the agreed delay and never claims delivery',async t=>{
 const f=await fixture(t),record=await f.task(f.staff,{dueDate:'2026-09-14'});
 const other=await f.account('Synthetic Escalation Contact','escalation@foundation.example','staff');
 const body={taskId:record.id,taskVersion:record.version,afterMinutes:120,escalateToId:other.id,escalateToVersion:other.version};
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.viewer,body})).status,403);
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,csrf:false,body})).status,403);
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,body:{...body,escalateToId:f.staff.user.id,escalateToVersion:f.accountVersion(f.staff.user.id)}})).status,400);
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,body:{...body,escalateToVersion:other.version+4}})).status,409);
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,body:{...body,taskVersion:99}})).status,409);
 const armed=await f.request('/task-escalations',{method:'POST',session:f.staff,body});
 assert.equal(armed.status,201,JSON.stringify(armed.json));
 assert.equal(armed.json.escalation.status,'Armed');
 assert.equal(armed.json.escalation.prepared,false);
 assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,body})).status,409);
 f.now=Date.parse('2026-09-15T00:30:00.000Z');
 assert.equal(f.run().escalated,0,'the agreed delay has not passed');
 assert.equal(f.prepared.length,0);
 f.now=Date.parse('2026-09-15T02:30:00.000Z');
 const run=f.run();
 assert.equal(run.escalated,1);
 assert.equal(f.run().escalated,0,'escalation is prepared exactly once');
 assert.equal(f.prepared.length,1);
 assert.deepEqual(Object.keys(f.prepared[0]).sort(),['afterMinutes','delivery','dueDate','escalateToId','escalationId','kind','ownerId','preparedAt','taskId']);
 assert.match(f.prepared[0].delivery,/not performed, confirmed or claimed/);
 const listed=(await f.request('/task-escalations',{session:f.staff})).json;
 assert.equal(listed.escalations[0].status,'Escalated');
 assert.equal(listed.escalations[0].prepared,true);
 assert.match(listed.delivery,/not performed/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_escalation_notices').get().n,1);
 assert.throws(()=>f.db.prepare('UPDATE task_escalation_notices SET prepared_at=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM task_escalation_notices').run());
 assert.equal(f.tasks().find(x=>x.id===record.id).status,'Open','escalation never reassigns or completes the task');
});

test('completion resolves an armed escalation and a changed escalation account suppresses it',async t=>{
 const f=await fixture(t),resolved=await f.task(f.staff,{dueDate:'2026-09-14',title:'Resolved work'}),suppressed=await f.task(f.staff,{dueDate:'2026-09-14',title:'Suppressed work'});
 const contact=await f.account('Synthetic Escalation Contact','escalation@foundation.example','staff');
 for(const record of [resolved,suppressed])assert.equal((await f.request('/task-escalations',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,afterMinutes:0,escalateToId:contact.id,escalateToVersion:contact.version}})).status,201);
 await f.complete(resolved);
 assert.equal((await f.request('/users/'+contact.id,{method:'PATCH',session:f.admin,body:{version:contact.version,role:'viewer',active:true}})).status,200);
 f.now=Date.parse('2026-09-15T02:30:00.000Z');
 const run=f.run();
 assert.equal(run.escalated,0);
 assert.equal(run.escalationsClosed,2);
 assert.equal(f.prepared.length,0);
 const listed=(await f.request('/task-escalations',{session:f.admin})).json.escalations;
 assert.equal(listed.find(e=>e.taskId===resolved.id).status,'Resolved');
 assert.equal(listed.find(e=>e.taskId===suppressed.id).status,'Suppressed');
 assert.match(listed.find(e=>e.taskId===suppressed.id).lastOutcome.reason,/Escalation account changed/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_escalation_notices').get().n,0);
 assert.throws(()=>f.db.prepare('UPDATE task_escalation_outcomes SET reason=?').run('tamper'));
});

test('a failing outbox prepares nothing, retries with bounds and never touches financial records',async t=>{
 const f=await fixture(t),record=await f.task(f.staff,{dueDate:'2026-09-14'});
 const contact=await f.account('Synthetic Escalation Contact','escalation@foundation.example','staff');
 await f.request('/task-escalations',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,afterMinutes:0,escalateToId:contact.id,escalateToVersion:contact.version}});
 const financial=f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();
 f.fault=true;f.now=Date.parse('2026-09-15T02:30:00.000Z');
 for(let attempt=1;attempt<=5;attempt++){
  f.advance(60000);
  const run=f.run();
  assert.equal(run.failed,1,'attempt '+attempt);
  assert.equal(run.escalated,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_escalation_notices').get().n,0);
 }
 const row=f.db.prepare('SELECT * FROM task_escalations').get();
 assert.equal(row.status,'Suppressed');
 assert.equal(row.attempt_count,5);
 assert.match(f.db.prepare('SELECT reason FROM task_escalation_outcomes ORDER BY rowid DESC LIMIT 1').get().reason,/Retry limit/);
 assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all(),financial);
 assert.equal(f.tasks().find(x=>x.id===record.id).status,'Open');
});

test('suspension closes follow-up work, reinstatement never resumes it, and restart keeps history',async t=>{
 const f=await fixture(t);let record=await f.task(f.staff,{dueDate:'2026-09-14'});
 const contact=await f.account('Synthetic Escalation Contact','escalation@foundation.example','staff');
 await f.request('/task-recurrence',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,ownerVersion:f.accountVersion(f.staff.user.id),cadence:'Daily',intervalCount:1,occurrences:3}});
 await f.request('/task-escalations',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,afterMinutes:0,escalateToId:contact.id,escalateToVersion:contact.version}});
 f.suspend();
 assert.equal((await f.request('/task-recurrence',{session:f.staff})).status,403);
 assert.equal((await f.request('/task-escalations',{session:f.staff})).status,403);
 const run=f.run();
 assert.equal(run.suspended,true);
 assert.equal(run.recurrencesClosed,1);
 assert.equal(run.escalationsClosed,1);
 assert.equal(f.prepared.length,0);
 f.resume();f.now=Date.parse('2026-09-16T02:30:00.000Z');
 record=await f.complete((await f.request('/workspace',{session:f.staff})).json.data.tasks.find(x=>x.id===record.id));
 const after=f.run();
 assert.equal(after.created,0,'reinstatement never resumes suppressed follow-up');
 assert.equal(after.escalated,0);
 await f.restart();
 const fresh=await f.login('staff@foundation.example');
 assert.equal((await f.request('/task-recurrence',{session:fresh})).json.recurrences[0].status,'Suppressed');
 assert.equal((await f.request('/task-escalations',{session:fresh})).json.escalations[0].status,'Suppressed');
 assert.equal(f.run().created,0);
});

test('with no injected outbox escalation stays internal only and contacts nothing',async t=>{
 const f=await fixture(t,{outbox:false}),record=await f.task(f.staff,{dueDate:'2026-09-14'});
 const contact=await f.account('Synthetic Escalation Contact','escalation@foundation.example','staff');
 await f.request('/task-escalations',{method:'POST',session:f.staff,body:{taskId:record.id,taskVersion:record.version,afterMinutes:0,escalateToId:contact.id,escalateToVersion:contact.version}});
 f.now=Date.parse('2026-09-15T02:30:00.000Z');
 assert.equal(f.run().escalated,1);
 assert.equal(f.db.prepare('SELECT outbox_reference FROM task_escalation_notices').get().outbox_reference,'internal-only');
 assert.equal(f.prepared.length,0);
});
