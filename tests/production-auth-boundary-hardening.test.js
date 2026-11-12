import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createProductionApp} from '../server/production/app.js';
import {resolveSaasRuntimeConfig} from '../server/production/runtimeConfig.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const findNode=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=findNode(child,predicate);if(found)return found;}return null;};

function signInHarness({loginResult={mfaEnrollmentRequired:true,csrfToken:'csrf'}}={}){
 let index=0,state=[],effects=[];
 const enrollment={secret:'ABCDEFGHIJKLMNOP234567',expiresAt:Date.parse('2026-11-11T12:05:00Z'),otpauthUrl:'otpauth://totp/Wimblo%3Afirst%40example.test?secret=ABCDEFGHIJKLMNOP234567&issuer=Wimblo&algorithm=SHA1&digits=6&period=30'};
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();},lazy(){return()=>null;}};
 const client={
  synthetic:false,restore:async()=>{throw Object.assign(new Error('signed out'),{status:401});},clear(){},subscribeSession:()=>()=>{},setCsrf(){},
  request:async path=>path==='/auth/login'?loginResult:path==='/auth/mfa/enroll'?enrollment:path==='/auth/mfa/confirm'?{enabled:true,recoveryCodes:['RECOVERY-CODE-ONE']} : Promise.reject(new Error(path))
 };
 const module={exports:{}},source=readFileSync(new URL('../src/production/ProductionApp.jsx',import.meta.url),'utf8'),code=transformSync(source,{loader:'jsx',format:'cjs'}).code;
 const require=id=>id==='react'?mock:id.endsWith('.css')?{}:id==='./productionApi.js'?{__esModule:true,productionApi:client}:{__esModule:true,default:()=>null};
 new Function('require','module','exports',code)(require,module,module.exports);
 const outer=()=>{index=0;effects=[];return module.exports.default({client});};
 const signIn=()=>{const shell=outer();return shell.type(shell.props);};
 async function passwordLogin(){
  outer();effects[0]();await flush();
  let tree=signIn(),inputs=[];
  const collect=node=>{if(!node||typeof node!=='object')return;if(node.type==='input')inputs.push(node);for(const child of React.Children.toArray(node.props?.children))collect(child);};collect(tree);
  inputs[0].props.onChange({target:{value:'first@example.test'}});inputs[1].props.onChange({target:{value:'correct password'}});
  tree=signIn();await findNode(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
  return signIn();
 }
 async function begin(){
  const tree=await passwordLogin();await findNode(tree,node=>node.type==='button').props.onClick();
  return signIn();
 }
 return {begin,passwordLogin,signIn,enrollment,state:()=>state,find:findNode};
}

test('first-login MFA renders accessible provisioning material and clears it on cancel',async()=>{
 const h=signInHarness(),tree=await h.begin(),html=renderToStaticMarkup(tree);
 const provisioning=findNode(tree,node=>node.type==='a'&&node.props.href===h.enrollment.otpauthUrl),manual=findNode(tree,node=>node.type==='input'&&node.props['aria-label']==='Manual setup key');
 assert.ok(provisioning);assert.match(provisioning.props['aria-label'],/authenticator/i);
 assert.ok(manual);assert.equal(manual.props.readOnly,true);assert.equal(manual.props.value,h.enrollment.secret);
 assert.match(html,/ABCDEFGHIJKLMNOP234567/);
 findNode(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).join('').includes('Start sign-in again')).props.onClick();
 assert.doesNotMatch(JSON.stringify(h.state()),/ABCDEFGHIJKLMNOP234567|otpauth:\/\//);
});

test('successful MFA confirmation removes provisioning material from component state',async()=>{
 const h=signInHarness();let tree=await h.begin();
 findNode(tree,node=>node.type==='input'&&node.props.autoComplete==='one-time-code').props.onChange({target:{value:'123456'}});
 tree=h.signIn();await findNode(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
 assert.match(renderToStaticMarkup(h.signIn()),/RECOVERY-CODE-ONE/);
 assert.doesNotMatch(JSON.stringify(h.state()),/ABCDEFGHIJKLMNOP234567|otpauth:\/\//);
});

test('existing-factor verification remains friendly to alphanumeric recovery codes',async()=>{
 const h=signInHarness({loginResult:{mfaRequired:true,challengeToken:'challenge-token'}}),tree=await h.passwordLogin(),input=findNode(tree,node=>node.type==='input'&&node.props.autoComplete==='one-time-code');
 assert.equal(input.props.maxLength,17);assert.equal(input.props.inputMode,undefined);
});

const pool=()=>({healthy:async()=>true});
const services=()=>({
 identityService:{authenticatePassword:async()=>{throw Object.assign(new Error('denied'),{status:401});},listActiveMemberships:async()=>[]},
 mfaService:{status:async()=>({enabled:false}),createChallenge:async()=>({}),verifyChallenge:async()=>({}),beginEnrollment:async()=>({}),confirmEnrollment:async()=>({})},
 sessionService:{cookieName:'wimblo_session',authenticate:async()=>null,verifyCsrf:()=>false,isRecent:()=>false,issue:async()=>({}),switchTenant:async()=>({}),logout:async()=>({cookie:''})},
 moduleService:{list:async()=>[],enable:async()=>({}),suspend:async()=>({}),beginRetirement:async()=>({}),disable:async()=>({}),authorize:async()=>({allowed:false,state:'disabled'})}
});
const appConfig=trustedProxyCidrs=>({
 processRole:'web',appOrigin:'https://crm.example.test',cookieName:'wimblo_session',mfaEncryptionKey:'11'.repeat(32),sessionSecret:'s'.repeat(40),
 network:{trustedProxyCidrs},limits:{trustProxyHops:1,dbPoolMax:4,jobConcurrency:2,jobLeaseMs:30_000}
});
async function listen(t,app,{remoteAddress,encrypted}={}){
 const server=remoteAddress||encrypted?createServer((req,res)=>{if(remoteAddress)Object.defineProperty(req.socket,'remoteAddress',{configurable:true,value:remoteAddress});if(encrypted)Object.defineProperty(req.socket,'encrypted',{configurable:true,value:true});app(req,res);}):app.listen(0,'127.0.0.1');
 if(remoteAddress||encrypted)server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;
}

test('HTTPS trust rejects a direct forwarded-proto spoof while preserving an explicitly trusted ingress',async t=>{
 const direct=createProductionApp({config:appConfig(['10.0.0.0/8']),controlPool:pool(),tenantPool:pool(),services:services()}),directBase=await listen(t,direct);
 assert.equal((await fetch(`${directBase}/health`,{headers:{'X-Forwarded-Proto':'https'}})).status,400);
 const ingress=createProductionApp({config:appConfig(['127.0.0.1/32']),controlPool:pool(),tenantPool:pool(),services:services()}),ingressBase=await listen(t,ingress);
 assert.equal((await fetch(`${ingressBase}/health`,{headers:{'X-Forwarded-Proto':'https'}})).status,200);
 for(const value of ['https,http','https, https'])assert.equal((await fetch(`${ingressBase}/health`,{headers:{'X-Forwarded-Proto':value}})).status,400);
});

test('an untrusted direct peer cannot rotate forwarded addresses around the login rate limit',async t=>{
 const app=createProductionApp({config:appConfig(['10.0.0.0/8']),controlPool:pool(),tenantPool:pool(),services:services()}),base=await listen(t,app,{remoteAddress:'203.0.113.10',encrypted:true});
 const statuses=[];
 for(let attempt=0;attempt<11;attempt++){
  const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'X-Forwarded-For':`198.51.100.${attempt+1}`,'Content-Type':'application/json'},body:'{"email":"first@example.test","password":"wrong"}'});statuses.push(response.status);
 }
 assert.deepEqual(statuses,[401,401,401,401,401,401,401,401,401,401,429]);
});

const validEnv=()=>({
 NODE_ENV:'production',WIMBLO_RUNTIME:'saas',PROCESS_ROLE:'web',APP_ORIGIN:'https://app.wimblo.example',
 DATABASE_URL:'postgresql://wimblo_tenant_app:tenant-password@db.example.test/wimblo?sslmode=require',CONTROL_DATABASE_URL:'postgresql://wimblo_control_app:control-password@db.example.test/wimblo?sslmode=verify-full',
 MFA_ENCRYPTION_KEY:'a'.repeat(64),SESSION_SECRET:'session-secret-with-at-least-thirty-two-characters',BACKUP_ENCRYPTION_KEY:'b'.repeat(64),
 DOCUMENT_STORAGE_PROVIDER:'s3',DOCUMENT_STORAGE_BUCKET:'wimblo-production-private',DOCUMENT_STORAGE_NAMESPACE:'production',DOCUMENT_STORAGE_PRIVATE_CONFIRMED:'true',
 BACKUP_STORAGE_BUCKET:'wimblo-production-backups',BACKUP_STORAGE_NAMESPACE:'production-backups',BACKUP_STORAGE_PRIVATE_CONFIRMED:'true',AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'SYNTHETIC_TEST_ACCESS',AWS_SECRET_ACCESS_KEY:'SYNTHETIC_TEST_SECRET',
 TRUSTED_PROXY_CIDRS:'10.0.0.0/8,2001:db8:1234::/48',TRUST_PROXY_HOPS:'3',DB_POOL_MAX:'10',JOB_CONCURRENCY:'4',JOB_LEASE_MS:'30000',PORT:'3000'
});

test('SaaS runtime requires a bounded explicit trusted-proxy IP or CIDR allowlist',()=>{
 const resolved=resolveSaasRuntimeConfig(validEnv(),'/srv/wimblo');
 assert.deepEqual(resolved.network,{trustedProxyCidrs:['10.0.0.0/8','2001:db8:1234::/48']});
 assert.equal(Object.hasOwn(resolved.limits,'trustProxyHops'),false);
 const missing=validEnv();delete missing.TRUSTED_PROXY_CIDRS;
 assert.throws(()=>resolveSaasRuntimeConfig(missing,'/srv/wimblo'),/TRUSTED_PROXY_CIDRS/);
 for(const value of ['0.0.0.0/0','::/0','10.0.0.0/33','10.0.0.0/8,,192.0.2.1','not-an-ip'])assert.throws(()=>resolveSaasRuntimeConfig({...validEnv(),TRUSTED_PROXY_CIDRS:value},'/srv/wimblo'),/TRUSTED_PROXY_CIDRS/);
});

test('the non-HTTP worker does not require a web-ingress proxy allowlist',()=>{
 const env={...validEnv(),PROCESS_ROLE:'worker'};delete env.TRUSTED_PROXY_CIDRS;
 assert.deepEqual(resolveSaasRuntimeConfig(env,'/srv/wimblo').network,{trustedProxyCidrs:[]});
});
