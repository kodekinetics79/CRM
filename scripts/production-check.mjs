import {DatabaseSync} from 'node:sqlite';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {inspectProductionReadiness,createHealthMonitoringProbe} from '../server/productionReadiness.js';
import {createObjectStorageFromEnv} from '../server/objectStorage.js';

const help='Usage: node scripts/production-check.mjs --db ABSOLUTE_WORKSPACE --root ABSOLUTE_PERSISTENT_MOUNT --tenant ORIGINAL_UUID [--evidence PRIVATE_JSON]\nReads the database without modification. Outputs safe check details, never configuration values.\nOperational evidence must come from actual encrypted readback, restore, monitoring and retention approval; configuration alone cannot pass.';
async function main(){
 const args=process.argv.slice(2);if(args.length===0||args[0]==='--help'){console.log(help);return;}
 if(args.length%2)throw Error('Invalid arguments.');const opts={};
 for(let i=0;i<args.length;i+=2){if(!['--db','--root','--evidence','--tenant'].includes(args[i])||opts[args[i]]||!(args[i]==='--tenant'?/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args[i+1]||''):isAbsolute(args[i+1]||'')))throw Error('Absolute paths, a tenant UUID and nonduplicate known arguments are required.');opts[args[i]]=args[i+1];}
 if(!opts['--db']||!opts['--root']||!opts['--tenant'])throw Error('Database, persistent root and original tenant UUID are required.');
 let recoveryEvidence={};
 if(opts['--evidence']){const info=await lstat(opts['--evidence']);if(!info.isFile()||info.isSymbolicLink()||info.size>65536||(info.mode&0o077))throw Error('Operational evidence must be a small private regular file.');recoveryEvidence=JSON.parse(await readFile(opts['--evidence'],'utf8'));}
 const db=new DatabaseSync(opts['--db'],{readOnly:true});
 try{let objectStorage;try{objectStorage=createObjectStorageFromEnv();}catch{objectStorage={verifyReadiness:async()=>({verified:false})};}
  const monitoring=createHealthMonitoringProbe({origin:process.env.APP_ORIGIN,alertDrill:recoveryEvidence.monitoring?.alertDrill});
  const result=await inspectProductionReadiness({db,dbPath:opts['--db'],durableRoot:opts['--root'],expectedTenantId:opts['--tenant'],objectStorage,recoveryEvidence,monitoring});console.log(JSON.stringify(result,null,2));process.exitCode=result.ready?0:2;
 }finally{db.close();}
}
main().catch(()=>{console.error('Production check failed. Verify private evidence, existing database and mount; no credentials were printed and no database was modified.');process.exitCode=1;});
