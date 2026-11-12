import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSyntheticEvaluationClient,SYNTHETIC_BASELINE} from '../src/production/syntheticEvaluationClient.js';

test('synthetic evaluation data is deterministic, unmistakable and uses no real customer domains',()=>{
 assert.equal(SYNTHETIC_BASELINE.synthetic,true);
 assert.match(SYNTHETIC_BASELINE.tenant.name,/Synthetic|Evaluation/i);
 const serialized=JSON.stringify(SYNTHETIC_BASELINE);
 assert.match(serialized,/\.example/);
 assert.doesNotMatch(serialized,/@(gmail|outlook|yahoo)\./i);
});

test('synthetic client mutations are resettable to a frozen baseline',async()=>{
 const client=createSyntheticEvaluationClient();
 const before=await client.request('/crm/parties');
 await client.request('/crm/people',{method:'POST',body:{displayName:'Synthetic new contact',firstName:'New',lastName:'Contact'}});
 const changed=await client.request('/crm/parties');
 assert.equal(changed.parties.length,before.parties.length+1);
 await client.reset();
 const reset=await client.request('/crm/parties');
 assert.deepEqual(reset,before);
 assert.equal(client.synthetic,true);
});

test('entry mode is build-time only and production source cannot import synthetic fixtures',()=>{
 const main=readFileSync(new URL('../src/main.jsx',import.meta.url),'utf8');
 const production=readFileSync(new URL('../src/production/ProductionApp.jsx',import.meta.url),'utf8');
 assert.match(main,/import\.meta\.env\.VITE_WIMBLO_APP_MODE/);
 assert.doesNotMatch(main,/URLSearchParams|localStorage|sessionStorage/);
 assert.doesNotMatch(production,/syntheticEvaluationClient|SYNTHETIC_BASELINE/);
});
