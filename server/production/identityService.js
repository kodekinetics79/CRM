import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const ROLES=new Set(['owner','admin','staff','viewer','helper']);
const ADMIN_ROLES=new Set(['owner','admin']);
const genericCredentials=()=>persistenceFail(PERSISTENCE_CODES.INVALID,'Invalid credentials.');
const unavailableInvitation=()=>persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation is invalid or unavailable.');
const text=(value,label,max=320)=>{const out=typeof value==='string'?value.trim():'';if(!out||out.length>max)persistenceFail(PERSISTENCE_CODES.INVALID,`${label} is invalid.`);return out;};
const normalizedEmail=value=>text(value,'Email').toLowerCase();
const timestamp=(value,label)=>{const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))persistenceFail(PERSISTENCE_CODES.INVALID,`${label} is invalid.`);return parsed.toISOString();};
const cleanIdentity=identity=>identity&&({identityId:identity.identityId,normalizedEmail:identity.normalizedEmail,displayName:identity.displayName,status:identity.status,securityVersion:identity.securityVersion,createdAt:identity.createdAt,updatedAt:identity.updatedAt});
const cleanMembership=membership=>membership&&({...membership});
const encode=value=>Buffer.from(value,'utf8').toString('base64url');
const decode=value=>Buffer.from(value,'base64url').toString('utf8');

export function createIdentityService({repository,passwordHash,verifyPassword,invitationSecret,clock=()=>new Date()}={}){
 if(!repository||typeof repository!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'An identity repository is required.');
 for(const method of ['findIdentityByEmail','getIdentity','getMembership','listMemberships','listTenantMemberships','changeMembership','createInvitation','getInvitation','acceptInvitationMembership','revokeInvitation','changeIdentity'])
  if(typeof repository[method]!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,`Identity repository is missing ${method}.`);
 if(typeof passwordHash!=='function'||typeof verifyPassword!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'Adaptive password hash and verification functions are required.');
 if(typeof invitationSecret!=='string'||Buffer.byteLength(invitationSecret,'utf8')<32)persistenceFail(PERSISTENCE_CODES.INVALID,'Invitation signing secret must contain at least 32 bytes.');
 if(typeof clock!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A clock function is required.');

 const secret=Buffer.from(invitationSecret,'utf8');
 const dummyPasswordHash=Promise.resolve(passwordHash(randomBytes(32).toString('base64url')));
 const now=()=>new Date(clock());
 const sign=payload=>createHmac('sha256',secret).update(payload,'utf8').digest('base64url');

 function issueToken(claims){
  const payload=encode(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
 }

 function verifyToken(token){
  try{
   const parts=typeof token==='string'?token.split('.'):[];
   if(parts.length!==2)return unavailableInvitation();
   const expected=Buffer.from(sign(parts[0]),'base64url'),actual=Buffer.from(parts[1],'base64url');
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return unavailableInvitation();
   const claims=JSON.parse(decode(parts[0]));
   if(!claims||typeof claims!=='object'||typeof claims.invitationId!=='string'||typeof claims.tenantId!=='string'||typeof claims.email!=='string'||!ROLES.has(claims.role)||typeof claims.expiresAt!=='string'||typeof claims.nonce!=='string')return unavailableInvitation();
   if(new Date(claims.expiresAt).getTime()<=now().getTime())return unavailableInvitation();
   return claims;
  }catch(error){
   if(error?.code===PERSISTENCE_CODES.CONFLICT)throw error;
   return unavailableInvitation();
  }
 }

 async function authorizedMembership(actorIdentityId,tenantId){
  const memberships=await repository.listMemberships(actorIdentityId,{status:'active'});
  const authorized=memberships.find(item=>item.tenantId===tenantId&&ADMIN_ROLES.has(item.role));
  if(!authorized)persistenceFail(PERSISTENCE_CODES.ISOLATION,'An active owner or administrator membership is required.');
  return authorized;
 }

 const invitationError=error=>{
  if(error?.code===PERSISTENCE_CODES.NOT_FOUND||error?.code===PERSISTENCE_CODES.CONFLICT)return unavailableInvitation();
  throw error;
 };

 async function issueInvitation({actorIdentityId,tenantId,email,role,expiresAt}){
  await authorizedMembership(actorIdentityId,tenantId);
  if(!ROLES.has(role))persistenceFail(PERSISTENCE_CODES.INVALID,'Invitation role is invalid.');
  const expiry=timestamp(expiresAt,'Invitation expiry'),invitationId=randomUUID();
  const claims={invitationId,tenantId,email:normalizedEmail(email),role,expiresAt:expiry,nonce:randomBytes(32).toString('base64url')};
  const token=issueToken(claims);
  const invitation=await repository.createInvitation({invitationId,tenantId,token,email:claims.email,role,createdBy:actorIdentityId,expiresAt:expiry});
  return {invitation,token};
 }

 async function acceptInvitation({token,password,displayName=null}){
  const claims=verifyToken(token);
  let invitation;
  try{invitation=await repository.getInvitation(claims.invitationId);}catch(error){return invitationError(error);}
  if(invitation.status!=='pending'||invitation.tenantId!==claims.tenantId||invitation.normalizedEmail!==claims.email||invitation.role!==claims.role||timestamp(invitation.expiresAt,'Invitation expiry')!==claims.expiresAt||new Date(invitation.expiresAt).getTime()<=now().getTime())return unavailableInvitation();

  let identity=await repository.findIdentityByEmail(claims.email),newIdentity=null;
  if(identity){
   let verified=false;
   try{verified=identity.status==='active'&&await verifyPassword(text(password,'Password',4096),identity.passwordHash);}catch{}
   if(!verified)return genericCredentials();
  }else{
   const suppliedPassword=text(password,'Password',4096);
   const encoded=await passwordHash(suppliedPassword);
   identity={identityId:randomUUID(),normalizedEmail:claims.email};
   newIdentity={email:claims.email,displayName:text(displayName,'Display name',200),passwordHash:text(encoded,'Password hash',4096)};
  }

  let accepted;
  try{accepted=await repository.acceptInvitationMembership({token,identityId:identity.identityId,membershipId:randomUUID(),expectedVersion:invitation.version,newIdentity});}
  catch(error){return invitationError(error);}
  if(accepted.invitation.tenantId!==claims.tenantId||accepted.invitation.role!==claims.role)return unavailableInvitation();
  return {identity:cleanIdentity(accepted.identity),membership:cleanMembership(accepted.membership)};
 }

 async function revokeInvitation({actorIdentityId,invitationId,expectedVersion}){
  let invitation;
  try{invitation=await repository.getInvitation(invitationId);}catch(error){return invitationError(error);}
  await authorizedMembership(actorIdentityId,invitation.tenantId);
  try{return await repository.revokeInvitation({invitationId,expectedVersion,actorIdentityId});}
  catch(error){return invitationError(error);}
 }

 async function authenticatePassword({email,password}){
  const identity=await repository.findIdentityByEmail(normalizedEmail(email));
  let verified=false;
  const supplied=typeof password==='string'&&password.length>0&&password.length<=4096?password:null;
  try{verified=Boolean(supplied&&await verifyPassword(supplied,identity?.passwordHash??await dummyPasswordHash)&&identity?.status==='active');}catch{}
  if(!verified)return genericCredentials();
  return cleanIdentity(identity);
 }

 async function listActiveMemberships(identityId){
  const identity=await repository.getIdentity(identityId);
  if(identity.status!=='active')return [];
  return (await repository.listMemberships(identityId,{status:'active'})).map(cleanMembership);
 }

 async function changeMembership({actorIdentityId,membershipId,role,status,expectedVersion}){
  const target=await repository.getMembership(membershipId);
  await authorizedMembership(actorIdentityId,target.tenantId);
  const removesOwner=target.status==='active'&&target.role==='owner'&&((role!==undefined&&role!=='owner')||(status!==undefined&&status!=='active'));
  if(removesOwner){
   const owners=await repository.listTenantMemberships(target.tenantId,{status:'active',role:'owner'});
   if(owners.length<=1)persistenceFail(PERSISTENCE_CODES.CONFLICT,'The final active owner cannot be removed or demoted.');
  }
  return repository.changeMembership({membershipId,role,status,expectedVersion,actorIdentityId});
 }

 async function suspendIdentity({actorIdentityId,identityId,expectedSecurityVersion}){
  if(actorIdentityId!==identityId)persistenceFail(PERSISTENCE_CODES.ISOLATION,'Global identity suspension is self-service only until platform-operator governance is configured.');
  return cleanIdentity(await repository.changeIdentity({identityId,status:'suspended',expectedSecurityVersion,actorIdentityId}));
 }

 return Object.freeze({issueInvitation,acceptInvitation,revokeInvitation,authenticatePassword,listActiveMemberships,changeMembership,suspendIdentity});
}
