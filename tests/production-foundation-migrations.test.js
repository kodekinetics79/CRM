import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  applyMigrations,
  planMigrations,
  applicationRoleGrants,
  controlPlaneRoleGrants,
  assertControlPlaneRole,
  poolFromEnv,
  controlPoolFromEnv,
  PERSISTENCE_CODES
} from '../server/persistence/index.js';

const ORIGINAL_CHECKSUMS=Object.freeze([
  '194da6b1d34e0222d4d4262a0afba19a5a979cf7c4f9f40bf2c52a5eb6657734',
  '02b4b3d09150b3397995310320438c050d317d731ea8fe663cdaa837fbd06d38',
  '5d6858c40d44f019546b4fcf78f2a95ce5b63419fe9931906a538755bcaaf53f',
  'db2763d6f81c477733b851d648c947de4a6d11eda98b6f00e81d6c1236b705a5',
  'c02504c89be96556ffaa2080ffa37d47c050a772c8c445e1a90b7f1ecb144c5d'
]);

const recorded=list=>list.map(({version,name,checksum})=>({version,name,checksum}));

test('production foundation appends contiguous migrations 6 through 12 without rewriting versions 1 through 5',()=>{
  assert.equal(SCHEMA_VERSION,12);
  assert.deepEqual(MIGRATIONS.map(entry=>entry.version),[1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.deepEqual(MIGRATIONS.slice(0,5).map(entry=>entry.checksum),ORIGINAL_CHECKSUMS);

  const plan=planMigrations(recorded(MIGRATIONS.slice(0,5)));
  assert.equal(plan.currentVersion,5);
  assert.equal(plan.targetVersion,12);
  assert.deepEqual(plan.pending.map(entry=>entry.version),[6,7,8,9,10,11,12]);
});

test('a failed production-foundation migration rolls back without recording its ledger row',async()=>{
  const executed=[];
  const session={async query(text){
    const sql=text.trim();
    executed.push(sql);
    if(sql.startsWith('SELECT version'))return {rows:recorded(MIGRATIONS.slice(0,5))};
    if(sql.startsWith('CREATE TABLE wimblo_platform.memberships'))throw Object.assign(new Error('synthetic foundation DDL failure'),{code:'42601'});
    return {rows:[],rowCount:0};
  }};

  await assert.rejects(()=>applyMigrations(session),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
    assert.match(error.message,/Migration 6/);
    assert.match(error.message,/rolled back/);
    return true;
  });
  assert.ok(executed.includes('ROLLBACK'));
  assert.equal(executed.some(sql=>sql.startsWith('INSERT INTO wimblo_schema_migrations')&&sql.includes('VALUES($1,$2,$3)')),false);
});

test('foundation migrations create control identity, module, job and lifecycle boundaries with forced tenant isolation',()=>{
  const byVersion=new Map(MIGRATIONS.map(entry=>[entry.version,entry.statements.join('\n')]));
  const identity=byVersion.get(6);
  for(const table of ['global_identities','memberships','invitations','opaque_sessions','mfa_settings','mfa_recovery_codes','mfa_challenges','control_audit']){
    assert.match(identity,new RegExp(`CREATE TABLE wimblo_platform\\.${table}\\b`),table);
  }
  assert.match(identity,/control_audit_no_update/);
  assert.match(identity,/control_audit_no_delete/);

  const modules=byVersion.get(7);
  for(const table of ['tenant_modules','module_events']){
    assert.match(modules,new RegExp(`ALTER TABLE wimblo_platform\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(modules,new RegExp(`ALTER TABLE wimblo_platform\\.${table} FORCE ROW LEVEL SECURITY`));
    assert.match(modules,new RegExp(`CREATE POLICY ${table}_tenant_isolation`));
  }

  const jobs=byVersion.get(8);
  for(const table of ['durable_jobs','durable_job_attempts','dead_letter_jobs']){
    assert.match(jobs,new RegExp(`ALTER TABLE wimblo_platform\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(jobs,new RegExp(`ALTER TABLE wimblo_platform\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(jobs,/UNIQUE \(tenant_id, idempotency_key\)/);

  const lifecycle=byVersion.get(9);
  for(const status of ['active','suspended','export_pending','deletion_scheduled','legal_hold','closed'])assert.match(lifecycle,new RegExp(`'${status}'`));
  assert.match(lifecycle,/retention_until/);
  assert.match(lifecycle,/lifecycle_version/);
  assert.match(lifecycle,/NOT VALID/);
  assert.match(lifecycle,/VALIDATE CONSTRAINT/);
  assert.match(lifecycle,/status <> 'deletion_scheduled' OR deletion_scheduled_at IS NOT NULL/);

  const queueIndexes=byVersion.get(10);
  assert.match(queueIndexes,/durable_jobs_due_claim_v2[\s\S]*tenant_id, queue, available_at[\s\S]*WHERE state IN \('ready','retry_wait'\)/);
  assert.match(queueIndexes,/durable_jobs_expired_claim_v2[\s\S]*tenant_id, queue, lease_expires_at[\s\S]*WHERE state = 'leased'/);

  const workerTenants=byVersion.get(11);
  assert.match(workerTenants,/FUNCTION wimblo_platform\.runnable_tenant_ids\(\)/);
  assert.match(workerTenants,/SECURITY DEFINER/);
  assert.match(workerTenants,/WHERE t\.status='active'/);
  assert.match(workerTenants,/REVOKE ALL ON FUNCTION wimblo_platform\.runnable_tenant_ids\(\) FROM PUBLIC/);

  const readiness=byVersion.get(12);
  assert.match(readiness,/FUNCTION wimblo_platform\.dead_letter_count\(\)/);
  assert.match(readiness,/SECURITY DEFINER/);
  assert.match(readiness,/count\(\*\)/);
  assert.match(readiness,/REVOKE ALL ON FUNCTION wimblo_platform\.dead_letter_count\(\) FROM PUBLIC/);
});

test('tenant and control-plane grants are distinct, least-privilege and identifier-safe',async()=>{
  const tenant=applicationRoleGrants('wimblo_app');
  const control=controlPlaneRoleGrants('wimblo_control');
  assert.ok(tenant.some(sql=>sql.includes('wimblo_platform.tenant_modules')));
  assert.ok(tenant.some(sql=>sql.includes('wimblo_platform.durable_jobs')));
  assert.ok(control.includes('GRANT USAGE ON SCHEMA wimblo_platform TO wimblo_control'));
  assert.ok(control.some(sql=>sql.includes('wimblo_platform.global_identities')));
  assert.ok(control.some(sql=>sql.includes('runnable_tenant_ids()')));
  assert.ok(control.some(sql=>sql.includes('dead_letter_count()')));
  assert.equal(control.some(sql=>/\b(records|gift_ledger|gift_allocations|object_metadata)\b/.test(sql)),false);
  assert.equal([...tenant,...control].some(sql=>/GRANT ALL|SUPERUSER|BYPASSRLS/.test(sql)),false);
  assert.throws(()=>controlPlaneRoleGrants('unsafe role'),/lower-case identifier/);

  await assert.rejects(()=>assertControlPlaneRole({
    async query(){return {rows:[{name:'postgres',rolsuper:true,rolbypassrls:false}]};}
  }),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
    assert.match(error.message,/superuser/i);
    return true;
  });
});

test('tenant and control pools consume separate explicit TLS connection URLs',async()=>{
  const env={
    NODE_ENV:'production',
    DATABASE_URL:'postgres://wimblo_app:tenant-secret@db.invalid/wimblo?sslmode=require',
    CONTROL_DATABASE_URL:'postgres://wimblo_control:control-secret@db.invalid/wimblo?sslmode=verify-full'
  };
  const tenant=poolFromEnv(env,{acquireAttempts:1});
  const control=controlPoolFromEnv(env,{acquireAttempts:1});
  try{
    assert.equal(tenant.config.connectionString,'[redacted]');
    assert.equal(control.config.connectionString,'[redacted]');
    assert.equal(control.config.applicationName,'wimblo-control-plane');
  }finally{
    await Promise.all([tenant.end(),control.end()]);
  }
  assert.throws(()=>controlPoolFromEnv({...env,CONTROL_DATABASE_URL:''}),/CONTROL_DATABASE_URL is required/);
  assert.throws(()=>controlPoolFromEnv({...env,CONTROL_DATABASE_URL:'postgres://wimblo_control:x@db.invalid/wimblo'}),/CONTROL_DATABASE_URL must require TLS/);
});
