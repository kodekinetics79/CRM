import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {dateLabel} from '../src/lib.js';

function harness(search=''){
 let index=0,state=[],effects=[],effectKeys=[];
 globalThis.window={location:{search,pathname:'/'},history:{replaceState(){}}};globalThis.document={title:''};
 const mock={...React,lazy:()=>()=>null,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(effect,deps){const i=index++;if(!effectKeys[i]||deps.some((dep,j)=>dep!==effectKeys[i][j])){effectKeys[i]=deps;effects.push(effect);}}};
 const module={exports:{}},require=id=>id==='react'?mock:id==='lucide-react'?new Proxy({},{get:()=>()=>null}):id==='../components/Brand'?()=>React.createElement('span',null,'wimblo'):{dateLabel};
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/EventCheckin.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 return props=>{index=0;const tree=module.exports.default(props);const pending=effects;effects=[];pending.forEach(effect=>effect());return tree;};
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
const html=tree=>renderToStaticMarkup(tree),button=(tree,name)=>find(tree,e=>e.type==='button'&&React.Children.toArray(e.props.children).includes(name));
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
const event={id:'event-1',name:'Synthetic event',date:'2026-09-13',location:'Synthetic hall',version:2},ticket={id:'ticket-1',attendeeName:'Casey Test',version:1,checkedIn:false,checkedInAt:null},user={id:'helper-1',name:'Synthetic Helper',role:'event-helper'};

test('helper empty state and security entry request no financial workspace',async()=>{
 for(const search of ['','?view=account-security']){
  const calls=[],render=harness(search),props={user,api:async path=>{calls.push(path);return {events:[]};}};
  render(props);await flush();const tree=render(props);
  assert.deepEqual(calls,search?[]:['/event-checkin/events']);assert.doesNotMatch(html(tree),/Giving insights|Record a gift|Search all workspace/);
  if(!search)assert.match(html(tree),/No events assigned yet/);
 }
});
test('check-in waits for authoritative success and locks competing actions while pending',async()=>{
 const calls=[];let complete;
 const api=async(path,options)=>{calls.push([path,options]);if(options?.method==='POST')return new Promise(resolve=>{complete=resolve;});if(path==='/event-checkin/events')return {events:[event]};return {event,tickets:[ticket],nextCursor:null};};
 const render=harness(),props={api,user};render(props);await flush();let tree=render(props);
 find(tree,e=>e.type==='button'&&e.props.className==='event-helper-event').props.onClick();await flush();tree=render(props);
 const action=find(tree,e=>e.type==='button'&&e.props['aria-label']==='Check in Casey Test'),pending=action.props.onClick();tree=render(props);
 assert.doesNotMatch(html(tree),/Casey Test is checked in/);assert.equal(find(tree,e=>e.type==='button'&&e.props['aria-label']==='Check in Casey Test').props.disabled,true);
 assert.equal(button(tree,'Sign out').props.disabled,true);assert.deepEqual(calls.at(-1)[1].body,{version:1,eventVersion:2});
 complete({event:{id:event.id,version:3},ticket:{...ticket,version:2,checkedIn:true,checkedInAt:'2026-09-13T12:00:00.000Z'}});await pending;tree=render(props);
 assert.match(html(tree),/Casey Test is checked in/);assert.equal(find(tree,e=>e.type==='button'&&e.props['aria-label']==='Check in Casey Test'),null);assert.equal(calls.filter(([,options])=>options?.method==='POST').length,1);
});
test('an interrupted response refreshes safe attendance once without replaying a mutation',async()=>{
 const calls=[];let checkedIn=false;
 const api=async(path,options)=>{calls.push([path,options]);if(options?.method==='POST'){checkedIn=true;throw Error('Synthetic lost response');}if(path==='/event-checkin/events')return {events:[event]};return {event:{...event,version:checkedIn?3:2},tickets:[{...ticket,checkedIn,version:checkedIn?2:1}],nextCursor:null};};
 const render=harness(),props={api,user};render(props);await flush();let tree=render(props);find(tree,e=>e.type==='button'&&e.props.className==='event-helper-event').props.onClick();await flush();tree=render(props);
 await find(tree,e=>e.type==='button'&&e.props['aria-label']==='Check in Casey Test').props.onClick();tree=render(props);
 assert.match(html(tree),/response was interrupted/);assert.match(html(tree),/Checked in/);assert.doesNotMatch(html(tree),/is checked in\./);assert.equal(calls.filter(([,options])=>options?.method==='POST').length,1);assert.equal(calls.filter(([path,options])=>path.includes('/events/event-1?')&&!options).length,2);
});
