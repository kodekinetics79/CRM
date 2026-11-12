import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProductionFoundation} from '../scripts/production-foundation-check.mjs';

const evidence=ageSeconds=>({
 runtimeProfile:{valid:true},runtimeRoles:{valid:true,distinct:true},schema:{valid:true,currentVersion:17,targetVersion:17,ledgerValid:true},
 rowLevelSecurity:{valid:true,forcedTables:35,expectedTables:35},controlPrivileges:{valid:true},objectStorage:{valid:true,privateConfirmed:true},
 mfaKey:{valid:true,distinctFromBackup:true},processes:{valid:true,webHealthy:true,workerHealthy:true,ageSeconds:30},
 deadLetters:{valid:true,count:0},backup:{valid:true,configured:true,privateConfirmed:true,ageSeconds}
});

test('backup readiness accepts the documented 24-hour RPO boundary and refuses one second older',()=>{
 const boundary=24*60*60;
 assert.equal(evaluateProductionFoundation(evidence(boundary),{expectedSchemaVersion:17}).status,'Ready');
 const stale=evaluateProductionFoundation(evidence(boundary+1),{expectedSchemaVersion:17});
 assert.equal(stale.status,'Blocked');
 assert.equal(stale.gates.find(gate=>gate.id==='backup-configuration').reason,'BACKUP_CONFIGURATION_INVALID');
});
