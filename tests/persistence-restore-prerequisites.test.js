import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantBackup,restoreTenantBackup,PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const KEY='e'.repeat(64);

async function referencedArchive(){
 const tenantId=randomUUID(),identityId=randomUUID();
 const repository={
  tenantId,kind:'fixture',
  async exportTenant(){return {format:'wimblo-persistence-tenant-dump',version:1,tenantId,tenantData:{crm_tasks:[{tenant_id:tenantId,owner_identity_id:identityId}]}};},
  async snapshotDigest(){return {tenantId,schemaVersion:18,collections:{},financial:{},totals:{},users:{},audit:{},settings:{},tenantData:{}};},
  async schemaVersion(){return 18;}
 };
 const backup=await createTenantBackup({repository,encryptionKey:KEY});
 return {...backup,tenantId,identityId};
}

test('control-plane repository outages remain unavailable errors and never open the restore target',async()=>{
 const fixture=await referencedArchive(),outage=new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,'Control repository is unavailable.');let factoryCalls=0;
 await assert.rejects(()=>restoreTenantBackup({
  archive:fixture.archive,encryptionKey:KEY,
  validateControlPlanePrerequisites:async()=>{throw outage;},
  createTargetRepository:()=>{factoryCalls++;throw new Error('target must remain closed');}
 }),error=>{
  assert.equal(error,outage);
  assert.equal(error.code,PERSISTENCE_CODES.UNAVAILABLE);
  return true;
 });
 assert.equal(factoryCalls,0);
});

test('authoritative missing identity or membership confirmation is an isolation refusal',async()=>{
 const fixture=await referencedArchive();let factoryCalls=0;
 await assert.rejects(()=>restoreTenantBackup({
  archive:fixture.archive,encryptionKey:KEY,
  validateControlPlanePrerequisites:async()=>({identityIds:[],membershipIdentityIds:[]}),
  createTargetRepository:()=>{factoryCalls++;throw new Error('target must remain closed');}
 }),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
  assert.match(error.message,/identity|membership/i);
  return true;
 });
 assert.equal(factoryCalls,0);
});
