import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Isolated component state harness, not a replacement for browser integration.
function component(file,dependencies={}){let index=0,effects=[],state=[];const mock={...React,lazy:()=>()=>null,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useCallback(fn){index++;return fn;},useMemo(fn){index++;return fn();},useEffect(fn){index++;effects.push(fn);}};const icon=()=>null,require=id=>id==='react'?mock:id==='lucide-react'?new Proxy({},{get:()=>icon}):dependencies[id]||{__esModule:true,default:()=>null};const module={exports:{}};new Function('require','module','exports',transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(require,module,module.exports);const render=props=>{index=0;effects=[];return module.exports.default(props);};return {render,effects:()=>effects,html:props=>renderToStaticMarkup(render(props))};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const button=(tree,text)=>find(tree,element=>element.type==='button'&&renderToStaticMarkup(element).includes(text));

const SOURCES=[{collection:'constituents',id:'person-a',version:1},{collection:'constituents',id:'person-b',version:2}];
const CANDIDATE={
 key:'person-a|person-b',kind:'duplicate',
 left:{id:'person-a',version:1,name:'Jane Doe',type:'Individual',person:true,household:'Doe household'},
 right:{id:'person-b',version:2,name:'Jane Doe',type:'Individual',person:true,household:'Doe household'},
 signals:[{type:'email',why:'Both records normalise to the same email address.',normalized:'jane.doe@example.test',left:{value:'Jane.Doe+news@Example.test',untrusted:true,withheld:false,patterns:[]},right:{value:'jane.doe@example.test',untrusted:true,withheld:false,patterns:[]}}],
 confidence:'Strong',blocked:false,blockers:[],sources:SOURCES,digest:'a'.repeat(64),
 nextAction:{label:'Open Identity & households and review the merge',where:'identity',requiresHuman:true,performedByWimblo:false,performed:false},
 statement:'This is a proposal built from the signals shown.',review:null
};
const BLOCKED={...CANDIDATE,key:'person-c|org-d',left:{...CANDIDATE.left,id:'person-c'},right:{id:'org-d',version:1,name:'Doe Family Foundation',type:'Foundation',person:false,household:null},
 blocked:true,digest:'b'.repeat(64),blockers:[{reason:'A person and an organization can never become one physical identity.',sources:SOURCES}],
 nextAction:{label:'Review manually; this pair cannot be merged',where:'identity',requiresHuman:true,performedByWimblo:false,performed:false}};
const OVERVIEW={
 provider:{name:'local-deterministic',mode:'local',requestedMode:'local',supported:true,available:true,network:false,hosted:false,reason:'Deterministic local composition from verified saved records.',templates:['posted-total'],neverPerforms:['merge_identity','post_gift']},
 assistance:{available:true,narratives:['giving-summary'],network:false,hosted:false,statement:'Assistance recommends and summarises only.',neverPerforms:['merge_identity','post_gift']},
 counts:{duplicates:2,stewardship:1,followups:0,quality:0,constituents:9},
 limits:{candidates:200},computedFor:'2026-09-15',cached:false,canReview:true,
 scope:'Every finding is recomputed from saved records on each request.'
};
const DUPLICATES={candidates:[CANDIDATE,BLOCKED],matched:2,matchedInView:2,returned:2,offset:0,limit:100,comparisons:4,oversizedGroups:0,scanned:9,computedFor:'2026-09-15',cached:false,method:'Deterministic normalisation of name, email, phone, household and recorded household address.',statement:'These are proposals.'};

function harness(overrides={}){
 const calls=[];
 const api=async(path,options)=>{
  calls.push([path,options]);
  const override=overrides[path.split('?')[0]];
  if(typeof override==='function')return override(path,options);
  if(path==='/data-quality')return overrides.overview||OVERVIEW;
  if(path.startsWith('/data-quality/duplicates'))return overrides.duplicates||DUPLICATES;
  if(path==='/data-quality/stewardship')return overrides.stewardship||{findings:[],matched:0,computedFor:'2026-09-15',cached:false,scope:'Computed from saved records at request time.'};
  if(path==='/data-quality/followups')return overrides.followups||{findings:[],matched:0,computedFor:'2026-09-15',cached:false,scope:'Community grants only.'};
  if(path==='/data-quality/quality')return overrides.quality||{findings:[],matched:0,computedFor:'2026-09-15',cached:false,scope:'Saved fields in this workspace only.'};
  if(path==='/data-quality/reviews')return overrides.review||{review:{id:'review-1',kind:'duplicate',findingKey:CANDIDATE.key,decision:'Accepted for review',reason:'Queued for the identity reviewer',actor:'admin',at:'2026-09-15T00:00:00.000Z',sourceDigest:CANDIDATE.digest,current:true,performed:'none'},performed:'none',note:'A review decision is recorded. No constituent was merged.'};
  if(path==='/data-quality/narrative')return overrides.narrative||{kind:'giving-summary',text:'Posted monetary gifts recorded in this period: 3, totalling $157.89 in exact recorded cents.',provider:'local-deterministic',network:false,hosted:false,generated:false,reviewRequired:true,performed:'none',figures:[{key:'posted-cents',kind:'cents',rendered:'$157.89',cents:15789,count:null,date:null,sources:SOURCES}],sources:SOURCES,sourceDigest:'c'.repeat(64),statement:'Every figure is an exact integer-cent value taken from the cited saved records.'};
  throw Object.assign(new Error('Unexpected path '+path),{status:404});
 };
 const screen=component('../src/features/DataQuality.jsx',{'../api.js':{api}});
 const opened=[],notices=[],dirty=[];
 const props={api,data:{designations:[{id:'fund-1',name:'Classroom fund'}]},notify:message=>notices.push(message),onDirty:value=>dirty.push(value),onOpen:(collection,id)=>opened.push([collection,id])};
 return {screen,props,calls,opened,notices,dirty,
  async settle(){screen.render(props);for(const effect of screen.effects())effect();await flush();return screen.render(props);}};
}

test('the screen loads, explains its bounds and never offers a control that acts',async()=>{
 const h=harness();
 const first=h.screen.render(h.props);
 assert.match(renderToStaticMarkup(first),/Recomputing findings from saved records/,'an explicit loading state');
 const tree=await h.settle();
 const html=renderToStaticMarkup(tree);
 assert.match(html,/Wimblo does not merge identities, post gifts, send communications, change consent, issue receipts or change permissions here/);
 assert.match(html,/recomputed from saved records each time you open them/);
 assert.match(html,/Nothing is cached/);
 // No control on the screen offers a consequential action.
 for(const label of ['Merge','Send','Post gift','Issue receipt','Approve','Apply','Void','Acknowledge'])
  assert.equal(findAll(tree,element=>element.type==='button'&&renderToStaticMarkup(element).trim()===label).length,0,'found an action control: '+label);
 assert.match(html,/Wimblo will not do this for you/);
});

test('every suggestion shows what it is based on and its explicit human next action',async()=>{
 const h=harness();
 const tree=await h.settle();
 const html=renderToStaticMarkup(tree);
 assert.match(html,/Why these were proposed/);
 assert.match(html,/Both records normalise to the same email address/);
 assert.match(html,/Normalised value: jane.doe@example.test/);
 assert.match(html,/What this is based on \(2 saved records\)/);
 assert.match(html,/version 1/);
 assert.match(html,/Open Identity &amp; households and review the merge/);
 // A blocked pair says why and never offers a merge.
 assert.match(html,/Why this cannot be merged/);
 assert.match(html,/person and an organization can never become one physical identity/);
 assert.match(html,/Review manually; this pair cannot be merged/);
 assert.match(html,/Open this record/);
 // Opening a cited record is delegated to the workspace, not performed here.
 const open=button(tree,'Open');
 assert.ok(open);
 open.props.onClick();
 assert.deepEqual(h.opened[0],['constituents','person-a']);
});

test('recording a decision is explicit, reasoned and human confirmed',async()=>{
 const h=harness();
 let tree=await h.settle();
 assert.equal(h.calls.some(([path,options])=>options?.method==='POST'),false,'nothing was posted on load');
 button(tree,'Record a review decision…').props.onClick();
 tree=h.screen.render(h.props);
 const form=find(tree,element=>element.props?.className==='quality-decision');
 assert.ok(form,'the decision form is disclosed only after an explicit request');
 assert.match(renderToStaticMarkup(form),/no record, consent, receipt or permission changes/);
 assert.ok(button(tree,'Confirm: record this decision only'));

 // An empty reason is refused before anything is sent.
 await form.props.onSubmit({preventDefault(){}});
 assert.equal(h.calls.some(([path])=>path==='/data-quality/reviews'),false);
 assert.match(renderToStaticMarkup(h.screen.render(h.props)),/Say why you are recording this decision/);

 const reason=find(tree,element=>element.type==='input'&&element.props.maxLength===500);
 reason.props.onChange({target:{value:'Queued for the identity reviewer'}});
 await find(h.screen.render(h.props),element=>element.props?.className==='quality-decision').props.onSubmit({preventDefault(){}});
 await flush();
 const posted=h.calls.find(([path])=>path==='/data-quality/reviews');
 assert.ok(posted);
 assert.equal(posted[1].method,'POST');
 assert.deepEqual(posted[1].body,{kind:'duplicate',findingKey:CANDIDATE.key,sourceDigest:CANDIDATE.digest,decision:'Accepted for review',reason:'Queued for the identity reviewer'});
 assert.match(h.notices.at(-1),/Nothing was merged, posted, sent or changed/);
});

test('empty, conflict, permission-denied and provider-off states are explicit',async()=>{
 const empty=harness({duplicates:{...DUPLICATES,candidates:[],matched:0}});
 assert.match(renderToStaticMarkup(await empty.settle()),/Nothing to review here[\s\S]*This is a result, not a failure/);

 const conflict=harness({'/data-quality/duplicates':()=>{throw Object.assign(new Error('This suggestion was withdrawn: its cited records changed.'),{status:409});}});
 const conflictTree=await conflict.settle();
 assert.match(renderToStaticMarkup(conflictTree),/This changed while you were working[\s\S]*withdrawn/);
 assert.ok(button(conflictTree,'Reload current findings'));

 const denied=harness({'/data-quality':()=>{throw Object.assign(new Error('Data quality review requires an administrator or staff role.'),{status:403});}});
 const deniedTree=await denied.settle();
 assert.match(renderToStaticMarkup(deniedTree),/You cannot open this review surface/);
 assert.match(renderToStaticMarkup(deniedTree),/limited to administrator and staff accounts/);

 const off=harness({overview:{...OVERVIEW,provider:{...OVERVIEW.provider,mode:'off',available:false,reason:'Assistance is off for this workspace. Deterministic findings remain available without it.'},assistance:{...OVERVIEW.assistance,available:false}}});
 let tree=await off.settle();
 find(tree,element=>element.props?.id==='quality-tab-narrative').props.onClick();
 tree=off.screen.render(off.props);
 assert.match(renderToStaticMarkup(tree),/Assistance is off for this workspace/);
 assert.match(renderToStaticMarkup(tree),/No hosted model is contacted in any configuration/);
 assert.equal(button(tree,'Compose from saved records'),null,'no compose control while assistance is off');
});

test('the narrative shows every figure with its cited records and claims nothing more',async()=>{
 const h=harness();
 let tree=await h.settle();
 find(tree,element=>element.props?.id==='quality-tab-narrative').props.onClick();
 tree=h.screen.render(h.props);
 const form=find(tree,element=>element.type==='form');
 findAll(tree,element=>element.type==='input'&&element.props.type==='date')[0].props.onChange({target:{value:'2026-01-01'}});
 tree=h.screen.render(h.props);
 findAll(tree,element=>element.type==='input'&&element.props.type==='date')[1].props.onChange({target:{value:'2026-06-30'}});
 await find(h.screen.render(h.props),element=>element.type==='form').props.onSubmit({preventDefault(){}});
 await flush();
 const posted=h.calls.find(([path])=>path==='/data-quality/narrative');
 assert.deepEqual(posted[1].body,{kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'});
 const html=renderToStaticMarkup(h.screen.render(h.props));
 assert.match(html,/totalling \$157\.89 in exact recorded cents/);
 assert.match(html,/Every figure and where it came from/);
 assert.match(html,/posted-cents/);
 assert.match(html,/no network request and no hosted model were used/);
 assert.match(html,/refused rather than approximated/);
 assert.ok(form);
});

test('the review surface is keyboard and screen-reader usable',async()=>{
 const h=harness();
 const tree=await h.settle();
 const tablist=find(tree,element=>element.props?.role==='tablist');
 assert.ok(tablist);
 assert.equal(tablist.props['aria-label'],'Data quality views');
 const tabs=findAll(tree,element=>element.props?.role==='tab');
 assert.equal(tabs.length,5);
 assert.equal(tabs.filter(tab=>tab.props['aria-selected']===true).length,1);
 assert.equal(tabs.filter(tab=>tab.props.tabIndex===0).length,1,'exactly one tab is in the tab order');
 for(const tab of tabs){
  assert.equal(typeof tab.props.onKeyDown,'function','arrow-key navigation is available');
  assert.ok(tab.props['aria-controls'].startsWith('quality-panel-'));
  assert.ok(tab.props.id.startsWith('quality-tab-'));
 }
 const panel=find(tree,element=>element.props?.role==='tabpanel');
 assert.equal(panel.props['aria-labelledby'],'quality-tab-duplicates');
 assert.equal(panel.props.tabIndex,-1);
 const status=find(tree,element=>element.props?.role==='status');
 assert.equal(status.props['aria-live'],'polite');
 for(const element of findAll(tree,element=>element.type==='button'))assert.equal(element.props.type,'button','every button declares its type');
 for(const element of findAll(tree,element=>element.type==='svg'||element.props?.['aria-hidden']===true))assert.ok(element);
});
