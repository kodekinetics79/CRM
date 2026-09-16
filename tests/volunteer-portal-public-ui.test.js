import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function harness(search=''){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 globalThis.window={location:{search,pathname:'/volunteer'},history:{replaceState(){}}};
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},
  useRef(initial){return state[index++]??=({current:initial});},
  useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((dep,j)=>dep!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:id.includes('lib')?lib:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/PublicVolunteer.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(run=>run());return tree;};
 return render;
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const named=(tree,label)=>find(tree,node=>node.type==='button'&&node.props['aria-label']===label);
const text=node=>React.Children.toArray(node.props.children).filter(child=>typeof child==='string').join('');
const button=(tree,label)=>find(tree,node=>node.type==='button'&&text(node).includes(label));
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const openShift={id:'s1',name:'Pantry sorting',date:'2026-09-20',startTime:'09:00',endTime:'12:00',location:'Pantry',capacity:3,status:'Open',eventId:null,reservedCount:1,waitlistCount:0,placesLeft:2,version:1,startsAt:'2026-09-20T09:00:00.000Z',past:false};
const fullShift={...openShift,id:'s2',name:'Evening set-up',capacity:1,reservedCount:1,waitlistCount:2,placesLeft:0};
const view=(changes={})=>({
 volunteer:{name:'Riley Volunteer',expiresAt:'2026-10-13T12:00:00.000Z'},
 consent:{granted:false,source:null,updatedAt:null,withdrawnByVolunteer:false},
 contactPreference:'Email',
 reservations:[],shifts:[openShift,fullShift],reminders:[],
 scope:'This link shows only your own volunteer shifts and reservations. It never opens constituent records, giving history or other volunteers’ details.',
 delivery:'Internal preparation only. Queuing a reminder is not delivery and no external provider is contacted.',
 timezone:'UTC',...changes});

async function page({request,token='wv1.token',search='?t=wv1.token'}={}){
 const calls=[],render=harness(search);
 const props={token,request:async(path,options)=>{calls.push([path,options]);return request?request(path,options):view();}};
 render(props);await flush();
 return {calls,render,props,tree:render(props),html:()=>renderToStaticMarkup(render(props))};
}

test('without a sign-up link the page explains what is needed and requests nothing',async()=>{
 const screen=await page({token:'',search:''});
 assert.deepEqual(screen.calls,[]);
 assert.match(screen.html(),/need your personal sign-up link/i);
 assert.doesNotMatch(screen.html(),/Pantry sorting/);
});

test('a revoked or expired link is an explicit state, never an empty shift list',async()=>{
 for(const message of ['This sign-up link was revoked. Ask staff for a new link.','This sign-up link has expired. Ask staff for a new link.']){
  const screen=await page({request:async()=>{throw Object.assign(new Error(message),{status:403});}});
  assert.match(screen.html(),/This link cannot be used/);
  assert.ok(screen.html().includes(message));
  assert.doesNotMatch(screen.html(),/You have no volunteer shifts booked yet|Pantry sorting/);
 }
 const broken=await page({request:async()=>{throw new Error('Shifts are temporarily unavailable');}});
 assert.match(broken.html(),/Your shifts are unavailable/);
 assert.match(broken.html(),/Shifts are temporarily unavailable/);
 assert.doesNotMatch(broken.html(),/no volunteer shifts booked/);
 await button(broken.render(broken.props),'Try again').props.onClick();
 assert.equal(broken.calls.length,2);
});

test('signing up sends one idempotent confirmation and a full shift offers only the waitlist',async()=>{
 let saved=view();
 const screen=await page({request:async(path,options)=>{
  if(options?.method==='POST'){saved=view({reservations:[{id:'r1',version:1,status:options.body.join,notes:'',shift:options.body.shiftId==='s1'?openShift:fullShift,history:[]}]});return saved;}
  return saved;
 }});
 assert.equal(named(screen.tree,'Sign up for Pantry sorting').props.disabled,false);
 assert.ok(named(screen.tree,'Join the waitlist for Evening set-up'),'a full shift offers the waitlist, never a place it cannot give');
 assert.equal(button(screen.tree,'Sign up').props.disabled,false);
 await named(screen.render(screen.props),'Sign up for Pantry sorting').props.onClick();
 await flush();
 const post=screen.calls.find(([,options])=>options);
 assert.equal(post[0],'/reservations');
 assert.match(post[1].body.requestId,/^[a-f0-9-]{36}$/);
 assert.deepEqual({shiftId:post[1].body.shiftId,join:post[1].body.join},{shiftId:'s1',join:'Reserved'});
 const html=screen.html();
 assert.match(html,/Your place is confirmed/);
 assert.match(html,/Already on your list/);
 assert.equal(screen.calls.filter(([,options])=>options).length,1,'one click sends exactly one confirmation');
});

test('a replayed confirmation says nothing changed and a conflict reloads instead of claiming success',async()=>{
 const replay=await page({request:async(path,options)=>options?{...view(),replayed:true}:view()});
 await named(replay.render(replay.props),'Sign up for Pantry sorting').props.onClick();
 await flush();
 assert.match(replay.html(),/already recorded\. Nothing changed/);
 let reads=0;
 const conflict=await page({request:async(path,options)=>{
  if(options)throw Object.assign(new Error('This shift is full. Join the waitlist instead.'),{status:409});
  reads++;return view();
 }});
 const before=reads;
 await named(conflict.render(conflict.props),'Sign up for Pantry sorting').props.onClick();
 await flush();
 assert.match(conflict.html(),/This shift is full/);
 assert.ok(reads>before,'the page refetches its own shifts after a conflict');
 assert.doesNotMatch(conflict.html(),/Your place is confirmed/);
});

test('a volunteer can cancel their own place, and a started shift offers no cancellation',async()=>{
 const booked=view({reservations:[{id:'r1',version:3,status:'Reserved',notes:'',shift:openShift,history:[]}]});
 const screen=await page({request:async(path,options)=>options?view({reservations:[{id:'r1',version:4,status:'Cancelled',notes:'',shift:openShift,history:[]}]}):booked});
 const cancel=named(screen.tree,'Cancel your place on Pantry sorting');
 assert.ok(cancel);assert.equal(cancel.props.disabled,false);
 await cancel.props.onClick();
 await flush();
 const post=screen.calls.find(([,options])=>options);
 assert.equal(post[0],'/reservations/r1/cancel');
 assert.equal(post[1].body.version,3);
 assert.match(screen.html(),/Your place is cancelled\. Your record of it is kept\./);
 assert.match(screen.html(),/Places you cancelled/);
 const started=await page({request:async()=>view({reservations:[{id:'r2',version:1,status:'Reserved',notes:'',shift:{...openShift,past:true},history:[]}]})});
 assert.equal(named(started.tree,'Pantry sorting has already started, so this place can no longer be cancelled here').props.disabled,true);
 assert.equal(named(started.tree,'Cancel your place on Pantry sorting'),null,'a disabled control never keeps an accessible name that promises the action');
 assert.match(started.html(),/Already started/);
});

test('the reminder choice is the volunteer’s own and a do-not-contact record is stated plainly',async()=>{
 const screen=await page({request:async(path,options)=>options?view({consent:{granted:true,source:'Volunteer',updatedAt:'2026-09-13T12:00:00.000Z',withdrawnByVolunteer:false}}):view()});
 assert.match(screen.html(),/have not asked for shift reminders/);
 await button(screen.render(screen.props),'Turn on shift reminders').props.onClick();
 await flush();
 const post=screen.calls.find(([,options])=>options);
 assert.equal(post[0],'/consent');
 assert.equal(post[1].body.granted,true);
 assert.match(screen.html(),/reminder choice is recorded: reminders are on/);
 assert.match(screen.html(),/whether one reaches you depends on the messaging/);
 assert.match(screen.html(),/separate from how your organization contacts you/);
 const blockedByPreference=await page({request:async()=>view({contactPreference:'Do not contact',consent:{granted:true,source:'Volunteer',updatedAt:null,withdrawnByVolunteer:false}})});
 assert.match(blockedByPreference.html(),/do not contact/);
 assert.match(blockedByPreference.html(),/no reminder is prepared/);
});

test('the public page stays within its own scope and is reachable without a mouse',async()=>{
 const screen=await page({request:async()=>view({reservations:[{id:'r1',version:1,status:'Reserved',notes:'',shift:openShift,history:[]}]})});
 const html=screen.html();
 assert.match(html,/<a class="skip-link" href="#volunteer-main">Skip to your shifts<\/a>/);
 assert.match(html,/id="volunteer-main" tabindex="-1"/);
 assert.ok(findAll(screen.tree,node=>node.type==='button').every(node=>node.props['aria-label']||text(node).trim().length>0),'every control has an accessible name');
 assert.ok(findAll(screen.tree,node=>node.type==='section').every(node=>node.props['aria-labelledby']));
 assert.doesNotMatch(html,/PRIVATE|\$[0-9]|@example|Taylor Bennett|Campaign|Designation/,'no other person, address or financial value reaches this page');
 assert.match(html,/only your own volunteer shifts/);
 assert.match(html,/It never opens constituent records, giving history or other volunteers/);
});

// --- Self-reported arrival and departure on the public page ------------------
const startedShift={...openShift,past:true};
const booked=(changes={})=>({id:'r1',version:2,status:'Reserved',notes:'',shift:startedShift,history:[],claim:null,...changes});
const attendanceView=(changes={})=>view({attendance:'Volunteer self-reported claim. It is not confirmed hours and is never counted in the volunteer time ledger or any hours report.',...changes});

test('a started shift invites times and says plainly that a claim is not confirmed hours',async()=>{
 const screen=await page({request:async()=>attendanceView({reservations:[booked()]})});
 const html=screen.html();
 assert.match(html,/Tell us when you arrived and left/);
 assert.match(html,/not confirmed hours/);
 assert.match(html,/times are recorded in UTC/);
 assert.ok(named(screen.tree,'Record when you arrived and left Pantry sorting'));
 const notStarted=await page({request:async()=>attendanceView({reservations:[booked({shift:openShift})]})});
 assert.doesNotMatch(notStarted.html(),/Tell us when you arrived and left/);
 const waitlisted=await page({request:async()=>attendanceView({reservations:[booked({status:'Waitlisted'})]})});
 assert.doesNotMatch(waitlisted.html(),/Tell us when you arrived and left/);
});

test('recorded times are sent once as an idempotent UTC claim built from the shift date',async()=>{
 let saved=attendanceView({reservations:[booked()]});
 const screen=await page({request:async(path,options)=>{
  if(options?.method==='POST'){saved=attendanceView({reservations:[booked({claim:{status:'Claimed',arrivedAt:options.body.arrivedAt,departedAt:options.body.departedAt,decisionReason:null}})]});return saved;}
  return saved;
 }});
 let tree=screen.render(screen.props);
 const inputs=findAll(tree,node=>node.type==='input'&&node.props.type==='time');
 assert.equal(inputs.length,2);
 assert.equal(inputs[0].props.value,'09:00');
 assert.equal(inputs[1].props.value,'12:00');
 inputs[0].props.onChange({target:{value:'09:05'}});
 tree=screen.render(screen.props);
 await named(tree,'Record when you arrived and left Pantry sorting').props.onClick();
 await flush();
 const post=screen.calls.find(([,options])=>options);
 assert.equal(post[0],'/reservations/r1/attendance');
 assert.match(post[1].body.requestId,/^[a-f0-9-]{36}$/);
 assert.equal(post[1].body.version,2);
 assert.equal(post[1].body.arrivedAt,'2026-09-20T09:05:00.000Z');
 assert.equal(post[1].body.departedAt,'2026-09-20T12:00:00.000Z');
 assert.equal(screen.calls.filter(([,options])=>options).length,1);
 const html=screen.html();
 assert.match(html,/Staff will confirm this; it is not confirmed hours yet/);
 assert.match(html,/Staff have not confirmed it yet/);
 assert.doesNotMatch(html,/Tell us when you arrived and left/,'a standing claim is not invited twice');
});

test('a decided claim is reported back to the volunteer in its own words',async()=>{
 const confirmed=await page({request:async()=>attendanceView({reservations:[booked({claim:{status:'Confirmed',arrivedAt:'2026-09-20T09:05:00.000Z',departedAt:'2026-09-20T12:00:00.000Z',decisionReason:'Supervisor saw them on site'}})]})});
 assert.match(confirmed.html(),/Staff confirmed what you recorded\. Your hours are added separately by staff\./);
 assert.doesNotMatch(confirmed.html(),/Tell us when you arrived and left/);
 const rejected=await page({request:async()=>attendanceView({reservations:[booked({claim:{status:'Rejected',arrivedAt:'2026-09-20T09:05:00.000Z',departedAt:'2026-09-20T12:00:00.000Z',decisionReason:'No record of this volunteer attending'}})]})});
 assert.match(rejected.html(),/Staff could not confirm what you recorded: No record of this volunteer attending/);
 assert.match(rejected.html(),/Tell us when you arrived and left/,'a rejected claim may be recorded again');
 const suppressed=await page({request:async()=>attendanceView({reservations:[booked({claim:{status:'Suppressed',arrivedAt:'2026-09-20T09:05:00.000Z',departedAt:'2026-09-20T12:00:00.000Z',decisionReason:'cancelled'}})]})});
 assert.match(suppressed.html(),/no longer matches this shift, so it was set aside/);
});
