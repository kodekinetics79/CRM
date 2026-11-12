import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));

function runVerifier(query){
 return spawnSync(process.execPath,['scripts/postgres-foundation-verify.mjs'],{
  cwd:root,
  env:{...process.env,WIMBLO_FOUNDATION_VERIFY_PG_URL:`postgres://wimblo_admin:local-only@127.0.0.1:57733/wimblo_foundation?${query}`},
  encoding:'utf8',
  timeout:15_000
 });
}

function assertRejectedBeforeConnect(result,kind){
 assert.notEqual(result.status,0,'unsafe verifier URL unexpectedly ran');
 assert.match(`${result.stdout}\n${result.stderr}`,new RegExp(`cannot override.*${kind}|${kind}.*override`,'i'));
 assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,/ECONNREFUSED|connect ECONN|connection refused/i);
}

test('foundation verifier rejects a query host override before opening its administrative pool',()=>{
 assertRejectedBeforeConnect(runVerifier('host=127.0.0.2'),'host');
});

test('foundation verifier rejects a query port override before opening its administrative pool',()=>{
 assertRejectedBeforeConnect(runVerifier('port=1'),'port');
});
