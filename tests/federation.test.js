import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync,createSign} from 'node:crypto';
import {createApp} from '../server/app.js';

// A locally generated key pair and a simulated issuer. Nothing in this suite may
// reach a real identity provider: global fetch to any other host is trapped.
const ISSUER='https://issuer.example.test';
const password='SyntheticFederation!2026';
const keyPair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keyPair.publicKey.export({format:'jwk'}),kid:'synthetic-signing-key',use:'sig',alg:'RS256'};
const otherPair=generateKeyPairSync('rsa',{modulusLength:2048});
const b64u=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
function idToken(claims,{header={},key=keyPair.privateKey}={}){
 const signingInput=b64u({alg:'RS256',typ:'JWT',kid:jwk.kid,...header})+'.'+b64u(claims);
 if(header.alg==='none')return signingInput+'.';
 return signingInput+'.'+createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
}
const discoveryDocument={issuer:ISSUER,authorization_endpoint:ISSUER+'/authorize',token_endpoint:ISSUER+'/token',jwks_uri:ISSUER+'/jwks',id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']};
const settings={issuer:ISSUER,clientId:'synthetic-client',redirectUri:'https://workspace.example.test/federation/callback',discoveryUrl:ISSUER+'/.well-known/openid-configuration',roleClaim:'groups',roleMappings:[{claimValue:'crm-staff',role:'staff'},{claimValue:'crm-readonly',role:'viewer'},{claimValue:'crm-event-helper',role:'event-helper'}],allowedEmailDomains:['example.test']};

async function fixture(t,{plan='dedicated',allowFederation=true,allowProductionFederation=false,transport='default'}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-federation-')),dbPath=join(dir,'workspace.sqlite');
 const initialAdmin={name:'Synthetic federation administrator',email:'admin.federation@example.test',password};
 const calls=[];
 const wired=transport==='default'?{
  discovery:async url=>{calls.push(['discovery',url]);return discoveryDocument;},
  jwks:async url=>{calls.push(['jwks',url]);return {keys:[jwk]};}
 }:transport;
 let time=Date.now(),active=true;
 const app=createApp({dbPath,seed:false,tenantId:randomUUID(),initialAdmin,reminderWorker:false,workflowWorker:false,
  tenantInfo:{slug:'federation-workspace',name:'Federation workspace'},isTenantActive:()=>active,
  extensions:{tenantAdministration:{plan,clock:()=>time,...(allowFederation?{allowFederation:true}:{}),...(allowProductionFederation?{allowProductionFederation:true}:{}),...(wired?{transport:wired}:{})}}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}
  return {status:response.status,json,text};
 }
 const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:initialAdmin.email,password})});
 const admin={...await response.json(),cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
 return {request,admin,calls,db:app.locals.db,advance:ms=>{time+=ms;},clock:()=>time,login:async mail=>{const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:mail,password})});return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};},suspend:()=>{active=false;return app.locals.suppressTenantAdministration();}};
}
async function configured(t,options={}){
 const f=await fixture(t,options);
 const saved=await f.request('/tenant-administration/federation',{method:'PUT',session:f.admin,body:{...settings,version:1}});
 assert.equal(saved.status,200,saved.text);
 const discovered=await f.request('/tenant-administration/federation/discovery',{method:'POST',session:f.admin,body:{}});
 assert.equal(discovered.status,200,discovered.text);
 const enabled=await f.request('/tenant-administration/federation/enablement',{method:'POST',session:f.admin,body:{version:discovered.json.federation.version,enabled:true,authorizationReference:'Signed authorization WIMBLO-SSO-0001',reason:'Approved optional federated sign-in boundary'}});
 assert.equal(enabled.status,200,enabled.text);
 return f;
}
async function assertion(f,claimOverrides={},options={}){
 const started=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 assert.equal(started.status,201,started.text);
 const {state,nonce,codeVerifier}=started.json.request;
 const claims={iss:ISSUER,aud:'synthetic-client',sub:'synthetic-subject-1',exp:Math.floor(f.clock()/1000)+300,iat:Math.floor(f.clock()/1000),nonce,email:'invited.person@example.test',email_verified:true,groups:['crm-staff'],...claimOverrides};
 return {started,result:await f.request('/tenant-administration/federation/callback',{method:'POST',session:f.admin,body:{state,codeVerifier,idToken:idToken(claims,options)}}),state,codeVerifier,claims};
}

test('federated sign-in is disabled by default and unconfigured servers refuse every provider action', async t=>{
 const f=await fixture(t,{allowFederation:false,transport:null});
 const view=await f.request('/tenant-administration/federation',{session:f.admin});
 assert.equal(view.status,200,view.text);
 assert.equal(view.json.federation.enabled,false);
 assert.equal(view.json.federation.configured,false);
 assert.equal(view.json.federation.issuer,'');
 assert.deepEqual(view.json.federation.assignableRoles,['staff','viewer','event-helper']);
 for(const [path,body] of [['/tenant-administration/federation',{...settings,version:1}],['/tenant-administration/federation/discovery',{}],['/tenant-administration/federation/authorization',{}],['/tenant-administration/federation/enablement',{version:1,enabled:true,authorizationReference:'No authorization on record',reason:'Unauthorized attempt'}]]){
  const method=path.endsWith('/federation')?'PUT':'POST';
  const denied=await f.request(path,{method,session:f.admin,body});
  assert.equal(denied.status,503,path+' '+denied.text);
  assert.match(denied.json.error,/not configured on this server/);
 }
 assert.equal(f.db.prepare('SELECT enabled FROM federation_settings WHERE id=1').get().enabled,0);
});

test('a plan without the federation connector refuses enablement even on a configured server', async t=>{
 const f=await fixture(t,{plan:'subscription'});
 const denied=await f.request('/tenant-administration/federation',{method:'PUT',session:f.admin,body:{...settings,version:1}});
 assert.equal(denied.status,409,denied.text);
 assert.match(denied.json.error,/Subscription plan does not include the federated sign-in connector/);
 assert.equal(f.db.prepare('SELECT enabled FROM federation_settings WHERE id=1').get().enabled,0);
});

test('a production workspace cannot enable federated sign-in without explicit configuration and recorded authorization', async t=>{
 const f=await fixture(t);
 // The workspace under test is not production; the enablement rule is exercised
 // directly against a production-flagged installation of the same module.
 const {install}=await import('../server/tenantAdministration.js');
 const express=(await import('express')).default;
 const {DatabaseSync}=await import('node:sqlite');
 for(const authorized of [false,true]){
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,role TEXT,password_hash TEXT,active INTEGER DEFAULT 1,version INTEGER DEFAULT 1);CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT,action TEXT,collection TEXT,record_id TEXT,at TEXT,details TEXT);INSERT INTO users VALUES('operator','Synthetic operator','operator@example.test','admin','x',1,1);");
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.user={id:'operator',name:'Synthetic operator',role:'admin'};req.session={csrf:'csrf'};next();});
  install(app,{db,get:()=>{throw Object.assign(new Error('not found'),{status:404});},audit:(u,action,c,r,details={})=>db.prepare('INSERT INTO audit(actor,action,collection,record_id,at,details) VALUES(?,?,?,?,?,?)').run(u?.id||'system',action,c||null,r||null,new Date().toISOString(),JSON.stringify(details)),
   csrf:(req,res,next)=>req.get('X-CSRF-Token')==='csrf'?next():res.status(403).json({error:'Invalid CSRF token'}),
   transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},
   isTenantActive:()=>true,recheckAccess:()=>true,mfaStatus:()=>({available:true,enabled:false,recoveryCodesRemaining:0}),
   fail:(status,message)=>{const e=new Error(message);e.status=status;throw e;},now:()=>new Date().toISOString(),
   tenantInfo:null,production:true,config:{plan:'dedicated',allowFederation:true,allowProductionFederation:authorized,transport:{discovery:async()=>discoveryDocument,jwks:async()=>({keys:[jwk]})}}});
  app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const call=(path,body,method='POST')=>fetch(base+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':'csrf'},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
  assert.equal((await call('/api/tenant-administration/federation',{...settings,version:1},'PUT')).status,200);
  assert.equal((await call('/api/tenant-administration/federation/discovery',{})).status,200);
  const enablement=await call('/api/tenant-administration/federation/enablement',{version:3,enabled:true,authorizationReference:'Signed authorization WIMBLO-SSO-0001',reason:'Production enablement attempt'});
  if(authorized)assert.equal(enablement.status,200,JSON.stringify(enablement.json));
  else{assert.equal(enablement.status,403,JSON.stringify(enablement.json));assert.match(enablement.json.error,/without explicit server configuration and recorded authorization/);}
  assert.equal(db.prepare('SELECT enabled FROM federation_settings WHERE id=1').get().enabled,authorized?1:0);
  await new Promise(r=>server.close(r));db.close();
 }
 assert.ok(f.admin.user);
});

test('discovery, JWKS and an authorization request use the configured boundary transport only', async t=>{
 const savedFetch=globalThis.fetch;let external=0;
 const f=await fixture(t);
 globalThis.fetch=async(url,options)=>{if(!String(url).startsWith('http://127.0.0.1'))external++;return savedFetch(url,options);};
 t.after(()=>{globalThis.fetch=savedFetch;});
 const saved=await f.request('/tenant-administration/federation',{method:'PUT',session:f.admin,body:{...settings,version:1}});
 assert.equal(saved.status,200,saved.text);
 const foreignJwks=await f.request('/tenant-administration/federation',{method:'PUT',session:f.admin,body:{...settings,discoveryUrl:'https://other.example.test/.well-known/openid-configuration',version:saved.json.federation.version}});
 assert.equal(foreignJwks.status,400);
 const escalation=await f.request('/tenant-administration/federation',{method:'PUT',session:f.admin,body:{...settings,roleMappings:[{claimValue:'crm-admins',role:'admin'}],version:saved.json.federation.version}});
 assert.equal(escalation.status,400,'a claim can never be mapped to administrator');
 const discovered=await f.request('/tenant-administration/federation/discovery',{method:'POST',session:f.admin,body:{}});
 assert.equal(discovered.status,200,discovered.text);
 assert.equal(discovered.json.federation.keyCount,1);
 assert.deepEqual(f.calls.map(c=>c[0]),['discovery','jwks']);
 assert.equal(f.calls[1][1],ISSUER+'/jwks');
 const beforeEnablement=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 assert.equal(beforeEnablement.status,409,'an authorization request requires an enabled boundary');
 const enabled=await f.request('/tenant-administration/federation/enablement',{method:'POST',session:f.admin,body:{version:discovered.json.federation.version,enabled:true,authorizationReference:'Signed authorization WIMBLO-SSO-0001',reason:'Approved optional boundary'}});
 assert.equal(enabled.status,200,enabled.text);
 const started=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 assert.equal(started.status,201,started.text);
 const url=new URL(started.json.request.authorizationUrl);
 assert.equal(url.origin+url.pathname,ISSUER+'/authorize');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('state'),started.json.request.state);
 assert.equal(url.searchParams.get('nonce'),started.json.request.nonce);
 assert.ok(url.searchParams.get('code_challenge').length>=43);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM federation_requests WHERE state_hash=?').get(started.json.request.state).n,0,'raw state is never stored');
 assert.equal(external,0,'no request left the local test harness');
});

test('a validated assertion maps claims to a non-administrator role and issues no workspace session', async t=>{
 const f=await configured(t);
 const {result}=await assertion(f);
 assert.equal(result.status,200,result.text);
 assert.equal(result.json.assertion.mappedRole,'staff');
 assert.equal(result.json.assertion.sessionIssued,false);
 assert.match(result.json.assertion.mfa,/never satisfied by a federated assertion/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,1,'the boundary creates no account');
 assert.equal(f.db.prepare('SELECT session_issued FROM federation_assertions').get().session_issued,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='validate_federated_assertion'").get().n,1);
 assert.throws(()=>f.db.exec('DELETE FROM federation_assertions'),/retained/i);
 const helper=await assertion(f,{groups:['crm-event-helper'],sub:'synthetic-subject-2'});
 assert.equal(helper.result.json.assertion.mappedRole,'event-helper');
});

test('state, nonce, PKCE, signature, audience, issuer and expiry are each enforced at the callback', async t=>{
 const f=await configured(t);
 const replay=await assertion(f);
 assert.equal(replay.result.status,200,replay.result.text);
 const reused=await f.request('/tenant-administration/federation/callback',{method:'POST',session:f.admin,body:{state:replay.state,codeVerifier:replay.codeVerifier,idToken:idToken(replay.claims)}});
 assert.equal(reused.status,409,'a state value is single use');
 const unknown=await f.request('/tenant-administration/federation/callback',{method:'POST',session:f.admin,body:{state:'x'.repeat(43),codeVerifier:'y'.repeat(43),idToken:idToken(replay.claims)}});
 assert.equal(unknown.status,401);
 const wrongVerifier=await assertion(f);
 assert.equal(wrongVerifier.result.status,200);
 const cases=[
  [{},{header:{alg:'none'}},400,/RS256/],
  [{},{header:{kid:'unknown-key'}},400,/No published signing key/],
  [{},{key:otherPair.privateKey},401,/signature did not verify/],
  [{iss:'https://attacker.example.test'},{},401,/different issuer/],
  [{aud:'another-client'},{},401,/different client/],
  [{exp:Math.floor(Date.now()/1000)-10},{},401,/expired/],
  [{nonce:'a-different-nonce'},{},401,/nonce/],
  [{sub:''},{},401,/subject/],
  [{email:'person@elsewhere.test'},{},403,/approved email domains/],
  [{email_verified:false},{},403,/has not verified/],
  [{groups:['crm-unmapped']},{},403,/No approved claim-to-role mapping/],
  [{groups:[]},{},403,/No approved claim-to-role mapping/]
 ];
 for(const [claims,options,status,message] of cases){
  const attempt=await assertion(f,claims,options);
  assert.equal(attempt.result.status,status,JSON.stringify(claims)+' '+attempt.result.text);
  assert.match(attempt.result.json.error,message);
 }
 const mismatched=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 const badVerifier=await f.request('/tenant-administration/federation/callback',{method:'POST',session:f.admin,body:{state:mismatched.json.request.state,codeVerifier:'z'.repeat(43),idToken:idToken({...replay.claims,nonce:mismatched.json.request.nonce})}});
 assert.equal(badVerifier.status,401);
 assert.match(badVerifier.json.error,/PKCE verifier/);
 const expiredRequest=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 f.advance(11*60*1000);
 const stale=await f.request('/tenant-administration/federation/callback',{method:'POST',session:f.admin,body:{state:expiredRequest.json.request.state,codeVerifier:expiredRequest.json.request.codeVerifier,idToken:idToken({...replay.claims,nonce:expiredRequest.json.request.nonce})}});
 assert.equal(stale.status,401);
 assert.match(stale.json.error,/expired/i);
});

test('the federation boundary is administrator-only, CSRF-protected and stops when the workspace is suspended', async t=>{
 const f=await configured(t);
 const created=await f.request('/users',{method:'POST',session:f.admin,body:{name:'Synthetic federation staff',email:'staff.federation@example.test',password,role:'staff'}});
 assert.equal(created.status,201,created.text);
 const staff=await f.login('staff.federation@example.test');
 for(const [path,method,body] of [['/tenant-administration/federation','GET',undefined],['/tenant-administration/federation','PUT',{...settings,version:1}],['/tenant-administration/federation/discovery','POST',{}],['/tenant-administration/federation/authorization','POST',{}],['/tenant-administration/federation/callback','POST',{state:'x'.repeat(43),codeVerifier:'y'.repeat(43),idToken:'a.b.c'}]]){
  const denied=await f.request(path,{method,session:staff,body});
  assert.equal(denied.status,403,path+' '+denied.text);
  assert.equal(denied.json.error,'Administrator required');
 }
 const noCsrf=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,csrf:false,body:{}});
 assert.equal(noCsrf.status,403);
 assert.equal(noCsrf.json.error,'Invalid CSRF token');
 const started=await f.request('/tenant-administration/federation/authorization',{method:'POST',session:f.admin,body:{}});
 assert.equal(started.status,201,started.text);
 f.suspend();
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM federation_requests WHERE consumed_at IS NULL').get().n,0,'suspension closes queued sign-in attempts');
 const suspended=await f.request('/tenant-administration/federation',{session:f.admin});
 assert.equal(suspended.status,403);
 assert.equal(suspended.json.error,'Workspace is suspended');
 assert.equal(f.db.prepare('SELECT enabled FROM federation_settings WHERE id=1').get().enabled,1,'suspension retains configuration without granting access');
});
