import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {findTestDisciplineViolations} from '../scripts/tdd-gate.mjs';

test('production test discipline reports focused and skipped tests with file and line',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wimblo-tdd-gate-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'good.test.js'),[
  "test('ordinary',()=>{});",
  "const literal='test.skip and describe.only';",
  '// it.skip and test.only are examples only',
  'const template=`test.only ${"it.skip"}`;',
  "assert.match('value',/RAISE EXCEPTION 'test.skip/);"
 ].join('\n'));
 await writeFile(join(root,'focused.test.js'),[
  "test.only('focused test',()=>{});",
  "describe.only('focused suite',()=>{});"
 ].join('\n'));
 await writeFile(join(root,'skipped.test.js'),[
  "test.skip('skipped test',()=>{});",
  "describe.skip('skipped suite',()=>{});",
  "it.skip('skipped case',()=>{});",
  "test('option skip',{skip:true},()=>{});"
 ].join('\n'));

 const result=await findTestDisciplineViolations({root});

 assert.deepEqual(result.focused,['focused.test.js:1','focused.test.js:2']);
 assert.deepEqual(result.skipped,['skipped.test.js:1','skipped.test.js:2','skipped.test.js:3','skipped.test.js:4']);
});
