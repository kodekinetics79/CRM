import test from 'node:test';
import assert from 'node:assert/strict';
import {runRepresentativeCrmCapacity} from '../server/production/capacityCertification.js';

test('capacity gate executes bounded representative CRM reads and measures actual database queries',async()=>{
 const tenantId='33333333-3333-4333-8333-333333333333';
 const tenantPool={withTenantSession:async(id,fn)=>{assert.equal(id,tenantId);return fn({query:async()=>{await new Promise(resolve=>setTimeout(resolve,2));return {rows:[],rowCount:0};}});}};
 const evidence=await runRepresentativeCrmCapacity({tenantPool,tenantId,operations:12,concurrency:3,poolMax:2});
 assert.equal(evidence.status,'passed');
 assert.equal(evidence.workload,'crm.listParties');
 assert.equal(evidence.operations,12);
 assert.equal(evidence.errors,0);
 assert.equal(evidence.actualQueries,12);
 assert.equal(evidence.queriesPerOperation,1);
 assert.ok(evidence.elapsedMs>=1);
 assert.ok(evidence.maxConcurrentOperations<=3);
 assert.ok(evidence.maxConcurrentQueries<=2);
 assert.equal(evidence.poolMax,2);
});
