import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {existsSync,lstatSync,realpathSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {parseBackupKey} from './backup.js';

const fail=message=>{throw new Error(message);};
const contained=(root,path)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
function privatePath(root,path){
 if(!contained(root,path))fail('Production database and platform registry must be inside PERSISTENT_DATA_DIR.');
 let cursor=path;
 while(cursor!==root){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())fail('Production data paths cannot contain symbolic links.');cursor=dirname(cursor);}
}

// Validate storage BEFORE opening a database or creating an administrator. A
// process cannot prove a provider's mount persistence; explicit confirmation is
// additionally required and independently checked during deployment handover.
export function resolveRuntimeConfig(env,root){
 const production=env.NODE_ENV==='production',evaluator=env.EVALUATOR_MODE==='true',clientEvaluation=env.CLIENT_EVALUATION_MODE==='true';
 const port=Number(env.PORT||(evaluator?4321:4311));
 if(!Number.isInteger(port)||port<1||port>65535)fail('PORT must be an integer between 1 and 65535.');
 if(clientEvaluation){
  if(production||env.NODE_ENV!=='evaluation'||evaluator)fail('Client evaluation mode is isolated from production and the local evaluator.');
  let origin;try{origin=new URL(env.APP_ORIGIN);}catch{fail('Client evaluation requires an exact HTTPS APP_ORIGIN.');}
  if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN||origin.username||origin.password)fail('Client evaluation requires an exact HTTPS APP_ORIGIN.');
  if(env.TRUST_PROXY!=='true'||env.ALLOW_DEMO!=='true'||env.ENABLE_ACCEPTANCE!=='true')fail('Client evaluation requires trusted HTTPS proxying, demonstration data and acceptance tools.');
  if(!env.CLIENT_EVALUATION_DATA_DIR||!isAbsolute(env.CLIENT_EVALUATION_DATA_DIR))fail('Client evaluation requires an absolute temporary data directory.');
  const evaluationRoot=resolve(env.CLIENT_EVALUATION_DATA_DIR),temporaryRoots=[resolve(tmpdir()),realpathSync(tmpdir())];
  if(!temporaryRoots.includes(dirname(evaluationRoot))||!basename(evaluationRoot).startsWith('wimblo-client-evaluation'))fail('Client evaluation data must use a direct, scoped wimblo-client-evaluation directory inside the system temporary directory.');
  const dbPath=resolve(evaluationRoot,'workspace.sqlite'),platformRoot=resolve(evaluationRoot,'platform');
  return {production:false,evaluator:false,clientEvaluation:true,port,host:'0.0.0.0',built:true,dbPath,platformRoot,durableRoot:null,evaluationRoot};
 }
 if(production&&(evaluator||env.ALLOW_DEMO==='true'||env.ENABLE_ACCEPTANCE==='true'))fail('Production cannot enable evaluator mode, acceptance tools or demonstration data.');
 const dbPath=env.DB_PATH||resolve(root,evaluator?'server/data/evaluator.sqlite':'server/data/foundation.sqlite');
 const platformRoot=env.PLATFORM_DATA_DIR||resolve(dirname(dbPath),basename(dbPath,'.sqlite')+'-platform');
 if(production){
  let origin;try{origin=new URL(env.APP_ORIGIN);}catch{fail('Production requires an exact HTTPS APP_ORIGIN.');}
  if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN||origin.username||origin.password)fail('Production requires an exact HTTPS APP_ORIGIN.');
  if(env.PERSISTENT_STORAGE_CONFIRMED!=='true'||!env.PERSISTENT_DATA_DIR||!isAbsolute(env.PERSISTENT_DATA_DIR))fail('Production requires a verified persistent mount and explicit PERSISTENT_DATA_DIR. Free ephemeral hosting is unsupported.');
  if(!isAbsolute(dbPath)||!isAbsolute(platformRoot)||dbPath===':memory:')fail('Production requires absolute persistent database and platform paths.');
  const durableRoot=resolve(env.PERSISTENT_DATA_DIR);
  if(!existsSync(durableRoot)||!lstatSync(durableRoot).isDirectory()||lstatSync(durableRoot).isSymbolicLink()||realpathSync(durableRoot)!==durableRoot)fail('Production persistent mount must already exist and cannot be a symbolic link.');
  privatePath(durableRoot,resolve(dbPath));privatePath(durableRoot,resolve(platformRoot));
  let mfa,backup;try{mfa=parseBackupKey(env.MFA_ENCRYPTION_KEY);backup=parseBackupKey(env.BACKUP_ENCRYPTION_KEY);if(mfa.equals(backup))fail('Production MFA and backup encryption keys must be distinct.');}finally{mfa?.fill(0);backup?.fill(0);}
  mkdirSync(dirname(dbPath),{recursive:true,mode:0o700});mkdirSync(platformRoot,{recursive:true,mode:0o700});
  const probe=resolve(durableRoot,'.wimblo-write-'+randomUUID());let fd;
  try{fd=openSync(probe,'wx',0o600);writeSync(fd,'Wimblo persistence write probe');fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);if(existsSync(probe))unlinkSync(probe);}
 }
 return {production,evaluator,clientEvaluation:false,port,host:evaluator?'127.0.0.1':env.APP_HOST||(production?'0.0.0.0':'127.0.0.1'),built:production||evaluator,dbPath,platformRoot,durableRoot:production?resolve(env.PERSISTENT_DATA_DIR):null,evaluationRoot:null};
}
