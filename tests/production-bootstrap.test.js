import test from 'node:test';
import assert from 'node:assert/strict';

const validEnv=()=>({
 NODE_ENV:'production',BOOTSTRAP_CONFIRM:'CREATE_INITIAL_TENANT',
 MIGRATION_DATABASE_URL:'postgresql://wimblo_migration_owner:migration-secret@db.example.test/neondb?sslmode=verify-full',
 BOOTSTRAP_TENANT_NAME:'Wimblo Production',BOOTSTRAP_OWNER_EMAIL:'owner@example.test',BOOTSTRAP_OWNER_NAME:'Initial Owner',
 BOOTSTRAP_OWNER_PASSWORD:'a-long-synthetic-password-only-for-tests',BOOTSTRAP_DATABASE_REGION:'us-east-1',BOOTSTRAP_STORAGE_REGION:'us-east-1'
});

test('production bootstrap creates one owner and core sales modules in a single transaction without returning the password',async()=>{
 const calls=[];let id=0;
 const result=await (await import('../server/production/bootstrap.js')).runProductionBootstrap({
  env:validEnv(),idFactory:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`,
  hashPassword:async value=>{assert.equal(value,validEnv().BOOTSTRAP_OWNER_PASSWORD);return 'scrypt-v1:synthetic:hash';},
  poolFactory:()=>({withAdminSession:async fn=>fn({query:async(sql,values=[])=>{calls.push({sql,values});return sql.includes('bootstrap_state')?{rows:[{tenant_count:0,identity_count:0,membership_count:0}]}:{rows:[],rowCount:1};}}),end:async()=>calls.push({sql:'close'})})
 });
 assert.deepEqual(result.modules,['core','sales']);assert.equal(result.tenantId,'00000000-0000-4000-8000-000000000001');assert.equal(JSON.stringify(result).includes(validEnv().BOOTSTRAP_OWNER_PASSWORD),false);
 assert.equal(calls[0].sql,'BEGIN');assert.equal(calls.at(-2).sql,'COMMIT');assert.equal(calls.at(-1).sql,'close');
 assert.equal(calls.some(call=>call.sql.includes('global_identities')),true);assert.equal(calls.filter(call=>call.sql.includes('tenant_modules')).length,2);
});

test('production bootstrap refuses existing state and always closes its pool',async()=>{
 let closed=false;
 await assert.rejects(()=>(import('../server/production/bootstrap.js')).then(({runProductionBootstrap})=>runProductionBootstrap({env:validEnv(),poolFactory:()=>({withAdminSession:async fn=>fn({query:async sql=>sql.includes('bootstrap_state')?{rows:[{tenant_count:1,identity_count:0,membership_count:0}]}:{rows:[]}}),end:async()=>{closed=true;}})})),/not empty/);
 assert.equal(closed,true);
});

test('production bootstrap preserves owner password bytes instead of trimming the secret',async()=>{
 const env={...validEnv(),BOOTSTRAP_OWNER_PASSWORD:'  a-long-password-with-significant-spaces  '};
 let received;
 await (await import('../server/production/bootstrap.js')).runProductionBootstrap({
  env,hashPassword:async value=>{received=value;return 'scrypt-v1:synthetic:hash';},idFactory:()=>crypto.randomUUID(),
  poolFactory:()=>({withAdminSession:async fn=>fn({query:async sql=>sql.includes('bootstrap_state')?{rows:[{tenant_count:0,identity_count:0,membership_count:0}]}:{rows:[]}}),end:async()=>{}})
 });
 assert.equal(received,env.BOOTSTRAP_OWNER_PASSWORD);
});
