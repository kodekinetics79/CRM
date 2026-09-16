import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import * as lib from '../src/lib.js';
import * as categories from '../shared/constituentTypes.js';
const compile=(path,require)=>{const module={exports:{}};new Function('require','module','exports',transformSync(readFileSync(new URL(path,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(require,module,module.exports);return module.exports;};
const schema=compile('../src/schema.js',()=>lib);
function harness(record){let index=0,state=[],dirty=[],payloads=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];}};
 const component=compile('../src/components/RecordForm.jsx',id=>id==='react'?mock:id==='../schema'?schema:id==='../lib'?lib:id.includes('constituentTypes')?categories:new Proxy({},{get:(_,name)=>function Stub(){return null;}})).default;
 const props={collection:'constituents',record,data:{constituents:[]},onSave:async p=>payloads.push(p),onCancel(){},onDirty:v=>dirty.push(v)};
 return {payloads,dirty,render(){index=0;return component(props);}};
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const r=find(child,predicate);if(r)return r;}return null;}
const checkbox=(tree,type)=>find(tree,e=>e.type==='label'&&React.Children.toArray(e.props.children).includes(type))?.props.children[0];
const submit=tree=>find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
test('new person can select all three additional categories and save one explicit canonical profile',async()=>{
 const h=harness();let tree=h.render();for(const type of ['Staff','Employee','Alumni']){checkbox(tree,type).props.onChange({target:{checked:true}});tree=h.render();}await submit(tree);assert.equal(h.payloads.length,1);assert.equal(h.payloads[0].type,'Individual');assert.deepEqual(h.payloads[0].additionalTypes,['Alumni','Employee','Staff']);assert.deepEqual(h.payloads[0].contacts,[]);assert.equal(h.payloads[0].role,undefined);assert.ok(h.dirty.every(Boolean));
});
test('editing a legacy employee keeps the primary category and explicit empty extras',async()=>{const h=harness({type:'Employee',name:'Legacy employee'});await submit(h.render());assert.equal(h.payloads[0].type,'Employee');assert.deepEqual(h.payloads[0].additionalTypes,[]);});
test('primary category change preserves existing extras visibly and blocks saving until incompatible categories are explicitly removed',async()=>{
 const h=harness({type:'Individual',name:'One identity',additionalTypes:['Staff']});let tree=h.render();find(tree,e=>e.props?.field?.key==='type').props.onChange('Business');tree=h.render();assert.ok(find(tree,e=>e.type==='button'&&e.props.className==='btn btn-primary').props.disabled);await submit(tree);assert.equal(h.payloads.length,0);
 const removal=find(h.render(),e=>e.type==='input'&&e.props.type==='checkbox'&&e.props.checked);assert.ok(removal);removal.props.onChange({target:{checked:false}});tree=h.render();assert.equal(find(tree,e=>e.type==='button'&&e.props.className==='btn btn-primary').props.disabled,false);await submit(tree);assert.equal(h.payloads[0].type,'Business');assert.deepEqual(h.payloads[0].additionalTypes,[]);
});
test('selecting an existing extra as primary requires deliberate removal of redundant category',async()=>{const h=harness({type:'Individual',name:'One identity',additionalTypes:['Employee']});let tree=h.render();find(tree,e=>e.props?.field?.key==='type').props.onChange('Employee');tree=h.render();await submit(tree);assert.equal(h.payloads.length,0);const removal=find(h.render(),e=>e.type==='input'&&e.props.checked);removal.props.onChange({target:{checked:false}});await submit(h.render());assert.equal(h.payloads[0].type,'Employee');assert.deepEqual(h.payloads[0].additionalTypes,[]);});
function listHarness(){let index=0,state=[],downloads=[];const mock={...React,useState(initial){const i=index++;state[i]??=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=v];}};const component=compile('../src/features/Records.jsx',id=>id==='react'?mock:id==='../schema'?schema:id==='../lib'?{...lib,download:(...args)=>downloads.push(args)}:id.includes('constituentTypes')?categories:new Proxy({},{get:()=>function Stub(){return null;}})).default;
 const data={constituents:[{id:'one',name:'One person',type:'Individual',additionalTypes:['Staff','Employee'],email:'one@example.test',preference:'Do not contact'},{id:'two',name:'Other person',type:'Alumni',preference:'Email'}]};return {downloads,render(){index=0;return component({collection:'constituents',data,onCreate(){},onOpen(){},notify(){},canWrite:true});}};
}
test('directory category filter includes extra membership once and retains preference',()=>{const h=listHarness();let tree=h.render();find(tree,e=>e.type==='select').props.onChange({target:{value:'Staff'}});tree=h.render();const table=find(tree,e=>Array.isArray(e.props?.rows));assert.equal(table.props.rows.length,1);assert.equal(table.props.rows[0].id,'one');assert.equal(table.props.rows[0].preference,'Do not contact');});
test('directory CSV retains primary category separately and includes effective additional categories',()=>{const h=listHarness(),tree=h.render();find(tree,e=>e.type==='button'&&React.Children.toArray(e.props.children).includes('Export CSV')).props.onClick();assert.equal(h.downloads.length,1);const csv=h.downloads[0][1];assert.match(csv,/Primary category/);assert.match(csv,/Additional categories/);assert.match(csv,/"Individual"/);assert.match(csv,/"Employee; Staff"/);assert.equal((csv.match(/One person/g)||[]).length,1);});
test('directory membership search and unknown category filter never duplicate or broaden identities',()=>{const h=listHarness();let tree=h.render();find(tree,e=>e.type==='input').props.onChange({target:{value:'Staff'}});tree=h.render();assert.equal(find(tree,e=>Array.isArray(e.props?.rows)).props.rows.length,1);find(tree,e=>e.type==='select').props.onChange({target:{value:'admin'}});assert.equal(find(h.render(),e=>Array.isArray(e.props?.rows)).props.rows.length,0);});
