import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
 runRepositoryConformance,CONFORMANCE_CHECKS,REPOSITORY_METHODS,assertRepositoryContract,
 createSqliteRepository,PERSISTENCE_CODES,canonicalJson,digestOf,recordChecksum,
 validateFinancialBatch,normalizedSearchText,matchesSearch,assertTenantId
} from '../server/persistence/index.js';

const TENANT='3f1c0b8e-1d2a-4b3c-8d4e-5f6a7b8c9d01';
const workspace=(tenantId=TENANT)=>createSqliteRepository({tenantId,dbPath:':memory:'});

test('the SQLite store satisfies every check of the persistence boundary conformance suite',async()=>{
 const run=await runRepositoryConformance({
  createRepository:()=>workspace(),
  createEmptyRepository:()=>workspace(),
  label:'sqlite'
 });
 assert.equal(run.kind,'sqlite');
 assert.equal(run.failed,0);
 assert.equal(run.passed,CONFORMANCE_CHECKS.length);
 assert.ok(run.checks.every(c=>c.passed),run.checks.filter(c=>!c.passed).map(c=>c.name).join(', '));
 // The same suite is executed against PostgreSQL by scripts/postgres-verify.mjs.
 // It is not duplicated here because a conditionally-skipped infrastructure test
 // reported as a pass is worse than no test.
 assert.ok(CONFORMANCE_CHECKS.length>=16);
});

test('the boundary refuses an implementation that is missing any part of the contract',()=>{
 const complete=workspace();
 try{
  assert.equal(assertRepositoryContract(complete),complete);
  for(const method of REPOSITORY_METHODS){
   const partial={...complete,[method]:undefined};
   assert.throws(()=>assertRepositoryContract(partial),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.INVALID);
    assert.match(error.message,new RegExp(method));
    return true;
   });
  }
  assert.throws(()=>assertRepositoryContract({...complete,kind:'mysql'}),/store kind/);
  assert.throws(()=>assertRepositoryContract({...complete,tenantId:'not-a-uuid'}),/tenant UUID/);
 }finally{complete.close();}
});

test('canonical documents and digests are order-independent and content-sensitive',()=>{
 assert.equal(canonicalJson({b:1,a:[3,{d:4,c:5}]}),canonicalJson({a:[3,{c:5,d:4}],b:1}));
 assert.notEqual(canonicalJson({a:1}),canonicalJson({a:'1'}));
 assert.equal(recordChecksum({id:'x',amount:100}),recordChecksum({amount:100,id:'x'}));
 const checksums=['aa','bb','cc'].map(v=>recordChecksum({v}));
 assert.equal(digestOf(checksums),digestOf([...checksums].reverse()));
 assert.notEqual(digestOf(checksums),digestOf(checksums.slice(1)));
 assert.throws(()=>assertTenantId('12345'),/tenant UUID/);
 assert.equal(assertTenantId(TENANT.toUpperCase()),TENANT);
});

test('financial validation refuses fractional, unbalanced, duplicated and negative cents before any write',()=>{
 const gift=(overrides={})=>({id:'g-1',date:'2026-01-05',amount:2500,status:'Posted',allocations:[{designationId:'d-1',amount:2500}],...overrides});
 assert.equal(validateFinancialBatch({gift:gift()}).allocations.length,1);
 const refused=[
  [{gift:gift({amount:25.5,allocations:[{designationId:'d-1',amount:25.5}]})},/exact integer cents/],
  [{gift:gift({allocations:[{designationId:'d-1',amount:2400}]})},/sum to the gift amount/],
  [{gift:gift({allocations:[{designationId:'d-1',amount:1250},{designationId:'d-1',amount:1250}]})},/Duplicate designation/],
  [{gift:gift({allocations:[{designationId:'d-1',amount:-2500},{designationId:'d-2',amount:5000}]})},/positive integer cents/],
  [{gift:gift({allocations:[]})},/at least one allocation/],
  [{gift:gift({amount:-1,allocations:[{designationId:'d-1',amount:1}]})},/cannot be negative/],
  [{gift:gift({status:'Pending'})},/Posted or Voided/],
  [{gift:gift({date:'05/01/2026'})},/ISO calendar date/],
  [{gift:gift(),audit:{actor:'x'}},/audit entry requires an action/]
 ];
 for(const [batch,pattern] of refused)assert.throws(()=>validateFinancialBatch(batch),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.INVALID);
  assert.match(error.message,pattern);
  return true;
 });
});

test('a refused financial write leaves the SQLite workspace exactly as it was',async()=>{
 const store=workspace();
 try{
  await store.writeFinancialBatch({gift:{id:'g-1',date:'2026-01-05',amount:2500,status:'Posted',allocations:[{designationId:'d-1',amount:2500}]},audit:{actor:'test',action:'create_gift'}});
  const before=store.snapshotDigest();
  for(const bad of [
   {gift:{id:'g-2',date:'2026-01-06',amount:2500,status:'Posted',allocations:[{designationId:'d-1',amount:2400}]},audit:{actor:'test',action:'create_gift'}},
   {gift:{id:'g-1',date:'2026-01-07',amount:100,status:'Posted',allocations:[{designationId:'d-1',amount:100}]},audit:{actor:'test',action:'create_gift'}}
  ])await assert.rejects(async()=>store.writeFinancialBatch(bad));
  assert.deepEqual(store.snapshotDigest(),before);
  assert.equal(store.snapshotDigest().financial.postedCents,2500);
 }finally{store.close();}
});

test('the search projection is deterministic, case-folded and covers nested fields',()=>{
 const record={id:'c-1',name:'Ada Fonseca',contact:{email:'ADA@Example.Invalid',phones:['555-0100']},version:2};
 assert.equal(normalizedSearchText(record),normalizedSearchText({version:2,contact:{phones:['555-0100'],email:'ADA@Example.Invalid'},name:'Ada Fonseca',id:'c-1'}));
 assert.match(normalizedSearchText(record),/ada@example\.invalid/);
 assert.ok(matchesSearch(record,'FONSECA'));
 assert.ok(matchesSearch(record,'555-0100'));
 assert.equal(matchesSearch(record,'nobody'),false);
 assert.throws(()=>matchesSearch(record,'   '),/non-empty term/);
 assert.throws(()=>matchesSearch(record,'x'.repeat(201)),/200 characters/);
});

test('a workspace that is not a Wimblo workspace is refused rather than created implicitly',()=>{
 assert.throws(()=>createSqliteRepository({tenantId:TENANT,dbPath:':memory:',manageSchema:false}),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
  assert.match(error.message,/not a Wimblo workspace/);
  return true;
 });
 assert.throws(()=>createSqliteRepository({tenantId:TENANT}),/connection or path is required/);
 assert.throws(()=>createSqliteRepository({tenantId:'nope',dbPath:':memory:'}),/tenant UUID/);
});

test('two tenants keep separate workspaces and separate digests',()=>{
 const a=workspace(),b=workspace(randomUUID());
 try{
  a.createRecord('constituents',{id:'shared',name:'Tenant A donor',version:1});
  b.createRecord('constituents',{id:'shared',name:'Tenant B donor',version:1});
  assert.equal(a.getRecord('constituents','shared').name,'Tenant A donor');
  assert.equal(b.getRecord('constituents','shared').name,'Tenant B donor');
  assert.notEqual(a.snapshotDigest().collections.constituents.digest,b.snapshotDigest().collections.constituents.digest);
  assert.notEqual(a.tenantId,b.tenantId);
 }finally{a.close();b.close();}
});
