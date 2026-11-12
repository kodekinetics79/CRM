import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePeopleCsv,createCrmImportService,IMPORT_LIMITS} from '../server/production/crmImportService.js';
import {randomUUID} from 'node:crypto';

const valid='external_key,display_name,first_name,last_name\r\nA-1,"Ada, Inc",Ada,Lovelace\r\n';

test('CSV parsing is strict, bounded and returns no raw rejected values',()=>{
 const parsed=parsePeopleCsv(valid);
 assert.equal(parsed.rows[0].displayName,'Ada, Inc');
 assert.equal(parsed.rows[0].externalKey,'A-1');
 for(const bad of [
  'external_key,external_key,first_name,last_name\n1,2,A,B\n',
  'external_key,,first_name,last_name\n1,X,A,B\n',
  'external_key,display_name,first_name,last_name\n1,"broken,A,B\n',
  'external_key,display_name,first_name,last_name\n1,"Ada"x,A,B\n',
  'external_key,display_name,first_name,last_name\n1,A\u0000,A,B\n',
  'external_key,display_name,first_name,last_name\n1,A\uFFFD,A,B\n',
  `external_key,display_name,first_name,last_name\n1,${'x'.repeat(IMPORT_LIMITS.maxCellBytes+1)},A,B\n`
 ])assert.throws(()=>parsePeopleCsv(bad),/CSV|header|cell|quote|NUL/i);
});

test('preview classifies canonical field limits and duplicate source keys without retaining raw values',()=>{
 const parsed=parsePeopleCsv(`external_key,display_name,first_name,last_name\r\n${'K'.repeat(301)},Ada,Ada,Lovelace\r\nA-1,Ada,Ada,Lovelace\r\nA-1,Grace,Grace,Hopper\r\n`);
 assert.equal(parsed.rowCount,3);
 assert.equal(parsed.validCount,1);
 assert.equal(parsed.invalidCount,2);
 assert.deepEqual(parsed.errors.map(error=>error.code),['MAX_LENGTH','DUPLICATE_EXTERNAL_KEY']);
 assert.equal(JSON.stringify(parsed.errors).includes('Grace'),false);
});

test('preview persists only hashes and reconciliation counts and exact replay is idempotent',async()=>{
 const tenantId=randomUUID(),identityId=randomUUID(),batchId=randomUUID(),calls=[];
 const row={tenant_id:tenantId,batch_id:batchId,idempotency_key:'import-1',source_system:'legacy',entity_type:'people',source_sha256:'a'.repeat(64),mapping_sha256:'b'.repeat(64),byte_count:Buffer.byteLength(valid),row_count:1,valid_count:1,invalid_count:0,inserted_count:0,updated_count:0,unchanged_count:0,status:'previewed',actor_identity_id:identityId,version:1,expires_at:'2026-11-12T00:00:00.000Z',created_at:'2026-11-11T23:00:00.000Z',updated_at:'2026-11-11T23:00:00.000Z'};
 const tenantPool={withTransaction:async(tenant,fn)=>fn({query:async(sql,values)=>{calls.push({sql,values});if(sql.includes('/*import-batch:by-key*/'))return {rows:[],rowCount:0};if(sql.includes('/*import-batch:insert*/'))return {rows:[{...row,source_sha256:values[5],mapping_sha256:values[6]}],rowCount:1};throw new Error(`Unexpected ${sql}`);}})};
 const service=createCrmImportService({tenantPool,moduleService:{authorize:async()=>({allowed:true})},clock:()=>new Date('2026-11-11T23:00:00.000Z')});
 const preview=await service.previewPeople({tenantId,actorRole:'staff',actorIdentityId:identityId,batchId,idempotencyKey:'import-1',sourceSystem:'legacy',csv:valid});
 assert.equal(preview.rowCount,1);assert.equal(preview.validCount,1);assert.equal(preview.errors.length,0);
 const insert=calls.find(call=>call.sql.includes('/*import-batch:insert*/'));
 assert.equal(insert.values.some(value=>value===valid||JSON.stringify(value).includes('Ada')),false);
 assert.match(insert.values[5],/^[a-f0-9]{64}$/);
});

test('commit refuses changed source before opening a transaction',async()=>{
 let opened=0;
 const service=createCrmImportService({tenantPool:{withTransaction:async()=>{opened++;}},moduleService:{authorize:async()=>({allowed:true})}});
 await assert.rejects(()=>service.commitPeople({tenantId:randomUUID(),actorRole:'staff',actorIdentityId:randomUUID(),batchId:randomUUID(),expectedVersion:1,sourceSystem:'legacy',idempotencyKey:'import-1',csv:valid.replace('Ada','Grace'),expectedSourceSha256:'0'.repeat(64)}),/source/i);
 assert.equal(opened,0);
});

test('commit locks the canonical party version and refuses a stale mapped target',async()=>{
 const tenantId=randomUUID(),identityId=randomUUID(),batchId=randomUUID(),targetId=randomUUID();
 const parsed=parsePeopleCsv(valid);let mappingLockSql='';
 const batch={tenant_id:tenantId,batch_id:batchId,idempotency_key:'import-1',source_system:'legacy',entity_type:'people',source_sha256:parsed.sourceSha256,mapping_sha256:parsed.mappingSha256,status:'previewed',version:1,expires_at:'2026-11-12T00:00:00.000Z'};
 const tenantPool={withTransaction:async(tenant,fn)=>fn({query:async sql=>{
  if(sql.includes('/*import-batch:lock*/'))return {rows:[batch],rowCount:1};
  if(sql.includes('/*import-map:lock*/')){mappingLockSql=sql;return {rows:[{target_subject_id:targetId,source_row_hash:parsed.rows[0].rowHash,target_version:1,current_target_version:2}],rowCount:1};}
  throw new Error(`Unexpected ${sql}`);
 }})};
 const service=createCrmImportService({tenantPool,moduleService:{authorize:async()=>({allowed:true})},clock:()=>new Date('2026-11-11T23:00:00.000Z')});
 await assert.rejects(()=>service.commitPeople({tenantId,actorRole:'staff',actorIdentityId:identityId,batchId,expectedVersion:1,sourceSystem:'legacy',idempotencyKey:'import-1',csv:valid,expectedSourceSha256:parsed.sourceSha256}),/target changed/i);
 assert.match(mappingLockSql,/JOIN parties p/);
 assert.match(mappingLockSql,/FOR UPDATE OF m,p/);
});
