import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function harness(){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef(initial){return state[index++]??=({current:initial});},useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((d,j)=>d!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:id.includes('lib')?lib:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/Messaging.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(e=>e());return tree;};
 render.unmount=()=>cleanups.forEach(c=>c?.());
 return render;
}
function find(tree,p){if(!tree||typeof tree!=='object')return null;if(p(tree))return tree;for(const c of React.Children.toArray(tree.props?.children)){const r=find(c,p);if(r)return r;}return null;}
function all(tree,p,found=[]){if(!tree||typeof tree!=='object')return found;if(p(tree))found.push(tree);for(const c of React.Children.toArray(tree.props?.children))all(c,p,found);return found;}
const text=e=>React.Children.toArray(e.props.children).filter(c=>typeof c==='string').join('');
const button=(tree,label)=>find(tree,e=>e.type==='button'&&text(e)===label);
const field=(tree,label)=>find(find(tree,e=>e.type==='label'&&text(e).startsWith(label)),e=>['input','select','textarea'].includes(e.type));
const form=(tree,heading)=>find(find(tree,e=>e.type==='section'&&find(e,x=>x.type==='h2'&&text(x)===heading)),e=>e.type==='form');
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const donor={id:'11111111-1111-4111-8111-111111111111',version:3,name:'Consented Donor',preference:'Email'};
const other={id:'33333333-3333-4333-8333-333333333333',version:1,name:'Second Donor',preference:'Email'};
const blocked={id:'44444444-4444-4444-8444-444444444444',version:1,name:'Blocked Donor',preference:'Do not contact'};
const gift={id:'55555555-5555-4555-8555-555555555555',version:2,status:'Posted',amount:10001,date:'2026-09-01'};
const template={id:'66666666-6666-4666-8666-666666666666',version:2,name:'Autumn update',kind:'Messaging'};
const status={enabled:true,mode:'TEST_ONLY',channels:['Email','SMS'],authorizationReference:'Synthetic authorization',rateLimitPerMinute:60,maxRecipients:50,productionReady:false};
const base={id:'77777777-7777-4777-8777-777777777777',name:'Autumn campaign',classification:'Marketing',channel:'Email',status:'Draft',version:1,recipientCount:0,snapshotDigest:null,configCurrent:true,updatedAt:'2026-09-14T12:00:00.000Z',delivery:'Not sent'};
const reviewed={...base,status:'Reviewed',version:2,recipientCount:1,snapshotDigest:'a'.repeat(64),sentCount:0,pendingCount:1,failedCount:0,sourceCurrent:true,staleRecipients:[],recipients:[{id:'88888888-8888-4888-8888-888888888888',constituentId:donor.id,constituentVersion:3,channel:'Email',addressMasked:'c***@e***',status:'Reviewed',attemptCount:0,writeAttempted:false,lastError:null,contentDigest:'b'.repeat(64),updatedAt:base.updatedAt}]};
const details=(campaign=reviewed,extra={})=>({campaign,outcomes:[{id:'o1',campaignVersion:campaign.version,status:'Reviewed',reason:'Recipient set frozen; nothing is sent',actor:'staff1',at:base.updatedAt,retryAt:null}],outcomeCount:1,outcomeLimit:100,deliveries:[],attributions:[],...extra});

async function ready({user={id:'admin1',role:'admin'},provider=status,campaigns=[],saved=null,suppressions=[],queue=[],api:custom,...extra}={}){
 const calls=[],render=harness();
 const props={user,notify:()=>{},onDirty:()=>{},data:{constituents:[donor,other,blocked,{id:'merged',version:1,name:'Merged',mergedInto:donor.id}],gifts:[gift,{id:'void',version:1,status:'Voided',amount:500,date:'2026-09-02'}]},
  api:async(path,options)=>{calls.push([path,options]);if(custom){const result=await custom(path,options);if(result!==undefined)return result;}
   if(options)return {campaign:saved?.campaign||base};
   if(path==='/messaging/status')return provider;
   if(path==='/messaging/campaigns')return {campaigns};
   if(path==='/correspondence/templates')return {templates:[template,{id:'x',version:1,name:'Ack',kind:'Acknowledgment'}]};
   if(path==='/messaging/suppressions')return {suppressions};
   if(path==='/messaging/queue')return {queue,classification:'Transactional'};
   if(path.startsWith('/messaging/campaigns/'))return saved||details();
   throw Object.assign(new Error('Unexpected path '+path),{status:404});},
  ...extra};
 render(props);await flush();
 return {calls,render,props,tree:render(props)};
}
const html=s=>renderToStaticMarkup(s.render(s.props));
const submit=tree=>find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});

test('viewers and unknown roles see an explicit permission denial and request nothing',async()=>{
 for(const role of ['viewer','event-helper',undefined]){
  const s=await ready({user:{id:'u1',role}});
  assert.deepEqual(s.calls,[]);
  assert.match(html(s),/requires staff or administrator access/);
  assert.equal(find(s.tree,e=>e.type==='form'),null);
  assert.ok(find(s.tree,e=>e.props?.role==='alert'));
 }
});

test('an unconfigured transport still reviews but states plainly that nothing can be sent',async()=>{
 const s=await ready({provider:{enabled:false,mode:'Disabled',channels:[],productionReady:false},saved:details(reviewed),campaigns:[reviewed]});
 assert.match(html(s),/No messaging transport is configured/);
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 const tree=s.render(s.props);
 assert.match(renderToStaticMarkup(tree),/cannot be executed. Nothing will be sent/);
 assert.equal(button(tree,'Execute reviewed campaign'),null);
 assert.equal(s.calls.filter(([,o])=>o).length,0);
});

test('loading, unavailable and empty registers are three distinct statements',async()=>{
 const failed=await ready({api:async()=>{throw Object.assign(new Error('Database unavailable'),{status:503});}});
 const failedHtml=html(failed);
 assert.match(failedHtml,/saved campaign register is unavailable/);
 assert.doesNotMatch(failedHtml,/No campaign has been reviewed/);
 assert.match(failedHtml,/Transport readiness is unavailable/);
 const empty=await ready();
 assert.match(html(empty),/No campaign has been reviewed in this workspace/);
 assert.match(html(empty),/No suppression is retained/);
});

test('drafting posts only the reviewed template identity and never claims a send',async()=>{
 const s=await ready();
 for(const [label,value] of [['Campaign name','Autumn campaign'],['Reviewed template',template.id]])field(s.render(s.props),label).props.onChange({target:{value}});
 let tree=s.render(s.props);
 assert.equal(find(tree,e=>e.type==='option'&&e.props.value==='x'),null,'only Messaging templates are offered');
 assert.equal(button(tree,'Draft campaign').props.disabled,false);
 await submit(form(tree,'Draft a campaign'));await flush();
 const posts=s.calls.filter(([,o])=>o);
 assert.equal(posts.length,1);
 assert.equal(posts[0][0],'/messaging/campaigns');
 assert.deepEqual(posts[0][1].body,{name:'Autumn campaign',classification:'Marketing',channel:'Email',templateId:template.id,templateVersion:2,reason:'Reviewed draft campaign',confirmed:true});
 assert.match(html(s),/Review its recipients before anything can be sent/);
});

test('review freezes only explicitly selected recipients and requires a reason and confirmation',async()=>{
 const s=await ready({campaigns:[base],saved:details(base)});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 let tree=s.render(s.props);
 assert.equal(find(tree,e=>e.type==='input'&&e.props['aria-label']==='Select recipient Blocked Donor'),null,'a Do not contact identity is never offered');
 assert.equal(find(tree,e=>e.type==='input'&&e.props['aria-label']==='Select recipient Merged'),null);
 assert.equal(button(tree,'Freeze reviewed recipients').props.disabled,true);
 find(tree,e=>e.type==='input'&&e.props['aria-label']==='Select recipient Consented Donor').props.onChange();
 tree=s.render(s.props);
 field(tree,'Reason for this reviewed selection').props.onChange({target:{value:'Reviewed consent evidence'}});
 tree=s.render(s.props);
 assert.equal(button(tree,'Freeze reviewed recipients').props.disabled,true,'an unconfirmed review cannot be submitted');
 find(tree,e=>e.type==='input'&&e.props.type==='checkbox'&&!e.props['aria-label']).props.onChange({target:{checked:true}});
 tree=s.render(s.props);
 await submit(form(tree,'Review the exact recipient set'));await flush();
 const posts=s.calls.filter(([,o])=>o);
 assert.equal(posts.length,1);
 assert.deepEqual(posts[0][1].body,{version:1,constituentIds:[donor.id],reason:'Reviewed consent evidence',confirmed:true});
});

test('execution pins one idempotency key, submits once and never repeats after an unconfirmed response',async()=>{
 let broken=true;
 const s=await ready({campaigns:[reviewed],saved:details(reviewed),api:async(path,options)=>{if(options&&path.endsWith('/execute')&&broken)throw new Error('Connection lost during execution');}});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 let tree=s.render(s.props);
 field(tree,'Reason for executing').props.onChange({target:{value:'Reviewed execution'}});
 tree=s.render(s.props);
 find(tree,e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
 tree=s.render(s.props);
 const executeForm=form(tree,'Execute the reviewed campaign');
 await Promise.all([submit(executeForm),submit(executeForm)]);await flush();
 let posts=s.calls.filter(([,o])=>o);
 assert.equal(posts.length,1,'a duplicated submission never produces a second execution request');
 assert.match(posts[0][1].body.idempotencyKey,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(posts[0][1].body.snapshotDigest,reviewed.snapshotDigest);
 assert.match(html(s),/response was not confirmed/);
 assert.match(html(s),/Pinned execution key/);
 broken=false;
 tree=s.render(s.props);
 await button(tree,'Discard inputs and reload saved campaigns').props.onClick();await flush();
 assert.equal(s.calls.filter(([,o])=>o).length,1);
});

test('staff see the reviewed snapshot but are told execution needs an administrator',async()=>{
 const s=await ready({user:{id:'staff1',role:'staff'},campaigns:[reviewed],saved:details(reviewed)});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 const page=html(s);
 assert.match(page,/Executing a reviewed campaign requires administrator access/);
 assert.equal(button(s.render(s.props),'Execute reviewed campaign'),null);
 assert.match(page,/c\*\*\*@e\*\*\*/,'the reviewed snapshot shows a masked address only');
 assert.equal(s.calls.filter(([,o])=>o).length,0);
});

test('a conflicting saved campaign is reported as a conflict with an explicit reload, not as a failure',async()=>{
 const s=await ready({campaigns:[reviewed],saved:details(reviewed),api:async(path,options)=>{if(options)throw Object.assign(new Error('Reviewed recipients changed before execution.'),{status:409});}});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 let tree=s.render(s.props);
 field(tree,'Reason for executing').props.onChange({target:{value:'Reviewed execution'}});
 tree=s.render(s.props);
 find(tree,e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
 await submit(form(s.render(s.props),'Execute the reviewed campaign'));await flush();
 const page=html(s);
 assert.match(page,/Reviewed recipients changed before execution/);
 assert.match(page,/Reload the saved campaign and review it again/);
 assert.ok(button(s.render(s.props),'Reload the saved campaign'));
 assert.equal(s.calls.filter(([,o])=>o).length,1);
});

test('a stale reviewed snapshot blocks execution and says nobody is silently skipped',async()=>{
 const stale={...reviewed,sourceCurrent:false,staleRecipients:[{recipientId:'r1',reason:'Recipient record changed after review'}]};
 const s=await ready({campaigns:[stale],saved:details(stale)});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 const tree=s.render(s.props),page=renderToStaticMarkup(tree);
 assert.match(page,/Recipient record changed after review/);
 assert.match(page,/refuses the whole campaign rather than skipping anyone/);
 assert.equal(button(tree,'Execute reviewed campaign').props.disabled,true);
});

test('attribution offers only posted gifts and states that no revenue is created',async()=>{
 const executed={...reviewed,status:'Executed',version:4,sentCount:1,pendingCount:0,recipients:[{...reviewed.recipients[0],status:'Sent'}]};
 const s=await ready({campaigns:[executed],saved:details(executed,{attributions:[{id:'a1',giftId:gift.id,giftVersion:2,attributedCents:10001,sourceCurrent:true}]})});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 let tree=s.render(s.props);
 assert.equal(find(tree,e=>e.type==='option'&&e.props.value==='void'),null,'a voided gift is never offered for attribution');
 assert.match(renderToStaticMarkup(tree),/never creates, edits or duplicates a gift/);
 assert.match(renderToStaticMarkup(tree),/\$100\.01/);
 for(const [label,value] of [['Reviewed recipient',executed.recipients[0].id],['Existing posted gift',gift.id],['Reason for this attribution','Donor replied to this campaign']])field(s.render(s.props),label).props.onChange({target:{value}});
 await submit(form(s.render(s.props),'Campaign attribution'));await flush();
 const post=s.calls.filter(([,o])=>o)[0];
 assert.equal(post[0],'/messaging/campaigns/'+executed.id+'/attributions');
 assert.deepEqual(post[1].body,{version:4,recipientId:executed.recipients[0].id,giftId:gift.id,giftVersion:2,reason:'Donor replied to this campaign',confirmed:true});
});

const queued=[{id:'q1',purpose:'volunteer-shift-reminder',classification:'Transactional',channel:'Email',reference:'shift-1',status:'Queued',delivery:'Not sent',queuedAt:'2026-09-14T12:00:00.000Z',lastError:null}];

test('the operational reminder queue is shown as transactional and never as delivered',async()=>{
 const s=await ready({queue:queued});
 const page=html(s);
 assert.match(page,/Operational reminder queue/);
 assert.match(page,/volunteer-shift-reminder/);
 assert.match(page,/never use marketing consent/);
 assert.match(page,/Queued/);
 assert.doesNotMatch(page,/Delivered/);
 const empty=await ready();
 assert.match(html(empty),/No operational reminder is queued/);
});

test('running the queue needs an administrator, a configured transport, a reason and confirmation',async()=>{
 const staffSide=await ready({queue:queued,user:{id:'staff1',role:'staff'}});
 assert.equal(button(staffSide.tree,'Hand queued reminders to the transport'),null);
 const unconfigured=await ready({queue:queued,provider:{enabled:false,mode:'Disabled',channels:[],productionReady:false}});
 assert.match(html(unconfigured),/queued reminders stay queued/);
 assert.equal(button(unconfigured.render(unconfigured.props),'Hand queued reminders to the transport'),null);
 const s=await ready({queue:queued});
 let tree=s.render(s.props);
 assert.equal(button(tree,'Hand queued reminders to the transport').props.disabled,true);
 field(tree,'Reason for running the queue').props.onChange({target:{value:'Scheduled operational run'}});
 tree=s.render(s.props);
 assert.equal(button(tree,'Hand queued reminders to the transport').props.disabled,true,'an unconfirmed run cannot be submitted');
 find(find(tree,e=>e.type==='section'&&find(e,x=>x.type==='h2'&&text(x)==='Operational reminder queue')),e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
 tree=s.render(s.props);
 await submit(form(tree,'Operational reminder queue'));await flush();
 const posts=s.calls.filter(([,o])=>o);
 assert.equal(posts.length,1);
 assert.equal(posts[0][0],'/messaging/queue/execute');
 assert.deepEqual(posts[0][1].body,{reason:'Scheduled operational run',confirmed:true});
 assert.match(html(s),/records a handoff only, never provider delivery/);
});

test('a revoked session removes retained recipient detail from the screen instead of keeping it cached',async()=>{
 let deny=false;
 const s=await ready({campaigns:[reviewed],saved:details(reviewed),api:async path=>{if(deny&&path.startsWith('/messaging'))throw Object.assign(new Error('Account access changed'),{status:401});}});
 await button(s.tree,'Autumn campaign').props.onClick();await flush();
 assert.match(html(s),/Autumn campaign/);
 deny=true;
 await button(s.render(s.props),'Refresh saved campaigns').props.onClick();await flush();
 const page=html(s);
 assert.match(page,/Your account access changed/);
 assert.doesNotMatch(page,/c\*\*\*@e\*\*\*|Consented Donor/);
});
