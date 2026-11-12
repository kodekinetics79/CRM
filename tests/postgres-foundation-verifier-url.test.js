import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));

test('foundation verifier rejects query target overrides before opening its administrative pool',()=>{
 const result=spawnSync(process.execPath,['scripts/postgres-foundation-verify.mjs'],{
  cwd:root,
  env:{...process.env,WIMBLO_FOUNDATION_VERIFY_PG_URL:'postgres://wimblo_admin:local-only@127.0.0.1:57733/wimblo_foundation?host=127.0.0.1&port=1'},
  encoding:'utf8',
  timeout:15_000
 });
 assert.notEqual(result.status,0,'unsafe verifier URL unexpectedly ran');
 assert.match(`${result.stdout}\n${result.stderr}`,/cannot override.*(?:host|port)|(?:host|port).*override/i);
 assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,/ECONNREFUSED|connect ECONN|connection refused/i);
});
