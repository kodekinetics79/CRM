import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createApp} from '../server/app.js';

const md5=email=>createHash('md5').update(email.toLowerCase()).digest('hex');
async function fixture(t){
 const members=new Map(),calls=[],tenantId=randomUUID(),initialAdmin={name:'Synthetic scale administrator',email:'scale.admin@example.test',password:'SyntheticScaleAcceptance!2026'};
 const config={mode:'TEST_ONLY',access:'READ_ONLY',serverPrefix:'us1',apiKey:'FAKE_QA',listId:'scale-list',webhookSecret:'SyntheticWebhookSigningOnlyScaleFixture2026',adapter:{async getMember(id){calls.push(id);assert.ok(members.has(id));return structuredClone(members.get(id));},async getCampaignReport(){throw Error('Not used in member scale fixture');}}};
 const app=createApp({seed:false,tenantId,initialAdmin,marketingResponses:config,reminderWorker:false,workflowWorker:false}),db=app.locals.db,service=app.locals.marketingResponses,server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api';
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:initialAdmin.email,password:initialAdmin.password})});assert.equal(login.status,200);const auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),req={user:db.prepare('SELECT * FROM users WHERE id=?').get(auth.user.id),session:db.prepare('SELECT * FROM sessions WHERE user_id=?').get(auth.user.id)};
 async function native(collection,body,method='POST',id){const r=await fetch(base+'/records/'+collection+(id?'/'+id:''),{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':auth.csrfToken},body:JSON.stringify(body)});const json=await r.json();assert.equal(r.status,method==='POST'?201:200,JSON.stringify(json));return json.record;}
 async function constituent(i,changes={}){const p=await native('constituents',{name:'Synthetic source '+i,email:'scale.'+i+'@example.test',type:'Individual',preference:'Email',...changes});members.set(md5(p.email),{id:md5(p.email),email_address:p.email,list_id:config.listId,status:'subscribed',last_changed:'2026-09-01T12:00:00Z',unique_email_id:'opaque-'+i});return p;}
 const payload=p=>({requestId:randomUUID(),constituentId:p.id,constituentVersion:p.version,listId:config.listId,memberId:md5(p.email),reason:'Reviewed synthetic primary identity only',readOnlyConfirmed:true});
 return{app,db,service,req,members,calls,native,constituent,payload,config};
}

test('6515 validated native constituents produce complete current bindings, paginated custody, replay and truthful changed/retired/DNC states',async t=>{
 const f=await fixture(t),start=performance.now(),sources=[],saved=[],requests=[];
 for(let i=0;i<6515;i++)sources.push(await f.constituent(i,{preference:i===6514?'Do not contact':'Email'}));
 const recordsBefore=f.db.prepare('SELECT * FROM records ORDER BY rowid').all();
 for(const [i,p]of sources.entries()){if(i%100===0)await new Promise(resolve=>setTimeout(resolve,1));const body=f.payload(p),r=await f.service.prepare(f.req,body);requests.push(body);saved.push(r.binding);assert.equal(r.binding.status,'Current');assert.equal(r.binding.version,2);assert.equal(r.binding.constituentId,p.id);assert.equal(r.binding.memberId,md5(p.email));assert.equal(r.binding.sourceCurrent,true);}
 assert.equal(f.calls.length,6515);assert.equal(saved.at(-1).marketingEligible,false);assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_bindings').get().n,6515);assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_member_observations').get().n,6515);
 const ids=new Set();let after;do{const page=f.service.list(f.req.user,{limit:100,...(after?{after}:{})});assert.ok(page.bindings.length<=100);for(const b of page.bindings){assert.ok(!ids.has(b.id));ids.add(b.id);assert.equal(b.sourceCurrent,true);}after=page.nextCursor;}while(after);assert.equal(ids.size,6515);
 const report=f.service.reportSources(f.req.user);assert.equal(report.marketingBindings.length,6515);assert.equal(report.marketingBindings.filter(x=>x.marketingEligible).length,6514);assert.deepEqual(f.db.prepare('SELECT * FROM records ORDER BY rowid').all(),recordsBefore);
 await new Promise(resolve=>setTimeout(resolve,5));
 const replay=await f.service.prepare(f.req,requests[0]);assert.equal(replay.replayed,true);assert.equal(replay.binding.id,saved[0].id);assert.equal(f.calls.length,6515);
 const beforeMismatch=f.db.prepare('SELECT count(*) n FROM marketing_bindings').get().n;await assert.rejects(f.service.prepare(f.req,{...requests[0],requestId:randomUUID(),memberId:md5('different@example.test')}),e=>e.status===409);assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_bindings').get().n,beforeMismatch);
 await f.native('constituents',{version:sources[1].version,notes:'Reviewed native source changed'},'PATCH',sources[1].id);assert.equal(f.service.detail(f.req.user,saved[1].id).binding.sourceCurrent,false);
 const retired=f.service.retire(f.req,saved[2].id,{version:saved[2].version,reason:'Explicit reviewed retirement'});assert.equal(retired.binding.status,'Retired');assert.equal(retired.binding.marketingEligible,false);
 const final=f.service.reportSources(f.req.user).marketingBindings;assert.equal(final.length,6515);assert.equal(final.filter(x=>x.marketingEligible).length,6512);
 for(const [query,args,index]of [['SELECT * FROM marketing_history WHERE binding_id=? AND binding_version=?',[saved[0].id,2],'marketing_history_binding_revision'],['SELECT 1 FROM marketing_bindings WHERE constituent_id=? LIMIT 1',[sources[0].id],'marketing_binding_constituent_history']])assert.ok(f.db.prepare('EXPLAIN QUERY PLAN '+query).all(...args).some(x=>x.detail.includes(index)),index);
 const unicodePlan=f.db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(data,'$.email') FROM records INDEXED BY marketing_native_unicode_email WHERE collection='constituents' AND typeof(json_extract(data,'$.email'))='text' AND json_extract(data,'$.email') GLOB '*[^ -~]*'").all();assert.ok(unicodePlan.some(x=>x.detail.includes('marketing_native_unicode_email')),JSON.stringify(unicodePlan));
 const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE collection='constituents' AND lower(json_extract(data,'$.email'))=? LIMIT 2").all(sources[0].email);assert.ok(plan.some(x=>x.detail.includes('marketing_native_primary_email')),JSON.stringify(plan));
 t.diagnostic('6515 real native creates and6515 bounded mock GET bindings completed in '+((performance.now()-start)/1000).toFixed(3)+'s; RSS '+Math.round(process.memoryUsage().rss/1048576)+'MiB. Synthetic adapter only; no provider operation/adopted capacity claim.');
});

test('indexed duplicates preserve ASCII case, exact whitespace and JavaScript Unicode fault lowercasing without widening native validation',async t=>{
 const f=await fixture(t),p=await f.constituent('case',{email:'K@example.test'}),dup=await f.constituent('duplicate',{email:'k@example.test'});
 await assert.rejects(f.service.prepare(f.req,f.payload(p)),e=>e.status===409);assert.equal(f.calls.length,0);
 f.db.prepare("UPDATE records SET data=json_set(data,'$.mergedInto','canonical') WHERE collection='constituents' AND id=?").run(dup.id);
 const original=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(dup.id).data);
 for(const [value,expected]of [['K@example.test',false],[' k@example.test',true],['k@example.test ',true]]){
  assert.equal(z.email().safeParse(value).success,false);f.db.prepare("UPDATE records SET data=? WHERE collection='constituents' AND id=?").run(JSON.stringify({...original,email:value,mergedInto:null}),dup.id);
  if(expected){const lookup=f.service.memberIdentity(f.req,p.id,p.version);assert.equal(lookup.memberId,md5(p.email));}else assert.throws(()=>f.service.memberIdentity(f.req,p.id,p.version),e=>e.status===409);
 }
 for(const mergedInto of [null,false,0,'']){f.db.prepare("UPDATE records SET data=? WHERE collection='constituents' AND id=?").run(JSON.stringify({...original,email:p.email.toLowerCase(),mergedInto}),dup.id);assert.throws(()=>f.service.memberIdentity(f.req,p.id,p.version),e=>e.status===409);}
 f.db.prepare("UPDATE records SET data=? WHERE collection='constituents' AND id=?").run(JSON.stringify({...original,email:p.email.toLowerCase(),mergedInto:'retained-alias'}),dup.id);assert.equal(f.service.memberIdentity(f.req,p.id,p.version).memberId,md5(p.email));assert.equal(f.calls.length,0);
});

test('20000 actual prepared bindings retain full request/observation custody and terminal history; cap rejects before mock retrieval without eviction',async t=>{
 const f=await fixture(t),p=await f.constituent('capacity'),bound=f.service.status().limits;assert.equal(bound.bindings,20000);assert.equal(bound.observations,200000);assert.equal(bound.events,200000);assert.equal(bound.campaignObservations,200000);assert.equal(bound.campaignRequests,200000);
 for(let i=0;i<bound.bindings;i++){const r=await f.service.prepare(f.req,f.payload(p));f.service.retire(f.req,r.binding.id,{version:r.binding.version,reason:'Synthetic retained lifecycle capacity fixture'});}
 const calls=f.calls.length,counts=()=>['marketing_bindings','marketing_requests','marketing_member_observations','marketing_history'].map(table=>f.db.prepare('SELECT count(*) n FROM '+table).get().n),before=counts();assert.deepEqual(before,[20000,20000,20000,60000]);
 await assert.rejects(f.service.prepare(f.req,f.payload(p)),e=>e.status===409&&/Binding limit/.test(e.message));assert.equal(f.calls.length,calls);assert.deepEqual(counts(),before);assert.equal(f.service.list(f.req.user,{limit:100}).bindings.length,100);
});

test('indexed identity remains fresh across async source changes and persistence audit failure, with no misleading observation',async t=>{
 const f=await fixture(t),p=await f.constituent('rollback');
 f.db.exec("CREATE TRIGGER scale_audit_failure BEFORE INSERT ON audit WHEN NEW.action='observe_marketing_member' BEGIN SELECT RAISE(ABORT,'synthetic audit failure');END;");
 await assert.rejects(f.service.prepare(f.req,f.payload(p)));assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_bindings').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_member_observations').get().n,0);const pending=f.service.list(f.req.user,{limit:100}).bindings[0];assert.equal(pending.status,'Pending');assert.equal(pending.providerStatus,null);
 f.db.exec('DROP TRIGGER scale_audit_failure');const saved=await f.service.refresh(f.req,pending.id,{version:pending.version,reason:'Explicit read-only retry',readOnlyConfirmed:true});assert.equal(saved.binding.status,'Current');
 const other=await f.constituent('async');f.config.adapter.getMember=async id=>{f.calls.push(id);f.db.prepare("UPDATE records SET data=json_set(data,'$.version',2,'$.email','changed@example.test') WHERE collection='constituents' AND id=?").run(other.id);return structuredClone(f.members.get(id));};
 await assert.rejects(f.service.prepare(f.req,f.payload(other)),e=>e.status===409);const closed=f.service.list(f.req.user,{limit:100}).bindings.find(x=>x.constituentId===other.id);assert.equal(closed.status,'ReviewRequired');assert.equal(closed.sourceCurrent,false);assert.equal(closed.providerStatus,null);assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_member_observations').get().n,1);
});
