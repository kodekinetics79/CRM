import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const run=mode=>spawnSync(process.execPath,['scripts/crm-production-certify.mjs',mode],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,WIMBLO_CERTIFY_SECRET:'must-not-appear'}});

test('capacity self-test enforces concurrency and per-operation query budgets',()=>{
 const result=run('--capacity-self-test');
 assert.equal(result.status,0,result.stderr||result.stdout);
 const evidence=JSON.parse(result.stdout);
 assert.equal(evidence.status,'passed');
 assert.ok(evidence.maxActive<=4);
 assert.ok(evidence.maxQueriesPerOperation<=4);
 assert.equal(evidence.operations,40);
 assert.doesNotMatch(result.stdout,/must-not-appear/);
});
