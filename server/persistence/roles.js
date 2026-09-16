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

export const TENANT_TABLES=Object.freeze(['tenants','records','users','settings','audit_entries','gift_ledger','gift_allocations','object_metadata']);

const identifier=name=>{
 if(typeof name!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(name))persistenceFail(PERSISTENCE_CODES.INVALID,'A role name must be a simple lower-case identifier.');
 return name;
};

/** SQL an administrator runs once, after migrating, to grant the application role. */
export function applicationRoleGrants(role){
 const name=identifier(role);
 return [
  ...TENANT_TABLES.map(table=>`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${name}`),
  `GRANT SELECT ON ${MIGRATION_LEDGER_TABLE} TO ${name}`
 ];
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
 return {role:role.name,superuser:false,bypassRls:false,tables:TENANT_TABLES.length,forced:true};
}
