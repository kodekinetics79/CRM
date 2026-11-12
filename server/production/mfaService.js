import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {MfaError,createMfaSecretProtector,encodeBase32,totp} from '../mfa.js';
import {PERSISTENCE_CODES} from '../persistence/contract.js';

const TTL_MS=5*60*1000;
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const fail=(message,status=401)=>{throw new MfaError(message,status);};
const equal=(left,right)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};

export function identitySecurityBinding(identity){
 return hash(JSON.stringify([identity?.passwordHash,identity?.status,identity?.securityVersion]));
}

export function createGlobalMfaService({repository,key,clock=Date.now,issuer='Wimblo'}={}){
 const required=['getIdentity','getMfaState','putMfaState','replaceRecoveryCodes','acknowledgeRecoveryCodeDelivery','consumeRecoveryCode','countRecoveryCodes','createMfaChallenge','getMfaChallenge','updateMfaChallenge'];
 if(!repository||required.some(method=>typeof repository[method]!=='function'))throw new MfaError('The global MFA repository is unavailable.',503);
 const protector=createMfaSecretProtector(key);
 const now=()=>{const value=clock();if(!Number.isSafeInteger(value)||value<0)throw new MfaError('Authenticator clock is unavailable.',503);return value;};
 const activeIdentity=async id=>{const identity=await repository.getIdentity(id);if(!identity||identity.status!=='active')fail('This identity cannot authenticate.');return identity;};
 const protect=(value,id)=>protector.encrypt(JSON.stringify(value),id);
 const unprotect=(value,id)=>{try{return JSON.parse(protector.decrypt(value,id));}catch(error){if(error instanceof MfaError)throw error;throw new MfaError('MFA cannot read this identity’s protected state.',503);}};
 const codes=()=>Array.from({length:8},()=>{const raw=randomBytes(8).toString('hex').toUpperCase();return `${raw.slice(0,8)}-${raw.slice(8)}`;});
 const codeHashes=(id,values)=>values.map(value=>hash(`${id}:${value}`));
 const matchTotp=(secret,code,lastStep,time)=>{
  if(typeof code!=='string'||!/^[0-9]{6}$/.test(code))return null;
  const step=Math.floor(time/30000);
  for(const delta of [0,-1,1]){const candidate=step+delta;if(candidate<0||candidate<=lastStep)continue;const expected=totp(secret,candidate*30000);if(equal(code,expected))return candidate;}
  return null;
 };

 async function status(identityId){
  await activeIdentity(identityId);
  const state=await repository.getMfaState(identityId);
  if(state?.secretCiphertext)unprotect(state.secretCiphertext,identityId);
  return {required:true,enabled:state?.state==='active',available:true,recoveryCodesRemaining:state?.state==='active'?await repository.countRecoveryCodes(identityId):0};
 }

 async function beginEnrollment(identityId){
  const identity=await activeIdentity(identityId),time=now(),current=await repository.getMfaState(identityId);
  if(current?.state==='active')fail('MFA is already enabled.',409);
  const secret=encodeBase32(randomBytes(20)),expiresAt=time+TTL_MS;
  const payload={secret,expiresAt,binding:identitySecurityBinding(identity),lastStep:-1,failures:0};
  await repository.putMfaState({identityId,state:'enrolling',secretCiphertext:protect(payload,identityId),enrolledAt:null,expectedVersion:current?.version??null,actorIdentityId:identityId});
  return {secret,expiresAt,otpauthUrl:`otpauth://totp/${encodeURIComponent(`${issuer}:${identity.normalizedEmail}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`};
 }

 async function confirmEnrollment(identityId,code,{sessionToken=null}={}){
  const identity=await activeIdentity(identityId),time=now(),state=await repository.getMfaState(identityId);
  if(state?.state==='active'){
   const active=unprotect(state.secretCiphertext,identityId),step=matchTotp(active.secret,code,-1,time);
   if(!Array.isArray(active.pendingRecoveryCodes)||step===null)fail('Enrollment expired. Start again.',409);
   return {enabled:true,recoveryCodes:[...active.pendingRecoveryCodes],securityVersion:identity.securityVersion,reauthenticationRequired:true,recoveryAcknowledgementRequired:true,sessionCleanupConfirmed:false};
  }
  if(!state||state.state!=='enrolling')fail('Enrollment expired. Start again.',409);
  const payload=unprotect(state.secretCiphertext,identityId);
  if(payload.expiresAt<=time||payload.binding!==identitySecurityBinding(identity))fail('Enrollment expired. Start again.',409);
  if(payload.failures>=5)fail('Too many enrollment attempts. Start again.',429);
  const step=matchTotp(payload.secret,code,-1,time);
  if(step===null){payload.failures++;await repository.putMfaState({identityId,state:'enrolling',secretCiphertext:protect(payload,identityId),enrolledAt:null,expectedVersion:state.version,actorIdentityId:identityId});fail('Enter a valid six-digit authenticator code.');}
  const recoveryCodes=codes();
  const active={secret:payload.secret,lastStep:step,failures:0,pendingRecoveryCodes:recoveryCodes};
  const rotated=await repository.replaceRecoveryCodes({identityId,codeHashes:codeHashes(identityId,recoveryCodes),actorIdentityId:identityId,mfaState:{state:'active',secretCiphertext:protect(active,identityId),enrolledAt:new Date(time),expectedVersion:state.version},preserveSessionToken:sessionToken});
  return {enabled:true,recoveryCodes,securityVersion:rotated.securityVersion,reauthenticationRequired:true,recoveryAcknowledgementRequired:true,sessionCleanupConfirmed:false};
 }

 async function acknowledgeRecoveryCodes(identityId,{sessionToken}={}){
  await activeIdentity(identityId);const state=await repository.getMfaState(identityId);
  if(!state||state.state!=='active')fail('MFA recovery delivery is not pending.',409);
  const payload=unprotect(state.secretCiphertext,identityId);
  if(!Array.isArray(payload.pendingRecoveryCodes))fail('MFA recovery delivery is not pending.',409);
  delete payload.pendingRecoveryCodes;
  await repository.acknowledgeRecoveryCodeDelivery({identityId,secretCiphertext:protect(payload,identityId),enrolledAt:state.enrolledAt,expectedVersion:state.version,sessionToken,actorIdentityId:identityId});
  return {ok:true,reauthenticationRequired:true,sessionCleanupConfirmed:true};
 }

 async function createChallenge(identityId){
  const identity=await activeIdentity(identityId),state=await repository.getMfaState(identityId),time=now();
  if(!state||state.state!=='active')fail('MFA is not enabled.',409);
  unprotect(state.secretCiphertext,identityId);
  const challengeId=randomUUID(),secret=randomBytes(32).toString('base64url'),challengeToken=`${challengeId}.${secret}`,expiresAt=time+TTL_MS;
  await repository.createMfaChallenge({challengeId,identityId,purpose:'sign_in',challengeHash:hash(`${challengeToken}:${identitySecurityBinding(identity)}`),expiresAt:new Date(expiresAt)});
  return {challengeToken,expiresAt};
 }

 async function verifyChallenge(challengeToken,code){
  const [challengeId,secret,...extra]=typeof challengeToken==='string'?challengeToken.split('.'):[];
  if(!challengeId||!secret||extra.length)fail('Invalid or expired MFA challenge.');
  const challenge=await repository.getMfaChallenge(challengeId);
  const time=now();
  if(!challenge||challenge.completedAt||new Date(challenge.expiresAt).getTime()<=time)fail('Invalid or expired MFA challenge.');
  if(challenge.attempts>=5)fail('Too many MFA attempts. Sign in again.',429);
  const identity=await activeIdentity(challenge.identityId),state=await repository.getMfaState(challenge.identityId);
  if(!state||state.state!=='active')fail('Invalid or expired MFA challenge.');
  const payload=unprotect(state.secretCiphertext,identity.identityId);
  if(!equal(challenge.challengeHash,hash(`${challengeToken}:${identitySecurityBinding(identity)}`)))fail('Account access changed. Sign in again.');
  let verified=false,nextStep=payload.lastStep;
  const step=matchTotp(payload.secret,code,payload.lastStep,time);
  if(step!==null){verified=true;nextStep=step;}
  else if(typeof code==='string'&&/^[A-F0-9]{8}-[A-F0-9]{8}$/.test(code)){
   try{await repository.consumeRecoveryCode({identityId:identity.identityId,codeHash:hash(`${identity.identityId}:${code}`),at:new Date(time)});verified=true;}catch(error){if(error?.code!==PERSISTENCE_CODES.CONFLICT)throw error;}
  }
  if(!verified){await repository.updateMfaChallenge({challengeId,expectedAttempts:challenge.attempts,attempts:challenge.attempts+1,completedAt:null});fail('Invalid or already used authenticator or recovery code.');}
  if(nextStep!==payload.lastStep){payload.lastStep=nextStep;await repository.putMfaState({identityId:identity.identityId,state:'active',secretCiphertext:protect(payload,identity.identityId),enrolledAt:state.enrolledAt,expectedVersion:state.version,actorIdentityId:identity.identityId});}
  await repository.updateMfaChallenge({challengeId,expectedAttempts:challenge.attempts,attempts:challenge.attempts+1,completedAt:new Date(time)});
  return {verified:true,identity:{identityId:identity.identityId,normalizedEmail:identity.normalizedEmail,displayName:identity.displayName,status:identity.status,securityVersion:identity.securityVersion}};
 }

 async function regenerateRecoveryCodes(identityId,{sessionToken=null}={}){
  const identity=await activeIdentity(identityId);const state=await repository.getMfaState(identityId);if(!state||state.state!=='active')fail('MFA is not enabled.',409);
  const payload=unprotect(state.secretCiphertext,identityId);
  if(Array.isArray(payload.pendingRecoveryCodes))return {recoveryCodes:[...payload.pendingRecoveryCodes],securityVersion:identity.securityVersion,reauthenticationRequired:true,recoveryAcknowledgementRequired:true};
  const recoveryCodes=codes();payload.pendingRecoveryCodes=recoveryCodes;
  const rotated=await repository.replaceRecoveryCodes({identityId,codeHashes:codeHashes(identityId,recoveryCodes),actorIdentityId:identityId,mfaState:{state:'active',secretCiphertext:protect(payload,identityId),enrolledAt:state.enrolledAt,expectedVersion:state.version},preserveSessionToken:sessionToken});
  return {recoveryCodes,securityVersion:rotated.securityVersion,reauthenticationRequired:true,recoveryAcknowledgementRequired:true};
 }

 return Object.freeze({status,beginEnrollment,confirmEnrollment,acknowledgeRecoveryCodes,createChallenge,verifyChallenge,regenerateRecoveryCodes});
}
