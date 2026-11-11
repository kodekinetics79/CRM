import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';

// server/reportSchedule.js keeps its own transaction helper rather than the shared one.
// The keyed-suite run showed its writes completed with no commit marker, so a crash after
// COMMIT could let a retry create a duplicate schedule. It now writes the marker inside its
// own transaction; these tests hold that, by reading the marker rather than trusting replay.
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-idempotency-schedules-'));
 const app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,key}={}){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrfToken;}
  if(key)headers['Idempotency-Key']=key;
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,replayed:r.headers.get('Idempotent-Replayed'),text:await r.text()};
 }
 async function login(email){
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});
  assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
 }
 const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example');
 const created=await request('/api/custom-reports',{method:'POST',session:admin,body:{name:'Keyed schedule source',entity:'gifts',columns:['amount'],aggregates:[{op:'sum',field:'amount'},{op:'count'}]}});
 assert.equal(created.status,201,created.text);
 const report=JSON.parse(created.text).report;
 const body={reportId:report.id,name:'Keyed hourly revenue',cadence:'Hourly',startAt:new Date(Date.now()+60000).toISOString()};
 return {request,staff,body,db:app.locals.db};
}

test('a keyed schedule creation writes its commit marker inside the schedule transaction',async t=>{
 const f=await fixture(t),key=randomUUID();
 const before=f.db.prepare('SELECT COUNT(*) AS n FROM report_schedules').get().n;
 const first=await f.request('/api/report-schedules',{method:'POST',session:f.staff,body:f.body,key});
 assert.equal(first.status,201,first.text);
 const marker=f.db.prepare("SELECT committed_at,state FROM idempotency_requests WHERE method='POST' AND path='/api/report-schedules' ORDER BY reserved_at DESC LIMIT 1").get();
 assert.ok(marker,'a keyed request must reserve an idempotency record');
 assert.notEqual(marker.committed_at,null,'the commit marker must be written inside the schedule transaction, not only after the response');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM report_schedules').get().n,before+1);
});

test('replaying the same keyed schedule creation returns the original response and creates no second schedule',async t=>{
 const f=await fixture(t),key=randomUUID();
 const first=await f.request('/api/report-schedules',{method:'POST',session:f.staff,body:f.body,key});
 assert.equal(first.status,201,first.text);
 const count=f.db.prepare('SELECT COUNT(*) AS n FROM report_schedules').get().n;
 const replay=await f.request('/api/report-schedules',{method:'POST',session:f.staff,body:f.body,key});
 assert.equal(replay.status,201);
 assert.equal(replay.replayed,'true');
 assert.equal(replay.text,first.text,'a replay must return the original response byte for byte');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM report_schedules').get().n,count,'a replay must never create a second schedule');
});
