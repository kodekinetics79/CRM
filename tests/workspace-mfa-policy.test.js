import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {workspaceMfaRequired,workspaceMfaSessionAllowed,workspaceMfaOwnerAllowed} from '../server/workspaceMfaPolicy.js';
import {createApp} from '../server/app.js';
import {totp} from '../server/mfa.js';

test('production policy denies missing factors and inconsistent session parity; local optional factors remain optional',()=>{
 assert.equal(workspaceMfaRequired(true),true);
 for(const production of [false,true])for(const enabled of [false,true])for(const available of [false,true])for(const verified of [0,1]){
  const expected=enabled?available&&verified===1:!production&&verified===0;
  assert.equal(workspaceMfaSessionAllowed(production,{enabled,available},{mfa_verified:verified}),expected);
  assert.equal(workspaceMfaOwnerAllowed(production,{enabled,available}),enabled?available:!production);
 }
 assert.equal(workspaceMfaSessionAllowed(true,null,{mfa_verified:1}),false);
 assert.equal(workspaceMfaSessionAllowed(false,{},{}),false);
});

test('production role changes never convert password-only enrollment sessions into workspace authority',async t=>{
 const values={NODE_ENV:'production',APP_ORIGIN:'https://mfa-policy.example.test',TRUST_PROXY:'true',ENABLE_ACCEPTANCE:'false',ALLOW_DEMO:'false',EVALUATOR_MODE:'false'};
 const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 let app,server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));app?.locals.close();for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const password='InertPolicyFixture!2026',time=1700000010000;
 app=createApp({seed:false,initialAdmin:{name:'Policy operator',email:'mfa-policy@example.test',password},mfaKey:'72'.repeat(32),mfaClock:()=>time,reminderWorker:false,workflowWorker:false});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 async function request(path,{method='GET',body,session}={}){const r=await fetch(base+'/api'+path,{method,headers:{'X-Forwarded-Proto':'https',...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,json:await r.json(),headers:r.headers};}
 const logged=await request('/auth/login',{method:'POST',body:{email:'mfa-policy@example.test',password}});assert.equal(logged.status,200);
 const accountId=logged.json.user.id;
 for(const role of ['admin','staff','viewer','event-helper']){
  app.locals.db.prepare('UPDATE users SET role=? WHERE id=?').run(role,accountId);
  const login=await request('/auth/login',{method:'POST',body:{email:'mfa-policy@example.test',password}});assert.equal(login.status,200);assert.equal(login.json.mfaEnrollmentRequired,true,role);
  const session={...login.json,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
  assert.equal((await request('/auth/me',{session})).json.mfaEnrollmentRequired,true);
  assert.equal((await request('/auth/mfa/status',{session})).json.required,true);
  for(const path of ['/workspace','/records/constituents','/reports/sources','/event-checkin/events','/auth/unknown'])assert.equal((await request(path,{session})).status,403,role+path);
  assert.equal((await request('/auth/mfa/disable',{method:'POST',session,body:{password,code:'123456'}})).status,403);
  assert.equal((await request('/auth/logout',{method:'POST',session,body:{}})).status,200);
 }
 // Enroll as helper, then verify with a recovery factor: MFA grants no broader role privileges.
 const login=await request('/auth/login',{method:'POST',body:{email:'mfa-policy@example.test',password}}),session={...login.json,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 const enroll=await request('/auth/mfa/enroll',{method:'POST',session,body:{password}});assert.equal(enroll.status,200);
 const confirm=await request('/auth/mfa/confirm',{method:'POST',session,body:{code:totp(enroll.json.secret,time)}});assert.equal(confirm.status,200);
 assert.equal((await request('/event-checkin/events',{session})).status,401);
 const challenge=await request('/auth/login',{method:'POST',body:{email:'mfa-policy@example.test',password}});assert.equal(challenge.json.mfaRequired,true);
 const verified=await request('/auth/mfa/verify',{method:'POST',body:{challengeToken:challenge.json.challengeToken,code:confirm.json.recoveryCodes[0]}});assert.equal(verified.status,200);assert.equal(verified.json.mfaEnrollmentRequired,undefined);
 const fresh={...verified.json,cookie:verified.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 assert.equal((await request('/event-checkin/events',{session:fresh})).status,200);
 assert.equal((await request('/workspace',{session:fresh})).status,403);
 assert.equal((await request('/auth/mfa/disable',{method:'POST',session:fresh,body:{password,code:confirm.json.recoveryCodes[1]}})).status,403);
});
