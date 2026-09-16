import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installAiRoutes,recordedRemoteAuthorization,REMOTE_EGRESS_REASON} from '../server/ai.js';

// Threat model under test: a NON-production instance (production already refuses
// seed and ALLOW_DEMO) that was started with seed:true but now holds converted
// buyer records. Such an instance passes the synthetic-data gate, because that
// gate describes how the database was initialised rather than what it holds.
// Remote egress must therefore be authorized on its own terms.
const APPROVAL='SEC-2026-09-15/remote-inference-approved';
// Captured once, before any fixture replaces the global, so a nested fixture can
// never issue its own requests through another fixture's recorder.
const REAL_FETCH=globalThis.fetch;
const ENV=['OLLAMA_BASE_URL','OLLAMA_MODEL','OLLAMA_API_KEY','OLLAMA_REMOTE_AUTHORIZATION'];
const personId=randomUUID();
const dataset=()=>({constituents:[{id:personId,name:'Converted buyer constituent',type:'Individual',preference:'Email',notes:'REAL_CONVERTED_BUYER_NOTE'}],gifts:[],tasks:[],grants:[],volunteers:[]});

// No provider object is injected: exactly what server/app.js does, so the module
// resolves its endpoint from the server environment and would open the
// connection itself. globalThis.fetch is replaced by a recorder that refuses to
// perform any request, so a gate failure shows up as a recorded attempt.
async function fixture(t,{env={},policy={enabled:true,dataMode:'synthetic'},data=dataset()}={}){
 const attempts=[],audits=[];
 const previous=Object.fromEntries(ENV.map(key=>[key,process.env[key]]));
 for(const key of ENV)delete process.env[key];
 Object.assign(process.env,env);
 globalThis.fetch=async(url,options)=>{attempts.push(String(url));return Response.json({done:true,message:{content:'A synthetic answer for review.'}});};
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{req.user={id:'egress-operator',role:'staff'};req.tenantId='egress-workspace';next();});
 installAiRoutes(app,{csrf:(req,res,next)=>next(),write:(req,res,next)=>next(),recheckAccess:()=>true,aiPolicy:policy,
  list:collection=>structuredClone(data[collection]||[]),
  get:(collection,id)=>{const record=(data[collection]||[]).find(item=>item.id===id);if(!record)throw Object.assign(new Error('Record not found'),{status:404});return structuredClone(record);},
  audit:(...args)=>audits.push(args)});
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));globalThis.fetch=REAL_FETCH;for(const key of ENV){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
 return {attempts,audits,
  overview:async()=>{const response=await REAL_FETCH(base+'/api/intelligence');return {status:response.status,json:await response.json()};},
  assist:async()=>{const response=await REAL_FETCH(base+'/api/intelligence/assist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:'help',question:'How do I record a gift?'})});return {status:response.status,json:await response.json()};}};
}

test('an approval reference must name itself and cannot be a boolean flag',()=>{
 assert.equal(recordedRemoteAuthorization(APPROVAL),APPROVAL);
 assert.equal(recordedRemoteAuthorization('  ticket-49281  '),'ticket-49281');
 for(const value of ['1','0','true','TRUE','yes','on','enabled','allowed','ok'])assert.equal(recordedRemoteAuthorization(value),'','a flag must not authorize egress: '+value);
 for(const value of ['','short','   ',null,undefined,'has;semicolon!!','x'.repeat(201),'<script>'])assert.equal(recordedRemoteAuthorization(value),'');
});

test('a synthetic-mode workspace cannot send records to a remote endpoint without its own recorded authorization',async t=>{
 const f=await fixture(t,{env:{OLLAMA_BASE_URL:'https://inference.example.test',OLLAMA_MODEL:'llama3.1',OLLAMA_API_KEY:'SERVER-ONLY-SECRET'}});
 const overview=await f.overview();
 assert.equal(overview.status,200);
 assert.equal(overview.json.provider.configured,false);
 assert.equal(overview.json.provider.processing,'cloud');
 assert.deepEqual(overview.json.provider.egress,{remote:true,transport:'wimblo',authorizationRequired:true,authorizationRecorded:false,reference:null,independentOfDataMode:true,independentOfTransport:true});
 assert.equal(overview.json.tasks.every(task=>!task.enabled),true);
 // The strongest demonstration posture the app can produce still does not authorize egress.
 assert.deepEqual(overview.json.policy,{enabled:true,dataMode:'synthetic'});

 const assist=await f.assist();
 assert.equal(assist.status,503,JSON.stringify(assist.json));
 assert.equal(assist.json.error,REMOTE_EGRESS_REASON);
 assert.match(assist.json.error,/describe how the database was initialised rather than what it holds/);
 assert.deepEqual(f.attempts,[],'a request was attempted to a remote endpoint without recorded authorization');
 assert.equal(assist.json.text,undefined);
 assert.equal(f.audits.at(-1)[4].status,'failed');
 assert.doesNotMatch(JSON.stringify(f.audits),/REAL_CONVERTED_BUYER_NOTE|SERVER-ONLY-SECRET/);
});

test('a boolean-looking authorization does not open egress',async t=>{
 for(const value of ['1','true','yes','on'])await t.test(value,async sub=>{
  const f=await fixture(sub,{env:{OLLAMA_BASE_URL:'https://inference.example.test',OLLAMA_MODEL:'llama3.1',OLLAMA_REMOTE_AUTHORIZATION:value}});
  const assist=await f.assist();
  assert.equal(assist.status,503,value);
  assert.equal(assist.json.error,REMOTE_EGRESS_REASON);
  assert.deepEqual(f.attempts,[],'flag "'+value+'" opened egress');
 });
});

test('a recorded approval opens egress deliberately and is written into the audit entry',async t=>{
 const f=await fixture(t,{env:{OLLAMA_BASE_URL:'https://inference.example.test',OLLAMA_MODEL:'llama3.1',OLLAMA_REMOTE_AUTHORIZATION:APPROVAL}});
 const overview=await f.overview();
 assert.equal(overview.json.provider.configured,true);
 assert.deepEqual(overview.json.provider.egress,{remote:true,transport:'wimblo',authorizationRequired:true,authorizationRecorded:true,reference:APPROVAL,independentOfDataMode:true,independentOfTransport:true});
 const assist=await f.assist();
 assert.equal(assist.status,200,JSON.stringify(assist.json));
 assert.deepEqual(f.attempts,['https://inference.example.test/api/chat']);
 const completed=f.audits.at(-1)[4];
 assert.equal(completed.status,'completed');
 assert.equal(completed.processing,'cloud');
 assert.equal(completed.remoteApproval,APPROVAL,'the standing approval is recorded with every remote generation');
 assert.equal(completed.egressTransport,'wimblo');
});

test('the egress gate and the workspace data gate are independent in both directions',async t=>{
 // Authorized egress, restricted data policy: still refused, by the data gate.
 await t.test('authorized egress still obeys the workspace data policy',async sub=>{
  const restricted=await fixture(sub,{policy:{enabled:true,dataMode:'restricted'},env:{OLLAMA_BASE_URL:'https://inference.example.test',OLLAMA_MODEL:'llama3.1',OLLAMA_REMOTE_AUTHORIZATION:APPROVAL}});
  const blockedByPolicy=await restricted.assist();
  assert.equal(blockedByPolicy.status,403);
  assert.match(blockedByPolicy.json.error,/Restricted records are not sent to a provider/);
  assert.deepEqual(restricted.attempts,[]);
 });
 // Synthetic data policy, unauthorized egress: still refused, by the egress gate.
 await t.test('a synthetic data policy does not stand in for egress authorization',async sub=>{
  const synthetic=await fixture(sub,{env:{OLLAMA_BASE_URL:'https://inference.example.test',OLLAMA_MODEL:'llama3.1'}});
  const blockedByEgress=await synthetic.assist();
  assert.equal(blockedByEgress.status,503);
  assert.equal(blockedByEgress.json.error,REMOTE_EGRESS_REASON);
  assert.deepEqual(synthetic.attempts,[]);
 });
});

test('a cloud-routed model reached through a local client is remote processing and is gated the same way',async t=>{
 await t.test('refused without a recorded approval',async sub=>{
  const proxied=await fixture(sub,{env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_MODEL:'gpt-oss:120b-cloud'}});
  const overview=await proxied.overview();
  assert.equal(overview.json.provider.processing,'cloud');
  assert.equal(overview.json.provider.egress.authorizationRequired,true);
  assert.equal(overview.json.provider.configured,false);
  const assist=await proxied.assist();
  assert.equal(assist.status,503);
  assert.equal(assist.json.error,REMOTE_EGRESS_REASON);
  assert.deepEqual(proxied.attempts,[]);
 });
 await t.test('allowed with a recorded approval',async sub=>{
  const authorized=await fixture(sub,{env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_MODEL:'gpt-oss:120b-cloud',OLLAMA_REMOTE_AUTHORIZATION:APPROVAL}});
  assert.equal((await authorized.assist()).status,200);
  assert.deepEqual(authorized.attempts,['http://127.0.0.1:11434/api/chat']);
 });
});

test('a loopback local model needs no egress authorization and is unchanged',async t=>{
 const f=await fixture(t,{env:{OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_MODEL:'llama3.1'}});
 const overview=await f.overview();
 assert.equal(overview.json.provider.processing,'local');
 assert.deepEqual(overview.json.provider.egress,{remote:false,transport:'wimblo',authorizationRequired:false,authorizationRecorded:false,reference:null,independentOfDataMode:true,independentOfTransport:true});
 assert.equal((await f.assist()).status,200);
 assert.deepEqual(f.attempts,['http://127.0.0.1:11434/api/chat']);
 assert.equal(f.audits.at(-1)[4].remoteApproval,undefined,'a local generation records no remote approval');
});

// The gate is uniform: supplying a transport is not permission. A caller that
// constructs the provider in source is governed exactly like Wimblo's own
// network stack, so /api/intelligence can never report a caller-supplied remote
// transport as an allowed path — it is either approved or refused.
async function injected(t,provider){
 const previous=Object.fromEntries(ENV.map(key=>[key,process.env[key]]));
 for(const key of ENV)delete process.env[key];
 t.after(()=>{for(const key of ENV){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
 const calls=[],audits=[],app=express();app.use(express.json());
 app.use((req,res,next)=>{req.user={id:'egress-operator',role:'staff'};req.tenantId='egress-workspace';next();});
 installAiRoutes(app,{csrf:(req,res,next)=>next(),write:(req,res,next)=>next(),recheckAccess:()=>true,aiPolicy:{enabled:true,dataMode:'synthetic'},
  list:()=>[],get:()=>{throw Object.assign(new Error('Record not found'),{status:404});},audit:(...args)=>audits.push(args),
  provider:{...provider,fetchImpl:async url=>{calls.push(String(url));return Response.json({done:true,message:{content:'A synthetic answer for review.'}});}}});
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 return {calls,audits,
  overview:async()=>(await REAL_FETCH(base+'/api/intelligence')).json(),
  assist:async()=>{const response=await REAL_FETCH(base+'/api/intelligence/assist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:'help',question:'How do I record a gift?'})});return {status:response.status,json:await response.json()};}};
}

test('a caller-supplied transport is governed by the same gate, not exempted by it',async t=>{
 const f=await injected(t,{baseUrl:'https://inference.example.test',model:'llama3.1'});
 const {provider,tasks}=await f.overview();
 assert.equal(provider.egress.transport,'caller-supplied');
 assert.equal(provider.egress.remote,true);
 assert.equal(provider.egress.authorizationRequired,true,'supplying a transport is not permission to send records off this host');
 assert.equal(provider.egress.authorizationRecorded,false);
 assert.equal(provider.egress.independentOfTransport,true);
 // An unapproved caller-supplied remote transport is never reported as usable.
 assert.equal(provider.configured,false);
 assert.equal(tasks.every(task=>!task.enabled),true);
 const assist=await f.assist();
 assert.equal(assist.status,503);
 assert.equal(assist.json.error,REMOTE_EGRESS_REASON);
 assert.deepEqual(f.calls,[],'a caller-supplied transport carried a request without a recorded approval');
});

test('a caller-supplied transport with a recorded approval is allowed and recorded as such',async t=>{
 const f=await injected(t,{baseUrl:'https://inference.example.test',model:'llama3.1',remoteAuthorization:APPROVAL});
 const {provider}=await f.overview();
 assert.equal(provider.configured,true);
 assert.deepEqual(provider.egress,{remote:true,transport:'caller-supplied',authorizationRequired:true,authorizationRecorded:true,reference:APPROVAL,independentOfDataMode:true,independentOfTransport:true});
 assert.equal((await f.assist()).status,200);
 assert.deepEqual(f.calls,['https://inference.example.test/api/chat']);
 assert.equal(f.audits.at(-1)[4].remoteApproval,APPROVAL);
 assert.equal(f.audits.at(-1)[4].egressTransport,'caller-supplied');
});
