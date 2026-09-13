import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const HOUR=3600000;
const definition=(changes={})=>({name:'Exact scheduled revenue',entity:'gifts',columns:['amount'],aggregates:[{op:'sum',field:'amount'},{op:'count'}],...changes});

async function fixture(t,{active=()=>true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-report-schedules-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,isTenantActive:active});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=csrf===true?session.csrfToken:csrf;}const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email='alex@foundation.example'){const r=await request('/api/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200,JSON.stringify(r.json));return {...r.json,cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(path,body,session=admin){const r=await request(path,{method:'POST',body,session});assert.equal(r.status,201,JSON.stringify(r.json));return r.json;}
 // Real API fixtures exercise catalog discovery, domain validation and authentication.
 const donor=(await create('/api/records/constituents',{name:'Schedule-only donor',type:'Individual',email:'schedule@example.test'})).record;
 const fund=(await create('/api/records/designations',{name:'Schedule-only fund',accountCode:'SCHEDULE-4100'})).record;
 const gifts=[];
 async function gift(amount){const r=(await create('/api/records/gifts',{constituentId:donor.id,amount,type:'Cash',method:'Check',date:'2026-09-13',allocations:[{designationId:fund.id,amount}]})).record;gifts.push(r);return r;}
 await gift(10001);await gift(204);
 const def=definition({filters:[{field:'constituentId',op:'eq',value:donor.id}]});
 const catalog=await request('/api/custom-reports/catalog',{session:admin});assert.equal(catalog.status,200);assert.equal(catalog.json.entities.find(e=>e.id==='gifts').fields.find(f=>f.key==='amount').unit,'cents');
 const report=(await create('/api/custom-reports',def)).report;
 const first=Date.now()+60000;
 async function schedule(session=staff,changes={}){return (await create('/api/report-schedules',{reportId:report.id,name:'Internal exact revenue',cadence:'Hourly',startAt:new Date(first).toISOString(),...changes},session)).schedule;}
 async function deliveries(){const r=await request('/api/report-deliveries',{session:admin});assert.equal(r.status,200);return r.json.deliveries;}
 async function delivery(id,session=admin){const r=await request(`/api/report-deliveries/${id}`,{session});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.delivery;}
 return {request,login,admin,staff,viewer,donor,fund,gift,gifts,report,def,first,schedule,deliveries,delivery,restart:async()=>{await close();await open();},get app(){return app;},get db(){return app.locals.db;}};
}

test('actual app produces exact current cents and current report version once at the scheduled time',async t=>{
 const f=await fixture(t),s=await f.schedule();assert.deepEqual(f.app.locals.runDueReports(f.first-1),{produced:0,failed:0});
 await f.gift(5);const edit=await f.request(`/api/custom-reports/${f.report.id}`,{method:'PATCH',session:f.admin,body:{...f.def,name:'Current definition',version:1}});assert.equal(edit.status,200);
 assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:1,failed:0});const history=await f.deliveries();assert.equal(history.length,1);const d=await f.delivery(history[0].id);assert.equal(d.scheduleId,s.id);assert.equal(d.status,'Produced');assert.equal(d.scheduledAt,new Date(f.first).toISOString());assert.equal(d.reportVersion,2);assert.equal(d.result.version,2);assert.equal(d.result.reportId,f.report.id);assert.deepEqual(d.result.rows,[[10210,3]]);assert.equal(d.result.columns[0].unit,'cents');
 assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:0,failed:0});assert.deepEqual(f.app.locals.runDueReports(f.first+HOUR-1),{produced:0,failed:0});assert.equal((await f.deliveries()).length,1);
 const current=(await f.request('/api/report-schedules',{session:f.staff})).json.schedules[0];assert.equal(current.version,2);assert.equal(current.nextRun,new Date(f.first+HOUR).toISOString());
 const audit=f.db.prepare("SELECT details FROM audit WHERE action='produce_scheduled_report'").all();assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].details).reportVersion,2);
});

test('pause skips generation; resume produces one catch-up and advances beyond now without replaying missed cycles',async t=>{
 const f=await fixture(t),s=await f.schedule();const pause=await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.staff,body:{version:1,status:'Paused'}});assert.equal(pause.status,200);
 const later=f.first+5*HOUR+1234;assert.deepEqual(f.app.locals.runDueReports(later),{produced:0,failed:0});assert.equal((await f.deliveries()).length,0);
 const resume=await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.staff,body:{version:2,status:'Active'}});assert.equal(resume.status,200);assert.deepEqual(f.app.locals.runDueReports(later),{produced:1,failed:0});
 const list=(await f.request('/api/report-schedules',{session:f.staff})).json;assert.equal(list.delivery,'Internal');assert.equal(list.timezone,'UTC');assert.match(list.worker,/while.*server.*running/);assert.equal(list.schedules[0].nextRun,new Date(f.first+6*HOUR).toISOString());assert.equal((await f.deliveries()).length,1);assert.deepEqual(f.app.locals.runDueReports(later),{produced:0,failed:0});
});

test('background generation checks current account role and active state despite an existing session, then retries next cadence',async t=>{
 const f=await fixture(t);await f.schedule();const change=await f.request(`/api/users/${f.staff.user.id}`,{method:'PATCH',session:f.admin,body:{version:1,role:'viewer',active:true}});assert.equal(change.status,200);assert.ok(change.json.sessionsRevoked>0);
 assert.equal((await f.request('/api/report-schedules',{session:f.staff})).status,401);assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:0,failed:1});let d=await f.delivery((await f.deliveries())[0].id);assert.equal(d.result,null);assert.match(d.error,/no longer.*access/);
 const deactivate=await f.request(`/api/users/${f.staff.user.id}`,{method:'PATCH',session:f.admin,body:{version:2,role:'staff',active:false}});assert.equal(deactivate.status,200);assert.deepEqual(f.app.locals.runDueReports(f.first+HOUR),{produced:0,failed:1});assert.equal((await f.deliveries()).filter(x=>x.status==='Failed').length,2);
 const restore=await f.request(`/api/users/${f.staff.user.id}`,{method:'PATCH',session:f.admin,body:{version:3,role:'staff',active:true}});assert.equal(restore.status,200);assert.deepEqual(f.app.locals.runDueReports(f.first+2*HOUR),{produced:1,failed:0});assert.equal((await f.deliveries()).length,3);
});

test('active scheduled owner does not require a live browser session for internal background delivery',async t=>{
 const f=await fixture(t);await f.schedule();const logout=await f.request('/api/auth/logout',{method:'POST',session:f.staff});assert.equal(logout.status,200);assert.equal((await f.request('/api/report-schedules',{session:f.staff})).status,401);assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:1,failed:0});assert.deepEqual((await f.delivery((await f.deliveries())[0].id)).result.rows,[[10205,2]]);
});

test('failed definition does not store partial output, repeated same cycle is suppressed, future cadence retries repaired definition',async t=>{
 const f=await fixture(t);await f.schedule();const stored=f.db.prepare('SELECT definition FROM custom_reports WHERE id=?').get(f.report.id).definition;
 // Controlled fixture fault represents a retained definition whose dynamic field is unavailable.
 f.db.prepare('UPDATE custom_reports SET definition=? WHERE id=?').run(JSON.stringify({...JSON.parse(stored),columns:['removedField'],aggregates:[]}),f.report.id);
 assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:0,failed:1});let history=await f.deliveries();assert.equal(history.length,1);const failed=await f.delivery(history[0].id);assert.equal(failed.result,null);assert.equal(failed.reportVersion,null);assert.match(failed.error,/could not be produced/);assert.doesNotMatch(failed.error,/removedField|SELECT|sqlite/i);assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:0,failed:0});
 const repair=await f.request(`/api/custom-reports/${f.report.id}`,{method:'PATCH',session:f.admin,body:{...f.def,version:1}});assert.equal(repair.status,200);assert.deepEqual(f.app.locals.runDueReports(f.first+HOUR),{produced:1,failed:0});history=await f.deliveries();assert.equal(history.length,2);assert.deepEqual((await f.delivery(history.find(x=>x.status==='Produced').id)).result.rows,[[10205,2]]);assert.equal((await f.delivery(failed.id)).status,'Failed');
});

test('schedule mutation requires authentication, writable role, CSRF, strict body, owner or admin and current version',async t=>{
 const f=await fixture(t),body={reportId:f.report.id,name:'Denied schedule',cadence:'Hourly',startAt:new Date(f.first).toISOString()};
 for(const [options,status] of [[{body},401],[{body,session:f.viewer},403],[{body,session:f.staff,csrf:false},403],[{body,session:f.staff,csrf:'wrong'},403],[{body:{...body,ownerId:f.admin.user.id},session:f.staff},400],[{body:{...body,cadence:'Monthly'},session:f.staff},400],[{body:{...body,startAt:new Date(Date.now()-120000).toISOString()},session:f.staff},400],[{body:{...body,startAt:new Date(Date.now()+367*86400000).toISOString()},session:f.staff},400]])assert.equal((await f.request('/api/report-schedules',{method:'POST',...options})).status,status);
 const s=await f.schedule(f.admin);const patch={version:1,status:'Paused'};
 assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.staff,body:patch})).status,403);assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.viewer,body:patch})).status,403);assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.admin,csrf:false,body:patch})).status,403);
 assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.admin,body:{...patch,nextRun:new Date(f.first).toISOString()}})).status,400);assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.admin,body:{status:'Paused'}})).status,400);
 assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.admin,body:patch})).status,200);assert.equal((await f.request(`/api/report-schedules/${s.id}`,{method:'PATCH',session:f.admin,body:patch})).status,409);
 const own=await f.schedule(f.staff);assert.equal((await f.request(`/api/report-schedules/${own.id}`,{method:'PATCH',session:f.admin,body:{version:1,status:'Paused'}})).status,200);assert.equal((await f.deliveries()).length,0);
 assert.equal((await f.request('/api/report-deliveries')).status,401);
});

test('durable schedules and immutable produced history survive restart while each future result uses new data',async t=>{
 const f=await fixture(t),s=await f.schedule();f.app.locals.runDueReports(f.first);const original=await f.delivery((await f.deliveries())[0].id);
 assert.throws(()=>f.db.prepare('UPDATE report_deliveries SET result=? WHERE id=?').run('{}',original.id),/immutable/);assert.throws(()=>f.db.prepare('DELETE FROM report_deliveries WHERE id=?').run(original.id),/retained/);
 await f.restart();const persisted=(await f.request('/api/report-schedules',{session:f.staff})).json.schedules.find(x=>x.id===s.id);assert.equal(persisted.version,2);assert.deepEqual(await f.delivery(original.id),original);assert.deepEqual(f.app.locals.runDueReports(f.first),{produced:0,failed:0});
 await f.gift(7);assert.deepEqual(f.app.locals.runDueReports(f.first+HOUR),{produced:1,failed:0});const history=await f.deliveries();assert.equal(history.length,2);assert.deepEqual((await f.delivery(history.find(x=>x.id!==original.id).id,f.viewer)).result.rows,[[10212,3]]);assert.deepEqual((await f.delivery(original.id,f.viewer)).result.rows,[[10205,2]]);
});

test('inactive tenant suspends background work without advancing schedules or retaining output; activation catches up once',async t=>{
 let active=true;const f=await fixture(t,{active:()=>active}),s=await f.schedule();active=false;
 const before=f.db.prepare('SELECT * FROM report_schedules WHERE id=?').get(s.id);assert.deepEqual(f.app.locals.runDueReports(f.first+3*HOUR),{produced:0,failed:0,suspended:true});assert.deepEqual(f.db.prepare('SELECT * FROM report_schedules WHERE id=?').get(s.id),before);assert.equal((await f.deliveries()).length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action LIKE '%scheduled_report'").get().n,0);
 active=true;assert.deepEqual(f.app.locals.runDueReports(f.first+3*HOUR),{produced:1,failed:0});assert.equal((await f.deliveries()).length,1);assert.equal((await f.request('/api/report-schedules',{session:f.admin})).json.schedules[0].nextRun,new Date(f.first+4*HOUR).toISOString());
});


test('retained administrator document reports cannot bypass live document visibility through scheduled snapshots',async t=>{
 const f=await fixture(t);
 const doc=await f.request('/api/documents',{method:'POST',session:f.admin,body:{collection:'constituents',recordId:f.donor.id,title:'Restricted board evidence',category:'Agreement',visibility:'Administrators',status:'Draft',evidenceDate:null,filename:'restricted.txt',contentBase64:Buffer.from('Fictional restricted evidence').toString('base64')}});assert.equal(doc.status,201,JSON.stringify(doc.json));
 const report=await f.request('/api/custom-reports',{method:'POST',session:f.admin,body:{name:'Private document names',entity:'documents',columns:['title']}});assert.equal(report.status,201,JSON.stringify(report.json));
 const schedule=await f.schedule(f.admin,{reportId:report.json.report.id});f.app.locals.runDueReports(f.first);const metadata=(await f.deliveries()).find(x=>x.scheduleId===schedule.id);assert.ok(metadata);
 const retained=await f.delivery(metadata.id);assert.equal(retained.result.requiredRole,'admin');assert.deepEqual(retained.result.rows,[['Restricted board evidence']]);
 for(const session of [f.staff,f.viewer]){const denied=await f.request(`/api/report-deliveries/${metadata.id}`,{session});assert.equal(denied.status,403);assert.ok(!JSON.stringify(denied.json).includes('Restricted board evidence'));const live=await f.request(`/api/custom-reports/${report.json.report.id}/run`,{session});assert.equal(live.status,200);assert.deepEqual(live.json.rows,[]);}
 await f.restart();assert.equal((await f.request(`/api/report-deliveries/${metadata.id}`,{session:f.viewer})).status,403);assert.deepEqual((await f.delivery(metadata.id)).result.rows,[['Restricted board evidence']]);
});
