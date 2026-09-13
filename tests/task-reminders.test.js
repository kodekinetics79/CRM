import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-task-reminders-'));let app,server,base,tenantActive=true,time=Date.parse('2026-09-13T12:00:00.000Z');
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',isTenantActive:()=>tenantActive,reminderClock:()=>time,reminderWorker:false});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 const ownerVersion=session=>app.locals.db.prepare('SELECT version FROM users WHERE id=?').get(session.user.id).version;
 async function task(session=staff,changes={}){const r=await request('/records/tasks',{session,method:'POST',body:{title:'PRIVATE_TASK_TITLE',dueDate:'2026-09-13',status:'Open',ownerId:session.user.id,notes:'PRIVATE_TASK_NOTES',...changes}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 async function reminder(task,session=staff,changes={}){return request('/tasks/'+task.id+'/reminders',{method:'POST',session,body:{taskVersion:task.version,ownerVersion:ownerVersion(session),remindAt:new Date(time+60000).toISOString(),...changes}});}
 async function editTask(task,changes){const r=await request('/records/tasks/'+task.id,{method:'PATCH',session:staff,body:{version:task.version,...changes}});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.record;}
 return {request,login,admin,staff,viewer,task,reminder,editTask,ownerVersion,advance:ms=>{time+=ms;},run:()=>app.locals.runDueReminders(time),suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},suppress:()=>app.locals.suppressTaskReminders(time),restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('reminders require exact current versions, UTC range, active task owner and CSRF',async t=>{
 const f=await fixture(t),task=await f.task();
 assert.equal((await f.request('/task-reminders')).status,401);assert.equal((await f.reminder(task,f.viewer)).status,403);assert.equal((await f.reminder(task,f.admin)).status,403);
 for(const changes of [{taskVersion:2},{ownerVersion:2}])assert.equal((await f.reminder(task,f.staff,changes)).status,409);
 for(const changes of [{remindAt:'2026-09-13T12:01:00'},{remindAt:'2026-09-13T13:01:00+01:00'},{remindAt:'2026-09-12T12:00:00Z'},{remindAt:'2028-09-13T12:00:00Z'},{extra:true}])assert.equal((await f.reminder(task,f.staff,changes)).status,400);
 assert.equal((await f.request('/tasks/'+task.id+'/reminders',{method:'POST',session:f.staff,csrf:false,body:{taskVersion:1,ownerVersion:1,remindAt:'2026-09-13T12:01:00Z'}})).status,403);
 const created=await f.reminder(task);assert.equal(created.status,201,JSON.stringify(created.json));assert.equal(created.json.reminder.version,1);assert.equal(created.json.delivery,'Internal only');assert.equal(created.json.timezone,'UTC');assert.equal((await f.reminder(task)).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminders').get().n,1);
});

test('one-shot internal delivery is exactly once, minimal and owner-only through restart',async t=>{
 const f=await fixture(t),task=await f.task(),created=await f.reminder(task);assert.equal(created.status,201);assert.equal(f.run().delivered,0);f.advance(60000);assert.deepEqual(f.run(),{delivered:1,suppressed:0,failed:0,suspended:false});assert.equal(f.run().delivered,0);
 const own=(await f.request('/reminder-inbox',{session:f.staff})).json;assert.equal(own.items.length,1);assert.deepEqual(Object.keys(own.items[0]).sort(),['deliveredAt','id','reminderId','taskId','taskTitle','taskVersion']);assert.ok(!JSON.stringify(own).includes('PRIVATE_TASK_NOTES'));
 assert.deepEqual((await f.request('/reminder-inbox',{session:f.admin})).json.items,[]);assert.equal((await f.request('/task-reminders/'+created.json.reminder.id,{session:f.admin})).status,404);
 const row=f.db.prepare('SELECT * FROM task_reminder_inbox').get();assert.throws(()=>f.db.prepare('DELETE FROM task_reminder_inbox WHERE id=?').run(row.id));assert.throws(()=>f.db.prepare('UPDATE task_reminder_inbox SET delivered_at=? WHERE id=?').run('tamper',row.id));
 await f.restart();assert.equal(f.run().delivered,0);const fresh=await f.login('staff@foundation.example');assert.equal((await f.request('/reminder-inbox',{session:fresh})).json.items.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,1);
});

test('owner cancellation is versioned, reasoned, terminal and retains dated outcomes',async t=>{
 const f=await fixture(t),task=await f.task(),r=(await f.reminder(task)).json.reminder,path='/task-reminders/'+r.id+'/cancel';
 for(const options of [{session:f.admin},{session:f.staff,csrf:false}])assert.ok([403,404].includes((await f.request(path,{...options,method:'POST',body:{version:1,reason:'Cancel'}})).status));
 assert.equal((await f.request(path,{session:f.staff,method:'POST',body:{version:2,reason:'Stale'}})).status,409);assert.equal((await f.request(path,{session:f.staff,method:'POST',body:{version:1,reason:' '}})).status,400);
 const canceled=await f.request(path,{session:f.staff,method:'POST',body:{version:1,reason:'Work plan changed'}});assert.equal(canceled.status,200);assert.equal(canceled.json.reminder.status,'Cancelled');assert.equal(canceled.json.reminder.version,2);
 assert.equal((await f.request(path,{session:f.staff,method:'POST',body:{version:2,reason:'Repeat'}})).status,409);f.advance(60000);assert.equal(f.run().delivered,0);
 const history=(await f.request('/task-reminders/'+r.id,{session:f.staff})).json;assert.equal(history.outcomes[0].reason,'Work plan changed');assert.equal(history.outcomes[0].status,'Cancelled');assert.ok(history.outcomes[0].at.endsWith('Z'));assert.throws(()=>f.db.prepare('UPDATE task_reminder_outcomes SET reason=? WHERE reminder_id=?').run('tamper',r.id));
 assert.equal((await f.reminder(task)).status,201);
});

test('completion, reassignment and owner binding changes suppress pending reminders without retargeting',async t=>{
 const f=await fixture(t),complete=await f.task(),assigned=await f.task(),binding=await f.task();await f.reminder(complete);await f.reminder(assigned);await f.reminder(binding);
 await f.editTask(complete,{status:'Completed'});await f.editTask(assigned,{ownerId:f.admin.user.id,assignmentReason:'Administrator now responsible'});f.db.prepare('UPDATE users SET version=version+1 WHERE id=?').run(f.staff.user.id);f.advance(60000);
 const run=f.run();assert.equal(run.delivered,0);assert.equal(run.suppressed,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM task_reminders WHERE status='Suppressed'").get().n,3);
 const next=await f.login('staff@foundation.example'),listed=(await f.request('/task-reminders',{session:next})).json;assert.ok(listed.reminders.every(r=>r.taskTitle===null));assert.ok(!JSON.stringify(listed).includes('PRIVATE_TASK_NOTES'));
});

test('delivered titles are withheld after task source or current responsibility changes',async t=>{
 const f=await fixture(t),task=await f.task();await f.reminder(task);f.advance(60000);assert.equal(f.run().delivered,1);await f.editTask(task,{ownerId:f.admin.user.id,assignmentReason:'Transfer responsibility after notification'});
 assert.deepEqual((await f.request('/reminder-inbox',{session:f.staff})).json.items,[]);assert.deepEqual((await f.request('/reminder-inbox',{session:f.admin})).json.items,[]);const old=(await f.request('/task-reminders',{session:f.staff})).json;assert.equal(old.reminders[0].taskTitle,null);assert.equal(old.reminders[0].sourceCurrent,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,1);
});

test('suspension consumes even future schedules, and reinstatement never resumes old reminders',async t=>{
 const f=await fixture(t),task=await f.task();await f.reminder(task);f.suspend();const run=f.run();assert.deepEqual(run,{delivered:0,suppressed:1,failed:0,suspended:true});assert.equal((await f.request('/task-reminders',{session:f.staff})).status,403);f.resume();f.advance(86400000);assert.equal(f.run().delivered,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,0);assert.equal(f.db.prepare('SELECT reason FROM task_reminder_outcomes').get().reason,'Workspace suspended');
});

test('delivery audit failure retains no inbox and schedules bounded retry without financial mutations',async t=>{
 const f=await fixture(t),task=await f.task(),r=(await f.reminder(task)).json.reminder,financial=f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();f.db.exec("CREATE TRIGGER synthetic_reminder_delivery_fault BEFORE INSERT ON audit WHEN NEW.action='deliver_task_reminder' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");f.advance(60000);
 assert.deepEqual(f.run(),{delivered:0,suppressed:0,failed:1,suspended:false});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,0);const state=f.db.prepare('SELECT * FROM task_reminders WHERE id=?').get(r.id);assert.equal(state.status,'Active');assert.equal(state.attempt_count,1);assert.equal(f.db.prepare('SELECT status FROM task_reminder_outcomes').get().status,'Failed');assert.equal(f.run().failed,0);
 f.db.exec('DROP TRIGGER synthetic_reminder_delivery_fault');f.advance(60000);assert.equal(f.run().delivered,1);assert.equal(f.run().delivered,0);assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all(),financial);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,1);
});

test('future source reconciliation frees full active capacity without bypassing stale cancellation',async t=>{
 const f=await fixture(t),tasks=[];for(let i=0;i<100;i++){const task=await f.task(f.staff,{title:'Future owned task '+i});tasks.push(task);assert.equal((await f.reminder(task)).status,201);}
 const waiting=await f.task(f.staff,{title:'Waiting for reminder capacity'});assert.equal((await f.reminder(waiting)).status,409);const first=f.db.prepare('SELECT id FROM task_reminders WHERE task_id=?').get(tasks[0].id);
 await f.editTask(tasks[0],{status:'Completed'});assert.equal((await f.request('/task-reminders/'+first.id+'/cancel',{session:f.staff,method:'POST',body:{version:1,reason:'Close obsolete reminder'}})).status,409);
 assert.deepEqual(f.run(),{delivered:0,suppressed:1,failed:0,suspended:false});assert.equal(f.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(first.id).status,'Suppressed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,0);assert.equal((await f.reminder(waiting)).status,201);
});

test('repeated delivery failures stop after five attempts and count committed terminal suppression',async t=>{
 const f=await fixture(t),task=await f.task(),r=(await f.reminder(task)).json.reminder;
 f.db.exec("CREATE TRIGGER synthetic_repeated_delivery_failure BEFORE INSERT ON audit WHEN NEW.action='deliver_task_reminder' BEGIN SELECT RAISE(ABORT,'Synthetic delivery fault'); END;");
 for(let attempt=1;attempt<=5;attempt++){f.advance(60000);assert.deepEqual(f.run(),{delivered:0,suppressed:attempt===5?1:0,failed:1,suspended:false});}
 const row=f.db.prepare('SELECT * FROM task_reminders WHERE id=?').get(r.id);assert.equal(row.status,'Suppressed');assert.equal(row.attempt_count,5);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_reminder_inbox').get().n,0);assert.equal(f.run().failed,0);
 const history=(await f.request('/task-reminders/'+r.id,{session:f.staff})).json;assert.equal(history.outcomeCount,5);assert.equal(history.outcomes[0].status,'Suppressed');assert.match(history.outcomes[0].reason,/Retry limit/);
});
