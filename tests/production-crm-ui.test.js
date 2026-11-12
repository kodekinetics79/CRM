import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {productionRequest,setProductionCsrf,clearProductionSession,ProductionApiError} from '../src/production/productionApi.js';

const root=new URL('../',import.meta.url);
const source=path=>readFileSync(new URL(path,root),'utf8');
function component(path){
 const module={exports:{}},code=transformSync(source(path),{loader:'jsx',format:'cjs'}).code;
 const require=id=>id==='react'?React:id.endsWith('.css')?{}:{__esModule:true,default:()=>null};
 new Function('require','module','exports',code)(require,module,module.exports);
 return module.exports;
}
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
