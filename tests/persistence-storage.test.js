import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
 createPrivateObjectStore,createMemoryObjectBackend,createMemoryObjectCatalog,parseObjectKey,
 OBJECT_CONTENT_TYPES,OBJECT_MAX_BYTES,ENCRYPTION_ALGORITHM,
 resolveResidency,RESIDENCY_PROFILES,DEFAULT_RESIDENCY_PROFILE,RESIDENCY_AUTHORITY,CUSTODY_MODES,
 createSqliteRepository,createTenantBackup,readBackupManifest,restoreTenantBackup,verifyRestore,
 PERSISTENCE_CODES
} from '../server/persistence/index.js';

const TENANT='7c2f9e10-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER='11111111-2222-4333-8444-555555555555';
const KEY='a'.repeat(64);
const sha=b=>createHash('sha256').update(b).digest('hex');
const document=Buffer.from('%PDF-1.7\nSynthetic private evidence.\n');

function store(overrides={}){
 return createPrivateObjectStore({
  backend:createMemoryObjectBackend(),
  catalog:createMemoryObjectCatalog(),
  residency:resolveResidency({databaseRegion:'us-east-1',storageRegion:'ca-central-1'}),
  encryptionKey:KEY,namespace:'release-a',
  ...overrides
 });
}

// ---------------------------------------------------------------- residency
test('data residency defaults to the US or Canada profile required by Addendum 2 §1(a)(iv)',()=>{
 assert.equal(DEFAULT_RESIDENCY_PROFILE,'us-ca');
 const resolved=resolveResidency({databaseRegion:'us-east-2',storageRegion:'ca-central-1'});
 assert.equal(resolved.profile,'us-ca');
 assert.deepEqual(resolved.countries,['US','CA']);
 assert.equal(resolved.authority,RESIDENCY_AUTHORITY);
 assert.match(resolved.authority,/United States or Canada/);
 // Configuration is not placement evidence and this must never claim otherwise.
 assert.equal(resolved.placementProven,false);
 assert.match(resolved.notice,/placement evidence must be obtained separately/);
 assert.ok(Object.isFrozen(resolved));
});

test('regions outside the configured residency profile are refused, and profiles may only narrow',()=>{
 for(const region of ['eu-west-1','ap-south-1','sa-east-1','us-gov-west-1',''])
  assert.throws(()=>resolveResidency({databaseRegion:region,storageRegion:'us-east-1'}),/outside the United States or Canada|explicit database and storage regions/);
 for(const region of ['eu-central-1','ap-northeast-1'])
  assert.throws(()=>resolveResidency({databaseRegion:'us-east-1',storageRegion:region}),/outside the United States or Canada/);
 assert.equal(resolveResidency({profile:'us-only',databaseRegion:'us-west-2',storageRegion:'us-west-2'}).countries.length,1);
 assert.throws(()=>resolveResidency({profile:'us-only',databaseRegion:'ca-central-1',storageRegion:'us-east-1'}),/United States only/);
 assert.throws(()=>resolveResidency({profile:'ca-only',databaseRegion:'us-east-1',storageRegion:'ca-central-1'}),/Canada only/);
 assert.throws(()=>resolveResidency({profile:'eu',databaseRegion:'us-east-1',storageRegion:'us-east-1'}),/Unknown data residency profile/);
 for(const profile of Object.values(RESIDENCY_PROFILES))assert.ok(profile.storageRegions.every(r=>r.startsWith('us-')||r.startsWith('ca-')));
});

test('custody, endpoints and production confirmation are explicit rather than assumed',()=>{
 for(const custody of CUSTODY_MODES)assert.equal(resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',custody}).custody,custody);
 assert.throws(()=>resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',custody:'trust-me'}),/Key custody must be one of/);
 for(const endpoint of ['https://key:secret@store.example','https://store.example?token=x','http://storage.example','not-a-url'])
  assert.throws(()=>resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',endpoint}),/endpoint/);
 assert.equal(resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',endpoint:'http://127.0.0.1:9000'}).endpoint,'http://127.0.0.1:9000');
 assert.throws(()=>resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',endpoint:'http://127.0.0.1:9000',production:true,residencyConfirmed:true}),/Production storage cannot use a custom endpoint/);
 assert.throws(()=>resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',production:true}),/explicit operator confirmation/);
 assert.equal(resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',production:true,residencyConfirmed:true}).residencyConfirmed,true);
});

// ------------------------------------------------------------- object store
test('a private object round-trips with checksum, size, content type and encryption metadata',async()=>{
 const s=store();
 const put=await s.put({tenantId:TENANT,objectId:'grant-agreement',revision:1,bytes:document,contentType:'application/pdf'});
 assert.equal(put.state,'active');
 assert.equal(put.size,document.length);
 assert.equal(put.sha256,sha(document));
 assert.equal(put.encryptionAlgorithm,ENCRYPTION_ALGORITHM);
 assert.equal(put.custody,'application-managed-key');
 assert.equal(put.region,'ca-central-1');
 assert.equal(put.residencyProfile,'us-ca');
 assert.notEqual(put.ciphertextSha256,put.sha256);
 assert.match(put.objectKey,/^namespaces\/release-a\/tenants\/7c2f9e10-4a5b-4c6d-8e7f-0a1b2c3d4e5f\/objects\/grant-agreement\/revisions\/1\//);
 const read=await s.get({tenantId:TENANT,objectId:'grant-agreement',revision:1});
 assert.ok(read.bytes.equals(document));
 assert.equal(read.metadata.sha256,sha(document));
 // The key identifier is derived, never the key itself.
 assert.equal(s.encryption.keyId.length,32);
 assert.equal(s.encryption.keyId.includes(KEY.slice(0,16)),false);
});

test('size, content-type, emptiness and identity limits are enforced before anything is stored',async()=>{
 const backend=createMemoryObjectBackend();
 const s=store({backend});
 const refusals=[
  [{objectId:'too-big',bytes:Buffer.alloc(OBJECT_MAX_BYTES+1),contentType:'application/pdf'},/exceeds the/],
  [{objectId:'empty',bytes:Buffer.alloc(0),contentType:'application/pdf'},/empty object is refused/],
  [{objectId:'executable',bytes:document,contentType:'application/x-msdownload'},/outside the accepted set/],
  [{objectId:'html',bytes:document,contentType:'text/html'},/outside the accepted set/],
  [{objectId:'../escape',bytes:document,contentType:'application/pdf'},/explicit object identity/],
  [{objectId:'ok',revision:0,bytes:document,contentType:'application/pdf'},/positive integers/]
 ];
 for(const [input,pattern] of refusals)await assert.rejects(()=>s.put({tenantId:TENANT,revision:1,...input}),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.INVALID);
  assert.match(error.message,pattern);
  return true;
 });
 await assert.rejects(()=>s.put({tenantId:'not-a-uuid',objectId:'ok',bytes:document,contentType:'application/pdf'}),/tenant UUID/);
 assert.equal(backend.size(),0,'nothing may be stored for a refused upload');
 assert.deepEqual(s.limits.contentTypes,[...OBJECT_CONTENT_TYPES]);
 assert.equal(s.limits.maxBytes,OBJECT_MAX_BYTES);
});

test('stored bytes are ciphertext, and corruption or a wrong key is detected rather than returned',async()=>{
 const backend=createMemoryObjectBackend(),catalog=createMemoryObjectCatalog();
 const s=store({backend,catalog});
 const put=await s.put({tenantId:TENANT,objectId:'doc',revision:1,bytes:document,contentType:'application/pdf'});
 const raw=await backend.get(put.objectKey,put.providerVersion);
 assert.equal(raw.includes('%PDF-1.7'),false,'plaintext must not reach the backend');
 assert.equal(sha(raw),put.ciphertextSha256);

 await catalog.update({tenantId:TENANT,objectId:'doc',revision:1},{});
 const other=createPrivateObjectStore({backend,catalog,residency:resolveResidency({databaseRegion:'us-east-1',storageRegion:'ca-central-1'}),encryptionKey:'b'.repeat(64),namespace:'release-a'});
 await assert.rejects(()=>other.get({tenantId:TENANT,objectId:'doc',revision:1}),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.VERIFICATION);
  assert.match(error.message,/authentication failed/);
  return true;
 });
 await assert.rejects(()=>s.get({tenantId:OTHER,objectId:'doc',revision:1}),/not catalogued/);
 await assert.rejects(()=>s.get({tenantId:TENANT,objectId:'doc',revision:2}),/not catalogued/);
 assert.throws(()=>parseObjectKey('short'),/32-byte hex or base64/);
 assert.equal(parseObjectKey(KEY).length,32);
});

test('a failed upload leaves a staged, unreadable revision instead of a readable one',async()=>{
 const backend={provider:'memory',async put(){throw new Error('synthetic backend outage');},async get(){throw new Error('unused');},async remove(){return true;}};
 const catalog=createMemoryObjectCatalog();
 const s=store({backend,catalog});
 await assert.rejects(()=>s.put({tenantId:TENANT,objectId:'doc',revision:1,bytes:document,contentType:'application/pdf'}),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.UNAVAILABLE);
  assert.equal(error.detail.state,'staged');
  return true;
 });
 assert.equal((await s.describe({tenantId:TENANT,objectId:'doc',revision:1})).state,'staged');
 await assert.rejects(()=>s.get({tenantId:TENANT,objectId:'doc',revision:1}),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.NOT_FOUND);
  assert.match(error.message,/never confirmed as uploaded/);
  return true;
 });
});

test('retention extends but never shortens, holds block deletion, and deletion is two-step with a tombstone',async()=>{
 let today=new Date('2026-09-15T00:00:00.000Z');
 const backend=createMemoryObjectBackend();
 const s=store({backend,clock:()=>today});
 const ref={tenantId:TENANT,objectId:'doc',revision:1};
 await s.put({...ref,bytes:document,contentType:'application/pdf',retainUntil:'2030-01-01'});

 await assert.rejects(()=>s.setRetention(ref,'2027-01-01'),/extended but not shortened/);
 assert.equal((await s.setRetention(ref,'2031-06-30')).retainUntil,'2031-06-30');
 await assert.rejects(async()=>s.setRetention(ref,'30 June 2031'),/ISO calendar dates/);
 await assert.rejects(()=>s.requestDeletion(ref),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
  assert.match(error.message,/retained until 2031-06-30/);
  return true;
 });

 today=new Date('2032-01-01T00:00:00.000Z');
 await s.setLegalHold(ref,true);
 await assert.rejects(()=>s.requestDeletion(ref),/legal hold/);
 await s.setLegalHold(ref,false);

 await assert.rejects(()=>s.confirmDeletion(ref),/must be requested before it is confirmed/);
 assert.equal((await s.requestDeletion(ref,{reason:'tenant exit'})).state,'deletion_requested');
 await assert.rejects(()=>s.requestDeletion(ref),/Only an active revision/);
 const deleted=await s.confirmDeletion(ref);
 assert.equal(deleted.state,'deleted');
 assert.equal(deleted.deletedAt,'2032-01-01T00:00:00.000Z');
 assert.equal(backend.size(),0,'the bytes must be gone');
 // The metadata tombstone is retained so a deletion remains accountable.
 assert.equal((await s.describe(ref)).state,'deleted');
 assert.equal((await s.describe(ref)).sha256,sha(document));
 await assert.rejects(()=>s.get(ref),/has been deleted/);
 assert.equal((await s.list({tenantId:TENANT,state:'deleted'})).length,1);
 assert.equal((await s.list({tenantId:TENANT,state:'active'})).length,0);
});

test('the object store refuses an incomplete configuration',()=>{
 const ok={backend:createMemoryObjectBackend(),catalog:createMemoryObjectCatalog(),residency:resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1'}),encryptionKey:KEY,namespace:'release-a'};
 assert.throws(()=>createPrivateObjectStore({...ok,backend:null}),/backend is required/);
 assert.throws(()=>createPrivateObjectStore({...ok,catalog:null}),/catalogue is required/);
 assert.throws(()=>createPrivateObjectStore({...ok,namespace:'../elsewhere'}),/stable deployment namespace/);
 assert.throws(()=>createPrivateObjectStore({...ok,encryptionKey:'nope'}),/32-byte hex or base64/);
 assert.throws(()=>createPrivateObjectStore({...ok,maxBytes:OBJECT_MAX_BYTES+1}),/size limit must be between/);
});

// ------------------------------------------------- backup, restore, verify
const seeded=()=>{
 const repository=createSqliteRepository({tenantId:TENANT,dbPath:':memory:'});
 repository.putSettings({organizationName:'Wimblo',fiscalStartMonth:7});
 repository.putUser({id:'u-1',name:'Alex Morgan',email:'alex@synthetic.invalid',role:'admin',passwordHash:'synthetic',active:1,version:1});
 for(let i=0;i<25;i++)repository.createRecord('constituents',{id:`c-${i}`,name:`Donor ${i}`,email:`d${i}@synthetic.invalid`,version:1});
 for(let i=0;i<10;i++)repository.writeFinancialBatch({
  gift:{id:`g-${i}`,constituentId:`c-${i}`,date:`2026-0${1+(i%9)}-15`,amount:1000+i,status:i===3?'Voided':'Posted',allocations:[{designationId:'d-1',amount:1000+i}],version:1},
  audit:{actor:'test',action:'create_gift'}
 });
 return repository;
};

test('a backup carries the counts, checksums and exact cent totals captured at the time it was taken',async()=>{
 const source=seeded();
 try{
  const {archive,manifest,archiveSha256}=await createTenantBackup({repository:source,encryptionKey:KEY});
  assert.equal(manifest.tenantId,TENANT);
  assert.equal(manifest.digest.totals.records,35);
  assert.equal(manifest.digest.financial.postedCents,source.snapshotDigest().financial.postedCents);
  assert.equal(manifest.digest.financial.voidedCents,1003);
  assert.match(archiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(archive.includes(Buffer.from('alex@synthetic.invalid')),false,'the archive must not carry plaintext');
  assert.deepEqual(readBackupManifest({archive,encryptionKey:KEY}).manifest,manifest);
 }finally{source.close();}
});

test('a restore into a fresh workspace proves row and checksum equality against the manifest and the source',async()=>{
 const source=seeded();
 try{
  const {archive,manifest}=await createTenantBackup({repository:source,encryptionKey:KEY});
  const restored=await restoreTenantBackup({
   archive,encryptionKey:KEY,expectedTenantId:TENANT,closeTarget:false,
   createTargetRepository:()=>createSqliteRepository({tenantId:TENANT,dbPath:':memory:'})
  });
  try{
   assert.equal(restored.verification.verified,true);
   assert.deepEqual(restored.counts,{records:35,users:1,audit:10});
   assert.deepEqual(restored.verification.rowCounts,{records:35,users:1,audit:10});
   assert.deepEqual(restored.verification.collections,{constituents:25,gifts:10});
   assert.deepEqual(restored.verification.financial,manifest.digest.financial);
   assert.deepEqual(restored.verification.comparisons.map(c=>c.against),['backup manifest']);
   const evidence=await verifyRestore({manifest,source,restored:restored.repository});
   assert.equal(evidence.verified,true);
   assert.deepEqual(evidence.comparisons.map(c=>[c.against,c.equal]),[['backup manifest',true],['live source',true]]);
   assert.deepEqual(restored.repository.snapshotDigest(),source.snapshotDigest());
  }finally{await restored.repository.close();}
 }finally{source.close();}
});

test('restore verification fails loudly and names the differing fields when the copy is not exact',async()=>{
 const source=seeded();
 try{
  const {archive,manifest}=await createTenantBackup({repository:source,encryptionKey:KEY});
  const restored=await restoreTenantBackup({
   archive,encryptionKey:KEY,closeTarget:false,
   createTargetRepository:()=>createSqliteRepository({tenantId:TENANT,dbPath:':memory:'})
  });
  try{
   restored.repository.putRecord('constituents',{id:'c-0',name:'Altered after restore',email:'d0@synthetic.invalid',version:2});
   await assert.rejects(()=>verifyRestore({manifest,restored:restored.repository}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.VERIFICATION);
    assert.match(error.message,/collections\.constituents\.digest/);
    return true;
   });
   restored.repository.deleteRecord('constituents','c-1');
   await assert.rejects(()=>verifyRestore({manifest,restored:restored.repository}),/totals\.records|collections\.constituents/);
  }finally{await restored.repository.close();}
 }finally{source.close();}
});

test('a tampered archive, a wrong key, a wrong tenant and a non-empty target are all refused',async()=>{
 const source=seeded();
 try{
  const {archive}=await createTenantBackup({repository:source,encryptionKey:KEY});
  const target=()=>createSqliteRepository({tenantId:TENANT,dbPath:':memory:'});
  for(const position of [archive.length-1,archive.length-200,60]){
   const tampered=Buffer.from(archive);tampered[position]^=0xff;
   await assert.rejects(()=>restoreTenantBackup({archive:tampered,encryptionKey:KEY,createTargetRepository:target}),error=>{
    assert.ok([PERSISTENCE_CODES.VERIFICATION,PERSISTENCE_CODES.INVALID].includes(error.code),error.code);
    return true;
   });
  }
  await assert.rejects(()=>restoreTenantBackup({archive,encryptionKey:'c'.repeat(64),createTargetRepository:target}),/authentication failed/);
  await assert.rejects(()=>restoreTenantBackup({archive,encryptionKey:KEY,expectedTenantId:OTHER,createTargetRepository:target}),/tenant does not match/);
  await assert.rejects(()=>restoreTenantBackup({archive,encryptionKey:KEY,createTargetRepository:()=>createSqliteRepository({tenantId:OTHER,dbPath:':memory:'})}),/scoped to a different tenant/);
  await assert.rejects(()=>restoreTenantBackup({archive,encryptionKey:KEY,createTargetRepository:()=>seeded()}),error=>{
   assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
   assert.match(error.message,/not empty/);
   return true;
  });
  await assert.rejects(()=>restoreTenantBackup({archive,encryptionKey:KEY}),/fresh-target repository factory is required/);
  await assert.rejects(()=>createTenantBackup({repository:source,encryptionKey:'too-short'}),/32-byte hex or base64 key/);
  await assert.rejects(()=>verifyRestore({restored:seeded()}),/needs a manifest or a live source/);
 }finally{source.close();}
});
