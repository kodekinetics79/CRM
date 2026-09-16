import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

// Separation of duties is an explicitly enabled control, never a silent new
// obligation: nothing in the RFP or the public Q&A requires a second approver for
// a void. These tests hold both halves of that decision — the default path must be
// byte-for-byte today's behaviour, and the enabled path must actually gate the
// real financial endpoint rather than only the module API.
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-duty-route-'));
 let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:''});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';
  if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrfToken;}
  const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,json:await r.json().catch(()=>({}))};
 }
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(r.status,200,'login '+email);
  return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
 }
 const admin=await login(),staff=await login('staff@foundation.example');
 const workspace=await request('/workspace',{session:admin});
 const gifts=workspace.json.data.gifts.filter(g=>g.status==='Posted');
 assert.ok(gifts.length>=2,'seeded posted gifts are required for this test');
 return {request,login,admin,staff,gifts,
  policy:async key=>{const r=await request('/tenant-administration/duty-policies',{session:admin});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.duties.find(p=>p.duty===key);},
  secondAdmin:async()=>{const r=await request('/users',{method:'POST',session:admin,body:{name:'Second administrator',email:'second.admin@foundation.example',password:'SyntheticApprover!2026',role:'admin'}});assert.equal(r.status,201,JSON.stringify(r.json));return login('second.admin@foundation.example','SyntheticApprover!2026');}};
}

test('by default a void behaves exactly as before: no approval is required or requested',async t=>{
 const f=await fixture(t),gift=f.gifts[0];
 const voided=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:f.staff,body:{version:gift.version,reason:'Synthetic default-path void'}});
 assert.equal(voided.status,200,JSON.stringify(voided.json));
 assert.equal(voided.json.record.status,'Voided');
});

test('an enabled control gates the real void endpoint and a second approver releases it',async t=>{
 const f=await fixture(t),gift=f.gifts[1];
 const approver=await f.secondAdmin();
 const policy=await f.policy('gift-void');
 assert.ok(policy,'gift-void policy must be listed');
 assert.equal(Boolean(policy.enabled),false,'the control must ship disabled');
 const enabled=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:f.admin,body:{version:policy.version,enabled:true,reason:'Synthetic two-person control for voids'}});
 assert.equal(enabled.status,200,JSON.stringify(enabled.json));

 const refused=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:f.staff,body:{version:gift.version,reason:'Synthetic void without approval'}});
 assert.equal(refused.status,409,JSON.stringify(refused.json));
 assert.match(refused.json.error,/approval by a second authorized person/i);
 const afterRefusal=await f.request('/workspace',{session:f.admin});
 assert.equal(afterRefusal.json.data.gifts.find(g=>g.id===gift.id).status,'Posted','a refused void must leave the gift posted');

 const review=await f.request('/tenant-administration/reviews',{method:'POST',session:f.staff,body:{duty:'gift-void',subjectId:gift.id,subjectVersion:gift.version,summary:'Synthetic void prepared for approval'}});
 assert.equal(review.status,201,JSON.stringify(review.json));
 const prepared=review.json.review;
 const stillRefused=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:f.staff,body:{version:gift.version,reason:'Synthetic void while undecided'}});
 assert.equal(stillRefused.status,409,'a prepared but undecided review must not release the action');

 const decision=await f.request('/tenant-administration/reviews/'+prepared.id+'/decision',{method:'POST',session:approver,body:{version:prepared.version,decision:'approved',reason:'Synthetic independent approval'}});
 assert.equal(decision.status,200,JSON.stringify(decision.json));

 const released=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:f.staff,body:{version:gift.version,reason:'Synthetic approved void'}});
 assert.equal(released.status,200,JSON.stringify(released.json));
 assert.equal(released.json.record.status,'Voided');
});
