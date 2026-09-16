import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {createHash,randomUUID} from 'node:crypto';import {createApp} from '../server/app.js';
async function fixture(t,{enabled=true}={}){
 let patchCount=0,member=null,lose=false;const tenantId=randomUUID(),listId='syntheticList',adapter={async getMember(){assert.ok(member);return structuredClone(member);},async getCampaignReport(){throw Error('No campaign access');},async updateMember(id,p){patchCount++;if(p.status)member.status=p.status;if(p.merge_fields)Object.assign(member.merge_fields,p.merge_fields);if(lose)throw Error('Synthetic lost response after remote save');return structuredClone(member);}};
 const baseConfig={serverPrefix:'us1',listId,apiKey:'a'.repeat(32)+'-us1',adapter};
 const app=createApp({seed:false,tenantId,initialAdmin:{name:'Synthetic sync admin',email:'sync.api@example.test',password:'SyntheticSyncApi!2026'},reminderWorker:false,workflowWorker:false,marketingResponses:{...baseConfig,mode:'TEST_ONLY',access:'READ_ONLY',webhookSecret:'SyntheticSignatureOnlyNoExternalCalls2026'},mailchimpContactSync:enabled?{...baseConfig,mode:'TEST_ONLY',access:'EXISTING_MEMBER_UPDATE',ownerPolicy:{approved:true,reference:'SYNTHETIC_QA_POLICY_ONLY',version:1,purpose:'Existing contact synchronization',existingMemberUpdates:true,mergeFields:[{tag:'DISPLAY',field:'name',type:'text'}]}}:null});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;let session;
 t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();});
 async function request(path,{method='GET',body,auth=true,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth&&session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json(),headers:r.headers};}
 const login=await request('/auth/login',{method:'POST',auth:false,body:{email:'sync.api@example.test',password:'SyntheticSyncApi!2026'}});assert.equal(login.status,200);session={...login.json,cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
 const donor=(await request('/records/constituents',{method:'POST',body:{name:'Synthetic whole name',type:'Individual',email:'synthetic.sync@example.test',preference:'Email'}})).json.record;
 member={id:createHash('md5').update(donor.email.toLowerCase()).digest('hex'),email_address:donor.email,list_id:listId,status:'subscribed',last_changed:'2026-09-13T12:00:00Z',unique_email_id:'syntheticOpaque123',merge_fields:{DISPLAY:'Old synthetic name'}};
 const b=await request('/marketing-responses/bindings',{method:'POST',body:{requestId:randomUUID(),constituentId:donor.id,constituentVersion:donor.version,listId,memberId:member.id,reason:'Synthetic existing identity read',readOnlyConfirmed:true}});assert.equal(b.status,201,JSON.stringify(b.json));const binding=b.json.binding;
 const payload=()=>({requestId:randomUUID(),constituentId:donor.id,constituentVersion:donor.version,bindingId:binding.id,bindingVersion:binding.version,reason:'Synthetic exact update review',confirmed:true});
 return {app,request,donor,binding,payload,get patches(){return patchCount;},get member(){return member;},set lose(v){lose=v;}};
}
test('mounted existing-member contact update requires session and CSRF, persists a one-time reviewed PATCH and rejects replay',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/mailchimp-contact-sync/status',{auth:false})).status,401);
 const denied=await f.request('/mailchimp-contact-sync/intents',{method:'POST',body:f.payload(),csrf:false});assert.equal(denied.status,403);assert.equal(f.patches,0);
 const p=await f.request('/mailchimp-contact-sync/intents',{method:'POST',body:f.payload()});assert.equal(p.status,201,JSON.stringify(p.json));assert.equal(p.json.intent.status,'Ready');assert.equal(p.json.intent.operation,'UpdateFields');
 const action={version:p.json.intent.version,reason:'Synthetic explicit single application',confirmed:true},path='/mailchimp-contact-sync/intents/'+p.json.intent.id+'/execute';
 const done=await f.request(path,{method:'POST',body:action});assert.equal(done.status,200,JSON.stringify(done.json));assert.equal(done.json.intent.status,'Reconciled');assert.equal(f.patches,1);assert.equal(f.member.merge_fields.DISPLAY,f.donor.name);
 assert.equal((await f.request(path,{method:'POST',body:action})).status,409);assert.equal(f.patches,1);
 const detail=await f.request('/mailchimp-contact-sync/intents/'+p.json.intent.id);assert.equal(detail.status,200);assert.ok(detail.json.history.length>=3);assert.equal((await f.request('/mailchimp-contact-sync/status')).json.productionReady,false);
});
test('mounted ambiguous provider completion blocks a new request and uses GET-only readback to recover',async t=>{
 const f=await fixture(t),p=await f.request('/mailchimp-contact-sync/intents',{method:'POST',body:f.payload()});assert.equal(p.status,201);f.lose=true;
 const path='/mailchimp-contact-sync/intents/'+p.json.intent.id;const failed=await f.request(path+'/execute',{method:'POST',body:{version:p.json.intent.version,reason:'Synthetic lost response test',confirmed:true}});assert.equal(failed.status,409);assert.equal(f.patches,1);
 const d=await f.request(path);assert.equal(d.json.intent.status,'Unknown');assert.equal((await f.request('/mailchimp-contact-sync/intents',{method:'POST',body:f.payload()})).status,409);
 const r=await f.request(path+'/reconcile',{method:'POST',body:{version:d.json.intent.version,reason:'Synthetic GET-only observed completion',confirmed:true}});assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.intent.status,'Reconciled');assert.equal(f.patches,1);
});
test('mounted default-disabled contact synchronization never invokes provider writes',async t=>{
 const f=await fixture(t,{enabled:false});const s=await f.request('/mailchimp-contact-sync/status');assert.equal(s.status,200);assert.equal(s.json.enabled,false);assert.equal((await f.request('/mailchimp-contact-sync/intents',{method:'POST',body:f.payload()})).status,503);assert.equal(f.patches,0);
});
