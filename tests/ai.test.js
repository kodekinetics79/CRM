import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {installAiRoutes,computePriorities} from '../server/ai.js';

const personId=randomUUID(),giftId=randomUUID(),otherId=randomUUID();
const today=new Date().toISOString().slice(0,10);
const person={id:personId,name:'Taylor Example',type:'Individual',preference:'Email',email:'private@example.test',phone:'555-123-1234',notes:'PRIVATE NOTE MUST NOT LEAVE',contacts:[{name:'Private additional contact'}]};
const gift={id:giftId,constituentId:personId,amount:12500,type:'Cash',date:today,status:'Posted',notes:'PRIVATE GIFT NOTE',externalRef:'PRIVATE REF'};
const dataset=()=>({constituents:[{...person}],gifts:[{...gift}],tasks:[{id:randomUUID(),title:'Review support',status:'Open',dueDate:today}],grants:[],volunteers:[]});
// Remote and cloud-routed egress requires its own recorded approval reference,
// independent of the workspace data mode and of who supplies the transport.
const CLOUD_APPROVAL='SEC-2026-09-15/cloud-inference-approved';
async function fixture(t,{provider={},policy={enabled:true,dataMode:'synthetic'},data=dataset(),fetchImpl,recheckAccess=()=>true,getGrantMilestones,getFundraisingNextActions,limitNow}={}){
 const calls=[],audits=[],scopes=[];const other=dataset();other.constituents[0]={...person,id:otherId,name:'Other tenant person'};other.gifts=[];
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{if(req.get('X-Test-Role')!=='anonymous')req.user={id:req.get('X-Test-User')||'test-user',role:req.get('X-Test-Role')||'staff'};req.tenantId=req.get('X-Test-Tenant')||'first';next();});
 const csrf=(req,res,next)=>req.get('X-CSRF-Token')==='test-token'?next():res.status(403).json({error:'Invalid CSRF token'});
 const write=(req,res,next)=>['admin','staff'].includes(req.user?.role)?next():res.status(403).json({error:'Readonly role'});
 installAiRoutes(app,{csrf,write,recheckAccess,getGrantMilestones,getFundraisingNextActions,limitNow,aiPolicy:policy,list:(collection,req)=>{scopes.push(req.tenantId);return (req.tenantId==='other'?other:data)[collection]||[];},get:(collection,id,req)=>{scopes.push(req.tenantId);const r=((req.tenantId==='other'?other:data)[collection]||[]).find(r=>r.id===id);if(!r)throw Object.assign(new Error('Record not found'),{status:404});return r;},audit:(...args)=>audits.push(args),provider:{model:'test-model',baseUrl:'http://127.0.0.1:11434',fetchImpl:async(url,options)=>{calls.push({url,options});return fetchImpl?fetchImpl(url,options):Response.json({message:{role:'assistant',content:'A factual response for review.'},done:true});},...provider}});
 app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.status?err.message:'Unexpected error'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path='/api/intelligence/assist',{body={task:'help',question:'How do I record a gift?'},method='POST',role='staff',csrf=true,tenant='first',userId='test-user'}={}){
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Test-Role':role,'X-Test-Tenant':tenant,'X-Test-User':userId,...(csrf?{'X-CSRF-Token':'test-token'}:{})},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:r.status,json:await r.json(),headers:r.headers};
 }
 return {request,calls,audits,data,scopes};
}

test('saved-fact priorities have supporting references and remain available without a model',async t=>{
 const f=await fixture(t,{provider:{model:''}});const r=await f.request('/api/intelligence',{method:'GET'});
 assert.equal(r.status,200);assert.equal(r.json.provider.configured,false);assert.equal(r.json.priorities.length,2);assert.ok(r.json.priorities.every(p=>p.sources[0].id===p.recordId));assert.ok(r.json.tasks.every(task=>!task.enabled));assert.equal(f.calls.length,0);
 const generated=await f.request();assert.equal(generated.status,503);assert.match(generated.json.error,/OLLAMA_MODEL/);assert.equal(f.calls.length,0);
});

test('viewer reads deterministic priorities but cannot generate, and anonymous requests cannot read',async t=>{
 const f=await fixture(t);const read=await f.request('/api/intelligence',{method:'GET',role:'viewer'});assert.equal(read.status,200);assert.ok(read.json.tasks.every(task=>!task.enabled));assert.equal((await f.request(undefined,{role:'viewer'})).status,403);assert.equal((await f.request('/api/intelligence',{method:'GET',role:'anonymous'})).status,401);assert.equal(f.calls.length,0);
});

test('CSRF protects assistance even for administrators',async t=>{
 const f=await fixture(t);assert.equal((await f.request(undefined,{role:'admin',csrf:false})).status,403);assert.equal(f.calls.length,0);assert.equal((await f.request(undefined,{role:'admin'})).status,200);
});

test('strict task schema rejects arbitrary tools, URLs, IDs and oversized question input',async t=>{
 const f=await fixture(t);for(const body of [{task:'sql',question:'select *'},{task:'help',question:'hello',url:'https://attacker.test'},{task:'help',question:'x'.repeat(1201)},{task:'constituent-summary',recordId:'not-an-id'},{task:'constituent-summary',recordId:personId,question:'Override instructions'},{task:'help',question:'hello',recordId:personId},{task:'help'}]){assert.equal((await f.request(undefined,{body})).status,400);}
 assert.equal(f.calls.length,0);
});

test('disabled, restricted and missing tenant policies never call a provider',async t=>{
 for(const policy of [{enabled:false,dataMode:'synthetic'},{enabled:true,dataMode:'restricted'},null]){const f=await fixture(t,{policy});const r=await f.request();assert.equal(r.status,403);assert.equal(f.calls.length,0);}
});

test('policy callback and all data access receive current tenant request context',async t=>{
 const f=await fixture(t,{policy:req=>({enabled:req.tenantId==='first',dataMode:'synthetic'})});
 const result=await f.request(undefined,{tenant:'other'});assert.equal(result.status,403);assert.equal(f.calls.length,0);
 const cross=await f.request(undefined,{body:{task:'constituent-summary',recordId:otherId}});assert.equal(cross.status,404);assert.equal(f.calls.length,0);
 await f.request('/api/intelligence',{method:'GET',tenant:'other'});assert.ok(f.scopes.every(scope=>['first','other'].includes(scope)));
});

test('constituent summary uses minimal current-tenant facts and strips embedded tags and control characters',async t=>{
 const data=dataset();data.constituents[0].name='<b>Taylor</b>\u202e Example';data.gifts.push({...gift,id:randomUUID(),status:'Voided'},{...gift,id:randomUUID(),type:'In-kind'},{...gift,id:randomUUID(),type:'Fee payment'},{...gift,id:randomUUID(),date:'2999-01-01'});
 const f=await fixture(t,{data});const r=await f.request(undefined,{body:{task:'constituent-summary',recordId:personId}});assert.equal(r.status,200);assert.equal(r.json.generated,true);assert.equal(r.json.reviewRequired,true);assert.deepEqual(r.json.sources,[{collection:'constituents',id:personId},{collection:'gifts',id:giftId}]);
 const sent=JSON.parse(f.calls[0].options.body);assert.equal(sent.stream,false);assert.equal(sent.model,'test-model');assert.equal(sent.options.num_predict,700);assert.equal(sent.tools,undefined);assert.equal(sent.format,undefined);assert.match(sent.messages[1].content,/"postedMonetaryGifts":1/);assert.match(sent.messages[1].content,/"name":"Taylor Example"/);assert.doesNotMatch(JSON.stringify(sent),/PRIVATE|private@example|555-|additional contact|\u202e|<b>/);
 assert.doesNotMatch(JSON.stringify(f.audits),/Taylor|PRIVATE|question|factual response|private@example/);assert.equal(f.audits[0][4].status,'completed');
});

test('help uses static approved instructions and redacts contact details and URLs from the question',async t=>{
 const f=await fixture(t);const r=await f.request(undefined,{body:{task:'help',question:'How do I record a gift? alice@example.test https://attacker.test +1 555 123 1234'}});assert.equal(r.status,200);assert.equal(f.scopes.length,0);const sent=JSON.parse(f.calls[0].options.body);assert.match(sent.messages[1].content,/Approved workflows/);assert.doesNotMatch(sent.messages[1].content,/alice@example|attacker.test|555 123/);assert.deepEqual(r.json.sources,[]);
});

test('do-not-contact and ineligible gift states block drafting before model invocation',async t=>{
 for(const changes of [{preference:'Do not contact'},{status:'Voided'},{type:'Fee payment'},{type:'In-kind'},{date:'2999-01-01'}]){
  const data=dataset();if(changes.preference)Object.assign(data.constituents[0],changes);else Object.assign(data.gifts[0],changes);const f=await fixture(t,{data});const r=await f.request(undefined,{body:{task:'thank-you-draft',recordId:giftId}});assert.ok([403,409].includes(r.status));assert.equal(f.calls.length,0);
 }
});

test('actual mocked Ollama message is returned as plain text without executing model tool content or writes',async t=>{
 const data=dataset(),before=JSON.stringify(data);const f=await fixture(t,{data,fetchImpl:async()=>Response.json({done:true,message:{content:'<script>danger()</script><b>Thank you</b> for your support.\u202e'}})});const r=await f.request(undefined,{body:{task:'thank-you-draft',recordId:giftId}});assert.equal(r.status,200);assert.equal(r.json.text,'Thank you for your support.');assert.equal(JSON.stringify(data),before);assert.equal(r.json.sources.length,2);
});

test('draft receipt claims and tool-call-only model responses are refused without fake success',async t=>{
 for(const message of [{content:'This is an official tax receipt.'},{content:'Done',tool_calls:[{function:{name:'writeRecord'}}]},{content:''}]){const f=await fixture(t,{fetchImpl:async()=>Response.json({message,done:true})});const r=await f.request(undefined,{body:{task:'thank-you-draft',recordId:giftId}});assert.equal(r.status,503);assert.equal(r.json.generated,undefined);assert.equal(f.audits[0][4].status,'failed');}
});

test('cloud credentials stay server-only and configured cloud models reached locally report cloud processing',async t=>{
 const f=await fixture(t,{provider:{model:'gpt-oss:120b-cloud',baseUrl:'https://ollama.com',apiKey:'SERVER-SECRET',remoteAuthorization:CLOUD_APPROVAL}});const r=await f.request('/api/intelligence',{method:'GET'});assert.equal(r.json.provider.processing,'cloud');assert.doesNotMatch(JSON.stringify(r.json),/SERVER-SECRET|https:\/\/ollama|120b/);assert.equal((await f.request()).status,200);assert.equal(f.calls[0].url,'https://ollama.com/api/chat');assert.equal(f.calls[0].options.headers.Authorization,'Bearer SERVER-SECRET');assert.equal(f.calls[0].options.redirect,'error');assert.doesNotMatch(JSON.stringify(f.audits),/SERVER-SECRET/);
 const proxy=await fixture(t,{provider:{model:'gpt-oss:120b-cloud',remoteAuthorization:CLOUD_APPROVAL}});assert.equal((await proxy.request('/api/intelligence',{method:'GET'})).json.provider.processing,'cloud');await proxy.request();assert.equal(proxy.calls[0].options.headers.Authorization,undefined);
});

test('remote and cloud-routed egress is refused without a recorded approval, whoever supplies the transport',async t=>{
 // The fixture always injects its own fetch implementation. Supplying a
 // transport is not permission to send workspace records off this host, so each
 // of these is refused with nothing attempted.
 for(const provider of [{model:'gpt-oss:120b-cloud',baseUrl:'https://ollama.com',apiKey:'SERVER-SECRET'},{model:'gpt-oss:120b-cloud'},{model:'llama3.1',baseUrl:'https://inference.example.test'}]){
  const f=await fixture(t,{provider});
  const overview=await f.request('/api/intelligence',{method:'GET'});
  assert.equal(overview.json.provider.processing,'cloud');
  assert.equal(overview.json.provider.configured,false);
  assert.equal(overview.json.provider.egress.authorizationRequired,true);
  assert.equal(overview.json.provider.egress.authorizationRecorded,false);
  assert.equal(overview.json.tasks.every(task=>!task.enabled),true);
  const r=await f.request();
  assert.equal(r.status,503,JSON.stringify(provider));
  assert.match(r.json.error,/OLLAMA_REMOTE_AUTHORIZATION/);
  assert.equal(r.json.generated,undefined);
  assert.equal(f.calls.length,0,'a request was attempted without a recorded approval');
 }
 // A recorded approval is what opens it, and it is recorded with the generation.
 const approved=await fixture(t,{provider:{model:'llama3.1',baseUrl:'https://inference.example.test',remoteAuthorization:CLOUD_APPROVAL}});
 assert.equal((await approved.request()).status,200);
 assert.equal(approved.calls.length,1);
 assert.equal(approved.audits.at(-1)[4].remoteApproval,CLOUD_APPROVAL);
 assert.equal(approved.audits.at(-1)[4].egressTransport,'caller-supplied');
 // A boolean-looking value is not an approval reference.
 for(const value of ['1','true','yes']){
  const flagged=await fixture(t,{provider:{model:'llama3.1',baseUrl:'https://inference.example.test',remoteAuthorization:value}});
  assert.equal((await flagged.request()).status,503,value);
  assert.equal(flagged.calls.length,0,value);
 }
});

test('invalid remote HTTP configuration and missing direct-cloud credentials are unavailable',async t=>{
 for(const provider of [{baseUrl:'http://remote.example.test:11434'},{baseUrl:'https://ollama.com',apiKey:''},{baseUrl:'https://server.example.test/api?secret=value'},{baseUrl:'http://user:password@127.0.0.1:11434'}]){const f=await fixture(t,{provider});assert.equal((await f.request()).status,503);assert.equal(f.calls.length,0);}
});

test('provider timeout aborts the request with no record changes or fabricated response',async t=>{
 const data=dataset(),before=JSON.stringify(data);let signal;const f=await fixture(t,{data,provider:{timeoutMs:15},fetchImpl:async(url,options)=>{signal=options.signal;return new Promise(()=>{});}});const r=await f.request();assert.equal(r.status,503);assert.match(r.json.error,/timed out/);assert.equal(signal.aborted,true);assert.equal(JSON.stringify(data),before);assert.equal(r.json.generated,undefined);assert.equal(f.audits[0][4].status,'failed');
});

test('provider network, HTTP, malformed, incomplete and oversized output failures are clear and bounded',async t=>{
 for(const fetchImpl of [async()=>{throw new Error('secret provider failure');},async()=>new Response('secret error',{status:500}),async()=>new Response('bad json'),async()=>Response.json({message:{content:'Incomplete'},done:false}),async()=>Response.json({message:{content:'x'.repeat(6001)}}),async()=>new Response('x'.repeat(65000))]){const f=await fixture(t,{fetchImpl});const r=await f.request();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.json),/secret/);assert.equal(r.json.generated,undefined);}
});

test('deterministic priorities exclude opt-outs, future gifts, completed tasks and inactive grant stages',()=>{
 const data=dataset();data.constituents[0].preference='Do not contact';data.tasks[0].status='Completed';data.grants=[{id:randomUUID(),stage:'Closed',deadline:'2020-01-01'},{id:randomUUID(),stage:'Awarded',reportDue:'2020-01-01',name:'Saved award'}];assert.equal(computePriorities(data,today).length,1);assert.equal(computePriorities(data,today)[0].kind,'grant');
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('workspace policy disabled or switched to restricted while a model is running withholds the answer',async t=>{
 for(const change of [{enabled:false},{dataMode:'restricted'}]){
  const policy={enabled:true,dataMode:'synthetic'},entered=deferred(),finish=deferred();
  const f=await fixture(t,{policy,fetchImpl:async()=>{entered.resolve();await finish.promise;return Response.json({message:{content:'PRIVATE GENERATED ANSWER'},done:true});}});
  const pending=f.request();await entered.promise;Object.assign(policy,change);finish.resolve();const r=await pending;
  assert.equal(r.status,403);assert.match(r.json.error,/policy changed/);assert.equal(r.json.text,undefined);assert.equal(r.json.generated,undefined);assert.doesNotMatch(JSON.stringify(f.audits),/PRIVATE GENERATED/);assert.equal(f.audits[0][4].status,'failed');
 }
});

test('session revocation or account suspension during model generation is freshly rechecked before disclosure',async t=>{
 let access=true,checks=0;const entered=deferred(),finish=deferred();
 const f=await fixture(t,{recheckAccess:req=>{checks++;assert.equal(req.user.id,'test-user');return access;},fetchImpl:async()=>{entered.resolve();await finish.promise;return Response.json({message:{content:'WITHHELD ANSWER'},done:true});}});
 const pending=f.request();await entered.promise;access=false;finish.resolve();const r=await pending;
 assert.equal(r.status,403);assert.equal(checks,1);assert.match(r.json.error,/access changed/);assert.equal(r.json.text,undefined);assert.doesNotMatch(JSON.stringify(f.audits),/WITHHELD/);
});

test('a missing current-access recheck fails closed before invoking any model',async t=>{
 const f=await fixture(t,{recheckAccess:null});const r=await f.request();assert.equal(r.status,503);assert.match(r.json.error,/access rechecks/);assert.equal(f.calls.length,0);
});

test('a new donor contact opt-out while drafting withholds generated text and creates no communication',async t=>{
 const data=dataset(),entered=deferred(),finish=deferred();
 const f=await fixture(t,{data,fetchImpl:async()=>{entered.resolve();await finish.promise;return Response.json({message:{content:'Dear Taylor, thank you for your support.'},done:true});}});
 const pending=f.request(undefined,{body:{task:'thank-you-draft',recordId:giftId}});await entered.promise;data.constituents[0].preference='Do not contact';const afterChange=JSON.stringify(data);finish.resolve();const r=await pending;
 assert.equal(r.status,403);assert.match(r.json.error,/Do not contact/);assert.equal(r.json.text,undefined);assert.equal(JSON.stringify(data),afterChange);assert.doesNotMatch(JSON.stringify(f.audits),/Taylor|thank you/);
});

test('changed gift recipient or void state while drafting invalidates the stale draft',async t=>{
 for(const change of [{status:'Voided'},{constituentId:otherId}]){
  const data=dataset();data.constituents.push({...person,id:otherId,name:'Another saved recipient'});const entered=deferred(),finish=deferred();
  const f=await fixture(t,{data,fetchImpl:async()=>{entered.resolve();await finish.promise;return Response.json({message:{content:'Thank you for your support.'},done:true});}});
  const pending=f.request(undefined,{body:{task:'thank-you-draft',recordId:giftId}});await entered.promise;Object.assign(data.gifts[0],change);finish.resolve();const r=await pending;
  assert.equal(r.status,409);assert.match(r.json.error,/gift changed/);assert.equal(r.json.text,undefined);
 }
});

test('per-user concurrency blocks duplicate cloud requests while another user can proceed',async t=>{
 const entered=deferred(),otherEntered=deferred(),finish=deferred();let started=0;
 const f=await fixture(t,{fetchImpl:async()=>{started++;(started===1?entered:otherEntered).resolve();await finish.promise;return Response.json({message:{content:'A complete answer.'},done:true});}});
 const first=f.request();await entered.promise;const blocked=await f.request();assert.equal(blocked.status,429);assert.match(blocked.json.error,/already running/);assert.equal(blocked.headers.get('retry-after'),'20');assert.equal(f.calls.length,1);
 const other=f.request(undefined,{userId:'other-user'});await otherEntered.promise;assert.equal(f.calls.length,2);finish.resolve();assert.equal((await first).status,200);assert.equal((await other).status,200);assert.equal((await f.request()).status,200);
});

test('six-call fixed window resets and priority reads do not consume per-user model quota',async t=>{
 let now=1000;const f=await fixture(t,{limitNow:()=>now});
 for(let i=0;i<10;i++)assert.equal((await f.request('/api/intelligence',{method:'GET'})).status,200);
 for(let i=0;i<6;i++)assert.equal((await f.request()).status,200);
 assert.equal(f.calls.length,6);const limited=await f.request();assert.equal(limited.status,429);assert.match(limited.json.error,/six model requests per minute/);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(f.calls.length,6);
 assert.equal((await f.request('/api/intelligence',{method:'GET'})).status,200);assert.equal((await f.request(undefined,{userId:'separate-user'})).status,200);
 now+=60000;assert.equal((await f.request()).status,200);assert.equal(f.calls.length,8);
});

test('a failed provider call releases concurrency but still consumes the model-request window',async t=>{
 let invocation=0;const f=await fixture(t,{fetchImpl:async()=>{invocation++;if(invocation===1)throw new Error('Provider unavailable');return Response.json({message:{content:'Successful second response.'},done:true});}});
 assert.equal((await f.request()).status,503);assert.equal((await f.request()).status,200);assert.equal(f.calls.length,2);
});

test('workflow help rejects invented Submit controls and unsupported sending instructions',async t=>{
 for(const content of ['Click the Submit button to record the gift.','Communications are drafts until you send them.','You can send the draft to the donor.','Wimblo automatically sends acknowledgments.','Click Send now.']){
  const f=await fixture(t,{fetchImpl:async()=>Response.json({message:{content},done:true})});const r=await f.request();assert.equal(r.status,503,content);assert.match(r.json.error,/unsupported action or control/);assert.equal(r.json.generated,undefined);assert.equal(r.json.text,undefined);
 }
});

test('approved help names real save controls and states unsent/manual capability limits',async t=>{
 const content='Choose Record a gift, use Split gift to allocate the whole amount, then choose Save gift. Wimblo cannot send messages or collect payments. Receipt register retains preparation and staff-confirmed Print issuance history; staff perform printing and hand-signing. There is no Send button. Communications drafts remain unsent. Record completed action logs only an acknowledgment you already performed.';
 const f=await fixture(t,{fetchImpl:async()=>Response.json({message:{content},done:true})});const r=await f.request();assert.equal(r.status,200);assert.equal(r.json.text,content);const sent=JSON.parse(f.calls[0].options.body);assert.match(sent.messages[0].content,/does not send messages, collect payments, physically print or sign receipts/);assert.match(sent.messages[1].content,/never an invented Submit button/);assert.match(sent.messages[1].content,/Drafts do not become sendable/);assert.match(sent.messages[1].content,/Record completed action/);
});

test('authorized exact milestone matching suppresses only corresponding legacy grant dates and exposes recorded open facts',()=>{
 const grantId=randomUUID(),data={grants:[{id:grantId,name:'Saved community grant',stage:'Preparing',deadline:today}],grantMilestones:[{id:randomUUID(),grantId,name:'Recorded application',kind:'Application',dueDate:today,status:'Completed',owner:{id:'owner',name:'Saved owner'}}]};assert.deepEqual(computePriorities(data,today),[]);
 data.grantMilestones[0].status='Open';let queue=computePriorities(data,today);assert.equal(queue.length,1);assert.equal(queue[0].milestoneId,data.grantMilestones[0].id);assert.equal(queue[0].recordId,grantId);assert.match(queue[0].detail,/Saved owner/);assert.match(queue[0].detail,/no external submission is claimed/);assert.deepEqual(queue[0].sources,[{collection:'grants',id:grantId},{collection:'grantMilestones',id:data.grantMilestones[0].id}]);
 for(const change of [{dueDate:'2020-01-01'},{kind:'Report'},{kind:'Agreement'},{grantId:randomUUID()}]){const saved={...data.grantMilestones[0]};Object.assign(data.grantMilestones[0],change,{status:'Completed'});queue=computePriorities(data,today);assert.equal(queue.length,1);assert.equal(queue[0].title,'Review a grant deadline');Object.assign(data.grantMilestones[0],saved);}
 data.grants[0]={...data.grants[0],stage:'Awarded',reportDue:today};data.grantMilestones[0]={...data.grantMilestones[0],kind:'Application',status:'Completed'};assert.equal(computePriorities(data,today)[0].title,'Review a grant report date');data.grantMilestones[0].kind='Report';assert.deepEqual(computePriorities(data,today),[]);
});

test('milestone callbacks receive current role and tenant scope and fail closed without provider calls',async t=>{
 const data=dataset(),grantId=randomUUID(),seen=[];data.tasks=[];data.gifts=[];data.grants=[{id:grantId,name:'Current tenant grant',stage:'Preparing',deadline:today}];
 const f=await fixture(t,{data,getGrantMilestones:req=>{seen.push({role:req.user.role,tenant:req.tenantId});return req.user.role==='admin'?[{id:randomUUID(),grantId,name:'Private completion',kind:'Application',dueDate:today,status:'Completed',owner:{name:'Owner'}}]:[];}});
 assert.equal((await f.request('/api/intelligence',{method:'GET',role:'admin'})).json.priorities.length,0);const staff=await f.request('/api/intelligence',{method:'GET',role:'staff'});assert.equal(staff.json.priorities.length,1);assert.doesNotMatch(JSON.stringify(staff.json),/Private completion/);await f.request('/api/intelligence',{method:'GET',tenant:'other',role:'viewer'});assert.deepEqual(seen,[{role:'admin',tenant:'first'},{role:'staff',tenant:'first'},{role:'viewer',tenant:'other'}]);assert.equal(f.calls.length,0);
 for(const getGrantMilestones of [()=>{throw new Error('private schema detail');},()=>null]){const broken=await fixture(t,{getGrantMilestones}),result=await broken.request('/api/intelligence',{method:'GET'});assert.equal(result.status,503);assert.equal(result.json.priorities,undefined);assert.doesNotMatch(JSON.stringify(result.json),/private schema/);assert.equal(broken.calls.length,0);}
});

import {createApp} from '../server/app.js';
async function actualGrantQueueFixture(t){
 const app=createApp({dbPath:':memory:',seed:true,mfaKey:''}),server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();});const base=`http://127.0.0.1:${server.address().port}/api`;
 async function request(path,{method='GET',session,body}={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email){const r=await request('/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200);return {...r.json,cookie:r.headers.get('set-cookie').split(';')[0]};}const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 // Reconcile only this isolated synthetic fixture's existing queue so the 20-row
 // priority bound cannot hide the test grant behind unrelated gift reminders.
 const initial=(await request('/workspace',{session:admin})).json.data,people=new Map(initial.constituents.map(p=>[p.id,p]));
 for(const task of initial.tasks)if(task.status!=='Completed'){const r=await request('/records/tasks/'+task.id,{method:'PATCH',session:admin,body:{version:task.version,status:'Completed'}});assert.equal(r.status,200);}
 for(const g of initial.gifts)if(g.status!=='Voided'&&!['Fee payment','In-kind'].includes(g.type)&&g.date<=today&&!g.acknowledgment&&people.get(g.constituentId)?.preference!=='Do not contact'){const r=await request('/gifts/'+g.id+'/acknowledge',{method:'POST',session:admin,body:{version:g.version,date:today,channel:'Post',notes:'Isolated queue fixture setup'}});assert.equal(r.status,200,JSON.stringify(r.json));}
 async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',session:admin,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const grant=await create('grants',{name:'Queue integration grant',amount:10000,stage:'Preparing',deadline:today});
 async function milestone(changes={}){const r=await request('/grant-operations',{method:'POST',session:staff,body:{grantId:grant.id,grantVersion:1,name:'Queue application milestone',kind:'Application',dueDate:today,ownerId:staff.user.id,ownerVersion:1,...changes}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.milestone;}
 async function document(visibility='Workspace'){const r=await request('/documents',{method:'POST',session:admin,body:{collection:'grants',recordId:grant.id,title:'Queue completion evidence',category:'Proposal',visibility,status:'Final',evidenceDate:today,filename:'queue.txt',contentBase64:Buffer.from('Actual saved completion proof').toString('base64')}});assert.equal(r.status,201);return r.json.document;}
 async function complete(m,d){return request('/grant-operations/'+m.id+'/complete',{method:'POST',session:admin,body:{version:m.version,grantVersion:1,ownerVersion:1,documentId:d.id,documentVersion:d.version,revision:1,completedDate:today,reference:'Human-confirmed application reference',confirmed:true}});}
 async function priorities(session=staff){const r=await request('/intelligence',{session});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.priorities.filter(p=>p.recordId===grant.id);}
 return {request,admin,staff,viewer,grant,milestone,document,complete,priorities,db:app.locals.db};
}

test('actual completed matching application removes stale queue reminder and reopen restores sourced owner/date without financial writes',async t=>{
 const f=await actualGrantQueueFixture(t),before=f.db.prepare("SELECT data FROM records WHERE collection IN ('grants','gifts') ORDER BY collection,id").all();assert.equal((await f.priorities()).length,1);const m=await f.milestone(),open=await f.priorities();assert.equal(open.length,1);assert.equal(open[0].milestoneId,m.id);assert.match(open[0].detail,/Recorded due|recorded due/);assert.match(open[0].detail,/Owner:/);const d=await f.document(),done=await f.complete(m,d);assert.equal(done.status,200);assert.deepEqual(await f.priorities(),[]);assert.deepEqual(await f.priorities(f.viewer),[]);
 const reopen=await f.request('/grant-operations/'+m.id+'/reopen',{method:'POST',session:f.staff,body:{version:done.json.milestone.version,reason:'Reviewed need for updated evidence'}});assert.equal(reopen.status,200);assert.equal((await f.priorities())[0].milestoneId,m.id);assert.deepEqual(f.db.prepare("SELECT data FROM records WHERE collection IN ('grants','gifts') ORDER BY collection,id").all(),before);
});

test('actual unrelated completed milestone date cannot suppress a legacy deadline and private exact completion is not disclosed',async t=>{
 const f=await actualGrantQueueFixture(t),different=await f.milestone({dueDate:'2020-01-01'}),publicProof=await f.document();assert.equal((await f.complete(different,publicProof)).status,200);assert.equal((await f.priorities()).length,1);assert.equal((await f.priorities())[0].title,'Review a grant deadline');
 const exact=await f.milestone({name:'Restricted exact milestone'}),privateProof=await f.document('Administrators');assert.equal((await f.complete(exact,privateProof)).status,200);assert.deepEqual(await f.priorities(f.admin),[]);const staff=await f.priorities(f.staff),viewer=await f.priorities(f.viewer);for(const queue of [staff,viewer]){assert.equal(queue.length,1);assert.equal(queue[0].title,'Review a grant deadline');assert.doesNotMatch(JSON.stringify(queue),/Restricted exact|Human-confirmed|Queue completion evidence/);assert.equal(queue[0].milestoneId,undefined);}
});


test('major follow-up priorities use current scoped lifecycle data without a model and fail closed on missing projection',async t=>{
 const id=randomUUID(),due={id,name:'Exact major follow-up',stage:'Asked',nextActionStatus:'Open',nextActionDate:today,owner:{name:'Saved owner'}};
 const seen=[],f=await fixture(t,{data:{},getFundraisingNextActions:req=>{seen.push(req.tenantId);return req.tenantId==='first'?[due]:[];}});
 const read=await f.request('/api/intelligence',{method:'GET',role:'viewer'});assert.equal(read.status,200);assert.equal(read.json.priorities.length,1);assert.equal(read.json.priorities[0].recordId,id);assert.equal(read.json.priorities[0].view,'fundraising');assert.match(read.json.priorities[0].detail,/no income/);assert.equal(f.calls.length,0);
 assert.ok(!(await f.request('/api/intelligence',{method:'GET',tenant:'other'})).json.priorities.some(p=>p.kind==='fundraising'));assert.deepEqual(seen,['first','other']);
 for(const change of [{nextActionStatus:'Completed'},{nextActionStatus:'Cancelled'},{stage:'Closed'},{stage:'Declined'},{nextActionDate:'2999-01-01'}])assert.deepEqual(computePriorities({fundraisingNextActions:[{...due,...change}]}),[]);
 const broken=await fixture(t,{getFundraisingNextActions:()=>{throw new Error('private projection failure');}});const rejected=await broken.request('/api/intelligence',{method:'GET'});assert.equal(rejected.status,503);assert.doesNotMatch(JSON.stringify(rejected.json),/private projection failure/);assert.equal(broken.calls.length,0);
});
