import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadWorkspaceSession} from '../src/workspaceSession.js';

function harness(){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){return state[index++]??=({current:initial});},useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((d,j)=>d!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}},require=id=>id==='react'?mock:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/AccountSecurity.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 return props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(effect=>effect());return tree;};
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const result=find(child,predicate);if(result)return result;}return null;}
const text=element=>React.Children.toArray(element.props.children).filter(child=>typeof child==='string').join('');
const button=(tree,label)=>find(tree,element=>element.type==='button'&&text(element)===label);
const field=(tree,label)=>find(find(tree,element=>element.type==='label'&&text(element)===label),element=>element.type==='input');
const submit=tree=>find(tree,element=>element.type==='form').props.onSubmit({preventDefault(){}});
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const codes=['RECOVERY-ONE','RECOVERY-TWO'];

for(const role of ['admin','staff','viewer','event-helper']){
 test(`production ${role} enrolls its own factor, saves recovery codes and reauthenticates before business access`,async()=>{
  const calls=[],user={id:`own-${role}`,email:`${role}@example.test`,role},render=harness();
  let reauthenticated=0,freshSignIn=false;
  const api=async(path,options)=>{
   calls.push([path,options]);
   if(path==='/auth/me')return {user,...(!freshSignIn?{mfaEnrollmentRequired:true}:{})};
   if(path==='/workspace')return {user,data:{gifts:[]}};
   if(path==='/auth/mfa/status')return {available:true,enabled:false,required:true};
   if(path==='/auth/mfa/enroll')return {secret:'SYNTHETIC-OWN-SETUP',expiresAt:'2026-09-13T13:00:00Z'};
   if(path==='/auth/mfa/confirm')return {recoveryCodes:codes};
   assert.fail('Unsupported security operation '+path);
  };
  assert.equal((await loadWorkspaceSession(api)).kind,'enrollment');
  assert.deepEqual(calls.map(([path])=>path),['/auth/me']);
  const props={api,user,required:true,onReauthenticate:()=>reauthenticated++};
  render(props);await flush();
  let tree=render(props);
  assert.match(renderToStaticMarkup(tree),/staff, viewers and event helpers/);
  field(tree,'Current password').props.onChange({target:{value:'OwnPassword!2026'}});
  submit(render(props));await flush();
  tree=render(props);
  assert.equal(field(tree,'Setup key').props.value,'SYNTHETIC-OWN-SETUP');
  assert.match(renderToStaticMarkup(tree),new RegExp(user.email));
  assert.deepEqual(calls.find(([path])=>path==='/auth/mfa/enroll')[1].body,{password:'OwnPassword!2026'});
  field(tree,'Six-digit authenticator code').props.onChange({target:{value:'123456'}});
  submit(render(props));await flush();
  tree=render(props);
  assert.deepEqual(calls.find(([path])=>path==='/auth/mfa/confirm')[1].body,{code:'123456'});
  assert.match(renderToStaticMarkup(tree),/Save your recovery codes/);
  assert.equal(button(tree,'Continue to sign in').props.disabled,true);
  assert.equal(reauthenticated,0);
  assert.equal(calls.some(([path])=>path==='/workspace'),false);
  find(tree,element=>element.type==='input'&&element.props.type==='checkbox').props.onChange({target:{checked:true}});
  tree=render(props);assert.equal(button(tree,'Continue to sign in').props.disabled,false);
  button(tree,'Continue to sign in').props.onClick();
  assert.equal(reauthenticated,1);
  assert.equal((await loadWorkspaceSession(api)).kind,'enrollment','confirming enrollment alone does not make a fresh authenticated session');
  freshSignIn=true;
  const result=await loadWorkspaceSession(api);
  assert.equal(result.kind,role==='event-helper'?'helper':'workspace');
  assert.equal(calls.filter(([path])=>path==='/workspace').length,role==='event-helper'?0:1);
 });
}

test('required factor has no disable action for any role, including status-enforced policy without parent hint',async()=>{
 for(const role of ['admin','staff','viewer','event-helper']){
  const calls=[],render=harness(),props={user:{id:role,role},api:async(path,options)=>{calls.push([path,options]);return {available:true,enabled:true,required:true,recoveryCodesRemaining:6};}};
  render(props);await flush();const tree=render(props);
  assert.equal(button(tree,'Disable MFA'),null);
  assert.equal(find(tree,element=>element.type==='form'),null);
  assert.match(renderToStaticMarkup(tree),/MFA cannot be disabled/);
  assert.match(renderToStaticMarkup(tree),/unused recovery code/);
  assert.equal(calls.filter(([,options])=>options).length,0);
 }
});

test('optional local factor retains explicit password-plus-code disabling and ends the old session',async()=>{
 const calls=[],render=harness();let ended=0;
 const props={user:{id:'local-staff',role:'staff'},api:async(path,options)=>{calls.push([path,options]);return {available:true,enabled:true,required:false,recoveryCodesRemaining:8};},onReauthenticate:()=>ended++};
 render(props);await flush();let tree=render(props);
 assert.ok(button(tree,'Disable MFA'));
 assert.doesNotMatch(renderToStaticMarkup(tree),/MFA cannot be disabled/);
 field(tree,'Current password').props.onChange({target:{value:'LocalPassword!2026'}});
 field(render(props),'Authenticator or recovery code').props.onChange({target:{value:'RECOVERY-ONE'}});
 submit(render(props));await flush();
 assert.deepEqual(calls.find(([path])=>path==='/auth/mfa/disable')[1].body,{password:'LocalPassword!2026',code:'RECOVERY-ONE'});
 assert.equal(ended,1);
});

test('required enrollment unavailable is a blocked setup with operator guidance, not a password-only fallback',async()=>{
 const render=harness(),props={required:true,user:{id:'viewer',role:'viewer'},api:async()=>({available:false,enabled:false,required:true})};
 render(props);await flush();const tree=render(props),html=renderToStaticMarkup(tree);
 assert.match(html,/Business records remain locked/);
 assert.match(html,/organization administrator/);
 assert.equal(button(tree,'Set up authenticator'),null);
 assert.equal(button(tree,'Disable MFA'),null);
 assert.doesNotMatch(html,/Your password remains required for sign-in/);
});

test('rejected authenticator confirmation retains setup and displays the error without recovery or session success',async()=>{
 const render=harness();let ended=0;
 const props={required:true,user:{id:'staff',email:'staff@example.test',role:'staff'},api:async path=>{
  if(path==='/auth/mfa/status')return {available:true,enabled:false,required:true};
  if(path==='/auth/mfa/enroll')return {secret:'SYNTHETIC-SETUP',expiresAt:'2026-09-13T13:00:00Z'};
  throw new Error('Code was not accepted. Use the next code from your authenticator.');
 },onReauthenticate:()=>ended++};
 render(props);await flush();field(render(props),'Current password').props.onChange({target:{value:'OwnPassword!2026'}});
 submit(render(props));await flush();field(render(props),'Six-digit authenticator code').props.onChange({target:{value:'000000'}});
 submit(render(props));await flush();const tree=render(props);
 assert.match(renderToStaticMarkup(tree),/role="alert".*Code was not accepted/);
 assert.ok(field(tree,'Setup key'));
 assert.equal(field(tree,'Six-digit authenticator code').props.value,'');
 assert.equal(button(tree,'Continue to sign in'),null);
 assert.equal(ended,0);
});

