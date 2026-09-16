import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as library from '../src/lib.js';

function harness(downloads){
 let index=0,state=[],effects=[],keys=[],cleanups=[];
 const mock={...React,
  useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},
  useRef(initial){return state[index++]??=({current:initial});},
  useEffect(effect,deps){const i=index++;if(!keys[i]||!deps||deps.some((d,j)=>d!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=effect();});}}};
 const module={exports:{}};
 const require=id=>id==='react'?mock:id.includes('lib')?{...library,download:(name,content,type)=>downloads.push({name,content,type})}:new Proxy({},{get:()=>()=>null});
 new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/BoardPack.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 const render=props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(effect=>effect());return tree;};
 render.unmount=()=>cleanups.forEach(cleanup=>cleanup?.());
 return render;
}
function find(tree,predicate){
 if(!tree||typeof tree!=='object')return null;
 if(predicate(tree))return tree;
 for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}
 return null;
}
function all(tree,predicate,found=[]){
 if(!tree||typeof tree!=='object')return found;
 if(predicate(tree))found.push(tree);
 for(const child of React.Children.toArray(tree.props?.children))all(child,predicate,found);
 return found;
}
const label=element=>React.Children.toArray(element.props.children).filter(child=>typeof child==='string').join('');
const button=(tree,text)=>all(tree,element=>element.type==='button').find(element=>label(element).includes(text))||null;
const field=(tree,id)=>find(tree,element=>element.type==='input'&&element.props.id===id);
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

const columns=[{key:'location',label:'School location',type:'text'},{key:'source',label:'Location source',type:'text'},{key:'totalCents',label:'Allocated value',type:'money',unit:'cents',currency:'USD'},{key:'allocationCount',label:'Allocation count',type:'number'},{key:'designationCount',label:'Designations',type:'number'}];
const donorColumns=[{key:'donorName',label:'Donor',type:'text'},{key:'firstGiftDate',label:'First gift',type:'date'},{key:'lastGiftDate',label:'Last gift',type:'date'},{key:'totalCents',label:'Total value',type:'money',unit:'cents',currency:'USD'},{key:'giftCount',label:'Gift count',type:'number'}];
const fingerprint='a'.repeat(64);
const assembled=(patch={})=>({
 pack:{id:'board',name:'Board reporting pack',description:'Standard board totals.'},
 range:{},scope:'Current saved gift records. Voided gifts are excluded.',displayRowLimit:100,
 totals:{totalCents:450001,giftCount:6,donorCount:3,monetaryCents:250001,inKindCents:200000,smallestGiftCents:1,largestGiftCents:250000,firstGiftDate:'2025-09-12',lastGiftDate:'2026-08-20',accountLocationCents:300000,designationSchoolCents:150001,locationUnrecordedCents:0},
 accountStructure:{available:true,linkedDesignations:1,digest:'d'.repeat(64)},locationRule:'A designation linked to a location/function account reports under that account; each row states its source and the two are never combined.',
 sections:[
  {id:'location',title:'Giving by school location',description:'One row per school location. A linked designation reports under its location/function account; an unlinked one falls back to its school field.',entity:'giftAllocations',columns,rows:[['100 · North Elementary','Location/function account',300000,2,1],['South middle','Designation school field',150001,4,2]],rowCount:2,displayedRows:2,truncated:false,sourceFingerprint:fingerprint},
  {id:'donor',title:'Donor first and last gift',description:'One row per donor.',entity:'gifts',columns:donorColumns,rows:[['Ada Donor','2025-09-12','2026-07-15',300000,2]],rowCount:140,displayedRows:100,truncated:true,sourceFingerprint:fingerprint}
 ],
 sourceFingerprint:fingerprint,executedAt:'2026-09-15T12:00:00.000Z',...patch});
const workbook=(patch={})=>({complete:true,sourceFingerprint:fingerprint,filename:'wimblo-Board-reporting-pack.xlsx',file:Buffer.from('PKsynthetic').toString('base64'),fileBytes:Buffer.from('PKsynthetic').length,sha256:'b'.repeat(64),rowCount:142,totals:{},sections:[],format:{mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',standard:'Office Open XML (ECMA-376) SpreadsheetML'},...patch});

async function ready({role='staff',responses={},...extra}={}){
 const calls=[],downloads=[],render=harness(downloads);
 const api=async(path,options)=>{
  calls.push([path,options]);
  const handler=responses[path];
  if(typeof handler==='function')return handler(options);
  if(path==='/report-packs')return {packs:[{id:'board',name:'Board reporting pack',sections:[],displayRowLimit:100,formats:['xlsx','pdf','rtf']}]};
  if(path==='/report-packs/board/run')return assembled();
  if(path==='/report-packs/board/export')return workbook();
  throw new Error('Unexpected request '+path);
 };
 const props={user:{id:'u1',role},api,notify:()=>{},onDirty:()=>{},...extra};
 const state={calls,downloads,props,render,tree:render(props)};
 await flush();state.tree=render(props);
 return state;
}
const html=state=>renderToStaticMarkup(state.render(state.props));
const assemble=async state=>{await find(state.render(state.props),element=>element.type==='form').props.onSubmit({preventDefault(){}});await flush();return state.render(state.props);};

test('a reporting role assembles the pack, sees every named drilldown and downloads only on an explicit choice',async()=>{
 const state=await ready();
 assert.match(html(state),/No pack is assembled yet/);
 assert.equal(state.downloads.length,0,'nothing downloads before a format is chosen');
 const tree=await assemble(state);
 assert.deepEqual(state.calls.map(([path])=>path),['/report-packs','/report-packs/board/run']);
 assert.match(html(state),/Giving by school location/);
 assert.match(html(state),/Donor first and last gift/);
 assert.match(html(state),/\$4,500\.01/,'money renders from exact integer cents');
 assert.match(html(state),/Board pack assembled from current saved records/);
 assert.equal(state.downloads.length,0,'rendering the pack never starts a download');
 const download=button(tree,'Excel workbook');
 assert.ok(download,'an explicit workbook button is offered');
 await download.props.onClick();await flush();
 assert.equal(state.downloads.length,1);
 assert.equal(state.downloads[0].name,'wimblo-Board-reporting-pack.xlsx');
 assert.equal(state.downloads[0].type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 assert.ok(state.downloads[0].content instanceof Uint8Array,'the verified bytes are downloaded, not a base64 string');
 assert.deepEqual(state.calls.at(-1)[1].body,{format:'xlsx',fingerprint:fingerprint});
 assert.match(html(state),/downloaded/);
 assert.match(html(state),/not verified here/,'the download claim stays honest about rendering');
 for(const text of ['PDF document','Rich text'])assert.ok(button(state.render(state.props),text),text+' is offered as its own explicit choice');
});

test('the screen shows each location row with the source it came from and how much is account linked',async()=>{
 const state=await ready();await assemble(state);
 const markup=html(state);
 assert.match(markup,/Location\/function account/);
 assert.match(markup,/Designation school field/);
 assert.match(markup,/Account-linked value/);
 assert.match(markup,/School-field value/);
 assert.match(markup,/Location not recorded/);
 assert.match(markup,/\$3,000\.00/,'the account-linked coverage figure is shown from exact integer cents');
 assert.match(markup,/never combined/,'the screen says the two location sources are never mixed');
 assert.match(markup,/1 linked/);
 const cells=all(state.render(state.props),element=>element.type==='td').filter(cell=>cell.props['data-label']==='Location source');
 assert.deepEqual(cells.map(cell=>React.Children.toArray(cell.props.children).join('')),['Location/function account','Designation school field']);
});

test('the screen states which rows are on screen and that a file carries the rest',async()=>{
 const state=await ready();await assemble(state);
 const markup=html(state);
 assert.match(markup,/Showing the first 100 of 140 rows on screen/);
 assert.match(markup,/Every row is included in a downloaded file/);
 assert.match(markup,/showing the first 100/);
});

test('an empty pack says so plainly instead of rendering an empty table',async()=>{
 const empty=assembled({totals:{totalCents:0,giftCount:0,donorCount:0,monetaryCents:0,inKindCents:0,smallestGiftCents:null,largestGiftCents:null,firstGiftDate:null,lastGiftDate:null,accountLocationCents:0,designationSchoolCents:0,locationUnrecordedCents:0},
  sections:[{id:'location',title:'Giving by school location',description:'One row per school location.',entity:'giftAllocations',columns,rows:[],rowCount:0,displayedRows:0,truncated:false,sourceFingerprint:fingerprint}]});
 const state=await ready({responses:{'/report-packs/board/run':()=>empty}});
 await assemble(state);
 assert.match(html(state),/No gift matched this section in the pack period/);
 assert.equal(find(state.render(state.props),element=>element.type==='tbody'),null,'no empty table is drawn');
 assert.match(html(state),/\$0\.00/);
});

test('a changed source refuses the download, clears the reviewed pack and asks for a fresh assembly',async()=>{
 let stale=true;
 const state=await ready({responses:{'/report-packs/board/export':()=>{if(stale){const error=new Error('Board pack sources changed since it was assembled.');error.status=409;throw error;}return workbook();}}});
 await assemble(state);
 await button(state.render(state.props),'PDF document').props.onClick();await flush();
 assert.equal(state.downloads.length,0,'a refused export downloads nothing');
 const markup=html(state);
 assert.match(markup,/sources changed since it was assembled/);
 assert.match(markup,/Assemble the pack again to continue/);
 assert.equal(find(state.render(state.props),element=>element.type==='table'),null,'the stale pack is cleared from the screen');
 assert.ok(find(state.render(state.props),element=>element.props?.role==='alert'),'the failure is announced as an alert');
 stale=false;
 await assemble(state);
 await button(state.render(state.props),'PDF document').props.onClick();await flush();
 assert.equal(state.downloads.length,1);
});

test('an unverifiable export is rejected by the screen before anything is written',async()=>{
 for(const patch of [{complete:false},{sourceFingerprint:'c'.repeat(64)},{fileBytes:3},{file:5}]){
  const state=await ready({responses:{'/report-packs/board/export':()=>workbook(patch)}});
  await assemble(state);
  await button(state.render(state.props),'Excel workbook').props.onClick();await flush();
  assert.equal(state.downloads.length,0,'no file is written for '+JSON.stringify(patch));
  assert.match(html(state),/could not be verified|did not match its declared size/);
 }
});

test('a role without reporting access requests nothing and keeps no assembled data on downgrade',async()=>{
 const denied=await ready({role:'event-helper'});
 assert.deepEqual(denied.calls,[]);
 assert.match(html(denied),/Your role cannot open reporting/);
 assert.equal(button(denied.render(denied.props),'Assemble board pack'),null);
 const state=await ready();
 await assemble(state);
 assert.match(html(state),/North Elementary/);
 state.props.user={id:'u1',role:'event-helper'};
 const after=renderToStaticMarkup(state.render(state.props));
 assert.doesNotMatch(after,/North Elementary|Ada Donor/,'private figures vanish immediately on downgrade');
 assert.match(after,/Your role cannot open reporting/);
});

test('a failed assembly is announced and leaves the previous pack out of the way',async()=>{
 let fail=true;
 const state=await ready({responses:{'/report-packs/board/run':()=>{if(fail)throw new Error('The board pack period must start before it ends.');return assembled();}}});
 await assemble(state);
 assert.match(html(state),/must start before it ends/);
 assert.equal(find(state.render(state.props),element=>element.type==='table'),null);
 fail=false;
 await assemble(state);
 assert.match(html(state),/Giving by school location/);
 assert.doesNotMatch(html(state),/must start before it ends/);
});

test('changing the period clears the assembled pack so an export can never be pinned to stale review',async()=>{
 const state=await ready();
 await assemble(state);
 assert.ok(find(state.render(state.props),element=>element.type==='table'));
 field(state.render(state.props),'board-pack-start').props.onChange({target:{value:'2026-01-01'}});
 const tree=state.render(state.props);
 assert.equal(find(tree,element=>element.type==='table'),null);
 assert.equal(field(tree,'board-pack-start').props.value,'2026-01-01');
 await assemble(state);
 assert.deepEqual(state.calls.at(-1)[1].body,{startDate:'2026-01-01'});
});

test('the screen is keyboard and screen reader usable: labelled controls, headed tables and announced regions',async()=>{
 const state=await ready();
 const tree=await assemble(state);
 for(const id of ['board-pack-start','board-pack-end']){
  const input=field(tree,id);
  assert.ok(input,id+' exists');
  assert.equal(input.props.type,'date');
  assert.ok(find(tree,element=>element.type==='label'&&element.props.htmlFor===id),id+' has its own label');
  assert.equal(input.props['aria-describedby'],'board-pack-period-hint');
 }
 assert.ok(find(tree,element=>element.type==='legend'));
 assert.ok(find(tree,element=>element.type==='h1'));
 for(const section of assembled().sections)assert.ok(find(tree,element=>element.type==='h2'&&element.props.id==='board-pack-'+section.id),section.id+' has a heading its panel points to');
 assert.ok(find(tree,element=>element.props?.role==='status'&&element.props['aria-live']==='polite'),'progress is announced politely');
 for(const table of all(tree,element=>element.type==='table')){
  assert.ok(find(table,element=>element.type==='caption'),'each table is captioned');
  for(const header of all(table,element=>element.type==='th'))assert.equal(header.props.scope,'col');
 }
 // Every body cell carries its own column label, which is what the mobile
 // stacked layout renders instead of a header row that has scrolled away.
 for(const cell of all(tree,element=>element.type==='td'))assert.equal(typeof cell.props['data-label'],'string');
 for(const control of all(tree,element=>element.type==='button'))assert.notEqual(label(control).trim(),'','every control has a text name');
 assert.equal(all(tree,element=>element.type==='button').every(control=>control.props.type==='submit'||control.props.type==='button'),true);
});
