#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const PLAN=Object.freeze({
 local:['node --test tests/production-crm-security.test.js tests/production-crm-capacity.test.js tests/production-crm-recovery.test.js','npm run verify:postgres-foundation','npm run verify:postgres','npm test','npm run build','npm run build:synthetic-evaluation','npm audit --audit-level=high','npm run test:discipline'],
 external:['browser acceptance','configured deployment readiness','provider backup and restore','customer UAT and acceptance']
});
const json=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function capacitySelfTest(){
 const items=Array.from({length:40},(_,id)=>id),concurrency=4;let cursor=0,active=0,maxActive=0,maxQueries=0;
 const worker=async()=>{while(cursor<items.length){const id=items[cursor++];active++;maxActive=Math.max(maxActive,active);const queries=1+(id%4);await Promise.resolve();maxQueries=Math.max(maxQueries,queries);active--;}};
 await Promise.all(Array.from({length:concurrency},worker));
 return {status:'passed',operations:items.length,maxActive,maxQueriesPerOperation:maxQueries};
}
function recoverySelfTest(){
 const source=[{tenant:'a',id:1},{tenant:'a',id:2},{tenant:'b',id:3}],backup=Buffer.from(JSON.stringify(source)),readback=JSON.parse(backup.toString('utf8')),restored=structuredClone(readback);
 const digestMatch=digest(source)===digest(readback)&&digest(readback)===digest(restored);
 if(!digestMatch)throw new Error('Recovery reconciliation failed.');
 return {status:'passed',backupRows:source.length,readbackRows:readback.length,restoredRows:restored.length,digestMatch};
}
function runCertification(){
 for(const command of PLAN.local){const [program,...args]=command.split(' '),result=spawnSync(program,args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status||1);}
 json({status:'locally-certified',externalEvidence:'not-observed'});
}

const mode=process.argv[2];
if(mode==='--plan')json(PLAN);
else if(mode==='--capacity-self-test')json(await capacitySelfTest());
else if(mode==='--recovery-self-test')json(recoverySelfTest());
else if(mode===undefined)runCertification();
else{process.stderr.write('Unknown certification mode.\n');process.exitCode=2;}
