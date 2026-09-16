import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installAiRoutes} from '../server/ai.js';

const today=()=>new Date().toISOString().slice(0,10),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const personId=randomUUID(),otherId=randomUUID(),giftId=randomUUID(),fundId=randomUUID(),otherFundId=randomUUID();
const gift=(id=giftId,patch={})=>({id,version:1,constituentId:personId,amount:12500,date:today(),type:'Cash',method:'Check',status:'Posted',giftKind:'One-time',allocations:[{designationId:fundId,amount:12500}],...patch});
const dataset=()=>({constituents:[{id:personId,version:1,name:'Synthetic selected donor',type:'Individual',preference:'Email',email:'PRIVATE_EMAIL@example.test',notes:'PRIVATE_PERSON_NOTE',contacts:[{name:'PRIVATE_CONTACT_NAME'}]},{id:otherId,version:1,name:'Unrelated donor',type:'Individual',preference:'Email'}],gifts:[gift()],tasks:[],grants:[],volunteers:[]});
async function fixture(t,{data=dataset(),policy={enabled:true,dataMode:'synthetic'},recheckAccess=()=>true,providerImpl}={}){
 const entered=deferred(),finish=deferred(),calls=[],audits=[],contexts=[],app=express();app.use(express.json());
 app.use((req,res,next)=>{req.user={id:'synthetic-operator',role:'staff'};req.tenantId='synthetic-workspace';next();});
 installAiRoutes(app,{list:(c,req)=>{contexts.push([c,req.tenantId,req.user.role]);return structuredClone(data[c]||[]);},get:(c,id,req)=>{contexts.push([c,req.tenantId,req.user.role]);const record=(data[c]||[]).find(r=>r.id===id);if(!record)throw Object.assign(new Error('Record not found'),{status:404});return structuredClone(record);},csrf:(req,res,next)=>next(),write:(req,res,next)=>next(),audit:(...args)=>audits.push(args),aiPolicy:policy,recheckAccess,provider:{baseUrl:'http://127.0.0.1:11434',model:'synthetic-freshness-fixture',fetchImpl:async(url,options)=>{calls.push([url,options]);entered.resolve();if(providerImpl)return providerImpl(url,options);await finish.promise;return Response.json({done:true,message:{content:'PRIVATE_STALE_ANSWER 125 dollars'}});}}});
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 async function request(task='constituent-summary',recordId=personId){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/intelligence/assist`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(task==='help'?{task,question:'How do I record a gift?'}:{task,recordId})});return {status:r.status,json:await r.json()};}
 return {data,policy,calls,audits,contexts,entered,finish,request};
}
function withheld(f,r,status=409){assert.equal(r.status,status,JSON.stringify(r.json));assert.equal(r.json.generated,undefined);assert.equal(r.json.text,undefined);assert.doesNotMatch(JSON.stringify(r.json),/PRIVATE_STALE_ANSWER/);assert.equal(f.audits.some(a=>a[4]?.status==='completed'),false);assert.equal(f.audits.at(-1)[4].status,'failed');assert.doesNotMatch(JSON.stringify(f.audits),/PRIVATE_STALE_ANSWER|PRIVATE_EMAIL|PRIVATE_PERSON_NOTE|allocations|12500|99900/);}
async function changed(t,mutate,{task='constituent-summary',data=dataset(),recordId=personId,status=409,...options}={}){const f=await fixture(t,{data,...options}),pending=f.request(task,recordId);await f.entered.promise;mutate(f.data);f.finish.resolve();const r=await pending;withheld(f,r,status);return f;}

test('summary rejects an changed aggregate gift beyond the recent-five sources instead of disclosing stale total',async t=>{
 const data=dataset();data.gifts=[gift(giftId,{date:'2020-01-01'}),...Array.from({length:5},()=>gift(randomUUID()))];const f=await changed(t,d=>{d.gifts[0].amount=99900;d.gifts[0].allocations[0].amount=99900;d.gifts[0].version++;},{data});
 const sent=JSON.parse(f.calls[0][1].body),facts=JSON.parse(sent.messages[1].content.split('Facts: ')[1]);assert.equal(facts.postedMonetaryGifts,6);assert.equal(facts.totalCents,75000);assert.equal(facts.recentGifts.length,5);assert.equal(f.contexts.filter(([c])=>c==='gifts').length,2);assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_EMAIL|PRIVATE_PERSON_NOTE|PRIVATE_CONTACT_NAME|allocations|designationId|source_digest|version/);
});

test('summary membership changes reject added, removed, voided, dated, reassigned, fee and noncash source gifts',async t=>{
 for(const [name,mutate] of [['added',d=>d.gifts.push(gift(randomUUID()))],['removed',d=>d.gifts=[]],['voided',d=>d.gifts[0].status='Voided'],['future',d=>d.gifts[0].date='2999-01-01'],['reassigned',d=>d.gifts[0].constituentId=otherId],['fee',d=>d.gifts[0].type='Fee payment'],['noncash',d=>d.gifts[0].type='In-kind']])await t.test(name,async sub=>{await changed(sub,mutate);});
});

test('newly eligible formerly excluded gifts invalidate summary count and money facts',async t=>{
 for(const [name,patch,change] of [['future',{date:'2999-01-01'},g=>g.date=today()],['void',{status:'Voided'},g=>g.status='Posted'],['fee',{type:'Fee payment'},g=>g.type='Cash'],['noncash',{type:'In-kind'},g=>g.type='Cash'],['different donor',{constituentId:otherId},g=>g.constituentId=personId]])await t.test(name,async sub=>{const data=dataset();data.gifts.push(gift(randomUUID(),patch));await changed(sub,d=>change(d.gifts[1]),{data});});
});

test('financial split, source revision and person lifecycle changes invalidate included source custody',async t=>{
 for(const [name,mutate] of [['split designation',d=>d.gifts[0].allocations[0].designationId=otherFundId],['split amount',d=>d.gifts[0].allocations[0].amount=12499],['gift revision',d=>d.gifts[0].version++],['person revision',d=>d.constituents[0].version++],['person merge',d=>d.constituents[0].mergedInto=otherId],['person type',d=>d.constituents[0].type='Business'],['person name',d=>d.constituents[0].name='Different reviewed donor']])await t.test(name,async sub=>{await changed(sub,mutate);});
});

test('thank-you pins the exact selected gift identity, financial source and recipient lifecycle facts',async t=>{
 for(const [name,mutate,status] of [['amount',d=>d.gifts[0].amount=99900,409],['method',d=>d.gifts[0].method='Cash',409],['classification',d=>d.gifts[0].giftKind='Planned gift',409],['split',d=>d.gifts[0].allocations[0].designationId=otherFundId,409],['acknowledged',d=>d.gifts[0].acknowledgment={date:today(),channel:'Post'},409],['removed gift',d=>d.gifts=[],409],['removed recipient',d=>d.constituents.shift(),409],['recipient merge',d=>d.constituents[0].mergedInto=otherId,409],['opt out',d=>d.constituents[0].preference='Do not contact',403]])await t.test(name,async sub=>{await changed(sub,mutate,{task:'thank-you-draft',recordId:giftId,status});});
});

test('excluded and unrelated records do not invalidate the selected prompt corpus',async t=>{
 for(const task of ['constituent-summary','thank-you-draft'])await t.test(task,async sub=>{const data=dataset();data.gifts.push(gift(randomUUID(),{date:'2999-01-01'}),gift(randomUUID(),{constituentId:otherId}));data.grants=[{id:randomUUID(),version:1,name:'Unrelated grant',stage:'Preparing'}];data.tasks=[{id:randomUUID(),version:1,title:'Unrelated task',status:'Open'}];const f=await fixture(sub,{data}),pending=f.request(task,task==='thank-you-draft'?giftId:personId);await f.entered.promise;data.gifts[1].amount=99900;data.gifts[2].amount=99900;data.constituents[1].version++;data.grants[0].stage='Closed';data.tasks[0].status='Completed';f.finish.resolve();const result=await pending;assert.equal(result.status,200,JSON.stringify(result.json));assert.equal(result.json.generated,true);assert.equal(f.audits.at(-1)[4].status,'completed');assert.doesNotMatch(JSON.stringify(f.calls),/Unrelated grant|Unrelated task|PRIVATE_EMAIL|PRIVATE_PERSON_NOTE/);});
});

test('changes during the asynchronous fresh permission check still invalidate the model source corpus',async t=>{
 const checking=deferred(),allow=deferred(),data=dataset(),f=await fixture(t,{data,recheckAccess:async()=>{checking.resolve();await allow.promise;return true;}}),pending=f.request();await f.entered.promise;f.finish.resolve();await checking.promise;data.gifts[0].amount=99900;allow.resolve();withheld(f,await pending);assert.equal(f.calls.length,1);
});

test('permission scope or workspace policy changes withhold the generated response before source disclosure',async t=>{
 for(const [name,change] of [['tenant',req=>req.tenantId='different-workspace'],['actor',req=>req.user.id='different-actor'],['role',req=>req.user.role='admin']])await t.test(name,async sub=>{const f=await fixture(sub,{recheckAccess:req=>{change(req);return true;}}),pending=f.request();await f.entered.promise;f.finish.resolve();withheld(f,await pending,403);assert.equal(f.contexts.filter(([c])=>c==='gifts').length,1);});
 const f=await fixture(t),pending=f.request();await f.entered.promise;f.policy.dataMode='restricted';f.finish.resolve();withheld(f,await pending,403);
});

test('UTC cutoff rollover invalidates a dated record prompt while timeless workflow help stays available',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,8,13,23,59,59)});const f=await fixture(t),pending=f.request();await f.entered.promise;t.mock.timers.tick(2000);f.finish.resolve();withheld(f,await pending);assert.match(JSON.parse(f.calls[0][1].body).messages[1].content,/through 2026-09-13/);
 const help=await fixture(t),helpPending=help.request('help');await help.entered.promise;t.mock.timers.tick(86400000);help.finish.resolve();assert.equal((await helpPending).status,200);assert.deepEqual(help.contexts,[]);
});

test('unchanged corpus and reordered native acquisition return factual suggestions without extra model requests',async t=>{
 const data=dataset();data.gifts.push(gift(randomUUID()));const f=await fixture(t,{data}),pending=f.request();await f.entered.promise;data.gifts.reverse();f.finish.resolve();const result=await pending;assert.equal(result.status,200);assert.equal(result.json.generated,true);assert.equal(result.json.reviewRequired,true);assert.equal(f.calls.length,1);assert.equal(f.audits.length,1);assert.equal(f.audits[0][4].status,'completed');
});

test('a stale-source rejection releases per-account concurrency and a new explicit request uses the current amount',async t=>{
 const data=dataset();let requests=0;const entered=deferred(),finish=deferred(),f=await fixture(t,{data,providerImpl:async()=>{requests++;if(requests===1){entered.resolve();await finish.promise;}return Response.json({done:true,message:{content:'A suggestion for human review.'}});}}),pending=f.request();await entered.promise;data.gifts[0].amount=99900;data.gifts[0].allocations[0].amount=99900;data.gifts[0].version++;finish.resolve();withheld(f,await pending);const next=await f.request();assert.equal(next.status,200);assert.equal(requests,2);assert.equal(JSON.parse(f.calls[1][1].body).messages[1].content.includes('"totalCents":99900'),true);assert.deepEqual(f.audits.map(a=>a[4].status),['failed','completed']);
});
