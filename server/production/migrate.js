import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parsePostgresConnectionUrl} from '../persistence/databaseUrl.js';
import {
 applyMigrations,
 applicationRoleGrants,
 assertSecurityDefinerOwnersBypassRls,
 controlPlaneRoleGrants,
 createPostgresPool
} from '../persistence/index.js';

const roleName=value=>decodeURIComponent(value).toLowerCase();
const roleIdentifier=value=>{
 const name=roleName(value);
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(name))throw new Error('Production migration role names must be simple lower-case identifiers.');
 return name;
};
const RUNTIME_SCHEMAS=Object.freeze(['public','wimblo_platform']);

export function runtimeRoleHardeningStatements({migration,tenant,control}){
 const owner=roleIdentifier(migration),runtimeRoles=[roleIdentifier(tenant),roleIdentifier(control)],statements=['REVOKE CREATE ON SCHEMA public FROM PUBLIC'];
 for(const schema of RUNTIME_SCHEMAS){
  statements.push(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
  statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  for(const role of runtimeRoles)statements.push(
   `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role}`,
   `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
   `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
   `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role}`,
   `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`,
   `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`,
   `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON FUNCTIONS FROM ${role}`
  );
 }
 return statements;
}

export async function assertRuntimeRoleHardening(session,{tenant,control}){
 const roles=[roleIdentifier(tenant),roleIdentifier(control)];
 const {rows:attributes}=await session.query(`SELECT requested.role_name,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication
   FROM unnest($1::text[]) requested(role_name) LEFT JOIN pg_roles r ON r.rolname=requested.role_name`,[roles]);
 const unsafeAttributes=attributes.filter(row=>row.rolsuper!==false||row.rolbypassrls!==false||row.rolcreatedb!==false||row.rolcreaterole!==false||row.rolreplication!==false).map(row=>row.role_name);
 const {rows:schemas}=await session.query(`SELECT role_name,
    has_schema_privilege(role_name,'public','CREATE') OR has_schema_privilege(role_name,'wimblo_platform','CREATE') AS can_create
   FROM unnest($1::text[]) requested(role_name)`,[roles]);
 const unsafeSchemas=schemas.filter(row=>row.can_create).map(row=>row.role_name);
 const {rows:tables}=await session.query(`SELECT role_name,n.nspname||'.'||c.relname AS object_name
   FROM unnest($1::text[]) requested(role_name)
   CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=ANY($2) AND c.relkind IN ('r','p','v','m') AND
    (has_table_privilege(role_name,c.oid,'TRUNCATE') OR has_table_privilege(role_name,c.oid,'REFERENCES') OR has_table_privilege(role_name,c.oid,'TRIGGER') OR has_table_privilege(role_name,c.oid,'MAINTAIN'))`,[roles,RUNTIME_SCHEMAS]);
 const {rows:sequences}=await session.query(`SELECT role_name,n.nspname||'.'||c.relname AS object_name
   FROM unnest($1::text[]) requested(role_name)
   CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=ANY($2) AND c.relkind='S' AND has_sequence_privilege(role_name,c.oid,'UPDATE')`,[roles,RUNTIME_SCHEMAS]);
 const allowedFunctions={
  [roles[0]]:['public.wimblo_current_tenant()','wimblo_platform.active_membership(uuid,uuid)'],
  [roles[1]]:['wimblo_platform.tenant_state(uuid)','wimblo_platform.runnable_tenant_ids()','wimblo_platform.dead_letter_count()']
 };
 const {rows:functions}=await session.query(`SELECT requested.role_name,n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ', ',')||')' AS signature
   FROM unnest($1::text[]) requested(role_name)
   CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE (n.nspname='wimblo_platform' OR p.oid=to_regprocedure('public.wimblo_current_tenant()'))
    AND has_function_privilege(requested.role_name,p.oid,'EXECUTE')`,[roles]);
 const unsafeFunctions=functions.filter(row=>!allowedFunctions[row.role_name]?.includes(row.signature));
 const executable=new Map(roles.map(role=>[role,new Set(functions.filter(row=>row.role_name===role).map(row=>row.signature))]));
 const missingFunctions=roles.flatMap(role=>allowedFunctions[role].filter(signature=>!executable.get(role).has(signature)).map(signature=>({role,signature})));
 const problems=[...unsafeAttributes.map(role=>`${role} role attributes`),...unsafeSchemas.map(role=>`${role} schema CREATE`),...tables.map(row=>`${row.role_name} ${row.object_name} dangerous table privilege`),...sequences.map(row=>`${row.role_name} ${row.object_name} sequence UPDATE`),...unsafeFunctions.map(row=>`${row.role_name} ${row.signature} unexpected EXECUTE`),...missingFunctions.map(row=>`${row.role} ${row.signature} required EXECUTE missing`)];
 if(problems.length)throw new Error(`Production runtime role hardening failed: ${problems.join(', ')}.`);
 return {roles:roles.length,leastPrivilege:true};
}

function migrationConfig(env){
 if(env.NODE_ENV!=='production')throw new Error('Production migration requires NODE_ENV=production.');
 const urls={
  migration:parsePostgresConnectionUrl(env.MIGRATION_DATABASE_URL,{label:'MIGRATION_DATABASE_URL',production:true,requireCredentials:true}),
  tenant:parsePostgresConnectionUrl(env.DATABASE_URL,{label:'DATABASE_URL',production:true,requireCredentials:true}),
  control:parsePostgresConnectionUrl(env.CONTROL_DATABASE_URL,{label:'CONTROL_DATABASE_URL',production:true,requireCredentials:true})
 };
 const roles=Object.fromEntries(Object.entries(urls).map(([key,url])=>[key,roleIdentifier(url.username)]));
 if(new Set(Object.values(roles)).size!==3)throw new Error('Production migration requires three distinct database roles.');
 const target=url=>`${url.hostname.toLowerCase()}:${url.port||'5432'}${decodeURIComponent(url.pathname)}`;
 if(new Set(Object.values(urls).map(target)).size!==1)throw new Error('Production migration URLs must use the same database authority and name.');
 return {urls,roles};
}

export async function runProductionMigration({
 env=process.env,
 poolFactory=createPostgresPool,
 apply=applyMigrations,
 hardenRoles=runtimeRoleHardeningStatements,
 applicationGrants=applicationRoleGrants,
 controlGrants=controlPlaneRoleGrants,
 verifyOwners=assertSecurityDefinerOwnersBypassRls,
 verifyPrivileges=assertRuntimeRoleHardening
}={}){
 const {urls,roles}=migrationConfig(env);
 const pool=poolFactory({connectionString:urls.migration.toString(),applicationName:'wimblo-production-migration',max:1,min:0});
 try{
  return await pool.withAdminSession(async session=>{
   const migration=await apply(session);
   for(const statement of hardenRoles(roles))await session.query(statement);
   for(const statement of [...applicationGrants(roles.tenant),...controlGrants(roles.control)])await session.query(statement);
   const ownership=await verifyOwners(session);
   const privileges=await verifyPrivileges(session,roles);
   return {
    schemaVersion:migration.currentVersion,
    appliedVersions:migration.applied.map(entry=>entry.version),
    tenantRole:roles.tenant,
    controlRole:roles.control,
    securityDefinerFunctions:ownership.functions,
    runtimeRolesVerified:privileges.roles
   };
  });
 }finally{await pool.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runProductionMigration().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`Wimblo production migration failed: ${error.message}\n`);process.exitCode=1;});
}
