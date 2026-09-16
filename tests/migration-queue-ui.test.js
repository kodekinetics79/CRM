import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {transformSync} from 'esbuild';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import * as contract from '../shared/migrationContract.js';import * as queue from '../shared/migrationQueue.js';import * as lib from '../src/lib.js';
function harness(rows){let index=0,state=[];const hooks={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){return state[index++]??=({current:initial});},useEffect(){index++;}};
 const module={exports:{}},require=id=>id==='react'?hooks:id==='lucide-react'?new Proxy({},{get:()=>()=>null}):id.includes('migrationContract')?contract:id.includes('migrationQueue')?queue:id==='./MigrationReview'?{ControlTotals:()=>null,ValidationResults:()=>null,BatchLineage:()=>null}:{...lib,parseCSV:()=>rows,download(){}};
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/Migration.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 return props=>{index=0;return module.exports.default(props);};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const result=find(child,predicate);if(result)return result;}return null;}
const button=(tree,label)=>find(tree,e=>e.type==='button'&&React.Children.toArray(e.props.children).includes(label)),html=tree=>renderToStaticMarkup(tree);
test('guided user reviews each part and resumes an uncertain saved response through exact replay without duplicate progress',async()=>{
 const rows=Array.from({length:501},(_,i)=>({sourceId:'synthetic-'+i,name:'Synthetic '+i,type:'Individual',preference:'Post'})),render=harness(rows),saved=new Map(),calls=[],dirty=[];let ambiguous=true;
 const api=async(path,{body}={})=>{calls.push([path,body]);if(path==='/migration/batches')return {batches:[]};if(path==='/migration/preview')return {valid:true,replayed:saved.has(body.fileKey),previewDigest:'a'.repeat(64),rows:[],summary:{}};
  if(path==='/migration/commit'){if(!saved.has(body.fileKey))saved.set(body.fileKey,body.files[0].rows.length);if(ambiguous){ambiguous=false;throw Error('Synthetic response lost after save');}return {batchId:body.fileKey,replayed:true,summary:{},reconciliation:{expectedCreateCounts:{constituents:0},actualCreateCounts:{constituents:0},expectedNewGiftCents:0,actualNewGiftCents:0}};}
  if(path.startsWith('/migration/source-reconciliation'))return {source:'CRM export',mappingCount:[...saved.values()].reduce((a,b)=>a+b,0),batchCount:saved.size,mappedCounts:{constituents:501,designations:0,gifts:0},integrity:{reconciled:true,changed:0,missing:0},scope:'Retained source records only.'};assert.fail(path);};
 const props={api,user:{role:'admin'},onDirty:value=>dirty.push(value)};
 button(render(props),'Use guided import').props.onClick();
 await find(render(props),e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'synthetic-original.csv',size:600001,text:async()=>''}],value:'file'}});
 await find(render(props),e=>e.type==='form').props.onSubmit({preventDefault(){}});let tree=render(props);assert.match(html(tree),/Review part 1 of 2/);assert.equal(calls.filter(([path])=>path==='/migration/commit').length,0);
 const confirm=()=>find(render(props),e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
 confirm();await button(render(props),'Commit validated batch').props.onClick();tree=render(props);assert.match(html(tree),/Synthetic response lost/);assert.equal(saved.size,1);assert.equal(button(tree,'Reconciliation reviewed — next part'),null);
 await button(tree,'Preview current part').props.onClick();confirm();await button(render(props),'Commit validated batch').props.onClick();tree=render(props);assert.match(html(tree),/1 parts saved or replayed/);assert.equal(saved.size,1);assert.match(html(tree),/Review part 1 of 2/);
 button(tree,'Reconciliation reviewed — next part').props.onClick();tree=render(props);assert.match(html(tree),/Review part 2 of 2/);assert.equal(calls.filter(([path])=>path==='/migration/commit').length,2);
 await button(tree,'Preview current part').props.onClick();confirm();await button(render(props),'Commit validated batch').props.onClick();tree=render(props);assert.match(html(tree),/All prepared parts saved/);assert.equal(saved.size,2);assert.equal([...saved.values()].reduce((a,b)=>a+b,0),501);assert.equal(dirty.at(-1),false);
 await button(tree,'Verify retained source totals').props.onClick();assert.match(html(render(props)),/Retained source mappings reconcile/);assert.match(html(render(props)),/do not certify that the entire buyer export/);
});
test('implicit contact preferences block guided preparation before preview or commit',async()=>{
 const render=harness([{sourceId:'d1',name:'Synthetic',type:'Individual'}]),calls=[],props={api:async path=>{calls.push(path);return {batches:[]};},user:{role:'admin'}};
 button(render(props),'Use guided import').props.onClick();await find(render(props),e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'synthetic.csv',size:100,text:async()=>''}],value:'file'}});
 await find(render(props),e=>e.type==='form').props.onSubmit({preventDefault(){}});assert.match(html(render(props)),/explicit nonblank contact preference/);assert.equal(calls.length,0);
});
test('committing the next part clears old totals and rejects a delayed earlier reconciliation',async()=>{
 const render=harness(Array.from({length:501},(_,i)=>({sourceId:'late-'+i,name:'Synthetic '+i,type:'Individual',preference:'Post'})));let resolveTotals;let commits=0;
 const props={user:{role:'admin'},api:async(path,{body}={})=>{
 if(path==='/migration/batches')return {batches:[]};
 if(path==='/migration/preview')return {valid:true,previewDigest:'b'.repeat(64),rows:[],summary:{}};
 if(path==='/migration/commit'){commits++;return {batchId:body.fileKey,summary:{},reconciliation:{expectedCreateCounts:{},actualCreateCounts:{},expectedNewGiftCents:0,actualNewGiftCents:0}};}
 if(path.startsWith('/migration/source-reconciliation'))return new Promise(resolve=>{resolveTotals=resolve;});assert.fail(path);}};
 const confirm=()=>find(render(props),e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});
 button(render(props),'Use guided import').props.onClick();await find(render(props),e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'delayed.csv',size:100,text:async()=>''}],value:'file'}});
 await find(render(props),e=>e.type==='form').props.onSubmit({preventDefault(){}});confirm();await button(render(props),'Commit validated batch').props.onClick();
 const earlier=button(render(props),'Verify retained source totals').props.onClick();
 button(render(props),'Reconciliation reviewed — next part').props.onClick();await button(render(props),'Preview current part').props.onClick();confirm();await button(render(props),'Commit validated batch').props.onClick();
 resolveTotals({mappingCount:500,batchCount:1,mappedCounts:{constituents:500,designations:0,gifts:0},integrity:{reconciled:true,changed:0,missing:0},scope:'Old snapshot.'});await earlier;
 assert.equal(commits,2);assert.match(html(render(props)),/All prepared parts saved/);assert.doesNotMatch(html(render(props)),/Retained source mappings reconcile|Old snapshot/);assert.equal(button(render(props),'Verify retained source totals').props.disabled,false);
});
