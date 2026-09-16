import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function harness(file,{search=''}={}){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 globalThis.window={location:{search,pathname:'/volunteer'},history:{replaceState(){}}};
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},
  useRef(initial){return state[index++]??=({current:initial});},
  useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((dep,j)=>dep!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:id.includes('lib')?lib:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/'+file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(run=>run());return tree;};
 render.unmount=()=>cleanups.forEach(clean=>clean?.());
 return render;
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const text=node=>React.Children.toArray(node.props.children).filter(child=>typeof child==='string').join('');
const button=(tree,label)=>find(tree,node=>node.type==='button'&&text(node).includes(label));
const labelled=(tree,label)=>find(find(tree,node=>node.type==='label'&&text(node).startsWith(label)),node=>['input','select','textarea'].includes(node.type));
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const staffUser={id:'staff-1',name:'Casey Rivera',role:'staff'};
const constituents=[{id:'c1',name:'Riley Volunteer',type:'Individual',version:1},{id:'c2',name:'PRIVATE_OTHER',type:'Individual',version:1},{id:'org',name:'Aspen Partners',type:'Business',version:1}];
const shift={id:'s1',name:'Pantry sorting',date:'2026-09-20',startTime:'09:00',endTime:'12:00',location:'Pantry',capacity:2,status:'Open',eventId:null,reservedCount:1,waitlistCount:1,placesLeft:1,version:1,startsAt:'2026-09-20T09:00:00.000Z',past:false,
 reminderConfig:{shiftId:'s1',leadMinutes:[1440],enabled:true,version:1,updatedAt:null,configured:true},
 roster:[{id:'r1',version:1,status:'Reserved',constituentId:'c1',notes:'',history:[{action:'Reserved'}]},{id:'r2',version:1,status:'Waitlisted',constituentId:'c2',notes:'',history:[{action:'Joined waitlist'}]}]};
const overview={generatedAt:'2026-09-13T12:00:00.000Z',timezone:'UTC',
 access:[{id:'a1',constituentId:'c1',status:'Active',issuedBy:'staff-1',issuedAt:'2026-09-13T12:00:00.000Z',expiresAt:'2026-10-13T12:00:00.000Z',revokedAt:null,revokeReason:null,lastUsedAt:null,useCount:2,version:1,expired:false}],
 shifts:[shift],
 reminders:[{id:'m1',shiftId:'s1',reservationId:'r1',constituentId:'c1',kind:'Shift reminder',leadMinutes:1440,sendAt:'2026-09-19T09:00:00.000Z',status:'Queued',attemptCount:1,nextAttempt:null,version:2,lastOutcome:{status:'Queued',reason:'Queued to the configured outbox. External delivery is not performed, confirmed or claimed here.',at:'2026-09-19T09:00:00.000Z',retryAt:null},queued:true}],
 consent:[{constituentId:'c1',granted:true,source:'Volunteer',basis:'Volunteer granted shift reminders',updatedAt:'2026-09-13T12:10:00.000Z',version:1,withdrawnByVolunteer:false}],
 cancellations:[{id:'h1',reservationId:'r9',shiftId:'s1',constituentId:'c1',action:'Self-cancelled',fromStatus:'Reserved',toStatus:'Cancelled',actorKind:'Volunteer',reason:'Family commitment',at:'2026-09-13T12:05:00.000Z'}],
 claims:[],pendingClaimCount:0,
 attendance:'Volunteer self-reported claim. It is not confirmed hours and is never counted in the volunteer time ledger or any hours report.',
 ledger:'No hours were written. Recorded hours remain the sole result of the volunteer clock, used by staff as a separate explicit action.',
 defaults:{leadMinutes:[1440,120],linkPath:'/volunteer'},
 outbox:{configured:false,mode:'Internal only'},
 delivery:'Internal preparation only. Queuing a reminder is not delivery and no external provider is contacted.',
 scope:'Volunteer self-service administration only. No revenue, receipt or external message is created here.'};

async function staffScreen({api,user=staffUser,data={constituents}}={}){
 const calls=[],render=harness('VolunteerPortal.jsx');
 const props={user,data,notify:()=>{},onDirty:()=>{},api:async(path,options)=>{calls.push([path,options]);return api?api(path,options):overview;}};
 render(props);await flush();
 return {calls,render,props,tree:render(props),html:()=>renderToStaticMarkup(render(props))};
}

test('viewers and event helpers see an explicit permission state and request nothing',async()=>{
 for(const role of ['viewer','event-helper']){
  const screen=await staffScreen({user:{id:'u1',name:'Board',role}});
  assert.deepEqual(screen.calls,[]);
  assert.match(screen.html(),/requires administrator or staff access/);
  assert.doesNotMatch(screen.html(),/Riley Volunteer|Issue sign-up link/);
 }
});

test('an unavailable register is explicit rather than falsely empty, and retries once asked',async()=>{
 const screen=await staffScreen({api:async()=>{throw new Error('Database temporarily unavailable');}});
 assert.match(screen.html(),/Database temporarily unavailable/);
 assert.doesNotMatch(screen.html(),/No sign-up links have been issued yet/);
 assert.equal(screen.calls.length,1);
 await button(screen.render(screen.props),'Try again').props.onClick();
 assert.equal(screen.calls.length,2);
 const denied=await staffScreen({api:async()=>{throw Object.assign(new Error('Account access changed. Sign in again'),{status:403});}});
 assert.match(denied.html(),/Account access changed/);
 assert.doesNotMatch(denied.html(),/Riley Volunteer/);
});

test('issuing a link offers only person constituents and shows the secret exactly once',async()=>{
 let issued=0;
 const screen=await staffScreen({api:async(path,options)=>{
  if(options?.method==='POST'){issued++;return {access:{...overview.access[0],id:'a2'},token:'wv1.token',linkPath:'/volunteer?t=wv1.token',notice:'Copy this link now. It is shown once and is never stored or sent by this workspace.'};}
  return overview;
 }});
 const options=findAll(screen.render(screen.props),node=>node.type==='option').map(node=>node.props.value);
 assert.ok(options.includes('c1')&&options.includes('c2'));
 assert.ok(!options.includes('org'),'an organization can never hold a volunteer sign-up link');
 assert.equal(button(screen.render(screen.props),'Issue sign-up link').props.disabled,true);
 labelled(screen.render(screen.props),'Volunteer').props.onChange({target:{value:'c1'}});
 labelled(screen.render(screen.props),'Reason').props.onChange({target:{value:'Weekly pantry volunteer'}});
 let tree=screen.render(screen.props);
 assert.equal(button(tree,'Issue sign-up link').props.disabled,false);
 await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 tree=screen.render(screen.props);
 assert.equal(issued,1);
 assert.equal(screen.calls.find(([,o])=>o)[1].body.constituentId,'c1');
 assert.match(renderToStaticMarkup(tree),/Copy this link now/);
 assert.equal(find(tree,node=>node.type==='input'&&node.props.readOnly).props.value,'/volunteer?t=wv1.token');
 assert.equal(labelled(tree,'Reason').props.value,'','the reason is cleared so one link is never issued twice by accident');
 button(screen.render(screen.props),'Hide link').props.onClick();
 assert.doesNotMatch(screen.html(),/wv1\.token/);
});

test('a conflict reloads the register and says so instead of claiming success',async()=>{
 let reloads=0;
 const screen=await staffScreen({api:async(path,options)=>{
  if(options?.method==='POST')throw Object.assign(new Error('This sign-up link is already revoked.'),{status:409});
  reloads++;return overview;
 }});
 const before=reloads;
 await button(screen.render(screen.props),'Revoke').props.onClick();
 await flush();
 assert.match(screen.html(),/already revoked/);
 assert.match(screen.html(),/latest register has been reloaded/);
 assert.ok(reloads>before,'the screen refetches rather than trusting its stale copy');
 assert.doesNotMatch(screen.html(),/Sign-up link revoked\./);
});

test('the staff screen states the delivery meaning, retained history and the outbox mode',async()=>{
 const screen=await staffScreen();
 const html=screen.html();
 assert.match(html,/Queuing a reminder is never delivery|not delivery/i);
 assert.match(html,/Outbox: Internal only/);
 assert.match(html,/Self-cancelled/);
 assert.match(html,/Family commitment/);
 assert.match(html,/Queued to the outbox/);
 assert.doesNotMatch(html,/Delivered to|Email sent|Message sent/);
 assert.match(html,/separate from contact preference and from any workspace login role/);
 const table=find(screen.tree,node=>node.type==='table');
 assert.ok(find(table,node=>node.type==='caption'),'every dense table carries a caption for screen readers');
 assert.ok(findAll(screen.tree,node=>node.type==='th').every(node=>node.props.scope==='col'));
 assert.ok(findAll(screen.tree,node=>node.type==='td').every(node=>typeof node.props['data-label']==='string'),'cells carry the label used for the mobile stacked layout');
});

test('choosing a shift shows its roster, reminder schedule and a keyboard-reachable cancel action',async()=>{
 const screen=await staffScreen();
 labelled(screen.render(screen.props),'Shift').props.onChange({target:{value:'s1'}});
 const tree=screen.render(screen.props);
 const html=renderToStaticMarkup(tree);
 assert.match(html,/Riley Volunteer/);
 assert.match(html,/Waitlisted/);
 const cancel=find(tree,node=>node.type==='button'&&node.props['aria-label']==='Cancel the place held by Riley Volunteer');
 assert.ok(cancel,'each row action names the volunteer it affects');
 assert.equal(cancel.props.disabled,false);
 assert.ok(find(tree,node=>node.type==='input'&&node.props.type==='checkbox'&&node.props.checked===true),'the configured lead time is shown as chosen');
 assert.ok(button(tree,'Fill free places from the waitlist'));
 assert.match(html,/Queuing is not delivery|not delivery/i);
});

// --- Self-reported arrival and departure on the staff screen -----------------
const claim=(changes={})=>({id:'k1',reservationId:'r1',shiftId:'s1',constituentId:'c1',arrivedAt:'2026-09-20T09:05:00.000Z',departedAt:'2026-09-20T12:00:00.000Z',status:'Claimed',version:1,createdAt:'',updatedAt:'',decidedBy:null,decidedAt:null,decisionReason:null,claimedMinutes:175,sourceCurrent:true,sourceProblem:null,decisions:[{id:'d1',status:'Claimed',reason:'Self-reported by the volunteer',actor:'volunteer-link:a1',actorKind:'Volunteer',at:''}],meaning:'Volunteer self-reported claim. It is not confirmed hours and is never counted in the volunteer time ledger or any hours report.',...changes});
const withClaims=rows=>({...overview,claims:rows,pendingClaimCount:rows.filter(r=>r.status==='Claimed').length,
 attendance:'Volunteer self-reported claim. It is not confirmed hours and is never counted in the volunteer time ledger or any hours report.',
 ledger:'No hours were written. Recorded hours remain the sole result of the volunteer clock, used by staff as a separate explicit action.'});

test('a pending claim is shown as a claim, never as hours, and names what it affects',async()=>{
 const screen=await staffScreen({api:async()=>withClaims([claim()])});
 const html=screen.html();
 assert.match(html,/Self-reported arrival and departure/);
 assert.match(html,/Riley Volunteer/);
 assert.match(html,/09:05–12:00 UTC/);
 assert.match(html,/175 minutes claimed · not confirmed hours/);
 assert.match(html,/never counted in the volunteer time ledger/);
 assert.match(html,/Recorded hours remain the sole result of the volunteer clock/);
 assert.doesNotMatch(html,/2\.92 hours|hours recorded|Hours added/);
 assert.ok(find(screen.tree,node=>node.type==='button'&&node.props['aria-label']==='Confirm the claim from Riley Volunteer'));
 assert.ok(find(screen.tree,node=>node.type==='label'&&node.props.className==='sr-only'&&node.props.htmlFor==='claim-reason-k1'));
 const empty=await staffScreen({api:async()=>withClaims([])});
 assert.match(empty.html(),/No volunteer has recorded arrival or departure times yet/);
});

test('a decision needs a typed reason and says plainly that no hours were written',async()=>{
 const posts=[];
 const screen=await staffScreen({api:async(path,options)=>{if(options)posts.push([path,options.body]);return withClaims([claim()]);}});
 let tree=screen.render(screen.props);
 const confirm=find(tree,node=>node.type==='button'&&node.props['aria-label']==='Confirm the claim from Riley Volunteer');
 const reject=find(tree,node=>node.type==='button'&&node.props['aria-label']==='Reject the claim from Riley Volunteer');
 assert.equal(confirm.props.disabled,true,'a decision cannot be made without a reason');
 assert.equal(reject.props.disabled,true);
 find(tree,node=>node.type==='input'&&node.props.id==='claim-reason-k1').props.onChange({target:{value:'Supervisor saw them on site'}});
 tree=screen.render(screen.props);
 assert.equal(find(tree,node=>node.type==='button'&&node.props['aria-label']==='Confirm the claim from Riley Volunteer').props.disabled,false);
 await find(tree,node=>node.type==='button'&&node.props['aria-label']==='Confirm the claim from Riley Volunteer').props.onClick();
 await flush();
 assert.deepEqual(posts[0],['/volunteer-portal/claims/k1/confirm',{version:1,reason:'Supervisor saw them on site'}]);
 assert.match(screen.html(),/No hours were written — record hours with the volunteer clock as a separate action/);
});

test('a decided or stale claim offers no decision and states why',async()=>{
 const decided=await staffScreen({api:async()=>withClaims([claim({status:'Confirmed',version:2,decidedBy:'staff-1',decidedAt:'',decisionReason:'Supervisor saw them on site'})])});
 assert.equal(find(decided.tree,node=>node.type==='button'&&node.props['aria-label']==='Confirm the claim from Riley Volunteer'),null);
 assert.match(decided.html(),/Supervisor saw them on site/);
 assert.match(decided.html(),/Closed/);
 const stale=await staffScreen({api:async()=>withClaims([claim({sourceCurrent:false,sourceProblem:'The shift date or times changed after this claim was made'})])});
 assert.match(stale.html(),/The shift date or times changed after this claim was made/);
 const suppressed=await staffScreen({api:async()=>withClaims([claim({status:'Suppressed',version:2,decisionReason:'The place this claim belongs to was cancelled'})])});
 assert.match(suppressed.html(),/Suppressed/);
 assert.match(suppressed.html(),/The place this claim belongs to was cancelled/);
});
