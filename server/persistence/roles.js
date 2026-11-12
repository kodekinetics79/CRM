// Database role requirements for effective tenant isolation.
//
// This module exists because of something the verification run actually caught:
// row-level security policies are silently ineffective when the application
// connects as a PostgreSQL superuser, or as any role with BYPASSRLS. The
// policies are present, the migration succeeded, and every cross-tenant read
// still returns rows. Configuration that looks correct and does nothing is the
// worst possible outcome for a tenant-isolation control, so the boundary
// refuses to open on such a connection rather than trusting the policy text.
//
// Deployment shape this enforces:
//   * migrations and grants run as the owner (an administrative role);
//   * the application connects as a separate NOSUPERUSER, NOBYPASSRLS role that
//     owns nothing and holds only SELECT/INSERT/UPDATE/DELETE on the tenant
//     tables and SELECT on the migration ledger;
//   * every tenant table has ROW LEVEL SECURITY enabled AND forced.

import {PERSISTENCE_CODES,persistenceFail} from './contract.js';
import {MIGRATION_LEDGER_TABLE} from './migrations.js';

export const TENANT_TABLES=Object.freeze([
 'tenants','records','users','settings','audit_entries','gift_ledger','gift_allocations','object_metadata',
 'parties','people','organizations','contact_points','relationships','party_events'
 ,'pipelines','pipeline_stages','leads','opportunities','opportunity_stage_events'
 ,'crm_subjects','crm_activities','crm_tasks','crm_task_events','crm_notes','crm_note_revisions','crm_attachment_links','crm_ownership_events'
 ,'crm_saved_reports','crm_import_batches','crm_import_source_mappings'
]);
const APPEND_ONLY_TENANT_TABLES=Object.freeze(['party_events','opportunity_stage_events','crm_activities','crm_task_events','crm_note_revisions','crm_attachment_links','crm_ownership_events']);
const MUTABLE_NO_DELETE_TENANT_TABLES=Object.freeze(['crm_subjects','crm_tasks','crm_notes','crm_saved_reports','crm_import_batches','crm_import_source_mappings']);
export const TENANT_FOUNDATION_TABLES=Object.freeze([
 'wimblo_platform.tenant_modules',
 'wimblo_platform.module_events',
 'wimblo_platform.durable_jobs',
 'wimblo_platform.durable_job_attempts',
 'wimblo_platform.dead_letter_jobs'
]);
export const CONTROL_PLANE_TABLES=Object.freeze([
 'wimblo_platform.global_identities',
 'wimblo_platform.memberships',
 'wimblo_platform.invitations',
 'wimblo_platform.opaque_sessions',
 'wimblo_platform.mfa_settings',
 'wimblo_platform.mfa_recovery_codes',
 'wimblo_platform.mfa_challenges',
 'wimblo_platform.module_catalog'
]);
const CONTROL_PLANE_SEQUENCE='wimblo_platform.control_audit_audit_id_seq';
const CONTROL_PLANE_FUNCTIONS=Object.freeze(['wimblo_platform.tenant_state(uuid)','wimblo_platform.runnable_tenant_ids()','wimblo_platform.dead_letter_count()']);
const TENANT_SECURITY_DEFINER_FUNCTIONS=Object.freeze(['wimblo_platform.active_membership(uuid,uuid)']);
const TENANT_RUNTIME_FUNCTIONS=Object.freeze(['public.wimblo_current_tenant()',...TENANT_SECURITY_DEFINER_FUNCTIONS]);
const SECURITY_DEFINER_FUNCTIONS=Object.freeze([...CONTROL_PLANE_FUNCTIONS,...TENANT_SECURITY_DEFINER_FUNCTIONS]);
const TENANT_FORBIDDEN_CONTROL_TABLES=Object.freeze([...CONTROL_PLANE_TABLES,'wimblo_platform.control_audit']);

const identifier=name=>{
 if(typeof name!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(name))persistenceFail(PERSISTENCE_CODES.INVALID,'A role name must be a simple lower-case identifier.');
 return name;
};

/** SQL an administrator runs once, after migrating, to grant the application role. */
export function applicationRoleGrants(role){
 const name=identifier(role);
 return [
  `GRANT USAGE ON SCHEMA public TO ${name}`,
  `GRANT USAGE ON SCHEMA wimblo_platform TO ${name}`,
  ...TENANT_TABLES.filter(table=>!APPEND_ONLY_TENANT_TABLES.includes(table)&&!MUTABLE_NO_DELETE_TENANT_TABLES.includes(table)).map(table=>`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${name}`),
  ...APPEND_ONLY_TENANT_TABLES.map(table=>`GRANT SELECT, INSERT ON ${table} TO ${name}`),
  ...MUTABLE_NO_DELETE_TENANT_TABLES.map(table=>`GRANT SELECT, INSERT, UPDATE ON ${table} TO ${name}`),
  ...TENANT_FOUNDATION_TABLES.map(table=>`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${name}`),
  ...TENANT_RUNTIME_FUNCTIONS.map(signature=>`GRANT EXECUTE ON FUNCTION ${signature} TO ${name}`),
  `GRANT SELECT ON ${MIGRATION_LEDGER_TABLE} TO ${name}`
 ];
}

/** Prove global and tenant-bound definer functions are owned by a role that can cross forced RLS deliberately. */
export async function assertSecurityDefinerOwnersBypassRls(session){
 if(!session||typeof session.query!=='function')persistenceFail(PERSISTENCE_CODES.ISOLATION,'A database session is required to inspect SECURITY DEFINER ownership.');
 const {rows}=await session.query(
  `SELECT required.signature,p.prosecdef,owner.rolname AS owner_name,owner.rolsuper,owner.rolbypassrls
   FROM unnest($1::text[]) AS required(signature)
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure(required.signature)
   LEFT JOIN pg_roles owner ON owner.oid=p.proowner`,[SECURITY_DEFINER_FUNCTIONS]);
 const bySignature=new Map(rows.map(row=>[row.signature,row]));
 const unsafe=SECURITY_DEFINER_FUNCTIONS.filter(signature=>{
  const functionRole=bySignature.get(signature);
  return !functionRole?.prosecdef||(!functionRole.rolsuper&&!functionRole.rolbypassrls);
 });
 if(unsafe.length)persistenceFail(PERSISTENCE_CODES.ISOLATION,`Required SECURITY DEFINER functions are missing or owned by roles that cannot bypass forced row-level security: ${unsafe.join(', ')}.`);
 return {functions:SECURITY_DEFINER_FUNCTIONS.length,ownersBypassRls:true};
}

/** SQL an administrator runs once for a control-plane connection role. */
export function controlPlaneRoleGrants(role){
 const name=identifier(role);
 return [
  `GRANT USAGE ON SCHEMA public TO ${name}`,
  `GRANT USAGE ON SCHEMA wimblo_platform TO ${name}`,
  ...TENANT_TABLES.map(table=>`REVOKE ALL PRIVILEGES ON ${table} FROM ${name}`),
  ...TENANT_FOUNDATION_TABLES.map(table=>`REVOKE ALL PRIVILEGES ON ${table} FROM ${name}`),
  ...CONTROL_PLANE_TABLES.map(table=>`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${name}`),
  `GRANT SELECT, INSERT ON wimblo_platform.control_audit TO ${name}`,
  `GRANT USAGE, SELECT ON SEQUENCE wimblo_platform.control_audit_audit_id_seq TO ${name}`,
  `GRANT EXECUTE ON FUNCTION wimblo_platform.tenant_state(uuid) TO ${name}`,
  `GRANT EXECUTE ON FUNCTION wimblo_platform.runnable_tenant_ids() TO ${name}`,
  `GRANT EXECUTE ON FUNCTION wimblo_platform.dead_letter_count() TO ${name}`,
  `GRANT SELECT ON ${MIGRATION_LEDGER_TABLE} TO ${name}`
 ];
}

/**
 * Prove that THIS connection is a non-bypassing control-plane role with no
 * inherited access to tenant business tables.
 */
export async function assertControlPlaneRole(session){
 if(!session||typeof session.query!=='function')persistenceFail(PERSISTENCE_CODES.ISOLATION,'A database session is required to inspect the control-plane role.');
 const {rows:[role]}=await session.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
 if(!role)persistenceFail(PERSISTENCE_CODES.ISOLATION,'The connected control-plane role could not be inspected.');
 if(role.rolsuper)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control plane is connected as superuser "${role.name}". Use a dedicated NOSUPERUSER control-plane role.`);
 if(role.rolbypassrls)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" holds BYPASSRLS. Remove it before serving traffic.`);

 const {rows:[schema]}=await session.query(`SELECT has_schema_privilege(current_user, 'wimblo_platform', 'USAGE') AS usable`);
 if(!schema?.usable)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" cannot use the wimblo_platform schema.`);

 const {rows:platform}=await session.query(
  `SELECT table_schema || '.' || table_name AS table_name,
          has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT') AS can_select,
          has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'INSERT') AS can_insert,
          has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'UPDATE') AS can_update,
          has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'DELETE') AS can_delete
   FROM information_schema.tables
   WHERE table_schema = 'wimblo_platform' AND table_name = ANY($1)`,
  [CONTROL_PLANE_TABLES.map(table=>table.split('.')[1])]);
 const access=new Map(platform.map(row=>[row.table_name,row]));
 const missing=CONTROL_PLANE_TABLES.filter(table=>{
  const row=access.get(table);
  return !row||!row.can_select||!row.can_insert||!row.can_update||!row.can_delete;
 });
 if(missing.length)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" lacks required least-privilege access to: ${missing.join(', ')}.`);

 const {rows:business}=await session.query(
  `SELECT table_schema || '.' || table_name AS table_name,
          (has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')
           OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'INSERT')
           OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'UPDATE')
           OR has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'DELETE')) AS has_business_access
   FROM information_schema.tables
   WHERE (table_schema = current_schema() AND table_name = ANY($1))
      OR (table_schema = 'wimblo_platform' AND table_name = ANY($2))`,[TENANT_TABLES,TENANT_FOUNDATION_TABLES.map(table=>table.split('.')[1])]);
 const exposed=business.filter(row=>row.has_business_access).map(row=>row.table_name);
 if(exposed.length)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" can access tenant business tables: ${exposed.join(', ')}.`);
 const {rows:[sequence]}=await session.query(`SELECT has_sequence_privilege(current_user,$1,'USAGE,SELECT') AS usable`,[CONTROL_PLANE_SEQUENCE]);
 if(!sequence?.usable)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" cannot use the required control audit sequence.`);
 const {rows:functions}=await session.query(`SELECT signature,has_function_privilege(current_user,signature,'EXECUTE') AS executable FROM unnest($1::text[]) AS required(signature)`,[CONTROL_PLANE_FUNCTIONS]);
 const executable=new Map(functions.map(item=>[item.signature,item.executable])),missingFunctions=CONTROL_PLANE_FUNCTIONS.filter(signature=>!executable.get(signature));
 if(missingFunctions.length)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The control-plane role "${role.name}" cannot execute required runtime functions: ${missingFunctions.join(', ')}.`);
 return {role:role.name,superuser:false,bypassRls:false,platformTables:CONTROL_PLANE_TABLES.length,businessTables:0,sequences:1,functions:CONTROL_PLANE_FUNCTIONS.length};
}

/**
 * Prove tenant isolation is actually in force for THIS connection.
 * Throws with the exact reason when it is not.
 */
export async function assertRowLevelSecurityEffective(session){
 const {rows:[role]}=await session.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
 if(!role)persistenceFail(PERSISTENCE_CODES.ISOLATION,'The connected role could not be inspected; tenant isolation cannot be confirmed.');
 if(role.rolsuper)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The application is connected as superuser "${role.name}". Superusers bypass row-level security, so tenant isolation policies would be present but ineffective. Connect as a NOSUPERUSER application role.`);
 if(role.rolbypassrls)persistenceFail(PERSISTENCE_CODES.ISOLATION,`The application role "${role.name}" holds BYPASSRLS, which defeats tenant isolation. Remove BYPASSRLS from the application role.`);
 const {rows}=await session.query(
  `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = ANY($1)`,[[...TENANT_TABLES]]);
 const byName=new Map(rows.map(r=>[r.relname,r]));
 const problems=TENANT_TABLES.map(table=>{
  const row=byName.get(table);
  if(!row)return `${table} (missing)`;
  if(!row.relrowsecurity)return `${table} (row-level security disabled)`;
  if(!row.relforcerowsecurity)return `${table} (row-level security not forced for the owner)`;
  return null;
 }).filter(Boolean);
 if(problems.length)persistenceFail(PERSISTENCE_CODES.ISOLATION,`Tenant isolation is not in force: ${problems.join(', ')}.`);
 const {rows:controlTables}=await session.query(
  `SELECT object_name,
          (has_table_privilege(current_user,object_name,'SELECT')
           OR has_table_privilege(current_user,object_name,'INSERT')
           OR has_table_privilege(current_user,object_name,'UPDATE')
           OR has_table_privilege(current_user,object_name,'DELETE')
           OR has_table_privilege(current_user,object_name,'TRUNCATE')
           OR has_table_privilege(current_user,object_name,'REFERENCES')
           OR has_table_privilege(current_user,object_name,'TRIGGER')
           OR has_table_privilege(current_user,object_name,'MAINTAIN')
           OR has_any_column_privilege(current_user,object_name,'SELECT,INSERT,UPDATE,REFERENCES')) AS has_privilege
   FROM unnest($1::text[]) AS forbidden(object_name)`,[TENANT_FORBIDDEN_CONTROL_TABLES]);
 const exposedTables=controlTables.filter(item=>item.has_privilege).map(item=>item.object_name);
 const {rows:functions}=await session.query(
  `SELECT signature,has_function_privilege(current_user,signature,'EXECUTE') AS executable
   FROM unnest($1::text[]) AS inspected(signature)`,[[...CONTROL_PLANE_FUNCTIONS,...TENANT_RUNTIME_FUNCTIONS]]);
 const functionAccess=new Map(functions.map(item=>[item.signature,item.executable]));
 const exposedFunctions=CONTROL_PLANE_FUNCTIONS.filter(signature=>functionAccess.get(signature));
 const missingFunctions=TENANT_RUNTIME_FUNCTIONS.filter(signature=>!functionAccess.get(signature));
 if(exposedTables.length||exposedFunctions.length||missingFunctions.length){
  const details=[...exposedTables,...exposedFunctions,...missingFunctions.map(signature=>`${signature} (required execute missing)`)];
  persistenceFail(PERSISTENCE_CODES.ISOLATION,`The application role "${role.name}" has unsafe or incomplete control-plane privileges: ${details.join(', ')}.`);
 }
 return {role:role.name,superuser:false,bypassRls:false,tables:TENANT_TABLES.length,forced:true,controlPlaneTables:0,tenantFunctions:TENANT_RUNTIME_FUNCTIONS.length};
}
