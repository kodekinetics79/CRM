import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {money,toCSV,parseCSV} from '../src/lib.js';
import * as migrationContract from '../shared/migrationContract.js';

// State/event isolation; desktop/mobile browser integration is checked separately.
function harness(file,exportName='default',dependencies={}) {
 let index=0,state=[];
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(){index++;}};
 const module={exports:{}},require=id=>id==='react'?mock:id==='lucide-react'?new Proxy({},{get:()=>()=>null}):id==='../../shared/migrationContract.js'?migrationContract:dependencies[id]||{money,toCSV,download(){}};
 new Function('React','require','module','exports',transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);
 return props=>{index=0;return module.exports[exportName](props);};
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
const html=tree=>renderToStaticMarkup(tree);
const button=(tree,text)=>find(tree,e=>e.type==='button'&&React.Children.toArray(e.props.children).includes(text));

test('validation review paginates and isolates errors while exporting the complete sanitized checklist',()=>{
 const downloaded=[],rows=Array.from({length:125},(_,i)=>({file:1,collection:'gifts',row:i+1,sourceId:i===100?'=UNSAFE()':'gift-'+i,status:i===100?'Error':'Valid',error:i===100?'Wrong source allocation':''}));
 const render=harness('../src/features/MigrationReview.jsx','ValidationResults',{'../lib':{money,toCSV,download:(...args)=>downloaded.push(args)}}),props={rows};
 let tree=render(props);assert.match(html(tree),/1–50 of 125 rows/);assert.doesNotMatch(html(tree),/gift-50</);
 button(tree,'Next rows').props.onClick();tree=render(props);assert.match(html(tree),/51–100 of 125 rows/);
 find(tree,e=>e.type==='select').props.onChange({target:{value:'errors'}});tree=render(props);assert.match(html(tree),/1–1 of 1 rows/);assert.doesNotMatch(html(tree),/gift-0</);
 button(tree,'Download error checklist').props.onClick();assert.equal(downloaded.length,1);assert.match(downloaded[0][1],/"101"/);assert.match(downloaded[0][1],/"'=UNSAFE\(\)"/);assert.doesNotMatch(downloaded[0][1],/gift-0/);
});

test('control totals default to new revenue and separately expose reused amounts and account codes',()=>{
 const group=(total)=>({byType:[{key:'Cash',giftCount:1,totalCents:total}],byMethod:[{key:'Check',giftCount:1,totalCents:total}],byDesignation:[{sourceId:'fund-1',accountCode:'ACCOUNT-99',allocationCount:1,totalCents:total}]}),props={controls:{new:group('123'),reused:group('999'),all:group('1122')}},render=harness('../src/features/MigrationReview.jsx','ControlTotals');
 let tree=render(props);assert.match(html(tree),/\$1\.23/);assert.doesNotMatch(html(tree),/\$9\.99/);assert.match(html(tree),/ACCOUNT-99/);
 find(tree,e=>e.type==='select').props.onChange({target:{value:'reused'}});tree=render(props);assert.match(html(tree),/\$9\.99/);assert.match(html(tree),/do not add revenue again/);
});

test('older batch controls remain explicitly unavailable and missing lineage is not called a validation success',()=>{
 assert.match(html(harness('../src/features/MigrationReview.jsx','ControlTotals')({})),/not captured for this older batch/);
 const detail={batch:{batchId:'old',sourceFiles:[]},lineage:[{collection:'gifts',sourceId:'g1',recordId:'record-1',status:'Missing'}],integrity:{missing:1,changed:0,unchanged:0},lineageCoverage:'Newly created rows only'},tree=harness('../src/features/MigrationReview.jsx','BatchLineage')({detail});
 assert.match(html(tree),/1 missing/);assert.match(html(tree),/record-1/);assert.match(html(tree),/Newly created rows only/);assert.doesNotMatch(html(tree),/No validation errors/);
});

test('successful batch save remains explicit when subsequent history refresh fails',async()=>{
 const calls=[],preview={valid:true,previewDigest:'digest',summary:{monetaryContributionCents:'12345',newGiftTotalCents:'0',giftTotalCents:'12345'},rows:[]};
 const api=async(path,options)=>{calls.push([path,options]);if(path==='/migration/preview')return preview;if(path==='/migration/commit')return {batchId:'saved',summary:preview.summary,reconciliation:{expectedNewGiftCents:'0',actualNewGiftCents:'0'}};throw Error('Connection interrupted');};
 const render=harness('../src/features/Migration.jsx','default',{'./MigrationReview':{ControlTotals:()=>null,ValidationResults:()=>null,BatchLineage:()=>null},'../lib':{money,toCSV,dateLabel:v=>v,parseCSV:()=>[{sourceId:'d1',name:'Example',type:'Individual'}],download(){}}}),props={api,user:{role:'admin'}};
 let tree=render(props);await find(tree,e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'sample.csv',size:100,text:async()=>''}],value:'sample.csv'}});
 tree=render(props);await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});tree=render(props);
 assert.match(html(tree),/All validated monetary contributions/);assert.doesNotMatch(html(tree),/New monetary contributions/);
 assert.equal(button(tree,'Commit validated batch').props.disabled,true);
 find(tree,e=>e.type==='input'&&e.props.type==='checkbox').props.onChange({target:{checked:true}});tree=render(props);
 await button(tree,'Commit validated batch').props.onClick();tree=render(props);
 assert.match(html(tree),/Batch reconciliation saved/);assert.match(html(tree),/The batch was saved, but the workspace could not refresh/);assert.doesNotMatch(html(tree),/uncertain commit|Preview again/);
 assert.deepEqual(calls.map(c=>c[0]),['/migration/preview','/migration/commit','/migration/batches']);
});

test('source lineage opens existing records through the workspace and never opens missing records',()=>{
 const opened=[],detail={batch:{batchId:'b'},lineage:[{collection:'gifts',sourceId:'g1',recordId:'saved-id',status:'Changed'},{collection:'gifts',sourceId:'g2',recordId:'missing-id',status:'Missing'}],integrity:{changed:1,missing:1},lineageCoverage:'All batch source rows'},render=harness('../src/features/MigrationReview.jsx','BatchLineage'),tree=render({detail,onOpenRecord:(...args)=>opened.push(args)});
 find(tree,e=>e.type==='button'&&e.props['aria-label']==='Open gifts source g1').props.onClick();assert.deepEqual(opened,[['gifts','saved-id']]);assert.equal(find(tree,e=>e.type==='button'&&e.props['aria-label']==='Open gifts source g2'),null);
});

test('batch history appends older pages using the server cursor and refresh starts a new list',async()=>{
 const calls=[],entry=(id)=>({batchId:id,fileKey:'batch-'+id,source:'Synthetic',committedAt:'2026-09-13'}),api=async path=>{calls.push(path);return path.includes('?')?{batches:[entry('older')],nextCursor:null}:{batches:[entry('newer')],nextCursor:'opaque/cursor'};},render=harness('../src/features/Migration.jsx','default',{'./MigrationReview':{ControlTotals:()=>null,ValidationResults:()=>null,BatchLineage:()=>null},'../lib':{money,toCSV,dateLabel:v=>v,download(){}}}),props={api,user:{role:'admin'}};
 let tree=render(props);await button(tree,'Refresh history').props.onClick();tree=render(props);assert.match(html(tree),/batch-newer/);assert.doesNotMatch(html(tree),/batch-older/);
 await button(tree,'Load older batches').props.onClick();tree=render(props);assert.match(html(tree),/batch-newer/);assert.match(html(tree),/batch-older/);assert.equal(button(tree,'Load older batches'),null);
 await button(tree,'Refresh history').props.onClick();tree=render(props);assert.doesNotMatch(html(tree),/batch-older/);assert.deepEqual(calls,['/migration/batches','/migration/batches?cursor=opaque%2Fcursor','/migration/batches']);
});

test('mapping preserves opt-outs and exposes an unmapped contact default before preview',async()=>{
 const render=harness('../src/features/Migration.jsx','default',{'../lib':{money,toCSV,parseCSV,dateLabel:v=>v,download(){}}}),props={api:async()=>({}),user:{role:'admin'}};
 let tree=render(props);await find(tree,e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'source.csv',size:100,text:async()=>toCSV(['sourceId','name','type','preference'],[['d1','Synthetic Staff','Staff','Do not contact']])}],value:'source.csv'}});tree=render(props);
 assert.doesNotMatch(html(tree),/Contact preference is not mapped/);assert.match(html(tree),/First data row: Do not contact/);
 const preference=find(tree,e=>e.type==='select'&&e.props.value==='preference');preference.props.onChange({target:{value:''}});tree=render(props);assert.match(html(tree),/that default is not marketing consent/);
 find(find(tree,e=>e.type==='label'&&React.Children.toArray(e.props.children).includes('preference')),e=>e.type==='select').props.onChange({target:{value:'preference'}});tree=render(props);assert.doesNotMatch(html(tree),/Contact preference is not mapped/);
});

test('oversized serialized mapped batch is stopped before a preview request and source remains staged',async()=>{
 const calls=[],rows=Array.from({length:500},(_,i)=>({sourceId:'d'+i,name:'Synthetic donor '+i,type:'Individual',notes:'x'.repeat(5000)})),render=harness('../src/features/Migration.jsx','default',{'../lib':{money,toCSV,dateLabel:v=>v,parseCSV:()=>rows,download(){}}}),props={api:async(...args)=>{calls.push(args);return {};},user:{role:'admin'}};
 let tree=render(props);await find(tree,e=>e.type==='input'&&e.props.type==='file').props.onChange({target:{files:[{name:'expanded.csv',size:100,text:async()=>''}],value:'expanded.csv'}});tree=render(props);await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});tree=render(props);
 assert.equal(calls.length,0);assert.match(html(tree),/exceeds the 2 MiB request limit/);assert.match(html(tree),/expanded.csv/);assert.equal(button(tree,'Commit validated batch'),null);
});

test('named CSV examples keep staff fields, exact gift dollars and source dependencies under the shared headers',()=>{
 const downloads=[],render=harness('../src/features/Migration.jsx','default',{'../lib':{money,toCSV,parseCSV,dateLabel:v=>v,download:(...args)=>downloads.push(args)}}),tree=render({api:async()=>({}),user:{role:'admin'}});
 for(const type of ['constituents','designations','gifts'])find(tree,e=>e.type==='button'&&React.Children.toArray(e.props.children).filter(c=>typeof c==='string').join('')===type+' example').props.onClick();
 const donor=parseCSV(downloads[0][1])[0],fund=parseCSV(downloads[1][1])[0],gift=parseCSV(downloads[2][1])[0];
 assert.equal(donor.name,'Alex Sample');assert.equal(donor.type,'Individual');assert.equal(donor.preference,'Email');assert.equal(gift.amount,'123.45');assert.equal(gift.donorSourceId,donor.sourceId);assert.equal(gift.designationSourceId,fund.sourceId);assert.equal(gift.giftKind,'One-time');assert.equal(fund.accountCode,'SAMPLE-100');
});
