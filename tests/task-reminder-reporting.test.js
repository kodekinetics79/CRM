import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
import {backupWorkspace,restoreWorkspace} from '../server/backup.js';

const sources=['taskReminderSchedules','taskReminderOutcomes','taskReminderInbox'];
const password='SyntheticReminderReporting!2026';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-reminder-reporting-')),dbPath=join(dir,'workspace.sqlite'),tenantId=randomUUID(),time=Date.parse('2026-09-13T12:00:00.000Z');
 const app=createApp({dbPath,seed:false,tenantId,initialAdmin:{name:'Reminder metadata administrator',email:'admin.reminders@example.test',password},mfaKey:'',reminderClock:()=>time,reminderWorker:false}),db=app.locals.db,server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,{method='GET',body,session}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {status:r.status,json,text};}
 async function login(email){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
 const sessions={admin:await login('admin.reminders@example.test')};for(const [key,role] of [['staff','staff'],['viewer','viewer'],['helper','event-helper']]){const result=await request('/users',{method:'POST',session:sessions.admin,body:{name:'Reminder reporting '+key,email:key+'.reminders@example.test',password,role}});assert.equal(result.status,201);sessions[key]=await login(key+'.reminders@example.test');}
 async function create(collection,body,session=sessions.admin){const r=await request('/records/'+collection,{method:'POST',session,body});assert.equal(r.status,201,r.text);return r.json.record;}
 const donor=await create('constituents',{name:'Existing financial source',type:'Individual'}),fund=await create('designations',{name:'Existing fund'});await create('gifts',{constituentId:donor.id,amount:10001,type:'Cash',method:'Check',date:'2026-09-13',allocations:[{designationId:fund.id,amount:10001}]});
 const financial=()=>db.prepare("SELECT * FROM records WHERE collection IN ('gifts','communications') ORDER BY collection,id").all(),before=financial(),tasks={},reminders={};
 for(const kind of ['delivered','cancelled','suppressed']){tasks[kind]=await create('tasks',{title:'PRIVATE_REMINDER_TASK_TITLE_'+kind,notes:'PRIVATE_REMINDER_TASK_BODY_'+kind,dueDate:'2026-09-13',status:'Open',ownerId:sessions.staff.user.id},sessions.staff);const result=await request('/tasks/'+tasks[kind].id+'/reminders',{method:'POST',session:sessions.staff,body:{taskVersion:1,ownerVersion:1,remindAt:new Date(time+1000).toISOString()}});assert.equal(result.status,201,result.text);reminders[kind]=result.json.reminder;}
 assert.equal((await request('/task-reminders/'+reminders.cancelled.id+'/cancel',{method:'POST',session:sessions.staff,body:{version:1,reason:'Planned internal reminder no longer needed'}})).status,200);
 assert.equal((await request('/records/tasks/'+tasks.suppressed.id,{method:'PATCH',session:sessions.staff,body:{version:1,status:'Completed'}})).status,200);
 assert.deepEqual(app.locals.runDueReminders(time+1000),{delivered:1,suppressed:1,failed:0,suspended:false});assert.deepEqual(financial(),before);
 const report=(entity,columns,session=sessions.admin,changes={})=>request('/custom-reports/run',{method:'POST',session,body:{name:'Curated internal reminder proof',entity,columns,...changes}});
 return {dir,db,tenantId,request,sessions,tasks,reminders,report,financial,before};
}

test('administrator reminder reports preserve exact original task/owner revisions and distinct outcome counts',async t=>{
 const f=await fixture(t),schedules=await f.report('taskReminderSchedules',['id','taskId','ownerId','taskRevision','ownerRevision','status','revision','attemptCount']);assert.equal(schedules.status,200,schedules.text);assert.equal(schedules.json.requiredRole,'admin');
 const expected=[['delivered','Delivered',1],['cancelled','Cancelled',0],['suppressed','Suppressed',0]].map(([kind,status,attempts])=>[f.reminders[kind].id,f.tasks[kind].id,f.sessions.staff.user.id,1,1,status,2,attempts]).sort((a,b)=>a[0]<b[0]?-1:1);assert.deepEqual(schedules.json.rows,expected);
 const outcomes=await f.report('taskReminderOutcomes',['reminderId','reminderRevision','status']);assert.equal(outcomes.status,200,outcomes.text);assert.equal(outcomes.json.requiredRole,'admin');assert.deepEqual(outcomes.json.rows.map(row=>JSON.stringify(row)).sort(),[['delivered','Delivered'],['cancelled','Cancelled'],['suppressed','Suppressed']].map(([kind,status])=>JSON.stringify([f.reminders[kind].id,2,status])).sort());
 const counts=await f.report('taskReminderOutcomes',['status'],f.sessions.admin,{groupBy:['status'],aggregates:[{op:'count'}]});assert.equal(counts.status,200,counts.text);assert.deepEqual(counts.json.rows.map(row=>JSON.stringify(row)).sort(),[['Delivered',1],['Cancelled',1],['Suppressed',1]].map(JSON.stringify).sort());
 const inbox=await f.report('taskReminderInbox',['reminderId','ownerId','taskId','taskRevision','delivery']);assert.equal(inbox.status,200,inbox.text);assert.deepEqual(inbox.json.rows,[[f.reminders.delivered.id,f.sessions.staff.user.id,f.tasks.delivered.id,1,'Internal only']]);assert.equal(inbox.json.requiredRole,'admin');assert.deepEqual(f.financial(),f.before);
});

test('curated reminder catalog exposes no account binding or task title/body and rejects raw fields',async t=>{
 const f=await fixture(t),catalog=await f.request('/custom-reports/catalog',{session:f.sessions.admin});assert.equal(catalog.status,200);const entities=catalog.json.entities.filter(entity=>sources.includes(entity.id));assert.equal(entities.length,3);
 const bindings=f.db.prepare('SELECT owner_binding FROM task_reminders').all().map(row=>row.owner_binding);
 for(const entity of entities){assert.equal(entity.requiredRole,'admin');assert.ok(!entity.fields.some(field=>/binding|password|taskTitle|taskBody|notes|snapshot/i.test(field.key)));const columns=entity.fields.map(field=>field.key),safe=await f.report(entity.id,columns.slice(0,20));assert.equal(safe.status,200,safe.text);assert.doesNotMatch(safe.text,/PRIVATE_REMINDER_TASK_TITLE|PRIVATE_REMINDER_TASK_BODY|owner_binding|password_hash/);for(const binding of bindings)assert.ok(!safe.text.includes(binding));
  for(const forbidden of ['owner_binding','ownerBinding','taskTitle','taskBody','notes','password_hash','source'])assert.equal((await f.report(entity.id,[forbidden])).status,400,entity.id+':'+forbidden);
 }
 assert.deepEqual(f.financial(),f.before);
});

test('staff/viewer cannot discover or preview administrator reminder sources and helper report access stays denied',async t=>{
 const f=await fixture(t);for(const session of [f.sessions.staff,f.sessions.viewer]){const catalog=await f.request('/custom-reports/catalog',{session});assert.equal(catalog.status,200);assert.ok(!catalog.json.entities.some(entity=>sources.includes(entity.id)));for(const entity of sources)assert.equal((await f.report(entity,['id'],session)).status,403,entity);}
 assert.equal((await f.request('/custom-reports/catalog',{session:f.sessions.helper})).status,403);for(const entity of sources)assert.equal((await f.report(entity,['id'],f.sessions.helper)).status,403);
 const own=await f.request('/reminder-inbox',{session:f.sessions.staff});assert.equal(own.status,200);assert.equal(own.json.items.length,1);assert.equal((await f.request('/reminder-inbox',{session:f.sessions.admin})).json.items.length,0);assert.deepEqual(f.financial(),f.before);
});

test('full native backup restores delivered reminder provenance and immutable history while clearing authentication',async t=>{
 const f=await fixture(t),key=randomBytes(32).toString('hex'),archivePath=join(f.dir,'reminders.wbackup'),destinationPath=join(f.dir,'restored.sqlite'),tables=['task_reminders','task_reminder_outcomes','task_reminder_inbox'];
 const expected=Object.fromEntries(tables.map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY id').all()]));const backup=await backupWorkspace({db:f.db,outputPath:archivePath,tenantId:f.tenantId,encryptionKey:key});for(const table of tables)assert.equal(backup.tables.find(row=>row.name===table).count,expected[table].length);
 const restored=await restoreWorkspace({archivePath,destinationPath,expectedTenantId:f.tenantId,encryptionKey:key});assert.ok(restored.cleared.sessions>0);const copy=new DatabaseSync(destinationPath);try{for(const table of tables)assert.deepEqual(copy.prepare('SELECT * FROM '+table+' ORDER BY id').all(),expected[table]);assert.equal(copy.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(copy.prepare('SELECT COUNT(*) n FROM mfa_challenges').get().n,0);assert.throws(()=>copy.prepare('DELETE FROM task_reminder_outcomes WHERE reminder_id=?').run(f.reminders.delivered.id));assert.throws(()=>copy.prepare('UPDATE task_reminder_inbox SET delivered_at=? WHERE reminder_id=?').run('tamper',f.reminders.delivered.id));assert.deepEqual(copy.prepare("SELECT * FROM records WHERE collection IN ('gifts','communications') ORDER BY collection,id").all(),f.before);}finally{copy.close();}
 assert.deepEqual(f.financial(),f.before);
});
