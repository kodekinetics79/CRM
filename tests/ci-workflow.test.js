import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');

test('CI builds the checked-out application before tests require built evaluator assets',()=>{
 const build=workflow.indexOf('- run: npm run build'),tests=workflow.indexOf('- run: npm test');
 assert.ok(build>=0,'CI must build the application.');
 assert.ok(tests>=0,'CI must run the complete test suite.');
 assert.ok(build<tests,'CI must build before tests start evaluator processes that serve dist.');
});

test('CI supplies the dedicated disposable PostgreSQL endpoint used by real foundation tests',()=>{
 assert.match(workflow,/services:\s*\n\s+postgres:/);
 assert.match(workflow,/image:\s*postgres:17-alpine/);
 assert.match(workflow,/POSTGRES_USER:\s*wimblo_admin/);
 assert.match(workflow,/POSTGRES_PASSWORD:\s*wimblo-foundation/);
 assert.match(workflow,/POSTGRES_DB:\s*wimblo_foundation/);
 assert.match(workflow,/127\.0\.0\.1:57733:5432/);
 assert.match(workflow,/- run: npm run verify:postgres-boundaries/);
 assert.match(workflow,/- run: npm run verify:postgres-foundation/);
});
