import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRowLevelSecurityEffective,CONTROL_PLANE_TABLES,TENANT_TABLES,PERSISTENCE_CODES} from '../server/persistence/index.js';

test('tenant startup refuses any effective control-table or unauthorized control-function privilege',async()=>{
 const session={async query(sql){
  if(sql.includes('FROM pg_roles'))return {rows:[{name:'wimblo_tenant',rolsuper:false,rolbypassrls:false}]};
  if(sql.includes('FROM pg_class'))return {rows:TENANT_TABLES.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true}))};
  if(sql.includes('has_table_privilege'))return {rows:CONTROL_PLANE_TABLES.map(table=>({object_name:table,has_privilege:table==='wimblo_platform.memberships'}))};
  if(sql.includes('has_function_privilege'))return {rows:[{signature:'wimblo_platform.tenant_state(uuid)',executable:true}]};
  throw new Error(`Unexpected tenant-role assertion query: ${sql}`);
 }};
 await assert.rejects(()=>assertRowLevelSecurityEffective(session),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
  assert.match(error.message,/memberships|tenant_state/);
  return true;
 });
});
