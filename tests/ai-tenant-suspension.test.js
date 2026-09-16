import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('mounted assistance withholds an in-flight answer after tenant suspension and releases its request slot',async t=>{
 const realFetch=globalThis.fetch;
 const overrides={NODE_ENV:'test',EVALUATOR_MODE:'',APP_ORIGIN:'',OLLAMA_MODEL:'synthetic-tenant-suspension',OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_API_KEY:''};
 const originalEnv=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
 const entered=deferred(),finish=deferred();let active=true,providerCalls=0,app,server;
 t.after(async()=>{
  finish.resolve();
  try{if(server)await new Promise(resolve=>server.close(resolve));}
  finally{
   try{app?.locals.close();}
   finally{
    globalThis.fetch=realFetch;
    for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
   }
  }
 });
 Object.assign(process.env,overrides);
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'http://127.0.0.1:11434/api/chat','Only the synthetic loopback model endpoint may be intercepted');
  assert.equal(options.method,'POST');
  assert.equal(options.headers.Authorization,undefined);
  assert.equal(JSON.parse(options.body).model,overrides.OLLAMA_MODEL);
  providerCalls++;
  if(providerCalls===1){entered.resolve();await finish.promise;}
  return Response.json({done:true,message:{content:providerCalls===1?'WITHHELD_SYNTHETIC_ANSWER':'Fresh synthetic answer for review.'}});
 };
 const operator={name:'Synthetic tenant assistance operator',email:'tenant.assistance@example.test',password:'SyntheticTenantAssistance!2026'};
 app=createApp({seed:false,tenantId:randomUUID(),initialAdmin:operator,mfaKey:'',aiPolicy:{enabled:true,dataMode:'synthetic'},isTenantActive:()=>active,reminderWorker:false,workflowWorker:false});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 async function request(path,body,session){
  const response=await realFetch(base+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},body:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,json:JSON.parse(text),text,headers:response.headers};
 }
 const login=await request('/auth/login',{email:operator.email,password:operator.password});
 assert.equal(login.status,200,login.text);
 const session={...login.json,cookie:login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
 assert.equal(session.user.role,'admin');
 const pending=request('/intelligence/assist',{task:'help',question:'How do I record a gift?'},session);
 await entered.promise;
 active=false;finish.resolve();
 const withheld=await pending;
 assert.equal(withheld.status,403,withheld.text);
 assert.match(withheld.json.error,/access changed/i);
 assert.equal(withheld.json.text,undefined);
 assert.equal(withheld.json.generated,undefined);
 assert.doesNotMatch(withheld.text,/WITHHELD_SYNTHETIC_ANSWER/);
 const attempts=()=>app.locals.db.prepare("SELECT actor,details FROM audit WHERE action='ai_assist' ORDER BY id").all();
 assert.deepEqual(attempts().map(row=>JSON.parse(row.details).status),['failed']);
 assert.equal(providerCalls,1);

 active=true;
 const fresh=await request('/intelligence/assist',{task:'help',question:'How do I review a saved gift?'},session);
 assert.equal(fresh.status,200,fresh.text);
 assert.equal(fresh.json.generated,true);
 assert.equal(fresh.json.reviewRequired,true);
 assert.equal(fresh.json.text,'Fresh synthetic answer for review.');
 assert.equal(providerCalls,2);
 assert.deepEqual(attempts().map(row=>JSON.parse(row.details).status),['failed','completed']);
 assert.ok(attempts().every(row=>row.actor===session.user.id));
 assert.doesNotMatch(JSON.stringify(attempts()),/WITHHELD_SYNTHETIC_ANSWER|Fresh synthetic answer|record a gift|OLLAMA_API_KEY|Authorization/);
});
