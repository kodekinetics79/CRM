import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createIdentityService} from '../server/production/identityService.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const instant='2026-11-11T15:00:00.000Z';
const clock=()=>new Date(instant);
const passwordHash=async password=>`adaptive:${password}`;
const verifyPassword=async(password,encoded)=>encoded===`adaptive:${password}`;
const invitationSecret='identity-invitation-secret-32-bytes-minimum';

function memoryRepository(){
  const identities=new Map(),emails=new Map(),memberships=new Map(),invitations=new Map();
  const calls=[];
  const conflict=message=>{throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,message);};
  return {
    calls,identities,memberships,invitations,businessCalls:0,
    async createIdentity(input){calls.push(['createIdentity',input]);if(emails.has(input.email.trim().toLowerCase()))conflict('duplicate email');const row={identityId:input.identityId,normalizedEmail:input.email.trim().toLowerCase(),displayName:input.displayName,passwordHash:input.passwordHash,status:'active',securityVersion:1};identities.set(row.identityId,row);emails.set(row.normalizedEmail,row.identityId);return {...row};},
    async findIdentityByEmail(value){calls.push(['findIdentityByEmail',value]);const id=emails.get(value.trim().toLowerCase());return id?{...identities.get(id)}:null;},
    async getIdentity(id){calls.push(['getIdentity',id]);const row=identities.get(id);if(!row)throw new PersistenceError(PERSISTENCE_CODES.NOT_FOUND,'missing');return {...row};},
    async changeIdentity(input){calls.push(['changeIdentity',input]);const row=identities.get(input.identityId);if(!row||row.securityVersion!==input.expectedSecurityVersion)conflict('identity version');row.status=input.status??row.status;row.securityVersion++;return {...row};},
    async createMembership(input){calls.push(['createMembership',input]);if([...memberships.values()].some(row=>row.tenantId===input.tenantId&&row.identityId===input.identityId))conflict('duplicate membership');const row={membershipId:input.membershipId,tenantId:input.tenantId,identityId:input.identityId,role:input.role,status:'active',version:1};memberships.set(row.membershipId,row);return {...row};},
    async getMembership(id){calls.push(['getMembership',id]);const row=memberships.get(id);if(!row)throw new PersistenceError(PERSISTENCE_CODES.NOT_FOUND,'missing');return {...row};},
    async listMemberships(identityId,{status=null}={}){calls.push(['listMemberships',identityId]);return [...memberships.values()].filter(row=>row.identityId===identityId&&(!status||row.status===status)).map(row=>({...row}));},
    async listTenantMemberships(tenantId,{status=null,role=null}={}){calls.push(['listTenantMemberships',tenantId]);return [...memberships.values()].filter(row=>row.tenantId===tenantId&&(!status||row.status===status)&&(!role||row.role===role)).map(row=>({...row}));},
    async changeMembership(input){calls.push(['changeMembership',input]);const row=memberships.get(input.membershipId);if(!row||row.version!==input.expectedVersion)conflict('membership version');row.role=input.role??row.role;row.status=input.status??row.status;row.version++;return {...row};},
    async createInvitation(input){calls.push(['createInvitation',input]);const row={invitationId:input.invitationId,tenantId:input.tenantId,token:input.token,normalizedEmail:input.email.trim().toLowerCase(),role:input.role,status:'pending',createdBy:input.createdBy,expiresAt:new Date(input.expiresAt).toISOString(),version:1};invitations.set(row.invitationId,row);return {...row,token:undefined};},
    async getInvitation(id){calls.push(['getInvitation',id]);const row=invitations.get(id);if(!row)throw new PersistenceError(PERSISTENCE_CODES.NOT_FOUND,'missing');return {...row,token:undefined};},
    async acceptInvitationMembership({token,identityId,membershipId,expectedVersion,newIdentity=null}){calls.push(['acceptInvitationMembership',{identityId,membershipId,expectedVersion,newIdentity}]);const row=[...invitations.values()].find(value=>value.token===token);if(!row||row.status!=='pending'||row.version!==expectedVersion)conflict('invitation unavailable');let identity=identities.get(identityId);if(newIdentity){if(emails.has(newIdentity.email))conflict('duplicate email');identity={identityId,normalizedEmail:newIdentity.email,displayName:newIdentity.displayName,passwordHash:newIdentity.passwordHash,status:'active',securityVersion:1};identities.set(identityId,identity);emails.set(identity.normalizedEmail,identityId);}if(!identity||identity.normalizedEmail!==row.normalizedEmail)conflict('identity mismatch');if([...memberships.values()].some(value=>value.tenantId===row.tenantId&&value.identityId===identityId))conflict('duplicate membership');const membership={membershipId,tenantId:row.tenantId,identityId,role:row.role,status:'active',version:1};memberships.set(membershipId,membership);row.status='consumed';row.consumedBy=identityId;row.version++;return {identity:{...identity},membership:{...membership},invitation:{...row,token:undefined}};},
    async consumeInvitation({token,identityId,expectedVersion}){calls.push(['consumeInvitation',{token,identityId,expectedVersion}]);const row=[...invitations.values()].find(value=>value.token===token);if(!row||row.status!=='pending'||row.version!==expectedVersion)conflict('invitation unavailable');row.status='consumed';row.consumedBy=identityId;row.version++;return {...row,token:undefined};},
    async revokeInvitation({invitationId,expectedVersion}){calls.push(['revokeInvitation',invitationId]);const row=invitations.get(invitationId);if(!row||row.status!=='pending'||row.version!==expectedVersion)conflict('invitation unavailable');row.status='revoked';row.version++;return {...row,token:undefined};}
  };
}

async function seeded(){
  const repository=memoryRepository();
  const ownerId=randomUUID(),tenantId=randomUUID();
  await repository.createIdentity({identityId:ownerId,email:'owner@example.com',displayName:'Owner',passwordHash:'adaptive:owner-pass'});
  const owner=await repository.createMembership({membershipId:randomUUID(),tenantId,identityId:ownerId,role:'owner'});
  const service=createIdentityService({repository,passwordHash,verifyPassword,invitationSecret,clock});
  return {repository,service,ownerId,owner,tenantId};
}

test('only an active owner or admin can issue an HMAC-bound invitation',async()=>{
  const {repository,service,ownerId,tenantId}=await seeded();
  const issued=await service.issueInvitation({actorIdentityId:ownerId,tenantId,email:'Person@Example.com',role:'staff',expiresAt:'2026-11-12T15:00:00.000Z'});
  assert.match(issued.token,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(issued.invitation.normalizedEmail,'person@example.com');
  const staffId=randomUUID();
  await repository.createIdentity({identityId:staffId,email:'staff@example.com',displayName:'Staff',passwordHash:'adaptive:staff-pass'});
  await repository.createMembership({membershipId:randomUUID(),tenantId,identityId:staffId,role:'staff'});
  await assert.rejects(()=>service.issueInvitation({actorIdentityId:staffId,tenantId,email:'x@example.com',role:'viewer',expiresAt:'2026-11-12T15:00:00.000Z'}),/owner or administrator/i);
  const [payload,signature]=issued.token.split('.');
  const replacement=signature.at(-1)==='A'?'B':'A';
  await assert.rejects(()=>service.acceptInvitation({token:`${payload}.${signature.slice(0,-1)}${replacement}`,password:'new-pass',displayName:'Person'}),/invalid or unavailable/i);
});

test('an existing email accepts only after matching password authentication and replay is refused',async()=>{
  const {repository,service,ownerId,tenantId}=await seeded();
  const existingId=randomUUID();
  await repository.createIdentity({identityId:existingId,email:'existing@example.com',displayName:'Existing',passwordHash:'adaptive:correct'});
  const {token}=await service.issueInvitation({actorIdentityId:ownerId,tenantId,email:'existing@example.com',role:'viewer',expiresAt:'2026-11-12T15:00:00.000Z'});
  await assert.rejects(()=>service.acceptInvitation({token,password:'wrong'}),/invalid credentials/i);
  const accepted=await service.acceptInvitation({token,password:'correct'});
  assert.equal(accepted.identity.identityId,existingId);
  assert.equal(repository.calls.filter(([name])=>name==='createIdentity').length,2);
  await assert.rejects(()=>service.acceptInvitation({token,password:'correct'}),/invalid or unavailable/i);
});

test('a new invitation email creates exactly one identity and one versioned membership',async()=>{
  const {repository,service,ownerId,tenantId}=await seeded();
  const {token}=await service.issueInvitation({actorIdentityId:ownerId,tenantId,email:'new@example.com',role:'admin',expiresAt:'2026-11-12T15:00:00.000Z'});
  const accepted=await service.acceptInvitation({token,password:'new-password',displayName:'New Admin'});
  assert.equal(accepted.identity.normalizedEmail,'new@example.com');
  assert.equal(accepted.identity.securityVersion,1);
  assert.equal(accepted.membership.version,1);
  assert.equal(accepted.membership.role,'admin');
  assert.equal(repository.identities.size,2);
});

test('revoked and expired invitations fail with the same unavailable result',async()=>{
  const {service,ownerId,tenantId}=await seeded();
  const revoked=await service.issueInvitation({actorIdentityId:ownerId,tenantId,email:'revoked@example.com',role:'viewer',expiresAt:'2026-11-12T15:00:00.000Z'});
  await service.revokeInvitation({actorIdentityId:ownerId,invitationId:revoked.invitation.invitationId,expectedVersion:1});
  await assert.rejects(()=>service.acceptInvitation({token:revoked.token,password:'password',displayName:'Revoked'}),/invalid or unavailable/i);
  const expired=await service.issueInvitation({actorIdentityId:ownerId,tenantId,email:'expired@example.com',role:'viewer',expiresAt:'2026-11-11T14:59:59.000Z'});
  await assert.rejects(()=>service.acceptInvitation({token:expired.token,password:'password',displayName:'Expired'}),/invalid or unavailable/i);
});

test('membership changes increment versions and cannot remove the final active owner',async()=>{
  const {repository,service,ownerId,owner,tenantId}=await seeded();
  await assert.rejects(()=>service.changeMembership({actorIdentityId:ownerId,membershipId:owner.membershipId,role:'admin',expectedVersion:1}),/final active owner/i);
  const secondId=randomUUID();
  await repository.createIdentity({identityId:secondId,email:'second@example.com',displayName:'Second',passwordHash:'adaptive:second'});
  await repository.createMembership({membershipId:randomUUID(),tenantId,identityId:secondId,role:'owner'});
  const changed=await service.changeMembership({actorIdentityId:ownerId,membershipId:owner.membershipId,role:'admin',expectedVersion:1});
  assert.equal(changed.version,2);
  assert.equal(changed.role,'admin');
});

test('one verified email accepts invitations to two tenants without merging tenant data',async()=>{
  const first=await seeded();
  const secondTenant=randomUUID();
  await first.repository.createMembership({membershipId:randomUUID(),tenantId:secondTenant,identityId:first.ownerId,role:'owner'});
  const firstInvite=await first.service.issueInvitation({actorIdentityId:first.ownerId,tenantId:first.tenantId,email:'shared@example.com',role:'staff',expiresAt:'2026-11-12T15:00:00.000Z'});
  const secondInvite=await first.service.issueInvitation({actorIdentityId:first.ownerId,tenantId:secondTenant,email:'shared@example.com',role:'viewer',expiresAt:'2026-11-12T15:00:00.000Z'});
  const acceptedA=await first.service.acceptInvitation({token:firstInvite.token,password:'shared-pass',displayName:'Shared Person'});
  const acceptedB=await first.service.acceptInvitation({token:secondInvite.token,password:'shared-pass'});
  assert.equal(acceptedA.identity.identityId,acceptedB.identity.identityId);
  assert.notEqual(acceptedA.membership.membershipId,acceptedB.membership.membershipId);
  assert.deepEqual(new Set([acceptedA.membership.tenantId,acceptedB.membership.tenantId]),new Set([first.tenantId,secondTenant]));
  assert.equal(first.repository.businessCalls,0);
});
