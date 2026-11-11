import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('the full integration suite bounds file concurrency to avoid resource-driven socket resets',async()=>{
 const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.match(packageJson.scripts.test,/--test-concurrency=4(?:\s|$)/);
});
