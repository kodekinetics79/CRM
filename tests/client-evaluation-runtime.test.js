import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('hosted client evaluation is HTTPS-only, synthetic and reset on restart',async t=>{
 const evaluationRoot=mkdtempSync(join(tmpdir(),'wimblo-client-evaluation-test-'));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const origin='https://evaluation.example.test';let child,startupOutput='';
 const env={...process.env,NODE_ENV:'evaluation',CLIENT_EVALUATION_MODE:'true',CLIENT_EVALUATION_DATA_DIR:evaluationRoot,EVALUATOR_MODE:'false',APP_ORIGIN:origin,TRUST_PROXY:'true',ALLOW_DEMO:'true',ENABLE_ACCEPTANCE:'true',PORT:String(port),DOCUMENT_STORAGE_PROVIDER:'sqlite'};
 async function start(){
  child=spawn(process.execPath,['server/index.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Client evaluation startup timed out: '+output)),30000);const inspect=chunk=>{output+=String(chunk);if(output.includes(`http://0.0.0.0:${port}`)){clearTimeout(timer);ok();}};child.stdout.on('data',inspect);child.stderr.on('data',inspect);child.once('exit',code=>{clearTimeout(timer);no(Error(`Client evaluation exited with ${code}: ${output}`));});child.once('error',error=>{clearTimeout(timer);no(error);});});startupOutput=output;
 }
 async function stop(){const exited=once(child,'exit');child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0);child=null;}
 async function request(path,{method='GET',body,session,secure=true}={}){
  const headers={Origin:origin,...(secure?{'X-Forwarded-Proto':'https'}:{}),...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}: {})};
  const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=text;}return {status:response.status,json,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),setCookie:response.headers.get('set-cookie')||''};
 }
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(evaluationRoot,{recursive:true,force:true});});

 await start();
 assert.equal((await request('/')).status,200);
 assert.equal((await request('/api/config',{secure:false})).status,403);
 assert.match(startupOutput,/client evaluator/i);
 const config=await request('/api/config');assert.equal(config.status,200);assert.deepEqual({demoAccess:config.json.demoAccess,acceptanceEnabled:config.json.acceptanceEnabled,clientEvaluation:config.json.clientEvaluation},{demoAccess:true,acceptanceEnabled:true,clientEvaluation:true});
 const health=await request('/api/health');assert.equal(health.status,200);assert.equal(health.json.mode,'client-evaluation');
 const login=await request('/api/auth/login',{method:'POST',body:{email:'alex@foundation.example',password:'FoundationDemo!2026'}});assert.equal(login.status,200,JSON.stringify(login.json));assert.match(login.setCookie,/; Secure/i);
 const session={cookie:login.cookie,csrf:login.json.csrfToken};
 const created=await request('/api/records/constituents',{method:'POST',session,body:{name:'Temporary evaluator record',email:'temporary@example.test',type:'Individual'}});assert.equal(created.status,201,JSON.stringify(created.json));const id=created.json.record.id;
 await stop();await start();
 const nextLogin=await request('/api/auth/login',{method:'POST',body:{email:'alex@foundation.example',password:'FoundationDemo!2026'}});const workspace=await request('/api/workspace',{session:{cookie:nextLogin.cookie,csrf:nextLogin.json.csrfToken}});assert.equal(workspace.status,200);assert.equal(workspace.json.data.constituents.some(record=>record.id===id),false);
 await stop();
});
