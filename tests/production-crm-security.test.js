import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createCrmReportingService} from '../server/production/crmReportingService.js';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {startWebRuntime} from '../server/production/web.js';
import {startWorkerRuntime} from '../server/production/worker.js';

const root=new URL('../',import.meta.url);
const source=path=>readFileSync(new URL(path,root),'utf8');
function statefulComponent(path,dependencies={}){
 let index=0,state=[],effects=[];
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();},lazy(){return()=>null;}};
 const module={exports:{}},code=transformSync(source(path),{loader:'jsx',format:'cjs'}).code;
 const require=id=>id==='react'?mock:id.endsWith('.css')?{}:dependencies[id]||{__esModule:true,default:()=>null};
 new Function('require','module','exports',code)(require,module,module.exports);
 return {render(props){index=0;effects=[];return module.exports.default(props);},effects:()=>effects};
}

const identity={identityId:'11111111-1111-4111-8111-111111111111',displayName:'Avery Chen'};
const membership={membershipId:'22222222-2222-4222-8222-222222222222',tenantId:'33333333-3333-4333-8333-333333333333',role:'staff'};
const modules=[{code:'core',name:'Core CRM',state:'enabled',capabilities:{read:true,write:true,export:true}}];

test('failed server logout is not presented as a completed sign-out',async()=>{
 let workspaceProps;
 let cleared=0;const failure=Object.assign(new Error('network unavailable'),{status:503});
 const client={synthetic:false,restore:async()=>({identity,membership,csrfToken:'csrf'}),request:async path=>{
  if(path==='/auth/tenants')return {memberships:[membership]};
  if(path==='/modules')return {modules};
  if(path==='/auth/logout')throw failure;
  throw new Error(path);
 },clear(){cleared++;},subscribeSession:()=>()=>{}};
 const Workspace=props=>(workspaceProps=props,React.createElement('div',null,'Customer workspace'));
 const h=statefulComponent('src/production/ProductionApp.jsx',{'./productionApi.js':{__esModule:true,productionApi:client},'./CrmWorkspace.jsx':{__esModule:true,default:Workspace}});
 h.render({client});h.effects()[0]();await new Promise(resolve=>setTimeout(resolve,0));renderToStaticMarkup(h.render({client}));
 await workspaceProps.onSignOut().catch(()=>{});
 const markup=renderToStaticMarkup(h.render({client}));
 assert.match(markup,/Sign-out not confirmed/);
 assert.doesNotMatch(markup,/Sign in to Wimblo/);
 assert.equal(cleared,0);
});
test('an already-ended 401 logout clears local customer state',async()=>{
 let workspaceProps,cleared=0;
 const client={synthetic:false,restore:async()=>({identity,membership,csrfToken:'csrf'}),request:async path=>{
  if(path==='/auth/tenants')return {memberships:[membership]};
  if(path==='/modules')return {modules};
  if(path==='/auth/logout')throw Object.assign(new Error('ended'),{status:401});
  throw new Error(path);
 },clear(){cleared++;},subscribeSession:()=>()=>{}};
 const Workspace=props=>(workspaceProps=props,React.createElement('div',null,'Customer workspace'));
 const h=statefulComponent('src/production/ProductionApp.jsx',{'./productionApi.js':{__esModule:true,productionApi:client},'./CrmWorkspace.jsx':{__esModule:true,default:Workspace}});
 h.render({client});h.effects()[0]();await new Promise(resolve=>setTimeout(resolve,0));renderToStaticMarkup(h.render({client}));
 await workspaceProps.onSignOut();
 const markup=renderToStaticMarkup(h.render({client}));
 assert.match(markup,/Sign in to Wimblo/);assert.doesNotMatch(markup,/Customer workspace/);assert.equal(cleared,1);
});

test('saved report update authorizes the persisted dataset before replacement',async()=>{
 const tenantId=randomUUID(),reportId=randomUUID(),calls=[];let updated=false;
 const service=createCrmReportingService({
  moduleService:{authorize:async input=>{calls.push([input.code,input.action]);return {allowed:input.code==='core'};}},
  tenantPool:{withTenantSession:async(id,fn)=>{assert.equal(id,tenantId);return fn({query:async sql=>{
   if(sql.includes('report:current'))return {rows:[{report_id:reportId,dataset:'opportunities',version:1,state:'active'}],rowCount:1};
   if(sql.includes('report:update')){updated=true;return {rows:[{report_id:reportId,dataset:'parties',version:2,state:'active'}],rowCount:1};}
   throw new Error(`unexpected query: ${sql}`);
  }});}}
 });
 await assert.rejects(()=>service.updateReport({tenantId,reportId,expectedVersion:1,actorRole:'staff',actorIdentityId:randomUUID(),name:'Downgraded',definition:{dataset:'parties',columns:['displayName']}}),/capability/i);
 assert.deepEqual(calls,[['core','write'],['sales','write']]);
 assert.equal(updated,false);
});

test('attachment links are tenant metadata references and never grant object byte access',async()=>{
 const tenantId=randomUUID(),subjectId=randomUUID(),actorIdentityId=randomUUID(),linkId=randomUUID(),now='2026-11-12T01:00:00.000Z';
 const session={query:async(sql,values=[])=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[],rowCount:0};
  if(sql.includes('subject:get'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',version:1}],rowCount:1};
  if(sql.includes('membership:active'))return {rows:[{identity_id:actorIdentityId}],rowCount:1};
  if(sql.includes('object:active'))return {rows:[{tenant_id:tenantId,object_id:'brief',revision:1,content_type:'application/pdf',size_bytes:42,state:'active'}],rowCount:1};
  if(sql.includes('attachment:insert'))return {rows:[{tenant_id:tenantId,link_id:linkId,subject_id:subjectId,object_id:'brief',object_revision:1,file_name:'brief.pdf',content_type:'application/pdf',size_bytes:42,actor_identity_id:actorIdentityId,occurred_at:now}],rowCount:1};
  throw new Error(`unexpected query: ${sql} ${values.length}`);
 }};
 const tenantPool={withTenantSession:async(id,fn)=>{assert.equal(id,tenantId);return fn(session);},withTransaction:async(id,fn)=>{assert.equal(id,tenantId);await session.query('BEGIN');try{const result=await fn(session);await session.query('COMMIT');return result;}catch(error){await session.query('ROLLBACK');throw error;}}};
 const link=await createCrmRepository({tenantPool,clock:()=>new Date(now)}).linkAttachment({tenantId,subjectId,actorIdentityId,linkId,objectId:'brief',objectRevision:1,fileName:'brief.pdf'});
 assert.deepEqual(link.accessPolicy,{scope:'tenant-metadata-reference',grantsByteAccess:false});
 assert.equal(Object.hasOwn(link,'downloadUrl'),false);
 assert.equal(Object.hasOwn(link,'objectKey'),false);
});

test('web and worker certification completes before accepting traffic or polling',async()=>{
 const webOrder=[];
 const web=await startWebRuntime({config:{processRole:'web'},app:{},verify:async()=>webOrder.push('verified'),listen:async()=>{webOrder.push('listen');return {close:async()=>{}};}});
 await web.close();assert.deepEqual(webOrder,['verified','listen']);
 const workerOrder=[];
 const worker=await startWorkerRuntime({config:{processRole:'worker',limits:{jobConcurrency:1}},repository:{},handlers:{},tenantIds:[],signal:AbortSignal.abort(),verify:async()=>workerOrder.push('verified'),run:async()=>workerOrder.push('poll')});
 await worker.close();assert.deepEqual(workerOrder,['verified','poll']);
});
