import test from 'node:test';
import assert from 'node:assert/strict';

const validEnv=()=>({
 NODE_ENV:'production',
 MIGRATION_DATABASE_URL:'postgresql://wimblo_migration_owner:migration-secret@db.example.test/neondb?sslmode=verify-full',
 DATABASE_URL:'postgresql://wimblo_tenant_runtime:tenant-secret@db.example.test/neondb?sslmode=verify-full',
 CONTROL_DATABASE_URL:'postgresql://wimblo_control_runtime:control-secret@db.example.test/neondb?sslmode=verify-full'
});

test('production migration runner applies the reviewed ledger and least-privilege grants before closing its pool',async()=>{
 const module=await import('../server/production/migrate.js').catch(()=>null);
 assert.ok(module?.runProductionMigration,'production migration runner is missing');
 const calls=[];
 const pool={
  async withAdminSession(fn){calls.push('session');return fn({query:async sql=>{calls.push(sql);return {rows:[]};}});},
  async end(){calls.push('close');}
 };
 const result=await module.runProductionMigration({
  env:validEnv(),
  poolFactory:options=>{assert.equal(options.applicationName,'wimblo-production-migration');assert.equal(options.max,1);return pool;},
  apply:async()=>{calls.push('migrate');return {currentVersion:18,targetVersion:18,applied:[{version:18}]};},
  hardenRoles:roles=>{assert.deepEqual(roles,{migration:'wimblo_migration_owner',tenant:'wimblo_tenant_runtime',control:'wimblo_control_runtime'});return ['REVOKE broad','ALTER defaults'];},
  applicationGrants:role=>{assert.equal(role,'wimblo_tenant_runtime');return ['GRANT tenant'];},
  controlGrants:role=>{assert.equal(role,'wimblo_control_runtime');return ['GRANT control'];},
  verifyOwners:async()=>{calls.push('verify-owners');return {functions:4,ownersBypassRls:true};},
  verifyPrivileges:async(_session,roles)=>{calls.push('verify-privileges');assert.equal(roles.tenant,'wimblo_tenant_runtime');return {roles:2,leastPrivilege:true};}
 });
 assert.deepEqual(calls,['session','migrate','REVOKE broad','ALTER defaults','GRANT tenant','GRANT control','verify-owners','verify-privileges','close']);
 assert.deepEqual(result,{schemaVersion:18,appliedVersions:[18],tenantRole:'wimblo_tenant_runtime',controlRole:'wimblo_control_runtime',securityDefinerFunctions:4,runtimeRolesVerified:2});
 assert.doesNotMatch(JSON.stringify(result),/secret|postgresql:/);
});

test('production migration runner refuses unsafe role reuse and closes after a migration failure',async()=>{
 const module=await import('../server/production/migrate.js').catch(()=>null);
 assert.ok(module?.runProductionMigration,'production migration runner is missing');
 const {runProductionMigration}=module;
 await assert.rejects(()=>runProductionMigration({env:{...validEnv(),CONTROL_DATABASE_URL:'postgresql://wimblo_tenant_runtime:other-secret@db.example.test/neondb?sslmode=verify-full'}}),/three distinct database roles/);
 let closed=false;
 await assert.rejects(()=>runProductionMigration({
  env:validEnv(),
  poolFactory:()=>({withAdminSession:async fn=>fn({query:async()=>({rows:[]})}),end:async()=>{closed=true;}}),
  apply:async()=>{throw new Error('synthetic migration failure');}
 }),/synthetic migration failure/);
 assert.equal(closed,true);
});

test('production migration runner refuses runtime URLs for a different database target before connecting',async()=>{
 const {runProductionMigration}=await import('../server/production/migrate.js');
 for(const DATABASE_URL of [
  'postgresql://wimblo_tenant_runtime:tenant-secret@other-db.example.test/neondb?sslmode=verify-full',
  'postgresql://wimblo_tenant_runtime:tenant-secret@db.example.test/otherdb?sslmode=verify-full'
 ])await assert.rejects(()=>runProductionMigration({
  env:{...validEnv(),DATABASE_URL},
  poolFactory:()=>{throw new Error('pool should not start');}
 }),/same database authority and name/);
});

test('runtime hardening requires only the exact tenant and control function capabilities',async()=>{
 const {assertRuntimeRoleHardening}=await import('../server/production/migrate.js');
 const roles={tenant:'wimblo_tenant_runtime',control:'wimblo_control_runtime'};
 const baseRows=[
  [{role_name:roles.tenant,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false},{role_name:roles.control,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false}],
  [{role_name:roles.tenant,can_create:false},{role_name:roles.control,can_create:false}],[],[],
  [
   {role_name:roles.tenant,signature:'public.wimblo_current_tenant()'},
   {role_name:roles.tenant,signature:'wimblo_platform.active_membership(uuid,uuid)'},
   {role_name:roles.control,signature:'wimblo_platform.tenant_state(uuid)'},
   {role_name:roles.control,signature:'wimblo_platform.runnable_tenant_ids()'},
   {role_name:roles.control,signature:'wimblo_platform.dead_letter_count()'}
  ]
 ];
 let index=0;
 const session={query:async(sql)=>{if(index===4)assert.match(sql,/to_regprocedure\('public\.wimblo_current_tenant\(\)'\)/);return {rows:baseRows[index++]};}};
 assert.deepEqual(await assertRuntimeRoleHardening(session,roles),{roles:2,leastPrivilege:true});

 index=0;
 const missingSession={query:async()=>({rows:index===4?baseRows[index++].filter(row=>row.signature!=='public.wimblo_current_tenant()'):baseRows[index++]})};
 await assert.rejects(()=>assertRuntimeRoleHardening(missingSession,roles),/wimblo_current_tenant.*required EXECUTE missing/);
});
