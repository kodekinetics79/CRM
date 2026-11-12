import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRowLevelSecurityEffective,CONTROL_PLANE_TABLES,TENANT_TABLES,PERSISTENCE_CODES} from '../server/persistence/index.js';

const FUNCTIONS=Object.freeze([
 'wimblo_platform.tenant_state(uuid)',
 'wimblo_platform.runnable_tenant_ids()',
 'wimblo_platform.dead_letter_count()',
 'wimblo_platform.active_membership(uuid,uuid)'
]);

function tenantSession({tablePrivilege=null,functionPrivilege=null}={}){
 return {async query(sql){
  if(sql.includes('FROM pg_roles'))return {rows:[{name:'wimblo_tenant',rolsuper:false,rolbypassrls:false}]};
  if(sql.includes('FROM pg_class'))return {rows:TENANT_TABLES.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true}))};
  if(sql.includes('has_table_privilege'))return {rows:[...CONTROL_PLANE_TABLES,'wimblo_platform.control_audit'].map(object_name=>({object_name,has_privilege:object_name===tablePrivilege}))};
  if(sql.includes('has_function_privilege'))return {rows:FUNCTIONS.map(signature=>({signature,executable:signature==='wimblo_platform.active_membership(uuid,uuid)'||signature===functionPrivilege}))};
  throw new Error(`Unexpected tenant-role assertion query: ${sql}`);
 }};
}

async function isolationFailure(session){
 let failure;
 try{await assertRowLevelSecurityEffective(session);}catch(error){failure=error;}
 assert.ok(failure,'unsafe tenant privilege unexpectedly passed startup');
 assert.equal(failure.code,PERSISTENCE_CODES.ISOLATION);
 return failure;
}

test('tenant startup independently names the exact forbidden control table',async()=>{
 const failure=await isolationFailure(tenantSession({tablePrivilege:'wimblo_platform.memberships'}));
 assert.match(failure.message,/wimblo_platform\.memberships/);
 assert.doesNotMatch(failure.message,/tenant_state/);
});

test('tenant startup independently names the exact forbidden control function',async()=>{
 const failure=await isolationFailure(tenantSession({functionPrivilege:'wimblo_platform.tenant_state(uuid)'}));
 assert.match(failure.message,/wimblo_platform\.tenant_state\(uuid\)/);
 assert.doesNotMatch(failure.message,/memberships/);
});
