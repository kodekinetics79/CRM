import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installCrmRoutes} from '../server/production/crmRoutes.js';
import {PERSISTENCE_CODES,persistenceFail} from '../server/persistence/contract.js';

const tenantId=randomUUID(),identityId=randomUUID(),subjectId=randomUUID(),taskId=randomUUID(),noteId=randomUUID();
const pass=(req,res,next)=>next();
const refuse=(req,res)=>res.status(403).json({error:'refused'});
const session=role=>(req,res,next)=>{req.productionSession={tenantId,identityId,membership:{role}};next();};

function appFor(service,{role='staff',csrf=pass,recent=pass}={}){
 const app=express();app.use(express.json());
 installCrmRoutes(app,{crmService:service,requireTenantSession:session(role),requireCsrf:csrf,requireRecentAuthentication:recent});
 app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||500).json({error:'refused'});});return app;
}
async function request(app,path,{method='GET',body}={}){const server=app.listen(0,'127.0.0.1');await once(server,'listening');try{return await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}finally{await new Promise(resolve=>server.close(resolve));}}

const service=()=>({
 listParties:async()=>[],getParty:async()=>({}),createPerson:async()=>({}),createOrganization:async()=>({}),updateParty:async()=>({}),listContacts:async()=>[],createContact:async()=>({}),listRelationships:async()=>[],createRelationship:async()=>({}),
 listPipelines:async()=>[],ensureDefaultPipeline:async()=>({}),listLeads:async()=>[],createLead:async()=>({}),convertLead:async()=>({}),listOpportunities:async()=>[],changeOpportunityStage:async()=>({}),
 getSubject:async input=>({subjectId:input.subjectId,subjectType:'party',ownerIdentityId:identityId,version:4}),listAssignmentMembers:async()=>[{identityId,displayName:'Signed in staff',role:'staff'}],createActivity:async input=>input,listSubjectTasks:async input=>({tasks:[{taskId,title:'Saved task',status:'open',version:2}],nextCursor:null,input}),getTask:async input=>({taskId:input.taskId,title:'Saved task',details:'Exact detail',status:'open',version:2}),createTask:async input=>input,updateTask:async input=>input,listSubjectNotes:async input=>({notes:[{noteId,title:'Saved note',currentRevision:2,version:2}],nextCursor:null,input}),getNote:async input=>({noteId:input.noteId,title:'Saved note',body:'Exact body',currentRevision:2,version:2}),createNote:async input=>input,reviseNote:async input=>input,linkAttachment:async input=>input,changeSubjectOwner:async input=>input,listTimeline:async input=>({items:[],nextCursor:null,input})
});

test('work routes carry tenant role and actor context and viewer can read resumable artifacts and timeline',async()=>{
 const calls=[],api=service();for(const name of ['createActivity','listSubjectTasks','getTask','createTask','updateTask','listSubjectNotes','getNote','createNote','reviseNote','linkAttachment','changeSubjectOwner','listTimeline']){const original=api[name];api[name]=async input=>{calls.push([name,input]);return original(input);};}
 const app=appFor(api);
 const activity=await request(app,`/api/crm/subjects/${subjectId}/activities`,{method:'POST',body:{activityType:'call',summary:'Called'}});
 assert.equal(activity.status,201);
 assert.equal((await request(app,`/api/crm/tasks/${taskId}`,{method:'PATCH',body:{expectedVersion:1,status:'completed'}})).status,200);
 assert.equal((await request(app,`/api/crm/notes/${noteId}/revisions`,{method:'POST',body:{expectedVersion:1,body:'Revised'}})).status,201);
 const viewer=appFor(api,{role:'viewer'});assert.equal((await request(viewer,`/api/crm/subjects/${subjectId}/tasks?limit=50`)).status,200);assert.equal((await request(viewer,`/api/crm/tasks/${taskId}`)).status,200);assert.equal((await request(viewer,`/api/crm/subjects/${subjectId}/notes?limit=50`)).status,200);assert.equal((await request(viewer,`/api/crm/notes/${noteId}`)).status,200);
 const timeline=await request(viewer,`/api/crm/subjects/${subjectId}/timeline?limit=25`);
 assert.equal(timeline.status,200);
 for(const [,input] of calls){assert.equal(input.tenantId,tenantId);assert.equal(input.actorIdentityId,identityId);if(input.subjectId)assert.equal(input.subjectId,subjectId);}
 assert.equal(calls.find(([name])=>name==='updateTask')[1].taskId,taskId);
 assert.equal(calls.find(([name])=>name==='reviseNote')[1].noteId,noteId);
});

test('subject detail and assignment member catalog are tenant-session reads with safe response fields',async()=>{
 const calls=[],api=service();for(const name of ['getSubject','listAssignmentMembers']){const original=api[name];api[name]=async input=>{calls.push([name,input]);return original(input);};}const app=appFor(api,{role:'viewer'});
 const subjectResponse=await request(app,`/api/crm/subjects/${subjectId}`),memberResponse=await request(app,'/api/crm/members');
 assert.equal(subjectResponse.status,200);assert.deepEqual(await subjectResponse.json(),{subject:{subjectId,subjectType:'party',ownerIdentityId:identityId,version:4}});
 assert.equal(memberResponse.status,200);const memberBody=await memberResponse.json();assert.deepEqual(memberBody,{members:[{identityId,displayName:'Signed in staff',role:'staff'}]});assert.doesNotMatch(JSON.stringify(memberBody),/password|email|security|hash/i);
 for(const [,input] of calls){assert.equal(input.tenantId,tenantId);assert.equal(input.actorIdentityId,identityId);assert.equal(input.actorRole,'viewer');}
 assert.equal((await request(appFor(api,{role:'helper'}),'/api/crm/members')).status,403);
 const disabled=service();disabled.listAssignmentMembers=async()=>persistenceFail(PERSISTENCE_CODES.ISOLATION,'Core capability disabled');assert.equal((await request(appFor(disabled),'/api/crm/members')).status,403);
});

test('every work mutation is blocked for viewers and by CSRF or recent-auth middleware',async()=>{
 const api=service(),paths=[
  ['POST',`/api/crm/subjects/${subjectId}/activities`,{activityType:'call',summary:'Called'}],
  ['POST',`/api/crm/subjects/${subjectId}/tasks`,{title:'Task',ownerIdentityId:identityId}],
  ['PATCH',`/api/crm/tasks/${taskId}`,{expectedVersion:1,status:'completed'}],
  ['POST',`/api/crm/subjects/${subjectId}/notes`,{title:'Note',body:'Body'}],
  ['POST',`/api/crm/notes/${noteId}/revisions`,{expectedVersion:1,body:'Revised'}],
  ['POST',`/api/crm/subjects/${subjectId}/attachments`,{objectId:'obj',objectRevision:1,fileName:'a.pdf'}],
  ['PATCH',`/api/crm/subjects/${subjectId}/owner`,{newOwnerIdentityId:identityId,expectedVersion:1}]
 ];
 for(const [method,path,body] of paths){assert.equal((await request(appFor(api,{role:'viewer'}),path,{method,body})).status,403);assert.equal((await request(appFor(api,{csrf:refuse}),path,{method,body})).status,403);assert.equal((await request(appFor(api,{recent:refuse}),path,{method,body})).status,403);}
});
