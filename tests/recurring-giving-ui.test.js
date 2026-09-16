import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function harness(){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},
  useRef(initial){return state[index++]??=({current:initial});},
  useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((d,j)=>d!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:id.includes('lib')?lib:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/RecurringGiving.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(e=>e());return tree;};
 render.unmount=()=>cleanups.forEach(c=>c?.());
 return render;
}
function find(tree,p){if(!tree||typeof tree!=='object')return null;if(p(tree))return tree;for(const c of React.Children.toArray(tree.props?.children)){const r=find(c,p);if(r)return r;}return null;}
function findAll(tree,p,out=[]){if(!tree||typeof tree!=='object')return out;if(p(tree))out.push(tree);for(const c of React.Children.toArray(tree.props?.children))findAll(c,p,out);return out;}
const text=e=>React.Children.toArray(e.props.children).filter(c=>typeof c==='string').join('');
const button=(tree,label)=>find(tree,e=>e.type==='button'&&text(e)===label);
const field=(tree,label)=>find(find(tree,e=>e.type==='label'&&text(e)===label),e=>['input','select','textarea'].includes(e.type));
const submit=tree=>find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const donor={id:'d1',version:2,name:'Synthetic supporter'},campaign={id:'c1',version:4,name:'Sustaining giving',status:'Active'},fund={id:'f1',version:3,name:'Classroom fund'};
const collection=(o={})=>({id:'col1',intentionId:'i1',sequence:1,version:1,status:'Scheduled',scheduledFor:'2026-09-15',amountCents:10001,currency:'usd',attemptCount:0,maxAttempts:4,nextAttempt:null,providerRef:null,method:null,giftId:null,giftStatus:null,giftVersion:null,recordedCashCents:0,lastErrorCode:null,createdAt:'2026-09-15T12:00:00Z',updatedAt:'2026-09-15T12:00:00Z',...o});
const intention=(o={})=>({id:'i1',requestId:'r1',version:2,mode:'TEST_ONLY',kind:'RecurringPayment',commitmentOnly:false,status:'Active',donorId:'d1',donorName:donor.name,campaignId:'c1',campaignName:campaign.name,designationId:'f1',designationName:fund.name,sourceVersions:{donor:2,campaign:4,designation:3},sourceCurrent:true,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:'2026-09-15',occurrences:6,nextDue:'2026-10-15',dunning:'None',donorTokenIssued:false,collections:[collection()],scheduledCount:1,recordedCashCents:0,committedCents:60006,createdAt:'2026-09-15T12:00:00Z',updatedAt:'2026-09-15T12:00:00Z',lastErrorCode:null,...o});
const providerReady={enabled:true,ready:true,mode:'TEST_ONLY',manualEntryPrimary:true};
const details=(i=intention())=>({intention:i,history:[{id:'h1',intentionId:i.id,collectionId:null,version:i.version,action:'Created',status:i.status,actor:'admin1',at:i.updatedAt,reason:'Reviewed synthetic sustaining commitment'}],historyCount:1,historyLimit:100});

async function ready({list=[],saved=details(),api:custom,provider=providerReady,...extra}={}){
 const calls=[],render=harness();
 const props={user:{id:'admin1',role:'admin'},onDirty:()=>{},
  data:{constituents:[donor,{id:'merged',version:1,name:'Merged supporter',mergedInto:'d1'}],campaigns:[campaign,{id:'closed',version:1,name:'Closed campaign',status:'Completed'}],designations:[fund]},
  api:async(path,o)=>{calls.push([path,o]);if(custom)return custom(path,o);if(o)return{intention:intention({version:3})};return path.endsWith('/status')?provider:path.includes('?')?{intentions:list,nextCursor:null}:saved;},
  ...extra};
 render(props);await flush();
 return {calls,render,props,tree:render(props),writes:()=>calls.filter(([,o])=>o)};
}
const html=s=>renderToStaticMarkup(s.render(s.props));
async function fillIntention(s,values={}){
 const entries={'Intention kind':'RecurringPayment','Donor':'d1','Campaign':'c1','Designation':'f1','Amount each time · USD':'100.01','Frequency':'Monthly','First scheduled date':'2026-10-01','Committed occurrences':'6','Reason for this reviewed commitment':'Reviewed synthetic sustaining commitment',...values};
 for(const [label,value] of Object.entries(entries))field(s.render(s.props),label).props.onChange({target:{value}});
 button(s.render(s.props),'Review this intention').props.onClick();
 // A refused review renders no confirmation box; the caller then asserts the refusal.
 find(s.render(s.props),e=>e.type==='input'&&e.props.type==='checkbox')?.props.onChange({target:{checked:true}});
}
async function select(s){await button(s.render(s.props),'Synthetic supporter').props.onClick();await flush();return s.render(s.props);}

test('viewers and helpers request nothing and are told plainly that access is denied',async()=>{
 for(const role of ['viewer','event-helper',undefined]){
  const s=await ready({user:{id:'u1',role}});
  assert.deepEqual(s.calls,[],role+' must issue no request');
  assert.match(html(s),/requires administrator or staff access/);
  assert.equal(find(s.tree,e=>e.props?.role==='alert')!==null,true,'the denial is announced to assistive technology');
 }
});

test('staff read the register but are offered no financially meaningful action',async()=>{
 const s=await ready({user:{id:'u2',role:'staff'},list:[intention()]});
 assert.ok(s.calls.length>0,'staff may read');
 assert.match(html(s),/Synthetic supporter/);
 for(const label of ['New recurring intention','Review pause','Review cancellation','Issue donor self-service link'])
  assert.equal(button(s.render(s.props),label),null,'staff must not be offered: '+label);
 const tree=await select(s);
 assert.equal(button(tree,'Review settlement'),null,'staff are never offered settlement');
 assert.equal(s.writes().length,0);
});

test('loading, unavailable, empty and populated register states are distinct and never claim a false emptiness',async()=>{
 const failed=await ready({api:async()=>{throw new Error('Database temporarily unavailable');}});
 assert.match(html(failed),/saved recurring register is unavailable/i);
 assert.doesNotMatch(html(failed),/No recurring intentions are recorded/);
 const empty=await ready({list:[]});
 assert.match(html(empty),/No recurring intentions are recorded/);
 assert.match(html(empty),/not a record of money received/);
 const populated=await ready({list:[intention()]});
 assert.match(html(populated),/Synthetic supporter/);
 assert.doesNotMatch(html(populated),/No recurring intentions are recorded/);
});

test('an unconfigured adapter still offers pledge commitments but never a collection instruction',async()=>{
 const s=await ready({provider:{enabled:false,ready:false,mode:'Disabled',reasonCode:'TEST_ADAPTER_NOT_CONFIGURED',manualEntryPrimary:true}});
 assert.match(html(s),/Simulated collection is unavailable/);
 const option=find(s.render(s.props),e=>e.type==='option'&&e.props.value==='RecurringPayment');
 assert.equal(option.props.disabled,true,'a collection instruction cannot be chosen without an adapter');
 assert.match(html(s),/Manual entry and import remain the primary/);
 await fillIntention(s,{'Intention kind':'RecurringPayment'});
 assert.match(html(s),/needs a configured test adapter/);
 assert.equal(s.writes().length,0,'no request is made for an unavailable instruction');
});

test('a reviewed intention pins exact source versions and one submission saves exactly once',async()=>{
 const s=await ready();
 await fillIntention(s);
 const tree=s.render(s.props);
 assert.equal(button(tree,'Save reviewed intention').props.disabled,false);
 assert.equal(find(tree,e=>e.type==='option'&&e.props.value==='merged'),null,'a merged identity is never offered');
 assert.equal(find(tree,e=>e.type==='option'&&e.props.value==='closed'),null,'a closed campaign is never offered');
 await Promise.all([submit(tree),submit(tree)]);
 const writes=s.writes();
 assert.equal(writes.length,1,'a double submission saves once');
 assert.equal(writes[0][0],'/recurring-giving/intentions');
 const body=writes[0][1].body;
 assert.match(body.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.deepEqual({...body,requestId:'pinned'},{requestId:'pinned',kind:'RecurringPayment',donorId:'d1',donorVersion:2,campaignId:'c1',campaignVersion:4,designationId:'f1',designationVersion:3,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:'2026-10-01',occurrences:6,reason:'Reviewed synthetic sustaining commitment',reviewConfirmed:true});
});

test('an actual source revision change invalidates the pinned review and blocks further action',async()=>{
 const s=await ready();
 await fillIntention(s);
 s.props.data=JSON.parse(JSON.stringify(s.props.data));
 assert.equal(button(s.render(s.props),'Save reviewed intention').props.disabled,false,'identical ids and revisions preserve the review');
 s.props.data={...s.props.data,campaigns:[{...campaign,version:5}]};
 s.render(s.props);
 assert.ok(button(s.render(s.props),'Save reviewed intention').props.disabled,'a real revision change invalidates the review');
 assert.match(html(s),/Source records changed/);
 assert.equal(s.writes().length,0);
});

test('the pledge and recurring-payment distinction is stated in the interface, not implied',async()=>{
 const pledge=intention({kind:'Pledge',commitmentOnly:true,collections:[collection({status:'Scheduled'})]});
 const s=await ready({list:[pledge],saved:details(pledge)});
 await select(s);
 const markup=html(s);
 assert.match(markup,/Pledge — a commitment/);
 assert.doesNotMatch(markup,/Attempt collection/,'a pledge is never offered a collection attempt');
 assert.match(markup,/Review settlement/,'a pledge installment is settled by reviewed manual entry');
});

test('settlement is a separate reviewed action that names exact money and posts exact versions',async()=>{
 const collected=intention({collections:[collection({status:'Collected',providerRef:'rc_test_x',method:'ACH',version:2})]});
 const s=await ready({list:[collected],saved:details(collected)});
 await select(s);
 let tree=s.render(s.props);
 assert.equal(button(tree,'Attempt collection'),null,'a collected occurrence is not re-attempted');
 button(tree,'Review settlement').props.onClick();
 tree=s.render(s.props);
 assert.match(html(s),/posts exactly one gift for this one occurrence/);
 assert.match(html(s),/issues no receipt and sends no acknowledgment/);
 assert.match(html(s),/\$100\.01/);
 assert.equal(button(tree,'Record one reviewed gift').props.disabled,true,'a reason is required');
 field(s.render(s.props),'Reason for this reviewed action').props.onChange({target:{value:'Reviewed exact collection facts'}});
 await submit(s.render(s.props));
 const writes=s.writes();
 assert.equal(writes.length,1);
 assert.equal(writes[0][0],'/recurring-giving/collections/col1/record-gift');
 assert.deepEqual(writes[0][1].body,{version:2,donorVersion:2,campaignVersion:4,designationVersion:3,reason:'Reviewed exact collection facts',reviewConfirmed:true});
});

test('a settlement conflict is reported as a conflict and blocks repetition until history reloads',async()=>{
 const collected=intention({collections:[collection({status:'Collected',version:2})]});
 const s=await ready({list:[collected],saved:details(collected),api:async(path,o)=>{
  if(o)throw Object.assign(new Error('Recurring collection changed. Reload its current version'),{status:409});
  return path.endsWith('/status')?providerReady:path.includes('?')?{intentions:[collected],nextCursor:null}:details(collected);}});
 await select(s);
 button(s.render(s.props),'Review settlement').props.onClick();
 field(s.render(s.props),'Reason for this reviewed action').props.onChange({target:{value:'Reviewed exact collection facts'}});
 await submit(s.render(s.props));
 await flush();
 assert.match(html(s),/conflicts with the saved record/);
 assert.match(html(s),/Reload saved history/);
 assert.equal(s.writes().length,1,'a conflict is never retried automatically');
});

test('a changed source or unconfirmed authority denies collection and settlement in the interface',async()=>{
 const stale=intention({sourceCurrent:false,collections:[collection({status:'Collected'})]});
 const s=await ready({list:[stale],saved:details(stale)});
 const tree=await select(s);
 assert.match(html(s),/donor, campaign, designation or recovery authority changed/);
 assert.equal(button(tree,'Review settlement').props.disabled,true);
 assert.equal(s.writes().length,0);
});

test('recovery state and attempt ceilings are shown as text rather than an unlabelled colour',async()=>{
 const failing=intention({dunning:'Exhausted',status:'ReviewRequired',collections:[collection({status:'ReviewRequired',attemptCount:4,lastErrorCode:'insufficient_funds'})]});
 const s=await ready({list:[failing],saved:details(failing)});
 await select(s);
 const markup=html(s);
 assert.match(markup,/Recovery attempts exhausted/);
 assert.match(markup,/insufficient_funds/);
 assert.match(markup,/4 of 4/);
 assert.match(markup,/Manual financial review required/);
});

test('the donor link is shown once, states that nothing was sent and describes its strict bounds',async()=>{
 const s=await ready({list:[intention()],saved:details(),api:async(path,o)=>{
  if(o)return {intention:intention({version:3,donorTokenIssued:true}),token:'v1.synthetic.token',expiresAt:'2026-10-15T12:00:00Z'};
  return path.endsWith('/status')?providerReady:path.includes('?')?{intentions:[intention()],nextCursor:null}:details();}});
 await select(s);
 button(s.render(s.props),'Issue donor self-service link').props.onClick();
 assert.match(html(s),/cannot browse constituents, see other donors or change consent/);
 field(s.render(s.props),'Reason for this reviewed action').props.onChange({target:{value:'Donor asked to manage their own giving'}});
 await submit(s.render(s.props));
 await flush();
 const markup=html(s);
 assert.match(markup,/v1\.synthetic\.token/);
 assert.match(markup,/Nothing has been sent/);
 assert.match(markup,/never stored in readable form/);
});

test('the screen is reachable without a pointer and labelled for assistive technology',async()=>{
 const s=await ready({list:[intention()],saved:details()});
 // The create form is the only view with a fieldset, so it carries the legend.
 const form=s.render(s.props);
 assert.equal(findAll(form,e=>e.type==='fieldset').length,findAll(form,e=>e.type==='legend').length,'every fieldset carries a legend');
 assert.ok(findAll(form,e=>e.type==='legend').length>=1);
 await select(s);
 const tree=s.render(s.props);
 assert.ok(findAll(tree,e=>e.type==='caption').length>=1,'tables carry a caption');
 assert.equal(findAll(tree,e=>e.type==='th'&&!e.props.scope).length,0,'every header cell declares a scope');
 assert.equal(findAll(tree,e=>e.type==='button'&&!e.props.type).length,0,'buttons declare an explicit type');
 assert.equal(findAll(tree,e=>e.type==='div'&&e.props.onClick).length,0,'no click handler hides on a non-interactive element');
 const markup=html(s);
 assert.doesNotMatch(markup,/<img(?![^>]*alt=)/,'any image carries alternative text');
});

test('the scope banner never implies live payment collection or an approved provider relationship',async()=>{
 const s=await ready({list:[intention()]});
 const markup=html(s);
 assert.match(markup,/No live payment provider is connected/);
 assert.match(markup,/Manual entry and import remain the primary way to record giving/);
 assert.doesNotMatch(markup,/payments? (?:are|is) processed/i);
 assert.doesNotMatch(markup,/approved provider|provider acceptance granted|live Stripe/i);
});
