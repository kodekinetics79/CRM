import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {productionRequest,setProductionCsrf,clearProductionSession,subscribeProductionSession,ProductionApiError} from '../src/production/productionApi.js';

const root=new URL('../',import.meta.url);
const source=path=>readFileSync(new URL(path,root),'utf8');
function component(path){
 const module={exports:{}},code=transformSync(source(path),{loader:'jsx',format:'cjs'}).code;
 const require=id=>id==='react'?React:id.endsWith('.css')?{}:{__esModule:true,default:()=>null};
 new Function('require','module','exports',code)(require,module,module.exports);
 return module.exports;
}
function statefulComponent(path,dependencies={}){let index=0,state=[],effects=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();},lazy(){return()=>null;}};const module={exports:{}},code=transformSync(source(path),{loader:'jsx',format:'cjs'}).code,require=id=>id==='react'?mock:id.endsWith('.css')?{}:dependencies[id]||{__esModule:true,default:()=>null};new Function('require','module','exports',code)(require,module,module.exports);return {render(props){index=0;effects=[];return module.exports.default(props);},effects:()=>effects};}
const findNode=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=findNode(child,predicate);if(found)return found;}return null;};
const workspaceModule=component('src/production/CrmWorkspace.jsx'),CrmWorkspace=workspaceModule.default,{navigationForModules}=workspaceModule;
const PipelineBoard=component('src/production/PipelineBoard.jsx').default;
const RecordTimeline=component('src/production/RecordTimeline.jsx').default;
const reportsModule=component('src/production/ReportsWorkspace.jsx'),ReportsWorkspace=reportsModule.default,{createImportReview}=reportsModule;
const identity={identityId:'11111111-1111-4111-8111-111111111111',displayName:'Avery Chen'};
const membership={membershipId:'22222222-2222-4222-8222-222222222222',tenantId:'33333333-3333-4333-8333-333333333333',role:'staff'};
const modules=[
 {code:'core',name:'Core CRM',state:'enabled',capabilities:{read:true,write:true,export:true}},
 {code:'sales',name:'Sales',state:'suspended',capabilities:{read:true,write:false,export:true}},
 {code:'automation',name:'Automation',state:'disabled',capabilities:{read:false,write:false,export:false}}
];

test('production API keeps CSRF in memory, sends it on writes, and returns typed safe errors',async()=>{
 const original=global.fetch,calls=[];
 global.fetch=async(url,options)=>{calls.push([url,options]);return new Response(JSON.stringify({error:'Record changed',code:'CONFLICT'}),{status:409,headers:{'Content-Type':'application/json'}});};
 try{
  setProductionCsrf('memory-only-csrf');
  await assert.rejects(()=>productionRequest('/crm/parties/x',{method:'PATCH',body:{expectedVersion:1}}),error=>{
   assert.ok(error instanceof ProductionApiError);assert.equal(error.status,409);assert.equal(error.code,'CONFLICT');return true;
  });
  assert.equal(calls[0][0],'/api/crm/parties/x');
  assert.equal(calls[0][1].credentials,'same-origin');
  assert.equal(calls[0][1].headers['X-CSRF-Token'],'memory-only-csrf');
  assert.equal(calls[0][1].headers.Authorization,undefined);
  clearProductionSession();
 }finally{global.fetch=original;}
});

test('a central 401 signal clears CSRF and tells the app to discard cached customer state',async()=>{
 const original=global.fetch,events=[],unsubscribe=subscribeProductionSession(event=>events.push(event));
 global.fetch=async()=>new Response(JSON.stringify({error:'Session expired',code:'AUTHENTICATION_REQUIRED'}),{status:401,headers:{'Content-Type':'application/json'}});
 try{setProductionCsrf('secret');await assert.rejects(()=>productionRequest('/crm/parties'));assert.deepEqual(events,[{type:'expired'}]);}
 finally{unsubscribe();global.fetch=original;clearProductionSession();}
});

test('ProductionApp unmounts cached customer UI and renders session-expired sign-in on central 401',async()=>{
 let expire,cleared=0;const client={synthetic:false,restore:async()=>({identity,membership,csrfToken:'csrf'}),request:async path=>path==='/auth/tenants'?{memberships:[membership]}:{modules},clear:()=>cleared++,subscribeSession:listener=>(expire=listener,()=>{})};
 const Cached=({session})=>React.createElement('div',null,`Cached customer: ${session.identity.displayName}`),h=statefulComponent('src/production/ProductionApp.jsx',{'./productionApi.js':{__esModule:true,productionApi:client},'./CrmWorkspace.jsx':{__esModule:true,default:Cached}});
 h.render({client});const boot=h.effects()[0],subscribe=h.effects()[1];boot();subscribe();await new Promise(resolve=>setTimeout(resolve,0));
 assert.match(renderToStaticMarkup(h.render({client})),/Cached customer: Avery Chen/);
 expire({type:'expired'});const expired=renderToStaticMarkup(h.render({client}));
 assert.match(expired,/Your session expired/);assert.doesNotMatch(expired,/Avery Chen|Cached customer/);assert.equal(cleared,1);
});

test('capability navigation keeps suspended sales read-only and removes disabled modules',()=>{
 const navigation=navigationForModules(modules,'staff');
 assert.ok(navigation.some(item=>item.key==='people'&&item.writable));
 assert.ok(navigation.some(item=>item.key==='sales'&&item.readOnly));
 assert.equal(navigation.some(item=>item.key==='automation'),false);
 const viewer=navigationForModules(modules,'viewer');
 assert.ok(viewer.every(item=>item.writable===false));
});

test('production workspace renders an operating brief, escaped content and explicit read-only state',()=>{
 const hostileMarkup='<'+ 'img onerror=alert(1)>';
 const html=renderToStaticMarkup(React.createElement(CrmWorkspace,{client:{request:async()=>({})},session:{identity,membership},memberships:[membership],modules,initialRoute:'home',initialParties:[{partyId:'p1',displayName:hostileMarkup,partyType:'person'}]}));
 assert.match(html,/Today’s operating brief/);
 assert.match(html,/Search people and organizations/);
 assert.match(html,/Sales is read-only/);
 assert.match(html,/&lt;img onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html,/<img onerror=/);
 assert.match(html,/Skip to workspace/);
});

test('pipeline, timeline and reports expose accessible non-drag workflows and explicit states',()=>{
 const pipeline=renderToStaticMarkup(React.createElement(PipelineBoard,{client:{request:async()=>({})},readOnly:false,initialData:{pipelines:[{pipelineId:'p',name:'Default',stages:[{stageId:'s1',name:'Discovery',position:1},{stageId:'s2',name:'Won',position:2}]}],opportunities:[{opportunityId:'o1',name:'Acme renewal',stageId:'s1',version:1,amountCents:12500,currency:'USD'}]}}));
 assert.match(pipeline,/Move opportunity/);assert.match(pipeline,/Stage/);assert.doesNotMatch(pipeline,/draggable/);
 const timeline=renderToStaticMarkup(React.createElement(RecordTimeline,{client:{request:async()=>({})},subjectId:'p1',initialData:{items:[{kind:'activity',sourceId:'a1',summary:'Met & reviewed',occurredAt:'2026-11-11T10:00:00Z'}],nextCursor:'next'}}));
 assert.match(timeline,/Relationship timeline/);assert.match(timeline,/Load more/);assert.match(timeline,/Met &amp; reviewed/);
 const reports=renderToStaticMarkup(React.createElement(ReportsWorkspace,{client:{request:async()=>({})},writable:true,initialDashboard:{total:0}}));
 assert.match(reports,/Preview people import/);assert.match(reports,/Commit import/);assert.match(reports,/Complete export or refuse/);
});

test('an import review pins one idempotency key to the exact in-memory CSV',()=>{
 const review=createImportReview('people.csv','name,email\nAvery,avery@example.com','fixed-key');
 assert.deepEqual(review,{fileName:'people.csv',source:'name,email\nAvery,avery@example.com',idempotencyKey:'fixed-key'});
 assert.equal(review.idempotencyKey,'fixed-key');
});

test('production UI source has explicit entry isolation, lazy route chunks and no unsafe browser storage or raw HTML',()=>{
 const main=source('src/main.jsx'),app=source('src/production/ProductionApp.jsx'),workspace=source('src/production/CrmWorkspace.jsx'),css=source('src/production/production.css');
 assert.match(main,/VITE_WIMBLO_APP_MODE/);assert.match(main,/synthetic-evaluation/);assert.match(main,/import\('\.\/production\/syntheticEvaluationClient/);assert.match(main,/import\('\.\/App/);
 assert.match(workspace,/React\.lazy|lazy\(/);
 for(const text of [main,app,workspace])assert.doesNotMatch(text,/dangerouslySetInnerHTML|\.innerHTML\s*=|localStorage|sessionStorage/);
 assert.match(css,/min-height:\s*44px/);assert.match(css,/@media\s*\(max-width:\s*700px\)/);assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);assert.match(css,/@media\s*\(forced-colors:\s*active\)/);assert.match(css,/:focus-visible/);
});

test('mobile navigation is hidden while closed and exposes keyboard-safe drawer semantics',()=>{
 const html=renderToStaticMarkup(React.createElement(CrmWorkspace,{client:{request:async()=>({})},session:{identity,membership},memberships:[membership],modules,initialRoute:'home',initialParties:[],initialMobile:true}));
 assert.match(html,/aria-label="Workspace navigation"[^>]*aria-hidden="true"[^>]*inert=""/);
 assert.match(html,/aria-label="Open navigation"[^>]*aria-expanded="false"/);
 const sourceText=source('src/production/CrmWorkspace.jsx');
 assert.match(sourceText,/Escape/);assert.match(sourceText,/navRef\.current\?\.focus/);assert.match(sourceText,/menuRef\.current\?\.focus/);assert.match(sourceText,/inert=/);
});

test('mobile drawer renders open background isolation and Escape closes it',()=>{
 const h=statefulComponent('src/production/CrmWorkspace.jsx'),props={client:{request:async()=>({})},session:{identity,membership},memberships:[membership],modules,initialRoute:'home',initialParties:[],initialMobile:true};let tree=h.render(props),menu=findNode(tree,node=>node.type==='button'&&node.props['aria-label']==='Open navigation');menu.props.onClick();tree=h.render(props);let aside=findNode(tree,node=>node.type==='aside'),background=findNode(tree,node=>node.props?.className==='prod-main-shell');assert.equal(aside.props['aria-hidden'],false);assert.equal(aside.props.inert,false);assert.equal(background.props.inert,true);assert.equal(findNode(tree,node=>node.props?.className==='prod-menu').props['aria-label'],'Close navigation');aside.props.onKeyDown({key:'Escape',preventDefault(){}});tree=h.render(props);assert.equal(findNode(tree,node=>node.type==='aside').props['aria-hidden'],true);
});
