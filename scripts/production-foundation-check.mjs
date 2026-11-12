#!/usr/bin/env node

import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
 MIGRATIONS,SCHEMA_VERSION,TENANT_TABLES,TENANT_FOUNDATION_TABLES,
 assertControlPlaneRole,assertRowLevelSecurityEffective,assertSecurityDefinerOwnersBypassRls,poolFromEnv,controlPoolFromEnv
} from '../server/persistence/index.js';
import {resolveSaasRuntimeConfig} from '../server/production/runtimeConfig.js';

const GATES=Object.freeze([
 ['runtime-profile','runtimeProfile','RUNTIME_PROFILE_INVALID'],['runtime-roles','runtimeRoles','RUNTIME_ROLES_INVALID'],
 ['schema-version','schema','SCHEMA_VERSION_INVALID'],['forced-rls','rowLevelSecurity','FORCED_RLS_INVALID'],
 ['control-privileges','controlPrivileges','CONTROL_PRIVILEGES_INVALID'],['private-object-storage','objectStorage','PRIVATE_STORAGE_INVALID'],
 ['mfa-key','mfaKey','MFA_KEY_INVALID'],['web-worker-processes','processes','PROCESS_EVIDENCE_INVALID'],
 ['dead-letters','deadLetters','DEAD_LETTERS_PRESENT'],['backup-configuration','backup','BACKUP_CONFIGURATION_INVALID']
]);

export const PRODUCTION_BACKUP_RPO_SECONDS=24*60*60;

const pass=(key,value,expectedSchemaVersion)=>{
 if(!value?.valid)return false;
 if(key==='runtimeRoles')return value.distinct===true;
 if(key==='schema')return value.ledgerValid===true&&value.currentVersion===expectedSchemaVersion&&value.targetVersion===expectedSchemaVersion;
 if(key==='rowLevelSecurity')return value.forcedTables===value.expectedTables&&value.expectedTables===TENANT_TABLES.length+TENANT_FOUNDATION_TABLES.length;
 if(key==='objectStorage')return value.privateConfirmed===true;
 if(key==='mfaKey')return value.distinctFromBackup===true;
 if(key==='processes')return value.webHealthy===true&&value.workerHealthy===true&&Number.isFinite(value.ageSeconds)&&value.ageSeconds>=0&&value.ageSeconds<=300;
 if(key==='deadLetters')return value.count===0;
 if(key==='backup')return value.configured===true&&value.privateConfirmed===true&&Number.isFinite(value.ageSeconds)&&value.ageSeconds>=0&&value.ageSeconds<=PRODUCTION_BACKUP_RPO_SECONDS;
 return true;
};

export function evaluateProductionFoundation(evidence={},options={}){
 const expectedSchemaVersion=options.expectedSchemaVersion??SCHEMA_VERSION;
 const gates=GATES.map(([id,key,reason])=>Object.freeze({id,status:pass(key,evidence[key],expectedSchemaVersion)?'Pass':'Blocked',reason:pass(key,evidence[key],expectedSchemaVersion)?'VERIFIED':reason}));
 return Object.freeze({scope:options.scope||'production-runtime',status:gates.every(gate=>gate.status==='Pass')?'Ready':'Blocked',gates:Object.freeze(gates)});
}

export function redactedReadinessJson(report){
 const safe={scope:String(report.scope),status:report.status,gates:report.gates.map(gate=>({id:gate.id,status:gate.status,reason:gate.reason}))};
 return JSON.stringify(safe,null,2);
}

const invalidEvidence=()=>({
 runtimeProfile:{valid:false},runtimeRoles:{valid:false,distinct:false},schema:{valid:false,currentVersion:0,targetVersion:SCHEMA_VERSION,ledgerValid:false},
 rowLevelSecurity:{valid:false,forcedTables:0,expectedTables:TENANT_TABLES.length+TENANT_FOUNDATION_TABLES.length},controlPrivileges:{valid:false},
 objectStorage:{valid:false,privateConfirmed:false},mfaKey:{valid:false,distinctFromBackup:false},processes:{valid:false,webHealthy:false,workerHealthy:false,ageSeconds:null},
 deadLetters:{valid:false,count:null},backup:{valid:false,configured:false,privateConfirmed:false,ageSeconds:null}
});

async function readOnly(pool,inspect){
 return pool.withAdminSession(async session=>{
  await session.query('BEGIN READ ONLY');
  try{return await inspect(session);}
  finally{await session.query('ROLLBACK').catch(()=>{});}
 });
}

async function readOperatorEvidence(env,now){
 const path=env.WIMBLO_PROCESS_EVIDENCE_FILE;
 if(!path||!isAbsolute(path))return null;
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||(info.mode&0o077)!==0)return null;
 if(await realpath(path)!==resolve(path))return null;
 const value=JSON.parse(await readFile(path,'utf8'));
 if(!env.WIMBLO_EVIDENCE_BINDING||value.environmentBinding!==env.WIMBLO_EVIDENCE_BINDING)return null;
 const observedAt=Date.parse(value.observedAt),backupAt=Date.parse(value.backup?.lastSuccessfulAt);
 if(!Number.isFinite(observedAt)||!Number.isFinite(backupAt))return null;
 return {
  processes:{valid:value.web?.running===true&&value.worker?.running===true,webHealthy:value.web?.healthy===true,workerHealthy:value.worker?.healthy===true,ageSeconds:Math.floor((now-observedAt)/1000)},
  backup:{valid:value.backup?.configured===true,configured:value.backup?.configured===true,privateConfirmed:value.backup?.privateConfirmed===true,ageSeconds:Math.floor((now-backupAt)/1000)}
 };
}

export async function collectProductionFoundationEvidence(env=process.env,{now=Date.now(),root=process.cwd()}={}){
 const evidence=invalidEvidence();let tenantPool,controlPool;
 try{
  const web=resolveSaasRuntimeConfig({...env,PROCESS_ROLE:'web'},root),worker=resolveSaasRuntimeConfig({...env,PROCESS_ROLE:'worker'},root);
  const tenantTarget=new URL(web.tenantDatabaseUrl),controlTarget=new URL(web.controlDatabaseUrl),sameTarget=tenantTarget.hostname===controlTarget.hostname&&tenantTarget.port===controlTarget.port&&tenantTarget.pathname===controlTarget.pathname;
  evidence.runtimeProfile={valid:web.mode==='saas'&&worker.mode==='saas'&&web.tenantDatabaseUrl===worker.tenantDatabaseUrl&&web.controlDatabaseUrl===worker.controlDatabaseUrl&&sameTarget};
  evidence.objectStorage={valid:web.objectStorage.provider==='s3'&&web.objectStorage.privateConfirmed===true&&web.backupStorage.privateConfirmed===true,privateConfirmed:web.objectStorage.privateConfirmed===true&&web.backupStorage.privateConfirmed===true};
  evidence.mfaKey={valid:true,distinctFromBackup:web.mfaEncryptionKey!==web.backupEncryptionKey};
  const operator=await readOperatorEvidence(env,now).catch(()=>null);
  if(operator){evidence.processes=operator.processes;evidence.backup=operator.backup;}
  tenantPool=poolFromEnv(env,{max:1,acquireAttempts:1,connectionTimeoutMs:3000,applicationName:'wimblo-readiness-tenant'});
  controlPool=controlPoolFromEnv(env,{max:1,acquireAttempts:1,connectionTimeoutMs:3000,applicationName:'wimblo-readiness-control'});
  const tenantRole=await readOnly(tenantPool,async session=>{
   const isolated=await assertRowLevelSecurityEffective(session);
   const {rows:[role]}=await session.query('SELECT current_user AS name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user');
   const {rows}=await session.query(`SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname='public' AND c.relname=ANY($1)) OR (n.nspname='wimblo_platform' AND c.relname=ANY($2))`,[TENANT_TABLES,TENANT_FOUNDATION_TABLES.map(table=>table.split('.')[1])]);
   const forced=rows.filter(row=>row.relrowsecurity&&row.relforcerowsecurity).length;
   evidence.rowLevelSecurity={valid:isolated.forced===true&&forced===TENANT_TABLES.length+TENANT_FOUNDATION_TABLES.length,forcedTables:forced,expectedTables:TENANT_TABLES.length+TENANT_FOUNDATION_TABLES.length};
   evidence.controlPrivileges={valid:isolated.controlPlaneTables===0&&isolated.tenantFunctions===1};
   return role;
  });
  const control=await readOnly(controlPool,async session=>{
   await assertControlPlaneRole(session);
   await assertSecurityDefinerOwnersBypassRls(session);
   const {rows:[role]}=await session.query('SELECT current_user AS name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user');
   const {rows}=await session.query('SELECT version,name,checksum FROM wimblo_schema_migrations ORDER BY version');
   evidence.schema={valid:true,currentVersion:rows.at(-1)?.version??0,targetVersion:SCHEMA_VERSION,ledgerValid:rows.length===MIGRATIONS.length&&rows.every((row,index)=>row.version===MIGRATIONS[index].version&&row.name===MIGRATIONS[index].name&&row.checksum===MIGRATIONS[index].checksum)};
   const dead=await session.query('SELECT wimblo_platform.dead_letter_count()::int AS count');
   evidence.deadLetters={valid:Number.isInteger(dead.rows[0]?.count),count:dead.rows[0]?.count};
   return role;
  });
  const safeRole=role=>role&&!role.rolsuper&&!role.rolbypassrls&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolreplication;
  evidence.runtimeRoles={valid:safeRole(tenantRole)&&safeRole(control),distinct:tenantRole?.name!==control?.name};
 }catch{
  // Each incomplete gate remains a fixed blocked result. Runtime errors are
  // deliberately not serialized because driver messages can contain hosts.
 }finally{
  await Promise.allSettled([controlPool?.end(),tenantPool?.end()]);
 }
 return evidence;
}

async function main(){
 const evidence=await collectProductionFoundationEvidence();
 const report=evaluateProductionFoundation(evidence);
 process.stdout.write(`${redactedReadinessJson(report)}\n`);
 process.exitCode=report.status==='Ready'?0:2;
}

const isMain=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url;
if(isMain)main().catch(()=>{process.stdout.write(`${redactedReadinessJson(evaluateProductionFoundation({}))}\n`);process.exitCode=1;});
