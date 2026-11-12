import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProductionApp} from '../server/production/app.js';
import {startWebRuntime} from '../server/production/web.js';
import {startWorkerRuntime} from '../server/production/worker.js';

const secret='database-password-must-never-leak';
const config=()=>({
 processRole:'web',appOrigin:'https://crm.example.test',cookieName:'wimblo_session',mfaEncryptionKey:'11'.repeat(32),sessionSecret:'s'.repeat(40),
 network:{trustedProxyCidrs:['127.0.0.1/32']},limits:{dbPoolMax:4,jobConcurrency:2,jobLeaseMs:30_000},
 publicMetadata:()=>({mode:'saas',processRole:'web'})
});
const pool=(healthy=true)=>({healthy:async()=>healthy,withAdminSession:async fn=>fn({query:async()=>({rows:[],rowCount:0})}),withTenantSession:async(_tenant,fn)=>fn({query:async()=>({rows:[],rowCount:0})}),withTransaction:async(_tenant,fn)=>fn({query:async()=>({rows:[],rowCount:0})}),end:async()=>{}});
const services=(error=Object.assign(new Error(`${secret}\nstack: private`),{status:500}))=>({
 identityService:{authenticatePassword:async()=>{throw error;},listActiveMemberships:async()=>[]},
 mfaService:{status:async()=>({enabled:false}),createChallenge:async()=>({}),verifyChallenge:async()=>({}),beginEnrollment:async()=>({}),confirmEnrollment:async()=>({})},
 sessionService:{cookieName:'wimblo_session',authenticate:async()=>null,verifyCsrf:()=>false,isRecent:()=>false,issue:async()=>({}),switchTenant:async()=>({}),logout:async()=>({cookie:''})},
 moduleService:{list:async()=>[],enable:async()=>({}),suspend:async()=>({}),beginRetirement:async()=>({}),disable:async()=>({}),authorize:async()=>({allowed:false,state:'disabled'})}
});

async function fixture(t,{controlHealthy=true,tenantHealthy=true,serviceError,resolvedServices}={}){
 const app=createProductionApp({config:config(),controlPool:pool(controlHealthy),tenantPool:pool(tenantHealthy),clock:()=>new Date('2026-11-11T12:00:00Z'),services:resolvedServices||services(serviceError)});
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
 const preflight=await f.request('/api/crm/parties/example',{method:'OPTIONS'});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'GET,POST,PATCH');
 assert.equal(preflight.headers.get('access-control-allow-headers'),'Content-Type,X-CSRF-Token,Idempotency-Key,X-Source-System,If-Match,X-Source-SHA256');
});

test('HTTP, foreign origins, unknown routes and legacy CRM routes fail closed',async t=>{
 const f=await fixture(t);
 const http=await f.request('/health',{headers:{'X-Forwarded-Proto':'http'}});assert.equal(http.status,400);
 const ambiguous=await f.request('/health',{headers:{'X-Forwarded-Proto':'https,http'}});assert.equal(ambiguous.status,400);
 const foreign=await f.request('/health',{headers:{Origin:'https://attacker.example'}});assert.equal(foreign.status,403);assert.equal(foreign.headers.get('access-control-allow-origin'),null);
 for(const path of ['/missing','/api/records/constituents']){const response=await f.request(path);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'Not found.',code:'NOT_FOUND'});}
});

test('production web serves the built same-origin frontend without converting missing API routes into HTML',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wimblo-production-web-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'dist','assets'),{recursive:true});
 await writeFile(join(root,'dist','index.html'),'<!doctype html><title>Wimblo production</title>');
 await writeFile(join(root,'dist','assets','app.js'),'globalThis.wimbloProduction=true;');
 const app=createProductionApp({config:{...config(),root},controlPool:pool(),tenantPool:pool(),clock:()=>new Date('2026-11-11T12:00:00Z'),services:services()});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{'X-Forwarded-Proto':'https',Origin:'https://crm.example.test'}});
 const page=await request('/');assert.equal(page.status,200);assert.match(page.headers.get('content-type')||'',/^text\/html/);assert.match(await page.text(),/Wimblo production/);
 const asset=await request('/assets/app.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type')||'',/javascript/);assert.match(await asset.text(),/wimbloProduction=true/);
 const missingApi=await request('/api/not-a-route');assert.equal(missingApi.status,404);assert.deepEqual(await missingApi.json(),{error:'Not found.',code:'NOT_FOUND'});
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

test('MFA enrollment confirmation has its own route-level rate limit',async t=>{
 const resolved=services(),identityId='10000000-0000-4000-8000-000000000001',session={identityId,identity:{identityId,normalizedEmail:'owner@example.test',displayName:'Owner',status:'active'},membership:{membershipId:'20000000-0000-4000-8000-000000000001',identityId,tenantId:'30000000-0000-4000-8000-000000000001',role:'owner',status:'active',version:1}};
 resolved.sessionService={...resolved.sessionService,authenticate:async token=>token==='valid-session'?session:null,verifyCsrf:()=>true,isRecent:()=>true};resolved.mfaService={...resolved.mfaService,confirmEnrollment:async()=>{throw Object.assign(new Error('invalid code'),{status:401});}};
 const f=await fixture(t,{resolvedServices:resolved});let last;
 for(let index=0;index<11;index++)last=await f.request('/api/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf',Cookie:'wimblo_session=valid-session'},body:'{"code":"000000"}'});
 assert.equal(last.status,429);assert.ok(Number(last.headers.get('retry-after'))>=1);
});

test('one session cannot exhaust another session MFA confirmation limit behind the same proxy',async t=>{
 const resolved=services(),sessionFor=identityId=>({identityId,identity:{identityId,normalizedEmail:`${identityId}@example.test`,displayName:'Owner',status:'active'},membership:{membershipId:`membership-${identityId}`,identityId,tenantId:'tenant',role:'owner',status:'active',version:1}});
 resolved.sessionService={...resolved.sessionService,authenticate:async token=>token==='session-a'?sessionFor('identity-a'):token==='session-b'?sessionFor('identity-b'):null,verifyCsrf:()=>true,isRecent:()=>true};resolved.mfaService={...resolved.mfaService,confirmEnrollment:async()=>{throw Object.assign(new Error('invalid code'),{status:401});}};
 const f=await fixture(t,{resolvedServices:resolved}),requestFor=token=>f.request('/api/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf',Cookie:`wimblo_session=${token}`},body:'{"code":"000000"}'});
 for(let index=0;index<10;index++)assert.equal((await requestFor('session-a')).status,401);
 assert.equal((await requestFor('session-a')).status,429);
 assert.equal((await requestFor('session-b')).status,401);
});

test('rotating authenticated session cookies cannot bypass the identity MFA confirmation limit',async t=>{
 const resolved=services(),identityId='10000000-0000-4000-8000-000000000001',session={identityId,identity:{identityId,normalizedEmail:'owner@example.test',displayName:'Owner',status:'active'},membership:{membershipId:'20000000-0000-4000-8000-000000000001',identityId,tenantId:'30000000-0000-4000-8000-000000000001',role:'owner',status:'active',version:1}};
 resolved.sessionService={...resolved.sessionService,authenticate:async token=>token?.startsWith('valid-')?session:null,verifyCsrf:()=>true,isRecent:()=>true};resolved.mfaService={...resolved.mfaService,confirmEnrollment:async()=>{throw Object.assign(new Error('invalid code'),{status:401});}};
 const f=await fixture(t,{resolvedServices:resolved}),requestFor=token=>f.request('/api/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf',Cookie:`wimblo_session=${token}`},body:'{"code":"000000"}'});
 for(let index=0;index<10;index++)assert.equal((await requestFor(`valid-${index}`)).status,401);
 assert.equal((await requestFor('valid-rotated')).status,429);
});

test('untrusted cookie churn never enters or allocates the password-reproof limiter',async t=>{
 const f=await fixture(t),response=await f.request('/api/auth/mfa/recovery/reset',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf',Cookie:'wimblo_session=attacker-controlled'},body:'{"password":"guess"}'});
 assert.equal(response.status,401);assert.equal(response.headers.get('ratelimit-limit'),null);assert.equal(response.headers.get('ratelimit-reset'),null);
});

test('identity limiter capacity fails closed without evicting an active password-reproof bucket',async t=>{
 const resolved=services(),sessionFor=identityId=>({identityId,identity:{identityId,normalizedEmail:'owner@example.test',displayName:'Owner',status:'active'},membership:{membershipId:`membership-${identityId}`,identityId,tenantId:'tenant',role:'owner',status:'active',version:1}});
 resolved.sessionService={...resolved.sessionService,authenticate:async token=>token?.startsWith('valid-')?sessionFor(token.slice(6)):null,verifyCsrf:()=>true,isRecent:()=>true};resolved.mfaService={...resolved.mfaService,confirmEnrollment:async()=>{throw Object.assign(new Error('invalid code'),{status:401});}};
 const f=await fixture(t,{resolvedServices:resolved}),requestFor=identity=>f.request('/api/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf',Cookie:`wimblo_session=valid-${identity}`},body:'{"code":"000000"}'});
 for(let attempt=0;attempt<10;attempt++)assert.equal((await requestFor('identity-0')).status,401);
 for(let start=1;start<10000;start+=20){const responses=await Promise.all(Array.from({length:Math.min(20,10000-start)},(_,offset)=>requestFor(`identity-${start+offset}`)));assert.equal(responses.every(response=>response.status===401),true);await Promise.all(responses.map(response=>response.arrayBuffer()));}
 assert.equal((await requestFor('identity-10000')).status,429);assert.equal((await requestFor('identity-0')).status,429);
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

test('startup verification failure closes initialized web and worker pools exactly once',async()=>{
 for(const kind of ['web','worker']){
  let ended=0,started=0;const pools=[{end:async()=>{ended++;}},{end:async()=>{ended++;}}],failure=new Error('startup certification failed');
  const start=kind==='web'
   ? startWebRuntime({config:{processRole:'web'},app:{},pools,verify:async()=>{throw failure;},listen:async()=>{started++;}})
   : startWorkerRuntime({config:{processRole:'worker'},repository:{},handlers:{},tenantIds:[],pools,verify:async()=>{throw failure;},run:async()=>{started++;}});
  await assert.rejects(()=>start,/startup certification failed/);assert.equal(started,0);assert.equal(ended,2);
 }
});

test('web listener failure closes initialized pools exactly once',async()=>{
 let ended=0;const pools=[{end:async()=>{ended++;}},{end:async()=>{ended++;}}];
 await assert.rejects(()=>startWebRuntime({config:{processRole:'web'},app:{},pools,verify:async()=>{},listen:async()=>{throw new Error('listen failed');}}),/listen failed/);
 assert.equal(ended,2);
});

test('worker loop rejection closes initialized pools and later close is idempotent',async()=>{
 let ended=0;const pools=[{end:async()=>{ended++;}},{end:async()=>{ended++;}}];
 const runtime=await startWorkerRuntime({config:{processRole:'worker'},repository:{},handlers:{},tenantIds:[],pools,verify:async()=>{},run:async()=>{throw new Error('worker loop failed');}});
 await assert.rejects(()=>runtime.running,/worker loop failed/);await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,2);
 await runtime.close();assert.equal(ended,2);
});
