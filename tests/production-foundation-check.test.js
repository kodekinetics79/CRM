import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProductionFoundation,redactedReadinessJson} from '../scripts/production-foundation-check.mjs';

const passEvidence=()=>({
 runtimeProfile:{valid:true},runtimeRoles:{valid:true,distinct:true},schema:{valid:true,currentVersion:14,targetVersion:14,ledgerValid:true},
 rowLevelSecurity:{valid:true,forcedTables:24,expectedTables:24},controlPrivileges:{valid:true},objectStorage:{valid:true,privateConfirmed:true},
 mfaKey:{valid:true,distinctFromBackup:true},processes:{valid:true,webHealthy:true,workerHealthy:true,ageSeconds:30},
 deadLetters:{valid:true,count:0},backup:{valid:true,configured:true,privateConfirmed:true,ageSeconds:3600}
});

test('readiness evaluation has fixed gates and passes only complete current evidence',()=>{
 const report=evaluateProductionFoundation(passEvidence(),{expectedSchemaVersion:14,scope:'production-runtime'});
 assert.equal(report.status,'Ready');
 assert.deepEqual(report.gates.map(gate=>gate.id),[
  'runtime-profile','runtime-roles','schema-version','forced-rls','control-privileges','private-object-storage','mfa-key','web-worker-processes','dead-letters','backup-configuration'
 ]);
 assert.ok(report.gates.every(gate=>gate.status==='Pass'));
});

test('every missing or unsafe production gate blocks with a fixed reason code',()=>{
 const cases=[
  ['runtimeProfile','RUNTIME_PROFILE_INVALID'],['runtimeRoles','RUNTIME_ROLES_INVALID'],['schema','SCHEMA_VERSION_INVALID'],
  ['rowLevelSecurity','FORCED_RLS_INVALID'],['controlPrivileges','CONTROL_PRIVILEGES_INVALID'],['objectStorage','PRIVATE_STORAGE_INVALID'],
  ['mfaKey','MFA_KEY_INVALID'],['processes','PROCESS_EVIDENCE_INVALID'],['deadLetters','DEAD_LETTERS_PRESENT'],['backup','BACKUP_CONFIGURATION_INVALID']
 ];
 for(const [key,reason] of cases){
  const evidence=passEvidence();evidence[key]={valid:false,count:key==='deadLetters'?1:undefined};
  const report=evaluateProductionFoundation(evidence,{expectedSchemaVersion:14});
  assert.equal(report.status,'Blocked',key);
  assert.ok(report.gates.some(gate=>gate.reason===reason),key);
 }
});

test('schema, process freshness, dead letters and key separation fail closed',()=>{
 for(const mutate of [
  evidence=>{evidence.schema.currentVersion=10;},
  evidence=>{evidence.processes.ageSeconds=301;},
  evidence=>{evidence.deadLetters.count=1;},
  evidence=>{evidence.mfaKey.distinctFromBackup=false;}
 ]){
  const evidence=passEvidence();mutate(evidence);
  assert.equal(evaluateProductionFoundation(evidence,{expectedSchemaVersion:14}).status,'Blocked');
 }
});

test('serialized readiness output cannot disclose credentials, URLs or operator metadata',()=>{
 const evidence=passEvidence();
 Object.assign(evidence,{databaseUrl:'postgres://secret@example.test/prod',bucket:'customer-private',roleName:'wimblo_control',errorMessage:'password=hunter2'});
 const json=redactedReadinessJson(evaluateProductionFoundation(evidence,{expectedSchemaVersion:14,scope:'local-foundation'}));
 assert.doesNotMatch(json,/secret|example\.test|customer-private|wimblo_control|hunter2|postgres:/i);
 assert.deepEqual(Object.keys(JSON.parse(json)),['scope','status','gates']);
});
