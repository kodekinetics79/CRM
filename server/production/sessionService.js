import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const csrfForToken=token=>createHash('sha256').update(`wimblo-csrf-v1:${token}`,'utf8').digest('base64url');
const safeEqual=(a,b)=>{const left=Buffer.from(a||''),right=Buffer.from(b||'');return left.length===right.length&&timingSafeEqual(left,right);};

export function createSessionService({repository,clock=Date.now,sessionTtlMs=8*60*60*1000,cookieName='wimblo_session',recentAuthenticationMs=15*60*1000}={}){
 const required=['createSession','getSession','revokeSessions','getIdentity','getMembership','listMemberships','getTenantState'];
 if(!repository||required.some(method=>typeof repository[method]!=='function'))persistenceFail(PERSISTENCE_CODES.INVALID,'A complete session repository is required.');
 if(!Number.isSafeInteger(sessionTtlMs)||sessionTtlMs<60_000)persistenceFail(PERSISTENCE_CODES.INVALID,'Session TTL must be at least one minute.');
 if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(cookieName))persistenceFail(PERSISTENCE_CODES.INVALID,'Session cookie name is invalid.');
 const now=()=>{const value=clock();if(!Number.isSafeInteger(value)||value<0)persistenceFail(PERSISTENCE_CODES.UNAVAILABLE,'Session clock is unavailable.');return value;};
 const cookie=(token,maxAge=sessionTtlMs)=>`${cookieName}=${token}; Path=/; Max-Age=${Math.floor(maxAge/1000)}; Secure; HttpOnly; SameSite=Lax`;
 const clearCookie=()=>`${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

 async function issue({identity,membership,mfaVerifiedAt,recentAuthenticatedAt}){
  if(!identity||identity.status!=='active'||!membership||membership.status!=='active'||membership.identityId!==identity.identityId)persistenceFail(PERSISTENCE_CODES.ISOLATION,'An active identity and membership are required.');
  const time=now(),token=randomBytes(32).toString('base64url'),csrfToken=csrfForToken(token);
  const session=await repository.createSession({token,csrfHash:digest(csrfToken),tenantId:membership.tenantId,identityId:identity.identityId,membershipVersion:membership.version,securityVersion:identity.securityVersion,mfaVerifiedAt,recentAuthenticatedAt:recentAuthenticatedAt??new Date(time),expiresAt:new Date(time+sessionTtlMs)});
  return {token,csrfToken,cookie:cookie(token),session};
 }

 async function revoke(token,session){if(session)await repository.revokeSessions({identityId:session.identityId,tenantId:session.tenantId,token,actorIdentityId:session.identityId});}

 async function authenticate(token,{allowUnverifiedMfa=false}={}){
  if(typeof token!=='string'||!token)return null;
  const session=await repository.getSession(token);if(!session||session.revokedAt||new Date(session.expiresAt).getTime()<=now())return null;
  const identity=await repository.getIdentity(session.identityId),memberships=identity?await repository.listMemberships(identity.identityId):[],membership=memberships.find(item=>item.tenantId===session.tenantId),tenant=await repository.getTenantState(session.tenantId);
  const stale=!identity||identity.status!=='active'||identity.securityVersion!==session.securityVersion||!membership||membership.status!=='active'||membership.version!==session.membershipVersion||!tenant||tenant.status!=='active';
  if(stale){await revoke(token,session);return null;}
  if(!session.mfaVerifiedAt&&!allowUnverifiedMfa)return null;
  return {...session,identity,membership,tenant,token,csrfToken:csrfForToken(token)};
 }

 async function switchTenant(token,membershipId){
  const current=await authenticate(token);if(!current)persistenceFail(PERSISTENCE_CODES.ISOLATION,'A current verified session is required.');
  const membership=await repository.getMembership(membershipId);if(!membership||membership.identityId!==current.identityId||membership.status!=='active')persistenceFail(PERSISTENCE_CODES.ISOLATION,'An active membership is required for tenant switching.');
  const tenant=await repository.getTenantState(membership.tenantId);if(!tenant||tenant.status!=='active')persistenceFail(PERSISTENCE_CODES.ISOLATION,'The selected tenant is not active.');
  await revoke(token,current);return issue({identity:current.identity,membership,mfaVerifiedAt:new Date(current.mfaVerifiedAt),recentAuthenticatedAt:new Date(current.recentAuthenticatedAt)});
 }
 async function logout(token){const session=await repository.getSession(token);await revoke(token,session);return {ok:true,cookie:clearCookie()};}
 const verifyCsrf=(session,value)=>Boolean(session?.csrfHash&&typeof value==='string'&&safeEqual(session.csrfHash,digest(value)));
 const isRecent=session=>Boolean(session?.recentAuthenticatedAt&&now()-new Date(session.recentAuthenticatedAt).getTime()<=recentAuthenticationMs);
 return Object.freeze({cookieName,issue,authenticate,switchTenant,logout,verifyCsrf,isRecent,cookie,clearCookie});
}
