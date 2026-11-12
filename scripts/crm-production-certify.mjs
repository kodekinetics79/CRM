#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {redactCertificationDiagnostic} from './certification-redaction.mjs';

const PLAN=Object.freeze({
 local:['node --test tests/production-crm-security.test.js tests/production-crm-capacity.test.js tests/production-crm-recovery.test.js','npm run verify:postgres-foundation','npm run verify:postgres','npm test','npm run build','npm run build:synthetic-evaluation','npm audit --audit-level=high','npm run test:discipline'],
 external:['browser acceptance','configured deployment readiness','provider backup and restore','customer UAT and acceptance']
});
const json=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function recoverySelfTest(){
 const source=[{tenant:'a',id:1},{tenant:'a',id:2},{tenant:'b',id:3}],backup=Buffer.from(JSON.stringify(source)),readback=JSON.parse(backup.toString('utf8')),restored=structuredClone(readback);
 const digestMatch=digest(source)===digest(readback)&&digest(readback)===digest(restored);
 if(!digestMatch)throw new Error('Recovery reconciliation failed.');
 return {status:'passed',backupRows:source.length,readbackRows:readback.length,restoredRows:restored.length,digestMatch};
}
function runCommand(command){
 const [program,...args]=command.split(' '),result=spawnSync(program,args,{encoding:'utf8',env:process.env,maxBuffer:64*1024*1024});
 if(result.stdout)process.stdout.write(redactCertificationDiagnostic(result.stdout));
 if(result.stderr)process.stderr.write(redactCertificationDiagnostic(result.stderr));
 if(result.error)process.stderr.write(`${redactCertificationDiagnostic(result.error.message)}\n`);
 return result.status??1;
}
function runCertification(){
 for(const command of PLAN.local){const status=runCommand(command);if(status!==0)process.exit(status);}
 json({status:'locally-certified',externalEvidence:'not-observed'});
}

const mode=process.argv[2];
if(mode==='--plan')json(PLAN);
else if(mode==='--recovery-self-test')json(recoverySelfTest());
else if(mode==='--verify-postgres')process.exitCode=runCommand('npm run verify:postgres');
else if(mode===undefined)runCertification();
else{process.stderr.write('Unknown certification mode.\n');process.exitCode=2;}
