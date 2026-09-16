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
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/PublicGiving.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
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

const status={enabled:true,mode:'TEST_ONLY',acceptsPayment:false,incomeRecorded:false,manualEntryPrimary:true,frequencies:['Monthly','Quarterly','Annual'],minimumCents:100,maximumCents:1e8};
const donorIntention=(o={})=>({id:'i1',status:'Active',kind:'RecurringPayment',commitmentOnly:false,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:'2026-09-15',nextDue:'2026-10-15',occurrences:6,version:2,scheduledCount:1,designationName:'Classroom fund',...o});

async function ready({api:custom,hash='',search='',...extra}={}){
 const calls=[],render=harness();
 const props={location:{hash,search},
  api:async(path,o)=>{calls.push([path,o]);if(custom)return custom(path,o);
   if(path==='/status')return status;
   if(path.startsWith('/return'))return {outcome:'returned',incomeRecorded:false,giftRecorded:false,paymentVerified:false};
   if(path==='/self-service/view')return {intention:donorIntention(),canCancel:true};
   if(path==='/self-service/cancel')return {intention:donorIntention({status:'Cancelled',version:3}),cancelled:true,consentChanged:false,financialHistoryChanged:false};
   return {received:true,submissionId:'sub-1',replayed:false,status:'PendingStaffReview',incomeRecorded:false,paymentTaken:false};},
  ...extra};
 render(props);await flush();
 return {calls,render,props,tree:render(props),writes:()=>calls.filter(([,o])=>o)};
}
const html=s=>renderToStaticMarkup(s.render(s.props));
async function fillGift(s,values={}){
 const entries={'Amount · USD':'25.00','Your name':'Actual supporter','Your email':'supporter@example.test',...values};
 for(const [label,value] of Object.entries(entries))field(s.render(s.props),label).props.onChange({target:{value}});
 find(s.render(s.props),e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
}

test('the page states plainly that it takes no payment and records no gift',async()=>{
 const s=await ready();
 const markup=html(s);
 assert.match(markup,/does not take a payment/);
 assert.match(markup,/no gift is recorded by submitting it/);
 assert.match(markup,/give by check or in person/,'the manual path stays visible and primary');
 assert.doesNotMatch(markup,/card number|cvv|expiry|pay now|checkout/i,'the page is never dressed as a payment terminal');
});

test('an unavailable public surface says so without inventing a giving path',async()=>{
 const s=await ready({api:async()=>{throw Object.assign(new Error('Public giving is not configured'),{status:503});}});
 const markup=html(s);
 assert.match(markup,/not available for this foundation right now/);
 assert.match(markup,/contact the foundation office/);
 assert.equal(find(s.render(s.props),e=>e.type==='form'),null,'no form is offered when the surface is unavailable');
 assert.equal(s.writes().length,0);
});

test('a submission sends exact integer cents once and reports that nothing was charged',async()=>{
 const s=await ready();
 await fillGift(s);
 const tree=s.render(s.props);
 await Promise.all([submit(tree),submit(tree)]);
 await flush();
 const writes=s.writes();
 assert.equal(writes.length,1,'a double submission sends once');
 assert.equal(writes[0][0],'/submissions');
 const body=writes[0][1].body;
 assert.equal(body.amountCents,2500,'the amount is exact integer cents');
 assert.equal(body.kind,'OneTime');
 assert.equal(body.frequency,null);
 assert.equal(body.acknowledged,true);
 assert.match(body.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const markup=html(s);
 assert.match(markup,/your request was received/i);
 assert.match(markup,/No payment has been taken and no gift has been recorded/);
 assert.match(markup,/\$25\.00/);
});

test('a recurring request carries its frequency and an invalid amount never reaches the server',async()=>{
 const s=await ready();
 field(s.render(s.props),'How often').props.onChange({target:{value:'RecurringPayment'}});
 await fillGift(s,{'Amount · USD':'not-a-number'});
 await submit(s.render(s.props));
 await flush();
 assert.equal(s.writes().length,0,'an unparseable amount is refused locally');
 assert.match(html(s),/two decimal places|between \$1\.00/);
 await fillGift(s,{'Amount · USD':'12.34'});
 await submit(s.render(s.props));
 await flush();
 const body=s.writes()[0][1].body;
 assert.equal(body.amountCents,1234);
 assert.equal(body.kind,'RecurringPayment');
 assert.equal(body.frequency,'Monthly');
});

test('the unconfirmed acknowledgement, missing name and bad email are refused before any request',async()=>{
 for(const [label,value,pattern] of [['Your name','','enter your name'],['Your email','not-an-email','valid email address']]){
  const s=await ready();
  await fillGift(s,{[label]:value});
  await submit(s.render(s.props));
  await flush();
  assert.equal(s.writes().length,0,label+' must be validated locally');
  assert.match(html(s),new RegExp(pattern,'i'));
 }
 const s=await ready();
 for(const [label,value] of [['Amount · USD','25.00'],['Your name','Actual supporter'],['Your email','supporter@example.test']])
  field(s.render(s.props),label).props.onChange({target:{value}});
 await submit(s.render(s.props));
 await flush();
 assert.equal(s.writes().length,0,'the acknowledgement must be confirmed');
 assert.match(html(s),/confirm you understand that this form takes no payment/);
});

test('a browser return states that no payment was verified and records nothing locally',async()=>{
 const s=await ready({search:'?outcome=cancelled'});
 await flush();
 const markup=html(s);
 assert.match(markup,/does not verify a payment or record a gift/);
 assert.ok(s.calls.some(([path])=>path.startsWith('/return')),'the return is reported to the server');
 assert.equal(s.writes().length,0,'a return is never a write');
});

test('a signed link shows only the donor own giving and never another supporter',async()=>{
 const s=await ready({hash:'#token=v1.synthetic.token'});
 await flush();
 const markup=html(s);
 assert.match(markup,/Your recurring giving/);
 assert.match(markup,/\$100\.01/);
 assert.match(markup,/Classroom fund/);
 assert.match(markup,/cannot see other supporters, change your contact preferences or change gifts already recorded/);
 assert.equal(find(s.render(s.props),e=>e.type==='label'&&text(e)==='Your name'),null,'the giving form is not shown on a self-service link');
 const viewCall=s.calls.find(([path])=>path==='/self-service/view');
 assert.equal(viewCall[1].body.token,'v1.synthetic.token','the token travels in the request body, not the URL');
});

test('an invalid or expired link explains itself and offers no giving action',async()=>{
 for(const [statusCode,pattern] of [[403,/not valid or has expired/],[404,/not available/]]){
  const s=await ready({hash:'#token=v1.bad.token',api:async path=>{
   if(path==='/status')return status;
   throw Object.assign(new Error('refused'),{status:statusCode});}});
  await flush();
  assert.match(html(s),pattern);
  assert.equal(button(s.render(s.props),'Cancel my recurring giving'),null,'no action is offered on a refused link');
 }
});

test('a donor cancellation is confirmed explicitly and states that recorded gifts are unchanged',async()=>{
 const s=await ready({hash:'#token=v1.synthetic.token'});
 await flush();
 assert.equal(s.writes().filter(([path])=>path==='/self-service/cancel').length,0);
 button(s.render(s.props),'Cancel my recurring giving').props.onClick();
 let tree=s.render(s.props);
 assert.ok(button(tree,'Keep my recurring giving'),'the donor can back out without cancelling');
 assert.equal(s.writes().filter(([path])=>path==='/self-service/cancel').length,0,'opening the form cancels nothing');
 await submit(tree);
 await flush();
 const cancel=s.calls.find(([path])=>path==='/self-service/cancel');
 assert.equal(cancel[1].body.version,2,'the cancellation pins the version the donor was shown');
 assert.equal(cancel[1].body.token,'v1.synthetic.token');
 const markup=html(s);
 assert.match(markup,/recurring giving is cancelled/);
 assert.match(markup,/Gifts you have already given are unchanged/);
});

test('a stale cancellation is reported as a conflict rather than retried',async()=>{
 const s=await ready({hash:'#token=v1.synthetic.token',api:async(path,o)=>{
  if(path==='/status')return status;
  if(path==='/self-service/view')return {intention:donorIntention(),canCancel:true};
  throw Object.assign(new Error('changed'),{status:409});}});
 await flush();
 button(s.render(s.props),'Cancel my recurring giving').props.onClick();
 await submit(s.render(s.props));
 await flush();
 assert.match(html(s),/details changed\. Please reload/);
 assert.equal(s.writes().filter(([path])=>path==='/self-service/cancel').length,1,'a conflict is never retried automatically');
});

test('the page is labelled, announces its states and works without a pointer',async()=>{
 const s=await ready();
 const tree=s.render(s.props);
 assert.ok(findAll(tree,e=>e.type==='legend').length>=1,'the form carries a legend');
 assert.equal(findAll(tree,e=>e.type==='button'&&!e.props.type).length,0,'buttons declare an explicit type');
 assert.equal(findAll(tree,e=>e.type==='div'&&e.props.onClick).length,0,'no handler hides on a non-interactive element');
 // Walk with an ancestor flag: React.Children.toArray clones nodes, so identity
 // comparison cannot be used to decide whether a control sits inside a label.
 const unlabelled=[];
 (function walk(node,insideLabel){
  if(!node||typeof node!=='object')return;
  if(['input','select','textarea'].includes(node.type)&&!insideLabel&&!node.props['aria-label']&&!node.props['aria-labelledby'])unlabelled.push(node.type);
  for(const child of React.Children.toArray(node.props?.children))walk(child,insideLabel||node.type==='label');
 })(tree,false);
 assert.deepEqual(unlabelled,[],'every control sits inside its label');
 const loading=harness();
 assert.match(renderToStaticMarkup(loading({api:async()=>new Promise(()=>{}),location:{hash:'',search:''}})),/role="status"/,'the loading state is announced');
 const failed=await ready({api:async()=>{throw Object.assign(new Error('nope'),{status:503});}});
 assert.match(html(failed),/role="alert"/,'the unavailable state is announced');
});
