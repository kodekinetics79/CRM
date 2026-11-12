import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import express from 'express';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {once} from 'node:events';
import {installCrmRoutes} from '../server/production/crmRoutes.js';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {createCrmReportingService} from '../server/production/crmReportingService.js';

const root=new URL('../',import.meta.url),flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child,predicate);if(match)return match;}return null;};
function harness(path,dependencies={}){let index=0,state=[],effects=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();},lazy(){return()=>null;}};const module={exports:{}},code=transformSync(readFileSync(new URL(path,root),'utf8'),{loader:'jsx',format:'cjs'}).code,require=id=>id==='react'?mock:id.endsWith('.css')?{}:dependencies[id]||{__esModule:true,default:()=>null};new Function('require','module','exports',code)(require,module,module.exports);return {render(props){index=0;effects=[];return module.exports.default(props);},effects:()=>effects};}

test('opportunity cards preserve exact cents instead of rounding to whole currency units',()=>{
 const h=harness('src/production/PipelineBoard.jsx'),tree=h.render({client:{request:async()=>({})},initialData:{pipelines:[{pipelineId:'p',name:'Pipeline',stages:[{stageId:'s',name:'Open',position:1,probability:10}]}],opportunities:[{opportunityId:'o',name:'Exact amount',stageId:'s',amountCents:12345,currency:'USD',version:1}]}});
 assert.match(renderToStaticMarkup(tree),/\$123\.45/);
});

test('pipeline board loads bounded opportunity pages beyond the first 100',async()=>{
 const pipeline={pipelineId:'p',name:'Pipeline',stages:[{stageId:'s',name:'Open',position:1,probability:10}]},first=Array.from({length:100},(_,index)=>({opportunityId:`first-${index}`,name:`First ${index}`,stageId:'s',amountCents:100,currency:'USD',version:1})),calls=[];
 const client={request:async path=>{calls.push(path);if(path==='/crm/pipelines')return {pipelines:[pipeline]};const query=new URLSearchParams(path.split('?')[1]),offset=Number(query.get('offset')||0);return {opportunities:offset===0?first:offset===100?[{opportunityId:'beyond',name:'Beyond first page',stageId:'s',amountCents:250,currency:'USD',version:1}]:[]};}};
 const h=harness('src/production/PipelineBoard.jsx'),props={client};h.render(props);h.effects()[0]();await flush();await flush();
 const html=renderToStaticMarkup(h.render(props));assert.match(html,/Beyond first page/);assert.ok(calls.includes('/crm/opportunities?limit=100&offset=100'));
});

test('pipeline board accepts the exact 1000-record ceiling after one bounded overflow probe',async()=>{
 const pipeline={pipelineId:'p',name:'Pipeline',stages:[{stageId:'s',name:'Open',position:1,probability:10}]},calls=[],client={request:async path=>{calls.push(path);if(path==='/crm/pipelines')return {pipelines:[pipeline]};const query=new URLSearchParams(path.split('?')[1]),offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||100);return {opportunities:offset<1000?Array.from({length:limit},(_,index)=>({opportunityId:`op-${offset+index}`,name:`Opportunity ${offset+index}`,stageId:'s',amountCents:100,currency:'USD',version:1})):[]};}};
 const h=harness('src/production/PipelineBoard.jsx'),props={client};h.render(props);h.effects()[0]();await flush();await flush();
 assert.match(renderToStaticMarkup(h.render(props)),/Opportunity 999/);assert.ok(calls.includes('/crm/opportunities?limit=1&offset=1000'));
});

test('party directory offers bounded paging and appends the next page',async()=>{
 const first=Array.from({length:100},(_,index)=>({partyId:`party-${index}`,displayName:`Party ${String(index).padStart(3,'0')}`,partyType:'person',status:'active',version:1})),second={partyId:'party-100',displayName:'Party 100',partyType:'person',status:'active',version:1},calls=[];
 const client={request:async path=>{calls.push(path);const query=new URLSearchParams(path.split('?')[1]),offset=Number(query.get('offset')||0);return {parties:offset===0?first:offset===100?[second]:[]};}};
 const modules=[{code:'core',capabilities:{read:true,write:true,export:true}}],session={identity:{identityId:'identity',displayName:'Staff'},membership:{membershipId:'membership',role:'staff'}};
 const h=harness('src/production/CrmWorkspace.jsx'),props={client,session,memberships:[],modules,initialRoute:'people'};h.render(props);h.effects()[0]();await flush();await flush();let tree=h.render(props),more=find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Load more relationships'));
 assert.ok(more);await more.props.onClick();await flush();tree=h.render(props);assert.match(renderToStaticMarkup(tree),/Party 100/);assert.ok(calls.includes('/crm/parties?limit=100&offset=100'));
});

test('intermediate-width navigation keeps destination labels and Sign out visible',()=>{
 const css=readFileSync(new URL('src/production/production.css',root),'utf8'),medium=css.match(/@media \(max-width:900px\)([\s\S]*?)@media \(max-width:700px\)/)?.[1]||'';
 assert.doesNotMatch(medium,/prod-rail nav button span[^}]*display:none/);assert.doesNotMatch(medium,/prod-rail footer>button[^}]*display:none/);
});

test('production typography uses the application design system without a second display-font dependency',()=>{
 const css=readFileSync(new URL('src/production/production.css',root),'utf8'),entry=readFileSync(new URL('src/main.jsx',root),'utf8'),manifest=readFileSync(new URL('package.json',root),'utf8');
 assert.doesNotMatch(css,/Newsreader/i);assert.doesNotMatch(entry,/newsreader/i);assert.doesNotMatch(manifest,/newsreader/i);
});

test('authorized note detail reads only the requested current revision body',async t=>{
 const tenantId=randomUUID(),identityId=randomUUID(),noteId=randomUUID(),subjectId=randomUUID(),calls=[];
 const service={getNote:async input=>{calls.push(input);return {noteId,subjectId,title:'Private note',body:'Authorized current body',currentRevision:2,version:2};}};
 const pass=(req,res,next)=>next(),session=(req,res,next)=>{req.productionSession={tenantId,identityId,membership:{role:'viewer'}};next();};
 const app=express();app.use(express.json());installCrmRoutes(app,{crmService:service,requireTenantSession:session,requireCsrf:pass,requireRecentAuthentication:pass});app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/crm/notes/${noteId}`);assert.equal(response.status,200);const body=await response.json();assert.equal(body.note.body,'Authorized current body');assert.deepEqual(calls[0],{noteId,tenantId,actorRole:'viewer',actorIdentityId:identityId});
});

test('changing a lead or opportunity subject owner updates the canonical sales row in the same transaction',async()=>{
 for(const subjectType of ['lead','opportunity']){
  const tenantId=randomUUID(),subjectId=randomUUID(),actorIdentityId=randomUUID(),ownerIdentityId=randomUUID(),calls=[];
  const session={query:async(sql,values=[])=>{calls.push(String(sql));if(String(sql).includes('/*subject:lock*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:subjectType,owner_identity_id:null,version:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}],rowCount:1};if(String(sql).includes('/*membership:active*/'))return {rows:[{active:true}],rowCount:1};if(String(sql).includes('/*subject:owner-update*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:subjectType,owner_identity_id:ownerIdentityId,version:2}],rowCount:1};if(String(sql).includes('/*ownership-event:insert*/'))return {rows:[],rowCount:1};if(String(sql).includes(`/*${subjectType}:owner-sync*/`))return {rows:[],rowCount:1};throw new Error(`Unexpected query: ${sql}`);}};
  const tenantPool={withTenantSession:async(tenant,fn)=>fn(session),withTransaction:async(tenant,fn)=>fn(session)},repository=createCrmRepository({tenantPool});
  await repository.changeSubjectOwner({tenantId,subjectId,newOwnerIdentityId:ownerIdentityId,expectedVersion:1,actorIdentityId});
  assert.ok(calls.some(sql=>sql.includes(`/*${subjectType}:owner-sync*/`)),`${subjectType} owner must stay synchronized`);
 }
});

test('timestamp lte report filters include the entire requested end day',async()=>{
 const tenantId=randomUUID();let captured;
 const service=createCrmReportingService({tenantPool:{withTenantSession:async(tenant,fn)=>fn({query:async(sql,values)=>{captured={sql,values};return {rows:[]};}})},moduleService:{authorize:async()=>({allowed:true})}});
 await service.executeReport({tenantId,actorRole:'viewer',definition:{dataset:'activities',columns:['summary'],filters:[{field:'occurredAt',operator:'lte',value:'2026-11-11'}]}});
 assert.match(captured.sql,/occurred_at<\(\$2::date \+ INTERVAL '1 day'\)/);assert.equal(captured.values[1],'2026-11-11');
});
