import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';

const run=(mode,extraEnv={})=>spawnSync(process.execPath,['scripts/crm-production-certify.mjs',mode],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,...extraEnv}});

test('recovery self-test reconciles backup, readback and restored records without disclosing secrets',()=>{
 const result=run('--recovery-self-test',{DATABASE_URL:'postgres://private-user:private-pass@db.invalid/wimblo',AWS_SECRET_ACCESS_KEY:'private-aws-secret'});
 assert.equal(result.status,0,result.stderr||result.stdout);
 const evidence=JSON.parse(result.stdout);
 assert.deepEqual(evidence,{status:'passed',backupRows:3,readbackRows:3,restoredRows:3,digestMatch:true});
 assert.doesNotMatch(`${result.stdout}${result.stderr}`,/private-user|private-pass|db\.invalid|private-aws-secret/);
});
test('actual verifier and composed certification failure redact configured credentials',()=>{
 const canaryUrl='postgres://certify-canary-user:certify-canary-password@127.0.0.1:1/certify_canary';
 for(const [script,args] of [['scripts/postgres-verify.mjs',[]],['scripts/crm-production-certify.mjs',['--verify-postgres']]]){
  const result=spawnSync(process.execPath,[script,...args],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,WIMBLO_VERIFY_PG_URL:canaryUrl}});
  const output=`${result.stdout}${result.stderr}`;
  assert.notEqual(result.status,0,script);
  assert.match(output,/no PostgreSQL server|PostgreSQL verification failed/i,script);
  assert.doesNotMatch(output,/certify-canary-user|certify-canary-password|certify_canary|postgres:\/\//i,script);
 }
});
test('certification plan is deterministic and separates local proof from provider proof',()=>{
 const result=run('--plan');assert.equal(result.status,0,result.stderr||result.stdout);
 const plan=JSON.parse(result.stdout);
 assert.deepEqual(plan.local,['node --test tests/production-crm-security.test.js tests/production-crm-capacity.test.js tests/production-crm-recovery.test.js','npm run verify:postgres-foundation','npm run verify:postgres','npm test','npm run build','npm run build:synthetic-evaluation','npm audit --audit-level=high','npm run test:discipline']);
 assert.deepEqual(plan.external,['browser acceptance','configured deployment readiness','provider backup and restore','customer UAT and acceptance']);
});

test('the ordinary production build emits the SaaS client rather than the legacy evaluator',()=>{
 const built=spawnSync('npm',['run','build'],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:process.env});assert.equal(built.status,0,built.stderr||built.stdout);
 const assets=new URL('../dist/assets/',import.meta.url),javascript=readdirSync(assets).filter(name=>name.endsWith('.js')).map(name=>readFileSync(new URL(name,assets),'utf8')).join('\n');
 assert.match(javascript,/Sign-out not confirmed/);
 assert.doesNotMatch(javascript,/About 1,622 representative designations/);
});
test('runbook names dedicated loopback infrastructure and cleanup without provider claims',()=>{
 const runbook=readFileSync(new URL('../docs/operations/WIMBLO-CRM-RUNBOOK.md',import.meta.url),'utf8');
 assert.match(runbook,/dedicated.*loopback PostgreSQL/i);
 assert.match(runbook,/S3-compatible.*MinIO/i);
 assert.match(runbook,/stop.*remove.*container/i);
 assert.match(runbook,/never.*provider/i);
});
