import {createHash} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const IDENTITY_STATUSES=new Set(['active','suspended','closed']);
const MEMBERSHIP_STATUSES=new Set(['active','suspended','revoked']);
const ROLES=new Set(['owner','admin','staff','viewer','helper']);
const MFA_STATES=new Set(['required','enrolling','active','recovery_required','disabled']);
const CHALLENGE_PURPOSES=new Set(['enrollment','sign_in','recovery','step_up']);

const fail=(message)=>persistenceFail(PERSISTENCE_CODES.INVALID,message);
const uuid=(value,label)=>{if(typeof value!=='string'||!UUID.test(value))fail(`${label} must be a UUID.`);return value.toLowerCase();};
const version=(value,label='Expected version')=>{if(!Number.isSafeInteger(value)||value<1)fail(`${label} must be a positive integer.`);return value;};
const text=(value,label,max=320)=>{const out=typeof value==='string'?value.trim():'';if(!out||out.length>max)fail(`${label} must contain between 1 and ${max} characters.`);return out;};
const email=value=>{
 const out=text(value,'Email',320).toLowerCase();
 if(!/^[^\s@]+@[^\s@]+$/.test(out))fail('Email must be valid.');
 return out;
};
const oneOf=(value,allowed,label)=>{if(!allowed.has(value))fail(`${label} is invalid.`);return value;};
const date=(value,label)=>{
 const parsed=value instanceof Date?new Date(value):new Date(value);
 if(Number.isNaN(parsed.getTime()))fail(`${label} must be a valid timestamp.`);
 return parsed.toISOString();
};
const nullableDate=value=>value===null||value===undefined?null:date(value,'Timestamp');
const digest=value=>{
 const secret=text(value,'Opaque token',4096);
 return createHash('sha256').update(secret,'utf8').digest('hex');
};
const hash=value=>{if(typeof value!=='string'||!HASH.test(value))fail('Hash must be a lower-case SHA-256 value.');return value;};
const iso=value=>value instanceof Date?value.toISOString():value;
const json=value=>value===undefined?{}:value;

const mapIdentity=row=>row?{
 identityId:row.identity_id,
 normalizedEmail:row.normalized_email,
 displayName:row.display_name,
 passwordHash:row.password_hash,
 status:row.status,
 securityVersion:Number(row.security_version),
 createdAt:iso(row.created_at),
 updatedAt:iso(row.updated_at)
}:null;

const mapMembership=row=>row?{
 membershipId:row.membership_id,
 tenantId:row.tenant_id,
 identityId:row.identity_id,
 role:row.role,
 status:row.status,
 version:Number(row.version),
 createdAt:iso(row.created_at),
 updatedAt:iso(row.updated_at)
}:null;

const mapInvitation=row=>row?{
 invitationId:row.invitation_id,
 tenantId:row.tenant_id,
 normalizedEmail:row.normalized_email,
 role:row.role,
 status:row.status,
 createdBy:row.created_by,
 consumedBy:row.consumed_by,
 expiresAt:iso(row.expires_at),
 consumedAt:iso(row.consumed_at),
 revokedAt:iso(row.revoked_at),
 version:Number(row.version),
 createdAt:iso(row.created_at)
}:null;

const mapMfa=row=>row?{
 identityId:row.identity_id,
 state:row.state,
 secretCiphertext:row.secret_ciphertext,
 enrolledAt:iso(row.enrolled_at),
 version:Number(row.version),
 updatedAt:iso(row.updated_at)
}:null;

const mapChallenge=row=>row?{
 challengeId:row.challenge_id,
 identityId:row.identity_id,
 purpose:row.purpose,
 challengeHash:row.challenge_hash,
 attempts:Number(row.attempts),
 expiresAt:iso(row.expires_at),
 completedAt:iso(row.completed_at),
 createdAt:iso(row.created_at)
}:null;

const mapSession=row=>row?{
 csrfHash:row.csrf_hash,
 tenantId:row.tenant_id,
 identityId:row.identity_id,
 membershipVersion:Number(row.membership_version),
 securityVersion:Number(row.security_version),
 mfaVerifiedAt:iso(row.mfa_verified_at),
 recentAuthenticatedAt:iso(row.recent_authenticated_at),
 createdAt:iso(row.created_at),
 expiresAt:iso(row.expires_at),
 revokedAt:iso(row.revoked_at)
}:null;

const mapAudit=row=>row?{
 auditId:Number(row.audit_id),
 tenantId:row.tenant_id,
 identityId:row.identity_id,
 actorIdentityId:row.actor_identity_id,
 action:row.action,
 targetType:row.target_type,
 targetId:row.target_id,
 details:row.details,
 at:iso(row.at)
}:null;

export function createControlRepository({pool,clock=()=>new Date()}={}){
 if(!pool||typeof pool.withAdminSession!=='function')fail('A control-plane PostgreSQL pool is required.');
 if(typeof clock!=='function')fail('A clock function is required.');

 const currentTime=()=>date(clock(),'Clock value');
 const read=fn=>pool.withAdminSession(fn);
 const transaction=fn=>pool.withAdminSession(async session=>{
  await session.query('BEGIN');
  try{
   const result=await fn(session);
   await session.query('COMMIT');
   return result;
  }catch(error){
   await session.query('ROLLBACK').catch(()=>{});
   throw error;
  }
 });

 async function appendAuditWith(session,{tenantId=null,identityId=null,actorIdentityId=null,action,targetType,targetId,details={},at=currentTime()}){
  const values=[
   tenantId===null?null:uuid(tenantId,'Audit tenant ID'),
   identityId===null?null:uuid(identityId,'Audit identity ID'),
   actorIdentityId===null?null:uuid(actorIdentityId,'Audit actor identity ID'),
   text(action,'Audit action',120),text(targetType,'Audit target type',80),text(String(targetId),'Audit target ID',200),JSON.stringify(json(details)),date(at,'Audit timestamp')
  ];
  const {rows}=await session.query(
   `INSERT INTO wimblo_platform.control_audit(tenant_id,identity_id,actor_identity_id,action,target_type,target_id,details,at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)
    RETURNING audit_id,tenant_id,identity_id,actor_identity_id,action,target_type,target_id,details,at`,values);
  return mapAudit(rows[0]);
 }

 async function appendAudit(entry){return transaction(session=>appendAuditWith(session,entry));}

 async function createIdentity({identityId,email:rawEmail,displayName,passwordHash,status='active',actorIdentityId=null}){
  const id=uuid(identityId,'Identity ID'),normalizedEmail=email(rawEmail),createdAt=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash,status,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)
     RETURNING identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at`,
    [id,normalizedEmail,text(displayName,'Display name',200),text(passwordHash,'Password hash',4096),oneOf(status,IDENTITY_STATUSES,'Identity status'),createdAt]);
   await appendAuditWith(session,{identityId:id,actorIdentityId,action:'identity.created',targetType:'identity',targetId:id,at:createdAt});
   return mapIdentity(rows[0]);
  });
 }

 async function findIdentityByEmail(rawEmail){
  const {rows}=await read(session=>session.query(
   `SELECT identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at
    FROM wimblo_platform.global_identities WHERE normalized_email=$1`,[email(rawEmail)]));
  return mapIdentity(rows[0]);
 }

 async function getIdentity(identityId){
  const id=uuid(identityId,'Identity ID');
  const {rows}=await read(session=>session.query(
   `SELECT identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at
    FROM wimblo_platform.global_identities WHERE identity_id=$1`,[id]));
  if(!rows[0])persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Identity was not found.');
  return mapIdentity(rows[0]);
 }

 async function changeIdentity({identityId,status=null,displayName=null,passwordHash=null,expectedSecurityVersion,actorIdentityId=null}){
  const id=uuid(identityId,'Identity ID'),expected=version(expectedSecurityVersion,'Expected security version'),at=currentTime();
  if(status===null&&displayName===null&&passwordHash===null)fail('Identity change requires at least one changed field.');
  const {identity,securityVersion}=await transaction(async session=>{
   const {rows}=await session.query(
    `UPDATE wimblo_platform.global_identities
     SET status=COALESCE($2,status),display_name=COALESCE($3,display_name),password_hash=COALESCE($4,password_hash),security_version=security_version+1,updated_at=$5::timestamptz
     WHERE identity_id=$1 AND security_version=$6
     RETURNING identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at`,
    [id,status===null?null:oneOf(status,IDENTITY_STATUSES,'Identity status'),displayName===null?null:text(displayName,'Display name',200),passwordHash===null?null:text(passwordHash,'Password hash',4096),at,expected]);
   if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Identity security version conflict. Reload before retrying.');
   await session.query('UPDATE wimblo_platform.opaque_sessions SET revoked_at=$2::timestamptz WHERE identity_id=$1 AND revoked_at IS NULL',[id,at]);
   await appendAuditWith(session,{identityId:id,actorIdentityId,action:'identity.changed',targetType:'identity',targetId:id,at});
   const mapped=mapIdentity(rows[0]);
   return {identity:mapped,securityVersion:mapped.securityVersion};
  });
  return {...identity,securityVersion};
 }

 async function createMembership({membershipId,tenantId,identityId,role,status='active',actorIdentityId=null}){
  const member=uuid(membershipId,'Membership ID'),tenant=uuid(tenantId,'Tenant ID'),identity=uuid(identityId,'Identity ID'),at=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)
     RETURNING membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at`,
    [member,tenant,identity,oneOf(role,ROLES,'Membership role'),oneOf(status,MEMBERSHIP_STATUSES,'Membership status'),at]);
   await appendAuditWith(session,{tenantId:tenant,identityId:identity,actorIdentityId,action:'membership.created',targetType:'membership',targetId:member,at});
   return mapMembership(rows[0]);
  });
 }

 async function getMembership(membershipId){
  const {rows}=await read(session=>session.query(
   `SELECT membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at
    FROM wimblo_platform.memberships WHERE membership_id=$1`,[uuid(membershipId,'Membership ID')]));
  if(!rows[0])persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Membership was not found.');
  return mapMembership(rows[0]);
 }

 async function listMemberships(identityId,{status=null}={}){
  if(status!==null)oneOf(status,MEMBERSHIP_STATUSES,'Membership status');
  const {rows}=await read(session=>session.query(
   `SELECT membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at
    FROM wimblo_platform.memberships WHERE identity_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at,membership_id`,
   [uuid(identityId,'Identity ID'),status]));
  return rows.map(mapMembership);
 }

 async function listTenantMemberships(tenantId,{status=null,role=null}={}){
  const tenant=uuid(tenantId,'Tenant ID');
  if(status!==null)oneOf(status,MEMBERSHIP_STATUSES,'Membership status');
  if(role!==null)oneOf(role,ROLES,'Membership role');
  const {rows}=await read(session=>session.query(
   `SELECT membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at
    FROM wimblo_platform.memberships
    WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR role=$3)
    ORDER BY created_at,membership_id`,[tenant,status,role]));
  return rows.map(mapMembership);
 }

 async function changeMembership({membershipId,role,status,expectedVersion,actorIdentityId=null}){
  const member=uuid(membershipId,'Membership ID'),expected=version(expectedVersion),at=currentTime();
  if(role===undefined&&status===undefined)fail('Membership change requires role or status.');
  const nextRole=role===undefined?null:oneOf(role,ROLES,'Membership role'),nextStatus=status===undefined?null:oneOf(status,MEMBERSHIP_STATUSES,'Membership status');
  return transaction(async session=>{
   const {rows:[located]}=await session.query('/*membership:tenant*/ SELECT tenant_id FROM wimblo_platform.memberships WHERE membership_id=$1',[member]);
   if(!located)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Membership version conflict. Reload before retrying.');
   await session.query("/*membership:lock*/ SELECT pg_advisory_xact_lock(hashtextextended('wimblo:membership:' || $1::text,0))",[located.tenant_id]);
   const {rows:[current]}=await session.query('/*membership:current*/ SELECT membership_id,tenant_id,identity_id,role,status,version FROM wimblo_platform.memberships WHERE membership_id=$1 FOR UPDATE',[member]);
   if(!current||Number(current.version)!==expected)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Membership version conflict. Reload before retrying.');
   const proposedRole=nextRole??current.role,proposedStatus=nextStatus??current.status,removesOwner=current.role==='owner'&&current.status==='active'&&(proposedRole!=='owner'||proposedStatus!=='active');
   if(removesOwner){const {rows:[owners]}=await session.query("/*membership:owner-count*/ SELECT count(*)::int AS count FROM wimblo_platform.memberships WHERE tenant_id=$1 AND role='owner' AND status='active'",[current.tenant_id]);if(Number(owners?.count)<=1)persistenceFail(PERSISTENCE_CODES.CONFLICT,'The final active owner cannot be removed or demoted.');}
   const {rows}=await session.query(
    `/*membership:update*/ UPDATE wimblo_platform.memberships
     SET role=COALESCE($2,role),status=COALESCE($3,status),version=version+1,updated_at=$4::timestamptz
     WHERE membership_id=$1 AND version=$5
     RETURNING membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at`,
    [member,nextRole,nextStatus,at,expected]);
   if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Membership version conflict. Reload before retrying.');
   const mapped=mapMembership(rows[0]);
   await session.query('UPDATE wimblo_platform.opaque_sessions SET revoked_at=$3::timestamptz WHERE tenant_id=$1 AND identity_id=$2 AND revoked_at IS NULL',[mapped.tenantId,mapped.identityId,at]);
   await appendAuditWith(session,{tenantId:mapped.tenantId,identityId:mapped.identityId,actorIdentityId,action:'membership.changed',targetType:'membership',targetId:member,at});
   return mapped;
  });
 }

 async function createInvitation({invitationId,tenantId,token,email:rawEmail,role,createdBy,expiresAt}){
  const id=uuid(invitationId,'Invitation ID'),tenant=uuid(tenantId,'Tenant ID'),creator=uuid(createdBy,'Invitation creator ID'),at=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `INSERT INTO wimblo_platform.invitations(invitation_id,tenant_id,token_hash,normalized_email,role,created_by,expires_at,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)
     RETURNING invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at`,
    [id,tenant,digest(token),email(rawEmail),oneOf(role,ROLES,'Invitation role'),creator,date(expiresAt,'Invitation expiry'),at]);
   await appendAuditWith(session,{tenantId:tenant,actorIdentityId:creator,action:'invitation.created',targetType:'invitation',targetId:id,at});
   return mapInvitation(rows[0]);
  });
 }

 async function getInvitation(invitationId){
  const {rows}=await read(session=>session.query(
   `SELECT invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at
    FROM wimblo_platform.invitations WHERE invitation_id=$1`,[uuid(invitationId,'Invitation ID')]));
  if(!rows[0])persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Invitation was not found.');
  return mapInvitation(rows[0]);
 }

 async function consumeInvitation({token,identityId,expectedVersion}){
  const identity=uuid(identityId,'Identity ID'),expected=version(expectedVersion),at=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `UPDATE wimblo_platform.invitations SET status='consumed',consumed_by=$2,consumed_at=$3::timestamptz,version=version+1
     WHERE token_hash=$1 AND status='pending' AND expires_at>$3::timestamptz AND version=$4
     RETURNING invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at`,
    [digest(token),identity,at,expected]);
   if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation is expired, consumed, revoked or changed.');
   const mapped=mapInvitation(rows[0]);
   await appendAuditWith(session,{tenantId:mapped.tenantId,identityId:identity,actorIdentityId:identity,action:'invitation.consumed',targetType:'invitation',targetId:mapped.invitationId,at});
   return mapped;
  });
 }

 async function acceptInvitationMembership({token,expectedVersion,identityId,membershipId,newIdentity=null}){
  const identity=uuid(identityId,'Identity ID'),member=uuid(membershipId,'Membership ID'),expected=version(expectedVersion),at=currentTime();
  return transaction(async session=>{
   const invitationResult=await session.query(
    `SELECT invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at
     FROM wimblo_platform.invitations
     WHERE token_hash=$1 AND status='pending' AND expires_at>$2::timestamptz AND version=$3 FOR UPDATE`,
    [digest(token),at,expected]);
   if(!invitationResult.rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation is expired, consumed, revoked or changed.');
   let invitation=mapInvitation(invitationResult.rows[0]);
   let identityRow;
   if(newIdentity){
    if(email(newIdentity.email)!==invitation.normalizedEmail)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation email no longer matches the new identity.');
    const created=await session.query(
     `INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',$5::timestamptz,$5::timestamptz)
      RETURNING identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at`,
     [identity,invitation.normalizedEmail,text(newIdentity.displayName,'Display name',200),text(newIdentity.passwordHash,'Password hash',4096),at]);
    identityRow=created.rows[0];
   }else{
    const existing=await session.query(
     `SELECT identity_id,normalized_email,display_name,password_hash,status,security_version,created_at,updated_at
      FROM wimblo_platform.global_identities WHERE identity_id=$1 FOR UPDATE`,[identity]);
    identityRow=existing.rows[0];
    if(!identityRow||identityRow.status!=='active'||identityRow.normalized_email!==invitation.normalizedEmail)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation identity no longer matches an active account.');
   }
   const consumed=await session.query(
    `UPDATE wimblo_platform.invitations SET status='consumed',consumed_by=$2,consumed_at=$3::timestamptz,version=version+1
     WHERE invitation_id=$1 AND status='pending' AND version=$4
     RETURNING invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at`,
    [invitation.invitationId,identity,at,expected]);
   if(!consumed.rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation changed during acceptance.');
   invitation=mapInvitation(consumed.rows[0]);
   const membershipResult=await session.query(
    `INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status,created_at,updated_at)
     VALUES($1,$2,$3,$4,'active',$5::timestamptz,$5::timestamptz)
     RETURNING membership_id,tenant_id,identity_id,role,status,version,created_at,updated_at`,
    [member,invitation.tenantId,identity,invitation.role,at]);
   if(newIdentity)await appendAuditWith(session,{identityId:identity,actorIdentityId:identity,action:'identity.created',targetType:'identity',targetId:identity,at});
   await appendAuditWith(session,{tenantId:invitation.tenantId,identityId:identity,actorIdentityId:identity,action:'invitation.consumed',targetType:'invitation',targetId:invitation.invitationId,at});
   await appendAuditWith(session,{tenantId:invitation.tenantId,identityId:identity,actorIdentityId:identity,action:'membership.created',targetType:'membership',targetId:member,at});
   return {identity:mapIdentity(identityRow),membership:mapMembership(membershipResult.rows[0]),invitation};
  });
 }

 async function revokeInvitation({invitationId,expectedVersion,actorIdentityId}){
  const id=uuid(invitationId,'Invitation ID'),actor=uuid(actorIdentityId,'Invitation actor ID'),expected=version(expectedVersion),at=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `UPDATE wimblo_platform.invitations SET status='revoked',revoked_at=$2::timestamptz,version=version+1
     WHERE invitation_id=$1 AND status='pending' AND version=$3
     RETURNING invitation_id,tenant_id,normalized_email,role,status,created_by,consumed_by,expires_at,consumed_at,revoked_at,version,created_at`,[id,at,expected]);
   if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Invitation cannot be revoked in its current version or state.');
   const mapped=mapInvitation(rows[0]);
   await appendAuditWith(session,{tenantId:mapped.tenantId,actorIdentityId:actor,action:'invitation.revoked',targetType:'invitation',targetId:id,at});
   return mapped;
  });
 }

 async function getMfaState(identityId){
  const {rows}=await read(session=>session.query(
   `SELECT identity_id,state,secret_ciphertext,enrolled_at,version,updated_at FROM wimblo_platform.mfa_settings WHERE identity_id=$1`,[uuid(identityId,'Identity ID')]));
  return mapMfa(rows[0]);
 }

 async function putMfaState({identityId,state,secretCiphertext=null,enrolledAt=null,expectedVersion=null,actorIdentityId=null,rotateSecurity=false}){
  const identity=uuid(identityId,'Identity ID'),nextState=oneOf(state,MFA_STATES,'MFA state'),at=currentTime();
  return transaction(async session=>{
   let result;
   if(expectedVersion===null){
    result=await session.query(
     `INSERT INTO wimblo_platform.mfa_settings(identity_id,state,secret_ciphertext,enrolled_at,updated_at)
      VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz) ON CONFLICT (identity_id) DO NOTHING
      RETURNING identity_id,state,secret_ciphertext,enrolled_at,version,updated_at`,[identity,nextState,secretCiphertext,nullableDate(enrolledAt),at]);
   }else{
    result=await session.query(
     `UPDATE wimblo_platform.mfa_settings SET state=$2,secret_ciphertext=$3,enrolled_at=$4::timestamptz,version=version+1,updated_at=$5::timestamptz
      WHERE identity_id=$1 AND version=$6 RETURNING identity_id,state,secret_ciphertext,enrolled_at,version,updated_at`,[identity,nextState,secretCiphertext,nullableDate(enrolledAt),at,version(expectedVersion)]);
   }
   if(!result.rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'MFA state version conflict. Reload before retrying.');
   let securityVersion=null;
   if(rotateSecurity){
    const changed=await session.query('UPDATE wimblo_platform.global_identities SET security_version=security_version+1,updated_at=$2::timestamptz WHERE identity_id=$1 RETURNING security_version',[identity,at]);
    if(!changed.rows[0])persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Identity was not found for MFA security rotation.');
    securityVersion=Number(changed.rows[0].security_version);
    await session.query('UPDATE wimblo_platform.opaque_sessions SET revoked_at=$2::timestamptz WHERE identity_id=$1 AND revoked_at IS NULL',[identity,at]);
   }
   await appendAuditWith(session,{identityId:identity,actorIdentityId,action:'mfa.state.changed',targetType:'mfa',targetId:identity,at,details:{state:nextState,securityRotated:rotateSecurity}});
   return {...mapMfa(result.rows[0]),securityVersion};
  });
 }

 async function replaceRecoveryCodes({identityId,codeHashes,actorIdentityId=null}){
  const identity=uuid(identityId,'Identity ID'),codes=Array.isArray(codeHashes)?[...new Set(codeHashes.map(hash))]:fail('Recovery codes must be an array of hashes.'),at=currentTime();
  if(codes.length<1||codes.length>20)fail('Recovery codes must contain between 1 and 20 unique hashes.');
  return transaction(async session=>{
   await session.query('DELETE FROM wimblo_platform.mfa_recovery_codes WHERE identity_id=$1',[identity]);
   for(const codeHash of codes)await session.query('INSERT INTO wimblo_platform.mfa_recovery_codes(identity_id,code_hash,created_at) VALUES($1,$2,$3::timestamptz)',[identity,codeHash,at]);
   const changed=await session.query('UPDATE wimblo_platform.global_identities SET security_version=security_version+1,updated_at=$2::timestamptz WHERE identity_id=$1 RETURNING security_version',[identity,at]);
   if(!changed.rows[0])persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Identity was not found for recovery-code rotation.');
   await session.query('UPDATE wimblo_platform.opaque_sessions SET revoked_at=$2::timestamptz WHERE identity_id=$1 AND revoked_at IS NULL',[identity,at]);
   await appendAuditWith(session,{identityId:identity,actorIdentityId,action:'mfa.recovery.replaced',targetType:'mfa',targetId:identity,at,details:{count:codes.length}});
   return {identityId:identity,count:codes.length,securityVersion:Number(changed.rows[0].security_version)};
  });
 }

 async function consumeRecoveryCode({identityId,codeHash,at=currentTime()}){
  const identity=uuid(identityId,'Identity ID'),usedAt=date(at,'Recovery use timestamp');
  return transaction(async session=>{
   const {rows}=await session.query(
    `UPDATE wimblo_platform.mfa_recovery_codes SET used_at=$3::timestamptz
     WHERE identity_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING identity_id,code_hash,used_at`,[identity,hash(codeHash),usedAt]);
   if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'Recovery code is invalid or already used.');
   await appendAuditWith(session,{identityId:identity,actorIdentityId:identity,action:'mfa.recovery.used',targetType:'mfa',targetId:identity,at:usedAt});
   return {identityId:identity,usedAt:iso(rows[0].used_at)};
  });
 }

 async function countRecoveryCodes(identityId){
  const {rows}=await read(session=>session.query(
   `SELECT COUNT(*)::integer AS count FROM wimblo_platform.mfa_recovery_codes WHERE identity_id=$1 AND used_at IS NULL`,
   [uuid(identityId,'Identity ID')]));
  return Number(rows[0]?.count??0);
 }

 async function createMfaChallenge({challengeId,identityId,purpose,challengeHash,expiresAt}){
  const challenge=uuid(challengeId,'Challenge ID'),identity=uuid(identityId,'Identity ID'),at=currentTime();
  const {rows}=await read(session=>session.query(
   `INSERT INTO wimblo_platform.mfa_challenges(challenge_id,identity_id,purpose,challenge_hash,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)
    RETURNING challenge_id,identity_id,purpose,challenge_hash,attempts,expires_at,completed_at,created_at`,
   [challenge,identity,oneOf(purpose,CHALLENGE_PURPOSES,'Challenge purpose'),hash(challengeHash),date(expiresAt,'Challenge expiry'),at]));
  return mapChallenge(rows[0]);
 }

 async function getMfaChallenge(challengeId){
  const {rows}=await read(session=>session.query(
   `SELECT challenge_id,identity_id,purpose,challenge_hash,attempts,expires_at,completed_at,created_at
    FROM wimblo_platform.mfa_challenges WHERE challenge_id=$1`,[uuid(challengeId,'Challenge ID')]));
  return mapChallenge(rows[0]);
 }

 async function updateMfaChallenge({challengeId,expectedAttempts,attempts,completedAt=null}){
  const challenge=uuid(challengeId,'Challenge ID');
  if(!Number.isSafeInteger(expectedAttempts)||expectedAttempts<0||!Number.isSafeInteger(attempts)||attempts<0||attempts>10)fail('Challenge attempts are invalid.');
  const {rows}=await read(session=>session.query(
   `UPDATE wimblo_platform.mfa_challenges SET attempts=$2,completed_at=$3::timestamptz
    WHERE challenge_id=$1 AND attempts=$4 AND completed_at IS NULL
    RETURNING challenge_id,identity_id,purpose,challenge_hash,attempts,expires_at,completed_at,created_at`,[challenge,attempts,nullableDate(completedAt),expectedAttempts]));
  if(!rows[0])persistenceFail(PERSISTENCE_CODES.CONFLICT,'MFA challenge changed or was already completed.');
  return mapChallenge(rows[0]);
 }

 async function createSession({token,csrfHash,tenantId,identityId,membershipVersion,securityVersion,mfaVerifiedAt,recentAuthenticatedAt,expiresAt}){
  const tenant=uuid(tenantId,'Tenant ID'),identity=uuid(identityId,'Identity ID'),at=currentTime();
  return transaction(async session=>{
   const {rows}=await session.query(
    `INSERT INTO wimblo_platform.opaque_sessions(token_hash,csrf_hash,tenant_id,identity_id,membership_version,security_version,mfa_verified_at,recent_authenticated_at,created_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz)
     RETURNING token_hash,csrf_hash,tenant_id,identity_id,membership_version,security_version,mfa_verified_at,recent_authenticated_at,created_at,expires_at,revoked_at`,
    [digest(token),hash(csrfHash),tenant,identity,version(membershipVersion,'Membership version'),version(securityVersion,'Security version'),nullableDate(mfaVerifiedAt),date(recentAuthenticatedAt,'Recent authentication timestamp'),at,date(expiresAt,'Session expiry')]);
   await appendAuditWith(session,{tenantId:tenant,identityId:identity,actorIdentityId:identity,action:'session.created',targetType:'session',targetId:rows[0].token_hash.slice(0,12),at});
   return mapSession(rows[0]);
  });
 }

 async function getSession(token){
  const {rows}=await read(session=>session.query(
   `SELECT token_hash,csrf_hash,tenant_id,identity_id,membership_version,security_version,mfa_verified_at,recent_authenticated_at,created_at,expires_at,revoked_at
    FROM wimblo_platform.opaque_sessions WHERE token_hash=$1`,[digest(token)]));
  return mapSession(rows[0]);
 }

 async function revokeSessions({identityId,tenantId=null,token=null,actorIdentityId=null}){
  const identity=uuid(identityId,'Identity ID'),tenant=tenantId===null?null:uuid(tenantId,'Tenant ID'),tokenHash=token===null?null:digest(token),at=currentTime();
  return transaction(async session=>{
   const result=await session.query(
    `UPDATE wimblo_platform.opaque_sessions SET revoked_at=$4::timestamptz
     WHERE identity_id=$1 AND ($2::uuid IS NULL OR tenant_id=$2) AND ($3::char(64) IS NULL OR token_hash=$3) AND revoked_at IS NULL`,[identity,tenant,tokenHash,at]);
   await appendAuditWith(session,{tenantId:tenant,identityId:identity,actorIdentityId,action:'session.revoked',targetType:'identity',targetId:identity,at,details:{count:result.rowCount}});
   return {identityId:identity,tenantId:tenant,revoked:Number(result.rowCount),at};
  });
 }

 async function getTenantState(tenantId){
  const {rows}=await read(session=>session.query('SELECT tenant_id,status,lifecycle_version FROM wimblo_platform.tenant_state($1)',[uuid(tenantId,'Tenant ID')]));
  return rows[0]?{tenantId:rows[0].tenant_id,status:rows[0].status,lifecycleVersion:Number(rows[0].lifecycle_version)}:null;
 }

 return Object.freeze({
  createIdentity,findIdentityByEmail,getIdentity,changeIdentity,
  createMembership,getMembership,listMemberships,listTenantMemberships,changeMembership,
  createInvitation,getInvitation,consumeInvitation,acceptInvitationMembership,revokeInvitation,
  getMfaState,putMfaState,replaceRecoveryCodes,consumeRecoveryCode,countRecoveryCodes,createMfaChallenge,getMfaChallenge,updateMfaChallenge,
  createSession,getSession,revokeSessions,getTenantState,appendAudit
 });
}
