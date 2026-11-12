import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {installProductionAuthRoutes} from '../server/production/authRoutes.js';
import {createSessionService} from '../server/production/sessionService.js';
import {createGlobalMfaService} from '../server/production/mfaService.js';
import {totp} from '../server/mfa.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const key=randomBytes(32).toString('base64');

function routeHarness(overrides={}){
 const routes=new Map(),app={get(path,...handlers){routes.set(`GET ${path}`,handlers);},post(path,...handlers){routes.set(`POST ${path}`,handlers);}};
 const identity={identityId:randomUUID(),normalizedEmail:'owner@example.test',displayName:'Owner',passwordHash:'never-serialize-me',status:'active',securityVersion:3};
 const membership={membershipId:randomUUID(),identityId:identity.identityId,tenantId:randomUUID(),role:'owner',status:'active',version:1};
 const session={...identity,identity,membership,identityId:identity.identityId,mfaVerifiedAt:new Date().toISOString(),csrfToken:'csrf'};
 const sessionService={cookieName:'wimblo_session',authenticate:async()=>session,verifyCsrf:()=>true,isRecent:()=>true,clearCookie:()=> 'wimblo_session=; Max-Age=0',issue:async()=>({cookie:'wimblo_session=new-token',csrfToken:'new-csrf'}),logout:async()=>({cookie:'wimblo_session=; Max-Age=0'}),...overrides.sessionService};
 installProductionAuthRoutes(app,{appOrigin:'https://app.example.test',identityService:{authenticatePassword:async()=>identity,listActiveMemberships:async()=>[membership],...overrides.identityService},mfaService:{status:async()=>({enabled:true}),createChallenge:async()=>({}),verifyChallenge:async()=>({}),beginEnrollment:async()=>({}),confirmEnrollment:async()=>({enabled:true,recoveryCodes:['CODE']}),acknowledgeRecoveryCodes:async()=>({ok:true}),resetPendingRecoveryDelivery:async()=>({recoveryCodes:['ROTATED-CODE'],securityVersion:4}),...overrides.mfaService},sessionService});
 return {routes,identity,membership,sessionService};
}

async function invoke(handlers,{session,token='token',body={}}={}){
 const req={body,headers:{cookie:'wimblo_session=token'},productionSession:session,productionSessionToken:token,get(name){return name==='Origin'?'https://app.example.test':name==='X-CSRF-Token'?'csrf':undefined;}};
 const result={status:200,headers:{},body:null};
 const res={setHeader(name,value){result.headers[name]=value;},json(value){result.body=value;return this;}};
 for(const handler of handlers){let nextError;let nextCalled=false;await handler(req,res,error=>{nextCalled=true;nextError=error;});if(nextError)throw nextError;if(handler.length>=3&&!nextCalled)break;}
 return result;
}

test('/api/auth/me exposes only the explicit public identity projection',async()=>{
 const h=routeHarness(),handlers=h.routes.get('GET /api/auth/me');
 const response=await invoke(handlers,{session:{...h.sessionService.authenticate?await h.sessionService.authenticate():null}});
 assert.deepEqual(response.body.identity,{identityId:h.identity.identityId,normalizedEmail:h.identity.normalizedEmail,displayName:h.identity.displayName,status:'active'});
 assert.equal(JSON.stringify(response.body).includes('never-serialize-me'),false);
 assert.equal(Object.hasOwn(response.body.identity,'passwordHash'),false);
});

test('control-plane availability errors propagate without revoking a valid session',async()=>{
 const identityId=randomUUID(),tenantId=randomUUID(),membershipId=randomUUID(),session={identityId,tenantId,membershipVersion:1,securityVersion:1,mfaVerifiedAt:new Date(),recentAuthenticatedAt:new Date(),expiresAt:new Date(Date.now()+60_000).toISOString(),revokedAt:null};
 let revoked=0;
 const repository={
  createSession:async()=>{},getSession:async()=>session,revokeSessions:async()=>{revoked++;},
  getIdentity:async()=>{throw new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,'control unavailable');},
  getMembership:async()=>null,listMemberships:async()=>[{membershipId,identityId,tenantId,status:'active',version:1}],getTenantState:async()=>({tenantId,status:'active'})
 };
 const service=createSessionService({repository,clock:()=>Date.now()});
 await assert.rejects(()=>service.authenticate('valid-token'),error=>error.code===PERSISTENCE_CODES.UNAVAILABLE);
 assert.equal(revoked,0);
 repository.getIdentity=async()=>({identityId,status:'active',securityVersion:1});
 repository.getTenantState=async()=>{throw new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,'tenant state unavailable');};
 await assert.rejects(()=>service.authenticate('valid-token'),error=>error.code===PERSISTENCE_CODES.UNAVAILABLE);
 assert.equal(revoked,0);
});

function mfaFixture(){
 let time=1_700_000_010_000,mfa=null,recovery=[],failReplacement=false,failAcknowledgement=false;
 const identity={identityId:randomUUID(),normalizedEmail:'owner@example.test',displayName:'Owner',passwordHash:'hash',status:'active',securityVersion:1};
 const repository={
  getIdentity:async()=>({...identity}),getMfaState:async()=>mfa&&structuredClone(mfa),countRecoveryCodes:async()=>recovery.length,
  putMfaState:async input=>(mfa={identityId:identity.identityId,state:input.state,secretCiphertext:input.secretCiphertext,enrolledAt:input.enrolledAt,version:(mfa?.version??0)+1}),
  async replaceRecoveryCodes(input){
   if(failReplacement)throw new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,'interrupted');
   if(input.mfaState)mfa={identityId:identity.identityId,...input.mfaState,version:(mfa?.version??0)+1};
   recovery=[...input.codeHashes];identity.securityVersion++;return {count:recovery.length,securityVersion:identity.securityVersion,mfaState:mfa};
  },
  async acknowledgeRecoveryCodeDelivery(input){if(failAcknowledgement)throw new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,'cleanup interrupted');mfa={...mfa,secretCiphertext:input.secretCiphertext,version:mfa.version+1};return {ok:true};},
  consumeRecoveryCode:async()=>({}),createMfaChallenge:async()=>({}),getMfaChallenge:async()=>null,updateMfaChallenge:async()=>({})
 };
 const service=createGlobalMfaService({repository,key,clock:()=>time});
 return {identity,repository,service,state:()=>structuredClone(mfa),failReplacement:()=>{failReplacement=true;},failAcknowledgement:()=>{failAcknowledgement=true;}};
}

test('MFA activation and recovery replacement commit atomically and remain resumable until delivery acknowledgement',async()=>{
 const interrupted=mfaFixture(),enrollment=await interrupted.service.beginEnrollment(interrupted.identity.identityId);interrupted.failReplacement();
 await assert.rejects(()=>interrupted.service.confirmEnrollment(interrupted.identity.identityId,totp(enrollment.secret,1_700_000_010_000),{sessionToken:'enrollment-session'}),/interrupted/);
 assert.equal(interrupted.state().state,'enrolling');

 const f=mfaFixture(),started=await f.service.beginEnrollment(f.identity.identityId),code=totp(started.secret,1_700_000_010_000);
 const first=await f.service.confirmEnrollment(f.identity.identityId,code,{sessionToken:'enrollment-session'});
 const retry=await f.service.confirmEnrollment(f.identity.identityId,code,{sessionToken:'enrollment-session'});
 assert.deepEqual(retry.recoveryCodes,first.recoveryCodes);
 assert.equal(first.recoveryAcknowledgementRequired,true);
 f.failAcknowledgement();
 await assert.rejects(()=>f.service.acknowledgeRecoveryCodes(f.identity.identityId,{sessionToken:'enrollment-session'}),/cleanup interrupted/);
 const afterFailure=await f.service.confirmEnrollment(f.identity.identityId,code,{sessionToken:'enrollment-session'});
 assert.deepEqual(afterFailure.recoveryCodes,first.recoveryCodes);
});

test('recovery acknowledgement is an explicit authenticated route and clears the cookie only after durable cleanup',async()=>{
 const h=routeHarness(),handlers=h.routes.get('POST /api/auth/mfa/recovery/ack');
 assert.ok(handlers,'recovery acknowledgement route must exist');
 const session=await h.sessionService.authenticate(),response=await invoke(handlers,{session});
 assert.equal(response.body.sessionCleanupConfirmed,true);
 assert.match(response.headers['Set-Cookie'],/Max-Age=0/);
});

test('locked pending recovery delivery resets only after same-identity password reproof and rotates the session',async()=>{
 const calls=[];
 const h=routeHarness({
  identityService:{authenticatePassword:async input=>{calls.push(['password',input]);return h.identity;}},
  mfaService:{resetPendingRecoveryDelivery:async(identityId,input)=>{calls.push(['reset',identityId,input]);return {recoveryCodes:['ROTATED-CODE'],securityVersion:4};}},
  sessionService:{issue:async input=>{calls.push(['issue',input]);return {cookie:'wimblo_session=new-token',csrfToken:'new-csrf'};},logout:async token=>{calls.push(['logout',token]);return {cookie:'wimblo_session=; Max-Age=0'};}}
 });
 const handlers=h.routes.get('POST /api/auth/mfa/recovery/reset');
 assert.ok(handlers,'password-reproof recovery reset route must exist');
 const response=await invoke(handlers,{session:await h.sessionService.authenticate(),body:{password:'correct-password'}});
 assert.deepEqual(response.body,{recoveryCodes:['ROTATED-CODE'],recoveryAcknowledgementRequired:true,csrfToken:'new-csrf'});
 assert.equal(response.headers['Set-Cookie'],'wimblo_session=new-token');
 assert.deepEqual(calls[0],['password',{email:h.identity.normalizedEmail,password:'correct-password'}]);
 assert.equal(calls[1][0],'reset');assert.equal(calls.some(entry=>entry[0]==='logout'),false);
 assert.equal(calls.find(entry=>entry[0]==='issue')[1].recentAuthenticatedAt instanceof Date,true);
});

test('recovery delivery reset refuses a password result for any other identity before rotating codes',async()=>{
 let resets=0;const h=routeHarness({identityService:{authenticatePassword:async()=>({identityId:randomUUID(),normalizedEmail:'other@example.test',status:'active',securityVersion:1})},mfaService:{resetPendingRecoveryDelivery:async()=>{resets++;}}});
 const session=await h.sessionService.authenticate();
 await assert.rejects(()=>invoke(h.routes.get('POST /api/auth/mfa/recovery/reset'),{session,body:{password:'wrong-account'}}),error=>error.code===PERSISTENCE_CODES.ISOLATION);
 assert.equal(resets,0);
});
