import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveRuntimeConfig} from '../server/runtimeConfig.js';

test('production refuses ephemeral deployment before database creation',()=>{
 const root=mkdtempSync(join(tmpdir(),'wimblo-runtime-'));
 try{assert.throws(()=>resolveRuntimeConfig({NODE_ENV:'production',APP_ORIGIN:'https://wimblo.example'},root),/persistent mount/);assert.deepEqual(readdirSync(root),[]);}finally{rmSync(root,{recursive:true,force:true});}
});
test('production rejects paths outside mount, symlink escapes, duplicate keys and demo mode',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wimblo-runtime-'))),outside=realpathSync(mkdtempSync(join(tmpdir(),'wimblo-outside-')));
 const env={NODE_ENV:'production',APP_ORIGIN:'https://wimblo.example',PERSISTENT_DATA_DIR:root,PERSISTENT_STORAGE_CONFIRMED:'true',DB_PATH:join(root,'workspace.sqlite'),PLATFORM_DATA_DIR:join(root,'platform'),MFA_ENCRYPTION_KEY:'a'.repeat(64),BACKUP_ENCRYPTION_KEY:'b'.repeat(64)};
 try{
  assert.throws(()=>resolveRuntimeConfig({...env,DB_PATH:join(outside,'workspace.sqlite')},root),/inside/);
  symlinkSync(outside,join(root,'escape'));assert.throws(()=>resolveRuntimeConfig({...env,DB_PATH:join(root,'escape','workspace.sqlite')},root),/symbolic/);
  assert.throws(()=>resolveRuntimeConfig({...env,BACKUP_ENCRYPTION_KEY:env.MFA_ENCRYPTION_KEY},root),/distinct/);
  assert.throws(()=>resolveRuntimeConfig({...env,EVALUATOR_MODE:'true'},root),/demonstration/);
  const config=resolveRuntimeConfig(env,root);assert.equal(config.host,'0.0.0.0');assert.equal(config.dbPath,env.DB_PATH);assert.equal(readdirSync(root).some(p=>p.startsWith('.wimblo-write-')),false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('local evaluator stays isolated and validates port',()=>{
 assert.equal(resolveRuntimeConfig({EVALUATOR_MODE:'true'},'/tmp/project').host,'127.0.0.1');
 assert.throws(()=>resolveRuntimeConfig({PORT:'0'},'/tmp/project'),/PORT/);
});
