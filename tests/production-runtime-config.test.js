import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSaasRuntimeConfig} from '../server/production/runtimeConfig.js';

const validEnv=()=>({
 NODE_ENV:'production',WIMBLO_RUNTIME:'saas',PROCESS_ROLE:'web',APP_ORIGIN:'https://app.wimblo.example',
 DATABASE_URL:'postgresql://wimblo_tenant_app:tenant-password@db.example.test/wimblo?sslmode=verify-full',
 CONTROL_DATABASE_URL:'postgresql://wimblo_control_app:control-password@db.example.test/wimblo?sslmode=verify-full',
 MFA_ENCRYPTION_KEY:'a'.repeat(64),SESSION_SECRET:'session-secret-with-at-least-thirty-two-characters',BACKUP_ENCRYPTION_KEY:'b'.repeat(64),
 DOCUMENT_STORAGE_PROVIDER:'s3',DOCUMENT_STORAGE_BUCKET:'wimblo-production-private',DOCUMENT_STORAGE_NAMESPACE:'production',DOCUMENT_STORAGE_PRIVATE_CONFIRMED:'true',
 BACKUP_STORAGE_BUCKET:'wimblo-production-backups',BACKUP_STORAGE_NAMESPACE:'production-backups',BACKUP_STORAGE_PRIVATE_CONFIRMED:'true',
 AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'SYNTHETIC_TEST_ACCESS',AWS_SECRET_ACCESS_KEY:'SYNTHETIC_TEST_SECRET',
 TRUSTED_PROXY_CIDRS:'10.0.0.0/8',DB_POOL_MAX:'10',JOB_CONCURRENCY:'4',JOB_LEASE_MS:'30000',PORT:'3000'
});

test('SaaS production requires web or worker process role and exact HTTPS origin',()=>{
 const missingRole=validEnv();delete missingRole.PROCESS_ROLE;
 assert.throws(()=>resolveSaasRuntimeConfig(missingRole,'/srv/wimblo'),{message:'SaaS production requires PROCESS_ROLE=web or worker.'});
 const badRole={...validEnv(),PROCESS_ROLE:'both'};
 assert.throws(()=>resolveSaasRuntimeConfig(badRole,'/srv/wimblo'),{message:'SaaS production requires PROCESS_ROLE=web or worker.'});
 const badOrigin={...validEnv(),APP_ORIGIN:'http://app.wimblo.example/path'};
 assert.throws(()=>resolveSaasRuntimeConfig(badOrigin,'/srv/wimblo'),{message:'SaaS production requires APP_ORIGIN to be an exact HTTPS origin.'});
 assert.equal(resolveSaasRuntimeConfig({...validEnv(),PROCESS_ROLE:'worker'},'/srv/wimblo').processRole,'worker');
});

test('SaaS production requires distinct tenant and control database URLs with TLS',()=>{
 const missing=validEnv();delete missing.DATABASE_URL;
 assert.throws(()=>resolveSaasRuntimeConfig(missing,'/srv/wimblo'),{message:'SaaS production requires DATABASE_URL and CONTROL_DATABASE_URL.'});
 const noTls={...validEnv(),DATABASE_URL:'postgresql://wimblo_tenant_app:password@db.example.test/wimblo'};
 assert.throws(()=>resolveSaasRuntimeConfig(noTls,'/srv/wimblo'),{message:'SaaS production database URLs must authenticate certificates and hostnames with sslmode=verify-full and cannot override authority host or port.'});
 const sameRole={...validEnv(),CONTROL_DATABASE_URL:'postgresql://wimblo_tenant_app:other-password@db.example.test/wimblo?sslmode=verify-full'};
 assert.throws(()=>resolveSaasRuntimeConfig(sameRole,'/srv/wimblo'),{message:'SaaS tenant and control databases require distinct runtime roles.'});
});

test('SaaS production rejects evaluator demo temporary storage and sync-postgres driver flags',()=>{
 for(const changes of [
  {CLIENT_EVALUATION_MODE:'true'},
  {DEMO_MODE:'true'},
  {ALLOW_DEMO:'true'},
  {CLIENT_EVALUATION_DATA_DIR:'/tmp/wimblo-client-evaluation-forbidden'},
  {PERSISTENCE_DRIVER:'sync-postgres'}
 ])assert.throws(()=>resolveSaasRuntimeConfig({...validEnv(),...changes},'/srv/wimblo'),{message:'SaaS production rejects evaluator, demo, temporary-storage and synchronous PostgreSQL settings.'});
});

test('resolved metadata never exposes database URLs keys or secret values',()=>{
 const env=validEnv(),config=resolveSaasRuntimeConfig(env,'/srv/wimblo'),serialized=JSON.stringify(config.publicMetadata());
 assert.deepEqual(config.publicMetadata(),{
  mode:'saas',processRole:'web',appOrigin:'https://app.wimblo.example',cookieName:'wimblo_session',
  objectStorage:{provider:'s3',region:'us-east-1',privateConfirmed:true},
  http:{host:'0.0.0.0',port:3000},
  limits:{dbPoolMax:10,jobConcurrency:4,jobLeaseMs:30000}
 });
 for(const secret of [env.DATABASE_URL,env.CONTROL_DATABASE_URL,env.MFA_ENCRYPTION_KEY,env.SESSION_SECRET,env.BACKUP_ENCRYPTION_KEY,env.AWS_ACCESS_KEY_ID,env.AWS_SECRET_ACCESS_KEY,env.DOCUMENT_STORAGE_BUCKET,env.BACKUP_STORAGE_BUCKET])assert.doesNotMatch(serialized,new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('SaaS listener settings are validated before process composition',()=>{
 const config=resolveSaasRuntimeConfig(validEnv(),'/srv/wimblo');assert.deepEqual(config.http,{host:'0.0.0.0',port:3000});
 for(const port of ['0','65536','invalid'])assert.throws(()=>resolveSaasRuntimeConfig({...validEnv(),PORT:port},'/srv/wimblo'),/PORT must be an integer between 1 and 65535/);
});

test('SaaS production accepts only an attested Render edge profile without a wildcard proxy range',()=>{
 const env={...validEnv(),TRUSTED_PROXY_CIDRS:undefined,TRUSTED_PROXY_PROVIDER:'render',RENDER:'true',RENDER_EXTERNAL_HOSTNAME:'app.wimblo.example'};
 assert.deepEqual(resolveSaasRuntimeConfig(env,'/srv/wimblo').network,{trustedProxyProvider:'render',trustedProxyCidrs:[]});
 for(const changes of [
  {RENDER:undefined},
  {RENDER:'false'},
  {RENDER_EXTERNAL_HOSTNAME:undefined},
  {RENDER_EXTERNAL_HOSTNAME:'other.wimblo.example'},
  {TRUSTED_PROXY_PROVIDER:'unknown'}
 ])assert.throws(()=>resolveSaasRuntimeConfig({...env,...changes},'/srv/wimblo'),/trusted proxy|Render/i);
});

test('SaaS production accepts verified private Neon storage only with its credential-free branch endpoint',()=>{
 const env={
  ...validEnv(),
  DOCUMENT_STORAGE_PROVIDER:'neon',
  AWS_ENDPOINT_URL_S3:'https://br-production.storage.c-11.us-east-1.aws.neon.tech',
  BACKUP_AWS_ENDPOINT_URL_S3:'https://br-production.storage.c-11.us-east-1.aws.neon.tech'
 };
 const config=resolveSaasRuntimeConfig(env,'/srv/wimblo');
 assert.equal(config.objectStorage.provider,'neon');
 assert.equal(config.objectStorage.endpoint,env.AWS_ENDPOINT_URL_S3);
 assert.equal(config.backupStorage.provider,'neon');
 assert.equal(config.backupStorage.endpoint,env.BACKUP_AWS_ENDPOINT_URL_S3);
 assert.equal(JSON.stringify(config.publicMetadata()).includes('storage.c-11'),false);
 for(const changes of [
  {AWS_ENDPOINT_URL_S3:undefined},
  {AWS_ENDPOINT_URL_S3:'http://unsafe.example.test'},
  {AWS_ENDPOINT_URL_S3:'https://key:secret@example.test'}
 ])assert.throws(()=>resolveSaasRuntimeConfig({...env,...changes},'/srv/wimblo'),/Neon storage requires a credential-free HTTPS branch endpoint/);
});
