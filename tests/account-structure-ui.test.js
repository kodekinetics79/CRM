import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {money} from '../src/lib.js';

// Isolated component state harness, not a replacement for browser integration.
function component(file,dependencies={}){let index=0,effects=[],state=[];const mock={...React,lazy:()=>()=>null,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useCallback(fn){index++;return fn;},useMemo(fn){index++;return fn();},useEffect(fn){index++;effects.push(fn);}};const icon=()=>null,require=id=>id==='react'?mock:id==='lucide-react'?new Proxy({},{get:()=>icon}):dependencies[id]||{__esModule:true,default:()=>null};const module={exports:{}};new Function('require','module','exports',transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(require,module,module.exports);const render=props=>{index=0;effects=[];return module.exports.default(props);};return {render,effects:()=>effects,html:props=>renderToStaticMarkup(render(props))};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const named=(tree,name)=>find(tree,e=>e.props?.name===name);
const button=(tree,text)=>find(tree,e=>e.type==='button'&&renderToStaticMarkup(e).includes(text));

const OVERVIEW={
 locations:[{id:'loc-1',code:'101',name:'Canyon View School',status:'Active',version:1},{id:'loc-2',code:'102',name:'Meadow Ridge School',status:'Retired',version:2}],
 functions:[{id:'fn-1',code:'4200',name:'Classroom support',status:'Active',version:1}],
 counts:{locations:2,activeLocations:1,functions:1,activeFunctions:1,pairs:1,activePairs:1,linkedDesignations:1},
 limits:{locations:999,functions:9999,pairs:10000,groups:2000,page:500,history:200},canManage:true,
 scope:'Locations are unique. Account structure grants no permission and no consent.'
};
const PAIR={id:'pair-1',code:'101-4200',status:'Active',version:1,locationId:'loc-1',locationCode:'101',locationName:'Canyon View School',locationStatus:'Active',functionId:'fn-1',functionCode:'4200',functionName:'Classroom support',functionStatus:'Active',linkedDesignations:1,open:true};
const PAIRS={pairs:[PAIR],matched:1,offset:0,limit:500};
const ROLLUP={groupBy:'location',totals:{postedGifts:2,postedGiftCents:150000,allocationGifts:2,allocations:3,allocationCents:150000,linkedCents:120000,unlinkedCents:30000,linkedDesignations:1,unlinkedDesignations:1},
 groups:[{key:'loc-1',code:'101',name:'Canyon View School',status:'Active',pairCount:1,gifts:2,allocations:2,designations:1,cents:120000}],
 groupCount:1,groupCents:120000,groupLimit:2000,
 reconciliation:{allocationsMatchPostedGifts:true,groupCentsMatchLinkedCents:true,groupAllocationsMatchLinked:true,linkedAndUnlinkedMatchLedger:true,duplicatedCents:0,reconciled:true},
 scope:'Posted gift allocations only, in exact integer cents. Voided gifts are excluded.'};
const FUND={id:'d-1',name:'STEM classroom supplies',accountCode:'SYN-101-STEM',school:'Canyon View',parentId:'d-0',parentName:'Canyon View School',version:3,depth:1,childCount:0,descendantCount:0,hierarchyIssue:false,directCents:120000,directAllocations:2,directGifts:2,subtreeCents:120000,subtreeAllocations:2,
 account:{pairId:'pair-1',pairCode:'101-4200',pairStatus:'Active',linkVersion:4,designationVersionAtLink:3,linkedAt:'2026-09-14T00:00:00.000Z',locationId:'loc-1',locationCode:'101',locationName:'Canyon View School',locationStatus:'Active',functionId:'fn-1',functionCode:'4200',functionName:'Classroom support',functionStatus:'Active'}};
const UNLINKED={...FUND,id:'d-2',name:'Creative arts classroom',accountCode:'SYN-101-ART',version:2,directCents:30000,directAllocations:1,directGifts:1,subtreeCents:30000,subtreeAllocations:1,account:null};
const FUNDS={designations:[FUND,UNLINKED],matched:2,returned:2,offset:0,limit:100,total:3,matchedTotals:{directCents:150000,directAllocations:3},hierarchy:{roots:1,maxDepth:1,cycles:0,rootSubtreeCents:150000,cycleCents:0},scope:'Own value adds up without overlap.'};

function harness(overrides={}){
 const calls=[];
 const api=async(path,options)=>{
  calls.push([path,options]);
  const override=overrides[path.split('?')[0]];
  if(typeof override==='function')return override(path,options);
  if(path.startsWith('/account-structure/pairs?'))return overrides.pairs||PAIRS;
  if(path.startsWith('/account-structure/rollups'))return overrides.rollup||ROLLUP;
  if(path.startsWith('/account-structure/designations?'))return overrides.funds||FUNDS;
  if(path==='/account-structure')return overrides.overview||OVERVIEW;
  if(overrides.mutate)return overrides.mutate(path,options);
  throw Object.assign(new Error('Unexpected request '+path),{status:500});
 };
 return {calls,api,view:component('../src/features/AccountStructure.jsx',{'../api.js':{api},'../lib.js':{money}})};
}
async function ready(overrides={},props={}){
 const h=harness(overrides),all={api:h.api,user:{id:'admin',role:'admin'},notify:()=>{},onDirty:()=>{},...props};
 h.view.render(all);h.view.effects()[0]();await flush();
 return {...h,props:all,tree:()=>h.view.render(all),html:()=>h.view.html(all)};
}

test('the screen opens in an explicit loading state before any account data is shown',async()=>{
 const h=harness(),props={api:h.api,user:{id:'admin',role:'admin'}};
 const first=renderToStaticMarkup(h.view.render(props));
 assert.match(first,/Loading locations, accounts and rollups/);
 assert.match(first,/aria-busy="true"/);
 assert.doesNotMatch(first,/Add location/);
 h.view.effects()[0]();await flush();
 const loaded=h.view.html(props);
 assert.doesNotMatch(loaded,/Loading locations, accounts and rollups/);
 assert.match(loaded,/Canyon View School/);
 assert.deepEqual(h.calls.map(c=>c[0]),['/account-structure','/account-structure/pairs?limit=500','/account-structure/rollups?groupBy=location','/account-structure/designations?limit=100']);
});

test('an administrator sees keyboard-reachable tabs, captioned tables and a mobile restructuring of every dense table',async()=>{
 const h=await ready();
 const tree=h.tree(),tabs=findAll(tree,e=>e.props?.role==='tab');
 assert.equal(tabs.length,3);
 assert.ok(tabs.every(t=>typeof t.props['aria-selected']==='boolean'),'every tab declares its selected state');
 assert.equal(tabs.filter(t=>t.props['aria-selected']===true).length,1);
 assert.deepEqual(tabs.map(t=>t.props.tabIndex),[0,-1,-1]);
 for(const tab of tabs){assert.ok(tab.props['aria-controls']);assert.ok(tab.props.id);}
 const panel=find(tree,e=>e.props?.role==='tabpanel');
 assert.equal(panel.props['aria-labelledby'],'account-tab-structure');
 assert.equal(find(tree,e=>e.props?.role==='status')?.props['aria-live'],'polite');
 const tables=findAll(tree,e=>e.type==='table');
 assert.equal(tables.length,3);
 for(const table of tables){
  assert.ok(table.props['aria-label'],'every table names itself');
  assert.ok(find(table,e=>e.type==='caption'),'every table carries a caption');
  assert.ok(findAll(table,e=>e.type==='th').every(th=>th.props.scope),'every header cell declares its scope');
 }
 // Dense tables are restructured, not merely scrolled, at phone width.
 const desktop=findAll(tree,e=>typeof e.props?.className==='string'&&e.props.className.includes('desktop-record-table'));
 const mobile=findAll(tree,e=>e.props?.className==='mobile-records');
 // Locations, functions and accounts: every dense table on this tab restructures.
 assert.equal(desktop.length,3);assert.equal(mobile.length,3);
 for(const list of mobile){assert.ok(list.props['aria-label']);assert.ok(findAll(list,e=>e.type==='dt').length>0);}
 const html=h.html();
 assert.match(html,/Three digits, unique across the workspace/);
 assert.match(html,/One function may serve many locations/);
 assert.match(html,/grants no permission and no consent/);
 assert.doesNotMatch(html,/linear-gradient|animation:/);
});

test('a viewer reviews every rollup but is given no mutation control at all',async()=>{
 const h=await ready({overview:{...OVERVIEW,canManage:false}},{user:{id:'viewer',role:'viewer'}});
 const html=h.html();
 assert.match(html,/You can review every location, account and rollup here/);
 assert.match(html,/Only an administrator can add, retire or relink accounts/);
 assert.match(html,/Canyon View School/);
 const tree=h.tree();
 assert.equal(find(tree,e=>e.type==='form'),null,'no mutation form is rendered for a read-only role');
 assert.equal(named(tree,'locationCode'),null);
 assert.equal(button(tree,'Retire'),null);
});

test('a permission failure at execution is reported as a denied change, not as a saved one',async()=>{
 const h=await ready({mutate:()=>{throw Object.assign(new Error('Administrator required'),{status:403});}});
 let tree=h.tree();
 named(tree,'locationCode').props.onChange({target:{value:'103'}});
 tree=h.tree();named(tree,'locationName').props.onChange({target:{value:'Third school'}});
 tree=h.tree();await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 const html=h.html();
 assert.match(html,/You cannot make this change/);
 assert.match(html,/Administrator required/);
 assert.doesNotMatch(html,/Location 103 added/);
});

test('a version conflict offers current values instead of silently retrying',async()=>{
 let attempts=0;
 const h=await ready({mutate:path=>{if(path.includes('/link')){attempts++;throw Object.assign(new Error('This account changed. Reload its current version before linking'),{status:409});}throw Object.assign(new Error('Unexpected'),{status:500});}});
 let tree=h.tree();
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='account-tab-designations').props.onClick();
 tree=h.tree();
 named(tree,'linkDesignation').props.onChange({target:{value:'d-2'}});
 tree=h.tree();named(tree,'linkPair').props.onChange({target:{value:'pair-1'}});
 tree=h.tree();named(tree,'linkReason').props.onChange({target:{value:'Reviewed assignment'}});
 tree=h.tree();await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 const html=h.html();
 assert.match(html,/This changed while you were working/);
 assert.match(html,/Reload current values/);
 assert.equal(attempts,1,'a conflict is surfaced once, never retried behind the person');
 assert.equal(h.calls.filter(c=>c[0].includes('/link')).length,1);
 const body=h.calls.find(c=>c[0].includes('/link'))[1].body;
 assert.equal(body.designationVersion,UNLINKED.version);
 assert.equal(body.pairVersion,PAIR.version);
});

test('a successful change confirms in the status region and reloads current values',async()=>{
 const saved=[];
 const h=await ready({mutate:(path,options)=>{saved.push([path,options.method]);return {location:{id:'loc-3',code:'103',name:'Third school',status:'Active',version:1}};}});
 let tree=h.tree();
 named(tree,'locationCode').props.onChange({target:{value:'103'}});
 tree=h.tree();named(tree,'locationName').props.onChange({target:{value:'Third school'}});
 tree=h.tree();await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 assert.deepEqual(saved,[['/account-structure/locations','POST']]);
 const html=h.html();
 assert.match(html,/Location 103 added/);
 assert.doesNotMatch(html,/That did not save|This changed while you were working/);
 assert.equal(named(h.tree(),'locationCode').props.value,'','the form clears after a confirmed save');
 assert.ok(h.calls.filter(c=>c[0]==='/account-structure').length>=2,'current values are reloaded after the change');
});

test('empty account structure explains the next step rather than showing blank tables',async()=>{
 const h=await ready({overview:{...OVERVIEW,locations:[],functions:[],counts:{locations:0,activeLocations:0,functions:0,activeFunctions:0,pairs:0,activePairs:0,linkedDesignations:0}},pairs:{pairs:[],matched:0,offset:0,limit:500},rollup:{...ROLLUP,groups:[],groupCount:0,groupCents:0,totals:{...ROLLUP.totals,linkedCents:0,unlinkedCents:150000}}});
 const html=h.html();
 assert.match(html,/No locations yet/);
 assert.match(html,/No functions yet/);
 assert.match(html,/No accounts yet/);
 let tree=h.tree();
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='account-tab-rollups').props.onClick();
 assert.match(renderToStaticMarkup(h.tree()),/Nothing linked yet/);
});

test('rollups state the exact reconciliation and refuse to look trustworthy when they do not reconcile',async()=>{
 const h=await ready();
 let tree=h.tree();
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='account-tab-rollups').props.onClick();
 const good=renderToStaticMarkup(h.tree());
 assert.match(good,/Reconciled exactly: every allocation is counted once/);
 assert.match(good,/\$1,200\.00/);
 assert.match(good,/\$1,500\.00/);
 assert.match(good,/\$300\.00/);
 assert.match(good,/counted once per location, never twice/);

 const broken=await ready({rollup:{...ROLLUP,groupCents:130000,reconciliation:{...ROLLUP.reconciliation,groupCentsMatchLinkedCents:false,duplicatedCents:10000,reconciled:false}}});
 let brokenTree=broken.tree();
 find(brokenTree,e=>e.props?.role==='tab'&&e.props.id==='account-tab-rollups').props.onClick();
 const html=renderToStaticMarkup(broken.tree());
 assert.match(html,/do not reconcile to the posted ledger/);
 assert.match(html,/Do not use them until the saved records are reviewed/);
 assert.equal(findAll(broken.tree(),e=>e.props?.role==='alert').length,1);
});

test('an unreadable saved ledger is reported as a source problem and the screen never invents totals',async()=>{
 const h=harness({'/account-structure/rollups':()=>{throw Object.assign(new Error('Stored posted gift allocations do not reconcile to their gift amount.'),{status:503});}});
 const props={api:h.api,user:{id:'admin',role:'admin'}};
 h.view.render(props);h.view.effects()[0]();await flush();
 const html=h.view.html(props);
 assert.match(html,/Saved records need review/);
 assert.match(html,/Stored posted gift allocations do not reconcile/);
 assert.match(html,/Reload current values/);
 assert.doesNotMatch(html,/Reconciled exactly/);
});

test('designation rows separate a fund’s own value from its subaccount rollup and flag broken hierarchy',async()=>{
 const h=await ready({funds:{...FUNDS,designations:[{...FUND,hierarchyIssue:true,depth:null,subtreeCents:null},UNLINKED],hierarchy:{...FUNDS.hierarchy,cycles:2}}});
 let tree=h.tree();
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='account-tab-designations').props.onClick();
 const html=renderToStaticMarkup(h.tree());
 assert.match(html,/Own value is this designation/);
 assert.match(html,/must not be added across levels/);
 assert.match(html,/Hierarchy needs review/);
 assert.match(html,/inconsistent parent and child chain/);
 assert.match(html,/Not linked/);
 assert.match(html,/101-4200/);
 assert.match(html,/Showing 2 of 2 matching designations/);
});
