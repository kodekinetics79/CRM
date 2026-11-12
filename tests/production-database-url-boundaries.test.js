import test from 'node:test';
import assert from 'node:assert/strict';
import {poolFromEnv,controlPoolFromEnv} from '../server/persistence/index.js';
import {resolveSaasRuntimeConfig} from '../server/production/runtimeConfig.js';

const validEnv=()=>({
 NODE_ENV:'production',WIMBLO_RUNTIME:'saas',PROCESS_ROLE:'web',APP_ORIGIN:'https://app.wimblo.example',
 DATABASE_URL:'postgresql://wimblo_tenant_app:tenant-password@db.example.test/wimblo?sslmode=verify-full',
 CONTROL_DATABASE_URL:'postgresql://wimblo_control_app:control-password@db.example.test/wimblo?sslmode=verify-full',
 MFA_ENCRYPTION_KEY:'a'.repeat(64),SESSION_SECRET:'session-secret-with-at-least-thirty-two-characters',BACKUP_ENCRYPTION_KEY:'b'.repeat(64),
 DOCUMENT_STORAGE_PROVIDER:'s3',DOCUMENT_STORAGE_BUCKET:'wimblo-production-private',DOCUMENT_STORAGE_NAMESPACE:'production',DOCUMENT_STORAGE_PRIVATE_CONFIRMED:'true',
 BACKUP_STORAGE_BUCKET:'wimblo-production-backups',BACKUP_STORAGE_NAMESPACE:'production-backups',BACKUP_STORAGE_PRIVATE_CONFIRMED:'true',
 AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'SYNTHETIC_TEST_ACCESS',AWS_SECRET_ACCESS_KEY:'SYNTHETIC_TEST_SECRET',
 TRUSTED_PROXY_CIDRS:'10.0.0.0/8'
});

test('production database URLs require explicit full certificate and hostname verification before pools open',()=>{
 for(const unsafe of [
  'postgresql://wimblo_tenant_app:x@db.example.test/wimblo?sslmode=require&uselibpqcompat=true',
  'postgresql://wimblo_tenant_app:x@db.example.test/wimblo?sslmode=require',
  'postgresql://wimblo_tenant_app:x@db.example.test/wimblo?sslmode=verify-ca'
 ]){
  const env={...validEnv(),DATABASE_URL:unsafe};
  assert.throws(()=>resolveSaasRuntimeConfig(env,'/srv/wimblo'),/verify-full|certificate/i,unsafe);
  assert.throws(()=>poolFromEnv(env),/verify-full|certificate/i,unsafe);
 }
 const tenant=poolFromEnv(validEnv()),control=controlPoolFromEnv(validEnv());
 return Promise.all([tenant.end(),control.end()]);
});

test('authority host and port cannot be replaced by PostgreSQL query parameters',()=>{
 for(const override of ['host=attacker.example.test','port=6543']){
  const env={...validEnv(),DATABASE_URL:`postgresql://wimblo_tenant_app:x@db.example.test:5432/wimblo?sslmode=verify-full&${override}`};
  assert.throws(()=>resolveSaasRuntimeConfig(env,'/srv/wimblo'),/host|port|override/i,override);
  assert.throws(()=>poolFromEnv(env),/host|port|override/i,override);
 }
});
