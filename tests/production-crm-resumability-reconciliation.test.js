import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import express from 'express';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {once} from 'node:events';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {createCrmImportService,parsePeopleCsv} from '../server/production/crmImportService.js';
import {installCrmRoutes} from '../server/production/crmRoutes.js';

const root=new URL('../',import.meta.url),flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness(path){let index=0,state=[],effects=[],cleanups=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);}};const module={exports:{}},code=transformSync(readFileSync(new URL(path,root),'utf8'),{loader:'jsx',format:'cjs'}).code;new Function('require','module','exports',code)(id=>id==='react'?mock:{__esModule:true,default:()=>null},module,module.exports);return{render(props){index=0;effects=[];return module.exports.default(props);},commit(){for(const cleanup of cleanups)cleanup?.();cleanups=effects.map(effect=>effect());}};}
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child,predicate);if(match)return match;}return null;};
const byName=(tree,name)=>find(tree,node=>node.props?.name===name),byButton=(tree,label)=>find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes(label));

test('relationship reload selects exact saved task and note records, then resumes current versions',async()=>{
 const party={partyId:randomUUID(),partyType:'person',displayName:'Reloaded relationship',status:'active',version:2},member={identityId:randomUUID(),displayName:'Staff',role:'staff'},taskId=randomUUID(),noteId=randomUUID(),calls=[];
 const task={taskId,subjectId:party.partyId,title:'Persisted task',details:'private task details',status:'open',ownerIdentityId:member.identityId,version:3};
 const note={noteId,subjectId:party.partyId,title:'Persisted note',body:'Persisted private body',currentRevision:2,version:2};
 const client={request:async(path,options={})=>{calls.push([path,options]);if(path===`/crm/parties/${party.partyId}`)return {party};if(path.endsWith('/contacts?limit=100'))return {contacts:[]};if(path===`/crm/subjects/${party.partyId}`)return {subject:{subjectId:party.partyId,subjectType:'party',ownerIdentityId:member.identityId,version:1}};if(path==='/crm/members')return {members:[member]};if(path===`/crm/subjects/${party.partyId}/tasks?limit=50`)return {tasks:[{taskId,title:task.title,status:task.status,version:task.version}]};if(path===`/crm/subjects/${party.partyId}/notes?limit=50`)return {notes:[{noteId,title:note.title,currentRevision:2,version:2}]};if(path===`/crm/tasks/${taskId}`&&options.method===undefined)return {task};if(path===`/crm/notes/${noteId}`&&options.method===undefined)return {note};if(path===`/crm/tasks/${taskId}`&&options.method==='PATCH')return {task:{...task,status:options.body.status,version:4}};if(path===`/crm/notes/${noteId}/revisions`)return {note:{...note,currentRevision:3,version:3}};throw new Error(`Unexpected ${path}`);}};
 const h=harness('src/production/RelationshipWorkspace.jsx'),props={client,party,writable:true,signedInIdentityId:member.identityId};h.render(props);h.commit();await flush();await flush();let tree=h.render(props);
 assert.ok(byName(tree,'savedTask'));assert.ok(byName(tree,'savedNote'));
 await byName(tree,'savedTask').props.onChange({target:{value:taskId}});await flush();tree=h.render(props);assert.match(renderToStaticMarkup(tree),/Persisted task/);await byButton(tree,'Start task').props.onClick();
 await byName(tree,'savedNote').props.onChange({target:{value:noteId}});await flush();tree=h.render(props);assert.equal(byName(tree,'noteBody').props.value,'Persisted private body');byName(tree,'noteBody').props.onChange({target:{name:'noteBody',value:'Reviewed revision'}});tree=h.render(props);await find(tree,node=>node.type==='form'&&node.props['aria-label']==='Revise note').props.onSubmit({preventDefault(){}});
 const taskWrite=calls.find(([path,options])=>path===`/crm/tasks/${taskId}`&&options.method==='PATCH'),noteWrite=calls.find(([path])=>path===`/crm/notes/${noteId}/revisions`);
 assert.deepEqual(taskWrite[1].body,{status:'in_progress',expectedVersion:3});assert.deepEqual(noteWrite[1].body,{body:'Reviewed revision',expectedVersion:2});
});

test('bounded subject artifact lists omit private task details and note bodies',async()=>{
 const tenantId=randomUUID(),subjectId=randomUUID(),taskId=randomUUID(),noteId=randomUUID(),now='2026-11-11T12:00:00.000Z',queries=[];
 const tenantPool={withTenantSession:async(tenant,fn)=>fn({query:async(sql,values)=>{queries.push({sql:String(sql),values});if(String(sql).includes('/*task:list*/'))return {rows:[{tenant_id:tenantId,task_id:taskId,subject_id:subjectId,title:'Task',details:'must not list',status:'open',owner_identity_id:randomUUID(),version:1,created_at:now,updated_at:now}],rowCount:1};if(String(sql).includes('/*note:list*/'))return {rows:[{tenant_id:tenantId,note_id:noteId,subject_id:subjectId,title:'Note',body:'must not list',current_revision:1,version:1,created_at:now,updated_at:now}],rowCount:1};throw new Error(`Unexpected ${sql}`);}}),withTransaction:async()=>{throw new Error('not used');}};
 const repository=createCrmRepository({tenantPool}),tasks=await repository.listTasks(tenantId,{subjectId,limit:50}),notes=await repository.listNotes(tenantId,{subjectId,limit:50});
 assert.equal(tasks[0].details,undefined);assert.equal(notes[0].body,undefined);assert.ok(queries.every(query=>query.values.at(-1)===50));
});

test('reviewed mapping reconciliation advances only the exact locked mapping and unwedges a new preview',async()=>{
 const tenantId=randomUUID(),actorIdentityId=randomUUID(),targetSubjectId=randomUUID(),batchId=randomUUID(),csv='external_key,display_name,first_name,last_name\nA-1,Ada,Ada,Lovelace\n',parsed=parsePeopleCsv(csv),events=[];let targetVersion=2,mappingVersion=1;
 const tenantPool={withTransaction:async(tenant,fn)=>fn({query:async(sql,values)=>{sql=String(sql);if(sql.includes('/*import-map:reconcile-lock*/'))return {rows:[{external_key:'A-1',target_subject_id:targetSubjectId,source_row_hash:parsed.rows[0].rowHash,target_version:mappingVersion,current_target_version:targetVersion}],rowCount:1};if(sql.includes('/*import-map:reconcile-update*/')){mappingVersion=targetVersion;return {rows:[{target_version:mappingVersion,updated_at:'2026-11-11T12:00:00.000Z'}],rowCount:1};}if(sql.includes('/*import-map:reconcile-audit*/')){events.push(values);return {rows:[],rowCount:1};}if(sql.includes('/*import-batch:by-key*/'))return {rows:[],rowCount:0};if(sql.includes('/*import-map:snapshot*/'))return {rows:[{external_key:'A-1',target_subject_id:targetSubjectId,source_row_hash:parsed.rows[0].rowHash,target_version:mappingVersion,current_target_version:targetVersion}],rowCount:1};if(sql.includes('/*import-batch:insert*/'))return {rows:[{tenant_id:tenantId,batch_id:batchId,idempotency_key:'after-review',source_system:'legacy',source_sha256:values[4],mapping_sha256:values[5],preview_sha256:values[6],row_count:1,valid_count:1,invalid_count:0,inserted_count:values[11],updated_count:values[12],unchanged_count:values[13],status:'previewed',version:1,expires_at:'2026-11-11T13:00:00.000Z'}],rowCount:1};throw new Error(`Unexpected ${sql}`);}})};
 const service=createCrmImportService({tenantPool,moduleService:{authorize:async()=>({allowed:true})},clock:()=>new Date('2026-11-11T12:00:00.000Z')});
 const mapping=await service.reconcilePeopleMapping({tenantId,actorRole:'staff',actorIdentityId,sourceSystem:'legacy',externalKey:'A-1',targetSubjectId,expectedSourceRowHash:parsed.rows[0].rowHash,expectedMappingTargetVersion:1,expectedCurrentTargetVersion:2,reason:'Reviewed the manual customer correction.'});
 assert.equal(mapping.targetVersion,2);assert.equal(events.length,1);const preview=await service.previewPeople({tenantId,actorRole:'staff',actorIdentityId,batchId,idempotencyKey:'after-review',sourceSystem:'legacy',csv});assert.equal(preview.unchangedCount,1);
});

test('mapping reconciliation refuses stale reviewed identities without update or audit',async()=>{
 const targetSubjectId=randomUUID(),calls=[],service=createCrmImportService({tenantPool:{withTransaction:async(tenant,fn)=>fn({query:async(sql)=>{calls.push(String(sql));if(String(sql).includes('/*import-map:reconcile-lock*/'))return {rows:[{external_key:'A-1',target_subject_id:targetSubjectId,source_row_hash:'a'.repeat(64),target_version:2,current_target_version:3}],rowCount:1};throw new Error('unexpected write');}})},moduleService:{authorize:async()=>({allowed:true})}});
 await assert.rejects(()=>service.reconcilePeopleMapping({tenantId:randomUUID(),actorRole:'staff',actorIdentityId:randomUUID(),sourceSystem:'legacy',externalKey:'A-1',targetSubjectId,expectedSourceRowHash:'a'.repeat(64),expectedMappingTargetVersion:1,expectedCurrentTargetVersion:3,reason:'Reviewed exact manual correction.'}),/stale|changed|review/i);
 assert.equal(calls.some(sql=>sql.includes('reconcile-update')||sql.includes('reconcile-audit')),false);
});

test('mapping reconciliation route requires write authorization and propagates reviewed context',async t=>{
 const tenantId=randomUUID(),identityId=randomUUID(),targetSubjectId=randomUUID(),calls=[],service={reconcilePeopleMapping:async input=>(calls.push(input),input)};
 const pass=(req,res,next)=>next(),session=role=>(req,res,next)=>{req.productionSession={tenantId,identityId,membership:{role}};next();},body={sourceSystem:'legacy',externalKey:'A-1',targetSubjectId,expectedSourceRowHash:'a'.repeat(64),expectedMappingTargetVersion:1,expectedCurrentTargetVersion:2,reason:'Reviewed exact manual correction.'};
 const app=express();app.use(express.json());installCrmRoutes(app,{crmService:{},crmImportService:service,requireTenantSession:session('staff'),requireCsrf:pass,requireRecentAuthentication:pass});app.use((error,req,res,next)=>res.status(error.status||500).json({error:'refused'}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/crm/imports/mappings/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);assert.deepEqual(calls[0],{...body,tenantId,actorRole:'staff',actorIdentityId:identityId});
});
