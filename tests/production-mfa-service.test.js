import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createGlobalMfaService,identitySecurityBinding} from '../server/production/mfaService.js';
import {totp} from '../server/mfa.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const key=randomBytes(32).toString('base64');
const digest=value=>createHash('sha256').update(value).digest('hex');

function fixture(){
  let time=1_700_000_010_000;
  const identity={identityId:randomUUID(),normalizedEmail:'person@example.com',displayName:'Person',passwordHash:'adaptive-hash',status:'active',securityVersion:1};
  let mfa=null,challenge=null,recovery=new Map(),revoked=0;
  const repository={
    async getIdentity(id){assert.equal(id,identity.identityId);return {...identity};},
    async getMfaState(){return mfa&&structuredClone(mfa);},
    async putMfaState(input){
      if(input.expectedVersion!==null&&input.expectedVersion!==undefined&&input.expectedVersion!==mfa?.version)throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'version');
      mfa={identityId:identity.identityId,state:input.state,secretCiphertext:input.secretCiphertext,enrolledAt:input.enrolledAt,version:(mfa?.version??0)+1,updatedAt:new Date(time).toISOString()};
      if(input.rotateSecurity){identity.securityVersion++;revoked++;}
      return {...mfa,securityVersion:input.rotateSecurity?identity.securityVersion:null};
    },
    async replaceRecoveryCodes({codeHashes}){recovery=new Map(codeHashes.map(value=>[value,false]));identity.securityVersion++;revoked++;return {count:codeHashes.length,securityVersion:identity.securityVersion};},
    async consumeRecoveryCode({codeHash}){if(!recovery.has(codeHash)||recovery.get(codeHash))throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'used');recovery.set(codeHash,true);return {usedAt:new Date(time).toISOString()};},
    async countRecoveryCodes(){return [...recovery.values()].filter(used=>!used).length;},
    async createMfaChallenge(input){challenge={...input,attempts:0,completedAt:null,createdAt:new Date(time).toISOString()};return {...challenge};},
    async getMfaChallenge(id){return challenge?.challengeId===id?{...challenge}:null;},
    async updateMfaChallenge(input){if(!challenge||challenge.attempts!==input.expectedAttempts||challenge.completedAt)throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'changed');challenge.attempts=input.attempts;challenge.completedAt=input.completedAt;return {...challenge};},
    async revokeSessions(){revoked++;return {revoked:1};}
  };
  const service=createGlobalMfaService({repository,key,clock:()=>time,issuer:'Wimblo'});
  return {identity,repository,service,time:()=>time,advance:ms=>time+=ms,state:()=>({mfa,challenge,recovery,revoked})};
}

test('identity security binding excludes tenant role and changes with credentials, status or security version',()=>{
  const identity={passwordHash:'hash',status:'active',securityVersion:2,role:'owner'};
  const initial=identitySecurityBinding(identity);
  assert.equal(initial,identitySecurityBinding({...identity,role:'viewer'}));
  assert.notEqual(initial,identitySecurityBinding({...identity,passwordHash:'changed'}));
  assert.notEqual(initial,identitySecurityBinding({...identity,status:'suspended'}));
  assert.notEqual(initial,identitySecurityBinding({...identity,securityVersion:3}));
});

test('all active production identities require MFA and enrollment stores only encrypted five-minute state',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.status(f.identity.identityId),{required:true,enabled:false,available:true,recoveryCodesRemaining:0});
  const enrollment=await f.service.beginEnrollment(f.identity.identityId);
  assert.match(enrollment.secret,/^[A-Z2-7]+$/);
  assert.equal(enrollment.expiresAt,f.time()+300000);
  assert.match(enrollment.otpauthUrl,/issuer=Wimblo/);
  const saved=f.state().mfa.secretCiphertext;
  assert.match(saved,/^v1\./);
  assert.equal(saved.includes(enrollment.secret),false);
  f.advance(300001);
  await assert.rejects(()=>f.service.confirmEnrollment(f.identity.identityId,totp(enrollment.secret,f.time())),/expired/i);
});

test('confirmation creates eight one-use recovery codes, rotates security and revokes prior sessions',async()=>{
  const f=fixture(),enrollment=await f.service.beginEnrollment(f.identity.identityId);
  const confirmed=await f.service.confirmEnrollment(f.identity.identityId,totp(enrollment.secret,f.time()));
  assert.equal(confirmed.enabled,true);
  assert.equal(confirmed.recoveryCodes.length,8);
  assert.equal(f.identity.securityVersion,3);
  assert.ok(f.state().revoked>=2);
  assert.equal(JSON.stringify([...f.state().recovery.keys()]).includes(confirmed.recoveryCodes[0]),false);
  const challenge=await f.service.createChallenge(f.identity.identityId);
  assert.equal((await f.service.verifyChallenge(challenge.challengeToken,confirmed.recoveryCodes[0])).verified,true);
  const replay=await f.service.createChallenge(f.identity.identityId);
  await assert.rejects(()=>f.service.verifyChallenge(replay.challengeToken,confirmed.recoveryCodes[0]),/invalid or already used/i);
});

test('TOTP steps and challenge tokens are one-use and security binding changes invalidate challenges',async()=>{
  const f=fixture(),enrollment=await f.service.beginEnrollment(f.identity.identityId);
  await f.service.confirmEnrollment(f.identity.identityId,totp(enrollment.secret,f.time()));
  f.advance(30000);
  const code=totp(enrollment.secret,f.time()),challenge=await f.service.createChallenge(f.identity.identityId);
  assert.equal((await f.service.verifyChallenge(challenge.challengeToken,code)).verified,true);
  await assert.rejects(()=>f.service.verifyChallenge(challenge.challengeToken,code),/invalid or expired/i);
  const next=await f.service.createChallenge(f.identity.identityId);
  await assert.rejects(()=>f.service.verifyChallenge(next.challengeToken,code),/invalid or already used/i);
  const changed=await f.service.createChallenge(f.identity.identityId);
  f.identity.securityVersion++;
  await assert.rejects(()=>f.service.verifyChallenge(changed.challengeToken,totp(enrollment.secret,f.time()+30000)),/access changed/i);
});

test('enrollment and challenges stop after five failures and expire after five minutes',async()=>{
  const f=fixture(),enrollment=await f.service.beginEnrollment(f.identity.identityId);
  for(let i=0;i<5;i++)await assert.rejects(()=>f.service.confirmEnrollment(f.identity.identityId,'000000'),/valid six-digit/i);
  await assert.rejects(()=>f.service.confirmEnrollment(f.identity.identityId,totp(enrollment.secret,f.time())),/too many/i);
  const replacement=await f.service.beginEnrollment(f.identity.identityId);
  await f.service.confirmEnrollment(f.identity.identityId,totp(replacement.secret,f.time()));
  const challenge=await f.service.createChallenge(f.identity.identityId);
  for(let i=0;i<5;i++)await assert.rejects(()=>f.service.verifyChallenge(challenge.challengeToken,'000000'),/invalid or already used/i);
  await assert.rejects(()=>f.service.verifyChallenge(challenge.challengeToken,'000000'),/too many/i);
  const expired=await f.service.createChallenge(f.identity.identityId);f.advance(300001);
  await assert.rejects(()=>f.service.verifyChallenge(expired.challengeToken,'000000'),/invalid or expired/i);
});

test('regenerating recovery codes rotates identity security and invalidates all old codes',async()=>{
  const f=fixture(),enrollment=await f.service.beginEnrollment(f.identity.identityId);
  const first=await f.service.confirmEnrollment(f.identity.identityId,totp(enrollment.secret,f.time()));
  const second=await f.service.regenerateRecoveryCodes(f.identity.identityId);
  assert.equal(second.recoveryCodes.length,8);
  const challenge=await f.service.createChallenge(f.identity.identityId);
  await assert.rejects(()=>f.service.verifyChallenge(challenge.challengeToken,first.recoveryCodes[0]),/invalid or already used/i);
  const fresh=await f.service.createChallenge(f.identity.identityId);
  assert.equal((await f.service.verifyChallenge(fresh.challengeToken,second.recoveryCodes[0])).verified,true);
});
