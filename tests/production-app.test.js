import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createProductionApp} from '../server/production/app.js';
import {startWebRuntime} from '../server/production/web.js';
import {startWorkerRuntime} from '../server/production/worker.js';

const secret='database-password-must-never-leak';
const config=()=>({
 processRole:'web',appOrigin:'https://crm.example.test',cookieName:'wimblo_session',mfaEncryptionKey:'11'.repeat(32),sessionSecret:'s'.repeat(40),
 limits:{trustProxyHops:1,dbPoolMax:4,jobConcurrency:2,jobLeaseMs:30_000},
 publicMetadata:()=>({mode:'saas',processRole:'web'})
});
const pool=(healthy=true)=>({healthy:async()=>healthy,withAdminSession:async fn=>fn({query:async()=>({rows:[],rowCount:0})}),withTenantSession:async(_tenant,fn)=>fn({query:async()=>({rows:[],rowCount:0})}),withTransaction:async(_tenant,fn)=>fn({query:async()=>({rows:[],rowCount:0})}),end:async()=>{}});
const services=(error=Object.assign(new Error(`${secret}\nstack: private`),{status:500}))=>({
 identityService:{authenticatePassword:async()=>{throw error;},listActiveMemberships:async()=>[]},
 mfaService:{status:async()=>({enabled:false}),createChallenge:async()=>({}),verifyChallenge:async()=>({}),beginEnrollment:async()=>({}),confirmEnrollment:async()=>({})},
 sessionService:{cookieName:'wimblo_session',authenticate:async()=>null,verifyCsrf:()=>false,isRecent:()=>false,issue:async()=>({}),switchTenant:async()=>({}),logout:async()=>({cookie:''})},
 moduleService:{list:async()=>[],enable:async()=>({}),suspend:async()=>({}),beginRetirement:async()=>({}),disable:async()=>({}),authorize:async()=>({allowed:false,state:'disabled'})}
});

async function fixture(t,{controlHealthy=true,tenantHealthy=true,serviceError}={}){
 const app=createProductionApp({config:config(),controlPool:pool(controlHealthy),tenantPool:pool(tenantHealthy),clock:()=>new Date('2026-11-11T12:00:00Z'),services:services(serviceError)});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,options={})=>fetch(base+path,{...options,headers:{'X-Forwarded-Proto':'https',Origin:'https://crm.example.test',...(options.headers||{})}});
 return {app,request};
}

test('production baseline sets Helmet CSP, exact CORS and no framework disclosure',async t=>{
 const f=await fixture(t),response=await f.request('/health');assert.equal(response.status,200);
 assert.match(response.headers.get('content-security-policy')||'',/default-src 'self'/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-powered-by'),null);
 assert.equal(response.headers.get('cross-origin-embedder-policy'),'require-corp');assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('access-control-allow-origin'),'https://crm.example.test');assert.match(response.headers.get('vary')||'',/Origin/);assert.equal((await response.json()).status,'ok');
});

test('HTTP, foreign origins, unknown routes and legacy CRM routes fail closed',async t=>{
 const f=await fixture(t);
 const http=await f.request('/health',{headers:{'X-Forwarded-Proto':'http'}});assert.equal(http.status,400);
 const ambiguous=await f.request('/health',{headers:{'X-Forwarded-Proto':'https,http'}});assert.equal(ambiguous.status,400);
 const foreign=await f.request('/health',{headers:{Origin:'https://attacker.example'}});assert.equal(foreign.status,403);assert.equal(foreign.headers.get('access-control-allow-origin'),null);
 for(const path of ['/missing','/api/records/constituents']){const response=await f.request(path);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'Not found.',code:'NOT_FOUND'});}
});

test('JSON bodies are bounded and production errors never expose messages, stacks or secrets',async t=>{
 const f=await fixture(t);
 const large=await f.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'a@example.test',password:'x'.repeat(70_000)})});assert.equal(large.status,413);assert.doesNotMatch(await large.text(),/xxxxx|stack|password/i);
 const failed=await f.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'a@example.test',password:'invalid'})});assert.equal(failed.status,500);const body=JSON.stringify(await failed.json());assert.doesNotMatch(body,new RegExp(`${secret}|stack|private`,'i'));assert.deepEqual(JSON.parse(body),{error:'Internal service error.',code:'INTERNAL_ERROR'});
 const invalidStatus=await fixture(t,{serviceError:Object.assign(new Error(secret),{status:200})});const clamped=await invalidStatus.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"email":"a@example.test","password":"invalid"}'});assert.equal(clamped.status,500);
});

test('authentication attempts are rate limited without affecting health checks',async t=>{
 const f=await fixture(t);let last;
 for(let index=0;index<11;index++)last=await f.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"email":"a@example.test","password":"invalid"}'});
 assert.equal(last.status,429);assert.ok(Number(last.headers.get('retry-after'))>=1);assert.equal((await f.request('/health')).status,200);
});

test('readiness requires both isolated pools while liveness remains process-local',async t=>{
 const f=await fixture(t,{tenantHealthy:false});assert.equal((await f.request('/health')).status,200);const ready=await f.request('/ready');assert.equal(ready.status,503);assert.deepEqual(await ready.json(),{status:'unavailable'});
});

test('web and worker start functions reject the wrong role before listeners or polling',async()=>{
 let listened=0,polled=0;
 await assert.rejects(()=>startWebRuntime({config:{processRole:'worker'},listen:async()=>{listened++;}}),/web process role/i);
 await assert.rejects(()=>startWorkerRuntime({config:{processRole:'web'},run:async()=>{polled++;}}),/worker process role/i);
 assert.equal(listened,0);assert.equal(polled,0);
});

test('web starts only HTTP and worker starts only polling through separate compositions',async()=>{
 let listened=0,polled=0;
 const web=await startWebRuntime({config:{processRole:'web'},app:{},listen:async()=>{listened++;return {close:async()=>{}};},pools:[]});await web.close();
 const worker=await startWorkerRuntime({config:{processRole:'worker'},run:async()=>{polled++;},repository:{},handlers:{},tenantIds:[],signal:AbortSignal.abort(),pools:[]});await worker.close();
 assert.equal(listened,1);assert.equal(polled,1);
});
