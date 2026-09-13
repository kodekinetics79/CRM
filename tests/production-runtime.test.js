import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,realpathSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {totp} from '../server/mfa.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('real production entrypoint preserves authorized data and enrolled MFA across graceful restart',async t=>{
 const data=realpathSync(mkdtempSync(join(tmpdir(),'wimblo-production-')));let child;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(data,{recursive:true,force:true});});
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const password='Fixture-'+randomBytes(20).toString('hex')+'!';
 const env={...process.env,NODE_ENV:'production',APP_HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:'https://production-fixture.example.test',TRUST_PROXY:'true',PERSISTENT_DATA_DIR:data,PERSISTENT_STORAGE_CONFIRMED:'true',DB_PATH:join(data,'workspace.sqlite'),PLATFORM_DATA_DIR:join(data,'platform'),ADMIN_EMAIL:'runtime@example.test',ADMIN_NAME:'Runtime fixture',ADMIN_PASSWORD:password,PLATFORM_ADMIN_EMAIL:'platform-runtime@example.test',PLATFORM_ADMIN_NAME:'Platform runtime fixture',PLATFORM_ADMIN_PASSWORD:password,MFA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ALLOW_DEMO:'false',EVALUATOR_MODE:'false',ENABLE_ACCEPTANCE:'false',DOCUMENT_STORAGE_PROVIDER:'sqlite'};
 async function start(){child=spawn(process.execPath,['server/index.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Production runtime startup timed out')),15000);child.stdout.on('data',chunk=>{if(String(chunk).includes('Wimblo application:')){clearTimeout(timer);ok();}});child.once('exit',()=>{clearTimeout(timer);no(Error('Production runtime exited before startup'));});child.once('error',e=>{clearTimeout(timer);no(e);});});}
 async function stop(){const exited=once(child,'exit');child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0);}
 async function request(path,{method='GET',body,session,secure=true,origin=env.APP_ORIGIN}={}){
  const headers={Origin:origin,...(secure?{'X-Forwarded-Proto':'https'}:{}),...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}: {})};
  const response=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  const json=await response.json();return {status:response.status,json,cookie:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 }
 await start();assert.equal(statSync(env.DB_PATH).mode&0o077,0);assert.equal(statSync(join(env.PLATFORM_DATA_DIR,'platform.sqlite')).mode&0o077,0);assert.equal((await request('/health')).status,200);assert.notEqual((await request('/health',{secure:false})).status,200);
 const login=await request('/auth/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password}});assert.equal(login.status,200);assert.equal(login.json.mfaEnrollmentRequired,true);
 const bootstrap={cookie:login.cookie,csrf:login.json.csrfToken};assert.equal((await request('/workspace',{session:bootstrap})).status,403);
 const pending=await request('/auth/mfa/enroll',{method:'POST',body:{password},session:bootstrap});assert.equal(pending.status,200);
 const confirm=await request('/auth/mfa/confirm',{method:'POST',body:{code:totp(pending.json.secret,Date.now())},session:bootstrap});assert.equal(confirm.status,200);assert.equal((await request('/auth/me',{session:bootstrap})).status,401);
 async function authenticate(recoveryCode){const challenge=await request('/auth/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password}});assert.equal(challenge.json.mfaRequired,true);const verified=await request('/auth/mfa/verify',{method:'POST',body:{challengeToken:challenge.json.challengeToken,code:recoveryCode}});assert.equal(verified.status,200);return {cookie:verified.cookie,csrf:verified.json.csrfToken};}
 const session=await authenticate(confirm.json.recoveryCodes[0]);
 const created=await request('/records/constituents',{method:'POST',body:{name:'Synthetic restart proof',type:'Individual',email:'restart-proof@example.test'},session});assert.equal(created.status,201);const id=created.json.record.id;
 assert.equal((await request('/records/constituents/'+id,{method:'PATCH',body:{version:1,name:'Blocked origin'},session,origin:'https://untrusted.example.test'})).status,403);
 await stop();delete env.ADMIN_PASSWORD;delete env.PLATFORM_ADMIN_PASSWORD;await start();
 const restoredSession=await authenticate(confirm.json.recoveryCodes[1]);const workspace=await request('/workspace',{session:restoredSession});assert.equal(workspace.status,200);assert.ok(workspace.json.data.constituents.some(c=>c.id===id&&c.name==='Synthetic restart proof'));
 const replay=await request('/auth/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password}});assert.equal((await request('/auth/mfa/verify',{method:'POST',body:{challengeToken:replay.json.challengeToken,code:confirm.json.recoveryCodes[0]}})).status,401);
 await stop();
});
