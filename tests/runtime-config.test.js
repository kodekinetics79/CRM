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

test('hosted client evaluation is explicit, HTTPS-only, resettable and never production',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wimblo-runtime-')));
 const evaluationRoot=join(tmpdir(),'wimblo-client-evaluation-test');
 const env={NODE_ENV:'evaluation',CLIENT_EVALUATION_MODE:'true',APP_ORIGIN:'https://evaluation.example.test',TRUST_PROXY:'true',ALLOW_DEMO:'true',ENABLE_ACCEPTANCE:'true',CLIENT_EVALUATION_DATA_DIR:evaluationRoot};
 try{
  for(const key of ['APP_ORIGIN','TRUST_PROXY','ALLOW_DEMO','ENABLE_ACCEPTANCE'])assert.throws(()=>resolveRuntimeConfig({...env,[key]:undefined},root),/client evaluation/i);
  assert.throws(()=>resolveRuntimeConfig({...env,APP_ORIGIN:'http://evaluation.example.test'},root),/client evaluation/i);
  assert.throws(()=>resolveRuntimeConfig({...env,CLIENT_EVALUATION_DATA_DIR:join(root,'other')},root),/client evaluation/i);
  assert.throws(()=>resolveRuntimeConfig({...env,CLIENT_EVALUATION_DATA_DIR:join(root,'wimblo-client-evaluation-nested')},root),/client evaluation/i);
  assert.throws(()=>resolveRuntimeConfig({...env,NODE_ENV:'production'},root),/client evaluation/i);
  const config=resolveRuntimeConfig(env,root);
  assert.equal(config.clientEvaluation,true);
  assert.equal(config.production,false);
  assert.equal(config.evaluator,false);
  assert.equal(config.host,'0.0.0.0');
  assert.equal(config.built,true);
  assert.equal(config.evaluationRoot,evaluationRoot);
  assert.equal(config.dbPath,join(evaluationRoot,'workspace.sqlite'));
  assert.equal(config.platformRoot,join(evaluationRoot,'platform'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
