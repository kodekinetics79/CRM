import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import express from 'express';
import {createPlatformApp} from '../server/platform.js';
import {createApp} from '../server/app.js';
const secret='synthetic-marketing-platform-signing-fixture';
const signature=(raw,t=Math.floor(Date.now()/1000))=>'t='+t+',v1='+createHmac('sha256',secret).update(String(t)+'.').update(raw).digest('hex');
const administrator={name:'Synthetic platform callback reviewer',email:'platform.callback@example.test',password:'PlatformCallbackOnly!2026'};
const tenantAdmin={name:'Synthetic tenant reviewer',email:'tenant.callback@example.test',password:'TenantCallbackOnly!2026'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-callback-platform-')),accepted=[];
 // This wrapper isolates the platform dispatch layer. Marketing member/event
 // validation is exercised separately against the real marketing response service.
 const app=createPlatformApp({rootDir:join(dir,'registry'),legacyDbPath:join(dir,'legacy.sqlite'),initialPlatformAdmin:administrator,tenantFactory:args=>{
  const native=createApp({...args,reminderWorker:false,workflowWorker:false}),child=express();
  child.post('/api/marketing-responses/webhook',express.raw({type:'application/x-www-form-urlencoded',limit:'256kb'}),(req,res)=>{try{
   const m=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(req.get('X-Mailchimp-Signature')||'');if(!m||Math.abs(Date.now()/1000-Number(m[1]))>300)throw Error('Signature');
   const expected=createHmac('sha256',secret).update(m[1]+'.').update(req.body).digest();if(!timingSafeEqual(expected,Buffer.from(m[2],'hex')))throw Error('Signature');
   const data=new URLSearchParams(req.body.toString());if(data.get('data[list_id]')!==args.tenantId)return res.status(400).json({error:'Fixture workspace binding denied'});
   accepted.push({tenantId:args.tenantId,bytes:req.body.toString(),id:data.get('data[id]')});res.json({accepted:true});
  }catch{return res.status(400).json({error:'Fixture signature denied'});}});
  child.use(native);Object.assign(child.locals,native.locals);return child;
 }});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 async function request(path,{method='GET',body,session,headers={}}={}){const r=await fetch(base+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});return{status:r.status,json:await r.json(),headers:r.headers};}
 const login=await request('/api/platform/auth/login',{method:'POST',body:{email:administrator.email,password:administrator.password}});assert.equal(login.status,200);const operator={...login.json,cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
 async function create(slug){const r=await request('/api/platform/tenants',{method:'POST',session:operator,body:{slug,name:'Synthetic '+slug,plan:'trial',dataMode:'synthetic',admin:tenantAdmin}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.tenant;}
 const alpha=await create('callback-alpha'),beta=await create('callback-beta');
 function payload(tenantId,id='synthetic'+randomUUID().replaceAll('-','')){return 'type=unsubscribe&fired_at=2026-09-13+12%3A00%3A00&data%5Blist_id%5D='+tenantId+'&data%5Bid%5D='+id+'&data%5Bemail%5D=synthetic%2Bencoded%40example.test';}
 async function callback(tenant,raw=payload(tenant.id),changes={}){return request('/api/marketing-responses/webhook/'+tenant.id,{method:'POST',body:raw,headers:{'Content-Type':'application/x-www-form-urlencoded','X-Mailchimp-Signature':signature(raw),...changes}});}
 return{app,request,operator,alpha,beta,payload,callback,accepted,dir};
}
test('platform preserves exact signed callback bytes and routes by bound tenant without business cookies',async t=>{
 const f=await fixture(t),raw=f.payload(f.alpha.id);
 const login=await f.request('/api/auth/login',{method:'POST',body:{email:tenantAdmin.email,password:tenantAdmin.password,tenantSlug:f.beta.slug}});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 assert.equal((await f.callback(f.alpha,raw,{Cookie:cookie})).status,200);assert.deepEqual(f.accepted,[{tenantId:f.alpha.id,bytes:raw,id:new URLSearchParams(raw).get('data[id]')}]);assert.equal((await f.callback(f.beta,raw)).status,400);assert.equal(f.accepted.length,1);
 assert.equal((await f.request('/api/workspace')).status,401);assert.equal((await f.request('/api/platform/tenants')).status,401);
 const tenantSession={...login.json,cookie};const workspace=await f.request('/api/workspace',{session:tenantSession});assert.equal(workspace.status,200);assert.equal(workspace.json.data.gifts.length,0);assert.equal(workspace.json.tenant.slug,f.beta.slug);
});
test('platform callback denies unscoped routes, forged signatures, browser origins, oversized bodies and suspended/missing workspaces',async t=>{
 const f=await fixture(t),raw=f.payload(f.alpha.id);
 assert.equal((await f.request('/api/marketing-responses/webhook',{method:'POST',body:raw})).status,404);
 assert.equal((await f.callback(f.alpha,raw,{'X-Mailchimp-Signature':'t=1,v1=not-valid'})).status,400);
 assert.equal((await f.callback(f.alpha,raw,{Origin:'https://synthetic.example.test'})).status,403);
 assert.equal((await f.callback(f.alpha,' '.repeat(256*1024+1))).status,413);
 assert.equal((await f.callback({id:'not-a-uuid'},raw)).status,400);
 assert.equal((await f.callback({id:randomUUID()},raw)).status,503);
 const suspend=await f.request('/api/platform/tenants/'+f.alpha.id,{method:'PATCH',session:f.operator,body:{version:f.alpha.version,status:'suspended'}});assert.equal(suspend.status,200);
 assert.equal((await f.callback(f.alpha,raw)).status,503);assert.equal(f.accepted.length,0);
 await rm(join(f.dir,'registry','tenants',f.beta.id,'workspace.sqlite'));
 assert.equal((await f.callback(f.beta,f.payload(f.beta.id))).status,503);assert.equal(f.accepted.length,0);
});
