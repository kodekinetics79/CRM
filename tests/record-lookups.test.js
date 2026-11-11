// Every collection scan replaced in validate() is proven equal to the scan it replaced,
// and every replacement is proven to read through its declared index. The PostgreSQL
// counterpart is tests/postgres/gift-source-reference-postgres.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {createRecordLookups,RECORD_LOOKUP_INDEXES} from '../server/recordLookups.js';
import {writeEdgeCases,assertLookupEquivalence,ORIGINAL_SCANS,PROBES} from './record-lookups-equivalence.js';
import {openWorkspace,writePathLookupsKeepScanSemantics} from './gift-source-reference-scenarios.js';

test('each indexed lookup returns exactly what the original scan returned, in the same order, across type edge cases',t=>{
 const app=createApp({seed:false,reminderWorker:false,workflowWorker:false});t.after(()=>app.locals.close());
 writeEdgeCases(app.locals.db);
 const {comparisons,nonEmpty}=assertLookupEquivalence(app.locals.db);
 assert.equal(comparisons,ORIGINAL_SCANS.length*PROBES.length);assert.ok(nonEmpty>100);
 assert.deepEqual(Object.entries(RECORD_LOOKUP_INDEXES).flatMap(([c,fields])=>Object.keys(fields).map(p=>c+'.'+p)).sort(),ORIGINAL_SCANS.map(s=>s.collection+'.'+s.path).sort(),'every declared index serves a proven replacement and no other');
});

test('each lookup statement is answered by its declared index, not by the collection',t=>{
 const app=createApp({seed:false,reminderWorker:false,workflowWorker:false}),db=app.locals.db;t.after(()=>app.locals.close());
 const statements=[];
 const listWhere=createRecordLookups({db:{prepare:sql=>{statements.push(sql);return db.prepare(sql);}},list:()=>assert.fail('a string value must not fall back to the scan'),readRecord:(c,v)=>JSON.parse(v)});
 for(const {collection,path} of ORIGINAL_SCANS){
  statements.length=0;listWhere(collection,path,'any-id');
  assert.equal(statements.length,1);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+statements[0]).all().map(r=>r.detail);
  assert.ok(plan.some(d=>d===`SEARCH records USING INDEX ${RECORD_LOOKUP_INDEXES[collection][path]} (<expr>=?)`),`${collection}.${path}: ${JSON.stringify(plan)}`);
 }
});

test('write-path checks that now use indexed lookups refuse exactly what the scans refused',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wimblo-lookups-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writePathLookupsKeepScanSemantics(await openWorkspace(t,join(dir,'workspace.sqlite')));
});
