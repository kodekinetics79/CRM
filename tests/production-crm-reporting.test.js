import test from 'node:test';
import assert from 'node:assert/strict';
import {MIGRATIONS,SCHEMA_VERSION,TENANT_TABLES,applicationRoleGrants,controlPlaneRoleGrants} from '../server/persistence/index.js';
import {createCrmReportingService,validateReportDefinition} from '../server/production/crmReportingService.js';
import {randomUUID} from 'node:crypto';

test('migration 16 adds lean governed reporting and import control tables',()=>{
 assert.equal(SCHEMA_VERSION,16);
 const sql=MIGRATIONS.find(entry=>entry.version===16)?.statements.join('\n')??'';
 for(const table of ['crm_saved_reports','crm_import_batches','crm_import_source_mappings']){
  assert.ok(TENANT_TABLES.includes(table),table);
  assert.match(sql,new RegExp(`CREATE TABLE ${table}\\(`));
  assert.match(sql,new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
 }
 assert.match(sql,/CHECK \(jsonb_typeof\(definition\)='object'/);
 assert.match(sql,/UNIQUE \(tenant_id, idempotency_key\)/);
 assert.match(sql,/row_count = valid_count \+ invalid_count/);
 assert.match(sql,/preview_sha256 char\(64\)/);
 assert.match(sql,/crm_import_batch_committed_immutable/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, target_subject_id\) REFERENCES crm_subjects/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, target_subject_id\) REFERENCES people\(tenant_id, party_id\)/);
});

test('report definitions are strict bounded ASTs and never accept SQL or unknown fields',()=>{
 const definition=validateReportDefinition({dataset:'opportunities',columns:['name','status','amountCents'],filters:[{field:'status',operator:'eq',value:'open'}],sort:{field:'name',direction:'asc'},dateRange:{from:'2026-01-01',to:'2026-12-31'}});
 assert.equal(definition.dataset,'opportunities');
 for(const bad of [
  {dataset:'opportunities',sql:'SELECT * FROM opportunities'},
  {dataset:'opportunities',columns:['password_hash']},
  {dataset:'opportunities',columns:['name'],filters:Array.from({length:11},()=>({field:'status',operator:'eq',value:'open'}))},
  {dataset:'opportunities',columns:['name'],dateRange:{from:'2024-01-01',to:'2026-01-02'}},
  {dataset:'opportunities',columns:['amountCents'],filters:[{field:'amountCents',operator:'contains',value:'12'}]},
  {dataset:'opportunities',columns:['expectedCloseDate'],filters:[{field:'expectedCloseDate',operator:'contains',value:'2026'}]},
  {dataset:'opportunities',columns:['amountCents'],filters:[{field:'amountCents',operator:'gte',value:'1200'}]},
  {dataset:'opportunities',columns:['status'],filters:[{field:'status',operator:'gte',value:'open'}]},
  {dataset:'unknown',columns:['name']}
 ])assert.throws(()=>validateReportDefinition(bad),/definition|dataset|field|range|filter/i);
 assert.doesNotThrow(()=>validateReportDefinition({dataset:'opportunities',columns:['amountCents','expectedCloseDate'],filters:[{field:'amountCents',operator:'gte',value:1200},{field:'expectedCloseDate',operator:'lte',value:'2026-12-31'}]}));
});

test('report execution uses fixed tenant-bound templates and bounded rows',async()=>{
 const tenantId=randomUUID(),calls=[];
 const tenantPool={withTenantSession:async(tenant,fn)=>{assert.equal(tenant,tenantId);return fn({query:async(sql,values)=>{calls.push({sql,values});return {rows:[{opportunity_id:randomUUID(),name:'Expansion',status:'open',amount_cents:'12500',currency:'USD',probability:25,expected_close_date:'2026-12-31'}],rowCount:1};}});}};
 const moduleService={authorize:async()=>({allowed:true})};
 const service=createCrmReportingService({tenantPool,moduleService});
 const result=await service.executeReport({tenantId,actorRole:'viewer',definition:{dataset:'opportunities',columns:['name','status','amountCents'],filters:[{field:'status',operator:'eq',value:'open'}]}});
 assert.equal(result.rows[0].amountCents,12500);
 assert.equal(result.truncated,false);
 assert.match(calls[0].sql,/FROM opportunities/);
 assert.match(calls[0].sql,/tenant_id=\$1/);
 assert.equal(calls[0].values[0],tenantId);
 assert.equal(calls[0].values.at(-1),1001);
 assert.doesNotMatch(calls[0].sql,/Expansion|open/);
});

test('sales reporting requires sales capability while core reporting does not',async()=>{
 const tenantId=randomUUID(),codes=[];
 const service=createCrmReportingService({tenantPool:{withTenantSession:async()=>({rows:[],rowCount:0})},moduleService:{authorize:async input=>{codes.push(input.code);return {allowed:input.code==='core'};}}});
 await assert.rejects(()=>service.executeReport({tenantId,actorRole:'viewer',definition:{dataset:'leads',columns:['status']}}),/capability/i);
 assert.deepEqual(codes,['core','sales']);
});

test('export requires the dedicated core and sales export capabilities',async()=>{
 const tenantId=randomUUID(),actions=[];
 const service=createCrmReportingService({
  tenantPool:{withTenantSession:async()=>({rows:[],rowCount:0})},
  moduleService:{authorize:async input=>{actions.push([input.code,input.action]);return {allowed:true};}}
 });
 await service.exportReport({tenantId,actorRole:'staff',definition:{dataset:'opportunities',columns:['name']}});
 assert.deepEqual(actions,[['core','export'],['sales','export']]);
});

test('saved report updates require the current optimistic version',async()=>{
 const tenantId=randomUUID(),reportId=randomUUID();
 const tenantPool={withTenantSession:async(tenant,fn)=>fn({query:async sql=>sql.includes('report:current')?{rows:[{report_id:reportId,dataset:'parties',version:1,state:'active'}],rowCount:1}:{rows:[],rowCount:0}})};
 const service=createCrmReportingService({tenantPool,moduleService:{authorize:async()=>({allowed:true})}});
 await assert.rejects(()=>service.updateReport({tenantId,reportId,expectedVersion:2,actorRole:'staff',actorIdentityId:randomUUID(),name:'Updated',definition:{dataset:'parties',columns:['displayName']}}),/version|conflict/i);
});

test('reporting tables are mutable without delete and invisible to control plane',()=>{
 const app=applicationRoleGrants('wimblo_app'),control=controlPlaneRoleGrants('wimblo_control');
 for(const table of ['crm_saved_reports','crm_import_batches','crm_import_source_mappings']){
  assert.ok(app.includes(`GRANT SELECT, INSERT, UPDATE ON ${table} TO wimblo_app`),table);
  assert.ok(control.includes(`REVOKE ALL PRIVILEGES ON ${table} FROM wimblo_control`),table);
  assert.equal(app.some(sql=>sql.includes(`DELETE ON ${table}`)),false,table);
 }
});
