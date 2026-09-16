// The states a person actually meets when something goes wrong.
//
// Nine specialists wrote these screens separately, and the states they diverge on
// most are the ones no happy-path fixture reaches: a role that may not be here, a
// register that cannot be read, a source that refused. Each screen is rendered in
// both, and held to the same rules the successful path is held to — named
// controls, labelled fields, an announced outcome, and never a raw error object.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as lib from '../src/lib.js';

function component(file){
 let index=0,effects=[],state=[],keys=[];
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},
  useRef(initial){const i=index++;return state[i]??=({current:initial});},
  useCallback(fn){index++;return fn;},
  useMemo(fn){index++;return fn();},
  useEffect(fn,deps){const i=index++;if(!keys[i]||!deps||deps.some((dep,j)=>dep!==keys[i][j])){keys[i]=deps;effects.push(fn);}}};
 const icon=()=>null;
 const require=id=>id==='react'?mock
  :id==='lucide-react'?new Proxy({},{get:()=>icon})
  :id.includes('/lib')?lib
  :new Proxy({},{get:()=>()=>null});
 const module={exports:{}};
 new Function('require','module','exports',transformSync(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(require,module,module.exports);
 const render=props=>{index=0;const pending=effects;effects=[];const tree=module.exports.default(props);pending.forEach(run=>run());return tree;};
 return render;
}
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function findAll(node,predicate,out=[]){
 if(!node||typeof node!=='object')return out;
 if(predicate(node))out.push(node);
 for(const child of React.Children.toArray(node.props?.children))findAll(child,predicate,out);
 return out;
}
function textOf(node){
 if(node==null||node===false)return '';
 if(typeof node==='string'||typeof node==='number')return String(node);
 if(typeof node!=='object')return '';
 return React.Children.toArray(node.props?.children).map(textOf).join(' ');
}
const ancestorOf=(root,predicate,target)=>{
 let found=false;
 (function walk(node,inside){
  if(!node||typeof node!=='object')return;
  if(node===target&&inside)found=true;
  const next=inside||predicate(node);
  for(const child of React.Children.toArray(node.props?.children)){
   // React.Children.toArray clones, so match on props rather than identity.
   if(child?.props&&target?.props&&child.type===target.type&&child.props===target.props&&next)found=true;
   walk(child,next);
  }
 })(root,false);
 return found;
};

// Each entry drives one screen into a state it must handle: a role that is not
// allowed here, or a workspace that will not answer.
const refuse=status=>async()=>{throw Object.assign(new Error(status===403?'This account may not open that.':'The saved records could not be read.'),{status});};
const base={notify(){},onDirty(){},onCommitted(){},onOpen(){},settings:{},data:{constituents:[],campaigns:[],designations:[],gifts:[]}};
const CASES=[
 {name:'Messaging · role refused',file:'src/features/Messaging.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'viewer'}}},
 {name:'Messaging · register unavailable',file:'src/features/Messaging.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Recurring giving · role refused',file:'src/features/RecurringGiving.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'viewer'}}},
 {name:'Recurring giving · register unavailable',file:'src/features/RecurringGiving.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Accounts & locations · unavailable',file:'src/features/AccountStructure.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Volunteer sign-up · role refused',file:'src/features/VolunteerPortal.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'viewer'}}},
 {name:'Volunteer sign-up · register unavailable',file:'src/features/VolunteerPortal.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Event planning · refused',file:'src/features/EventPlanning.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'viewer'}}},
 {name:'Event planning · unavailable',file:'src/features/EventPlanning.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Board pack · role refused',file:'src/features/BoardPack.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'event-helper'}}},
 {name:'Board pack · catalogue unavailable',file:'src/features/BoardPack.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'staff'}}},
 {name:'Tenant administration · role refused',file:'src/features/TenantAdministration.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'staff'}}},
 {name:'Tenant administration · unavailable',file:'src/features/TenantAdministration.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Data quality · refused',file:'src/features/DataQuality.jsx',props:{...base,api:refuse(403),user:{id:'u1',role:'viewer'}}},
 {name:'Data quality · unavailable',file:'src/features/DataQuality.jsx',props:{...base,api:refuse(503),user:{id:'u1',role:'admin'}}},
 {name:'Public giving · surface unavailable',file:'src/features/PublicGiving.jsx',props:{api:refuse(503),location:{hash:'',search:''}}},
 {name:'Public volunteer · no sign-up link',file:'src/features/PublicVolunteer.jsx',props:{token:'',request:refuse(403)}},
 {name:'Public volunteer · link refused',file:'src/features/PublicVolunteer.jsx',props:{token:'t',request:refuse(403)}},
];

async function drive(entry){
 const render=component(entry.file);
 render(entry.props);
 await flush();
 render(entry.props);
 await flush();
 const tree=render(entry.props);
 return {tree,html:renderToStaticMarkup(tree)};
}

for(const entry of CASES){
 test(entry.name+' is a stated outcome, not a broken screen',async()=>{
  const {tree,html}=await drive(entry);

  // 1. Nothing leaks an object, an unresolved value or a failed number.
  assert.doesNotMatch(html,/\[object Object\]/,'a caught error reached the screen instead of its message');
  assert.doesNotMatch(html,/>undefined<|>NaN<|\$NaN|>null</,'an unresolved value is rendered as text');

  // 2. The state is announced rather than silently replacing the screen.
  const announced=findAll(tree,node=>node.props?.role==='status'||node.props?.role==='alert');
  assert.ok(announced.length>0,'no live region announces this state');
  assert.ok(announced.some(node=>textOf(node).trim().length>12),'the announced region carries no sentence');

  // 3. Every control a person can reach names itself.
  for(const button of findAll(tree,node=>node.type==='button')){
   const name=(button.props['aria-label']||textOf(button)).trim();
   assert.ok(name.length>0,'a button in '+entry.name+' has no accessible name');
   assert.ok(button.props.type,'a button in '+entry.name+' has no explicit type: '+name);
  }
  for(const control of findAll(tree,node=>['input','select','textarea'].includes(node.type))){
   const named=control.props['aria-label']||control.props['aria-labelledby']||control.props.id||ancestorOf(tree,node=>node.type==='label',control);
   assert.ok(named,'a form control in '+entry.name+' has no accessible name');
  }

  // 4. A dense table either swaps for a prioritised list or carries its labels.
  for(const table of findAll(tree,node=>node.type==='table')){
   const swapped=String(table.props.className||'').includes('desktop-record-table');
   if(swapped)continue;
   for(const cell of findAll(table,node=>node.type==='td'))
    assert.ok(cell.props['data-label'],'a table cell in '+entry.name+' carries no mobile label');
  }
 });
}

test('a refused role is told what to do next, never just refused',async()=>{
 // Every screen that can deny access states the reason and the way forward in the
 // same breath. Divergent wording here is what makes a product feel assembled
 // from parts, and a bare "denied" leaves a person with nowhere to go.
 const denials=CASES.filter(entry=>/refused/.test(entry.name));
 for(const entry of denials){
  const {html}=await drive(entry);
  const words=html.replace(/<[^>]+>/g,' ');
  assert.match(words,/administrator|staff|ask|reporting role|sign-up link|new link/i,entry.name+' does not say who can help or what to do next');
 }
});

test('no Phase 8 screen offers a control that acts before its state is known',async()=>{
 // A screen that could not read its records must not present a control that
 // implies it can change them. Reload and retry are the exceptions: they exist
 // precisely to resolve the unknown.
 // Reading again is always safe; recording, issuing, executing or settling is not.
 // Assembling a board pack only reads saved gift records, so it belongs here too.
 const SAFE=/reload|refresh|try again|retry|assemble|sign in|discard|hide|cancel|close|new campaign|new recurring|clear|open dashboard|submit my request|send another|keep my/i;
 for(const entry of CASES.filter(e=>/unavailable|refused/.test(e.name))){
  const {tree}=await drive(entry);
  // A control inside a disabled fieldset is disabled in the browser even though
  // its own props say nothing, so collect those the same way.
  const inertFieldsets=findAll(tree,node=>node.type==='fieldset'&&node.props.disabled);
  const inert=new Set(inertFieldsets.flatMap(set=>findAll(set,node=>node.type==='button').map(node=>node.props)));
  for(const button of findAll(tree,node=>node.type==='button')){
   if(button.props.disabled||inert.has(button.props))continue;
   const name=(button.props['aria-label']||textOf(button)).trim();
   if(button.props.role==='tab')continue;
   assert.ok(SAFE.test(name),entry.name+' offers "'+name+'" while its saved state is unknown');
  }
 }
});
