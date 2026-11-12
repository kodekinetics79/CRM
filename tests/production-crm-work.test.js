import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MIGRATIONS,SCHEMA_VERSION,TENANT_TABLES,applicationRoleGrants,controlPlaneRoleGrants,PERSISTENCE_CODES} from '../server/persistence/index.js';
import {createJobRepository} from '../server/production/jobRepository.js';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {createCrmService} from '../server/production/crmService.js';

const now='2026-11-12T02:00:00.000Z';
const clock=()=>new Date(now);
const tenantId=randomUUID(),subjectId=randomUUID(),actorId=randomUUID(),ownerId=randomUUID();

function scriptedPool(responder){
 const calls=[];
 const session={async query(sql,values=[]){const text=String(sql).trim();calls.push({sql:text,values});if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return {rows:[],rowCount:0};const result=responder(text,values,calls);if(!result)throw new Error(`Unexpected work query: ${text}`);return result;}};
 return {calls,pool:{async withTenantSession(id,fn){assert.equal(id,tenantId);return fn(session);},async withTransaction(id,fn){assert.equal(id,tenantId);await session.query('BEGIN');try{const out=await fn(session);await session.query('COMMIT');return out;}catch(error){await session.query('ROLLBACK');throw error;}}}};
}

test('migration 15 adds typed CRM subjects and canonical work facts with forced RLS',()=>{
 assert.ok(SCHEMA_VERSION>=15);
 const sql=MIGRATIONS.find(entry=>entry.version===15)?.statements.join('\n')??'';
 for(const table of ['crm_subjects','crm_activities','crm_tasks','crm_task_events','crm_notes','crm_note_revisions','crm_attachment_links','crm_ownership_events']){
  assert.match(sql,new RegExp(`CREATE TABLE ${table}\\(`));
  assert.ok(TENANT_TABLES.includes(table),table);
  assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
 }
 assert.match(sql,/subject_type IN \('party','lead','opportunity'\)/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, party_id\) REFERENCES parties/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, lead_id\) REFERENCES leads/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, opportunity_id\) REFERENCES opportunities/);
 assert.match(sql,/CHECK \(\(status = 'completed'\) = \(completed_at IS NOT NULL\)\)/);
 assert.match(sql,/FOREIGN KEY \(tenant_id, object_id, object_revision\) REFERENCES object_metadata/);
 assert.match(sql,/INSERT INTO crm_subjects.*FROM parties/s);
 assert.match(sql,/INSERT INTO crm_subjects.*FROM leads/s);
 assert.match(sql,/INSERT INTO crm_subjects.*FROM opportunities/s);
 assert.match(sql,/CREATE TRIGGER crm_subject_identity_immutable BEFORE UPDATE OF subject_type,party_id,lead_id,opportunity_id ON crm_subjects/);
 for(const name of ['crm_activity_append_only','crm_task_event_append_only','crm_note_revision_append_only','crm_attachment_link_append_only','crm_ownership_event_append_only'])assert.match(sql,new RegExp(name));
});

test('subject registration refuses cross-type UUID collisions and accepts an exact existing identity',async()=>{
 const pipelineId=randomUUID(),stageId=randomUUID(),leadId=randomUUID(),partyId=randomUUID();
 const leadRow={tenant_id:tenantId,lead_id:leadId,party_id:partyId,pipeline_id:pipelineId,stage_id:stageId,source:'web',status:'new',owner_identity_id:null,expected_value_cents:100,currency:'USD',probability:10,expected_close_date:'2026-12-31',converted_opportunity_id:null,version:1,created_at:now,updated_at:now};
 const make=registeredType=>scriptedPool(sql=>{
  if(sql.includes('/*pipeline-stage:get*/'))return {rows:[{tenant_id:tenantId,stage_id:stageId,pipeline_id:pipelineId,kind:'open'}],rowCount:1};
  if(sql.includes('/*lead:insert*/'))return {rows:[leadRow],rowCount:1};
  if(sql.includes('/*subject:register*/'))return {rows:[],rowCount:0};
  if(sql.includes('/*subject:registered*/'))return {rows:[{tenant_id:tenantId,subject_id:leadId,subject_type:registeredType,party_id:registeredType==='party'?leadId:null,lead_id:registeredType==='lead'?leadId:null,opportunity_id:null}],rowCount:1};
  return {rows:[],rowCount:0};
 });
 const input={tenantId,leadId,partyId,pipelineId,stageId,source:'web',expectedValueCents:100,currency:'USD',probability:10,expectedCloseDate:'2026-12-31'};
 const collision=make('party');
 await assert.rejects(()=>createCrmRepository({tenantPool:collision.pool,clock}).createLead(input),error=>error.code===PERSISTENCE_CODES.CONFLICT);
 assert.equal(collision.calls.at(-1).sql,'ROLLBACK');
 const exact=make('lead');
 assert.equal((await createCrmRepository({tenantPool:exact.pool,clock}).createLead(input)).leadId,leadId);
 assert.equal(exact.calls.at(-1).sql,'COMMIT');
});

test('work grants retain append-only facts and deny control-plane access',()=>{
 const app=applicationRoleGrants('wimblo_app'),control=controlPlaneRoleGrants('wimblo_control');
 for(const table of ['crm_activities','crm_task_events','crm_note_revisions','crm_attachment_links','crm_ownership_events']){
  assert.ok(app.includes(`GRANT SELECT, INSERT ON ${table} TO wimblo_app`),table);
  assert.equal(app.some(sql=>sql.includes(table)&&/UPDATE|DELETE/.test(sql)),false,table);
  assert.ok(control.includes(`REVOKE ALL PRIVILEGES ON ${table} FROM wimblo_control`),table);
 }
 for(const table of ['crm_subjects','crm_tasks','crm_notes']){
  assert.ok(app.includes(`GRANT SELECT, INSERT, UPDATE ON ${table} TO wimblo_app`),table);
  assert.equal(app.some(sql=>sql.includes(table)&&sql.includes('DELETE')),false,table);
 }
});

test('job enqueueInTransaction reuses the caller session and public enqueue delegates',async()=>{
 const f=scriptedPool(sql=>sql.includes('/*job:enqueue*/')?{rows:[{tenant_id:tenantId,job_id:randomUUID(),queue:'default',kind:'crm.task_reminder',idempotency_key:'crm.task-reminder:x:1',payload:{taskId:'x'},state:'ready',priority:0,available_at:now,lease_owner:null,lease_expires_at:null,attempts:0,max_attempts:5,version:1,created_at:now,updated_at:now,completed_at:null}],rowCount:1}:{rows:[],rowCount:0});
 const jobs=createJobRepository({tenantPool:f.pool,clock});
 await f.pool.withTransaction(tenantId,session=>jobs.enqueueInTransaction(session,{tenantId,kind:'crm.task_reminder',idempotencyKey:'crm.task-reminder:x:1',payload:{taskId:'x'},availableAt:now}));
 assert.equal(f.calls.filter(call=>call.sql==='BEGIN').length,1);
 assert.equal(f.calls.some(call=>call.sql.includes('/*job:enqueue*/')),true);
});

test('task creation appends history and reminder inside one transaction',async()=>{
 const taskId=randomUUID();
 const f=scriptedPool((sql)=>{
  if(sql.includes('/*subject:get*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',version:1}],rowCount:1};
  if(sql.includes('/*membership:active*/'))return {rows:[{identity_id:ownerId}],rowCount:1};
  if(sql.includes('/*task:insert*/'))return {rows:[{tenant_id:tenantId,task_id:taskId,subject_id:subjectId,title:'Follow up',details:null,status:'open',owner_identity_id:ownerId,due_at:now,reminder_at:now,completed_at:null,version:1,created_at:now,updated_at:now}],rowCount:1};
  if(sql.includes('/*job:enqueue*/'))return {rows:[{tenant_id:tenantId,job_id:randomUUID(),queue:'default',kind:'crm.task_reminder',idempotency_key:`crm.task-reminder:${taskId}:1`,payload:{},state:'ready',priority:0,available_at:now,attempts:0,max_attempts:5,version:1,created_at:now,updated_at:now}],rowCount:1};
  return {rows:[],rowCount:1};
 });
 const jobs=createJobRepository({tenantPool:f.pool,clock});
 const repository=createCrmRepository({tenantPool:f.pool,jobRepository:jobs,clock});
 const task=await repository.createTask({tenantId,taskId,subjectId,title:'Follow up',ownerIdentityId:ownerId,dueAt:now,reminderAt:now,actorIdentityId:actorId});
 assert.equal(task.version,1);
 assert.ok(f.calls.some(call=>call.sql.includes('/*task-event:insert*/')));
 const job=f.calls.find(call=>call.sql.includes('/*job:enqueue*/'));
 assert.deepEqual(JSON.parse(job.values[5]),{taskId,subjectId,expectedTaskVersion:1});
 assert.equal(f.calls.at(-1).sql,'COMMIT');
});

test('stale task update rolls back without history or reminder',async()=>{
 const taskId=randomUUID();
 const f=scriptedPool(sql=>sql.includes('/*task:lock*/')?{rows:[{tenant_id:tenantId,task_id:taskId,subject_id:subjectId,status:'open',version:2}],rowCount:1}:{rows:[],rowCount:0});
 const repository=createCrmRepository({tenantPool:f.pool,clock});
 await assert.rejects(()=>repository.updateTask({tenantId,taskId,expectedVersion:1,status:'completed',actorIdentityId:actorId}),error=>error.code===PERSISTENCE_CODES.CONFLICT);
 assert.equal(f.calls.some(call=>call.sql.includes('/*task-event:insert*/')),false);
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});

test('notes are revised immutably and attachment responses expose no storage topology',async()=>{
 const noteId=randomUUID(),linkId=randomUUID();
 const f=scriptedPool((sql)=>{
  if(sql.includes('/*subject:get*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',version:1}],rowCount:1};
  if(sql.includes('/*membership:active*/'))return {rows:[{identity_id:actorId}],rowCount:1};
  if(sql.includes('/*note:lock*/'))return {rows:[{tenant_id:tenantId,note_id:noteId,subject_id:subjectId,title:'Research',current_revision:1,version:1,created_at:now,updated_at:now}],rowCount:1};
  if(sql.includes('/*note-revision:insert*/'))return {rows:[{tenant_id:tenantId,note_id:noteId,revision:2,subject_id:subjectId,body:'Second',actor_identity_id:actorId,occurred_at:now}],rowCount:1};
  if(sql.includes('/*note:update*/'))return {rows:[{tenant_id:tenantId,note_id:noteId,subject_id:subjectId,title:'Research',current_revision:2,version:2,created_at:now,updated_at:now}],rowCount:1};
  if(sql.includes('/*object:active*/'))return {rows:[{tenant_id:tenantId,object_id:'obj-1',revision:2,content_type:'application/pdf',size_bytes:100,state:'active',object_key:'secret',bucket:'secret'}],rowCount:1};
  if(sql.includes('/*attachment:insert*/'))return {rows:[{tenant_id:tenantId,link_id:linkId,subject_id:subjectId,object_id:'obj-1',object_revision:2,file_name:'brief.pdf',content_type:'application/pdf',size_bytes:100,actor_identity_id:actorId,occurred_at:now}],rowCount:1};
  return {rows:[],rowCount:1};
 });
 const repository=createCrmRepository({tenantPool:f.pool,clock});
 const revised=await repository.reviseNote({tenantId,noteId,expectedVersion:1,body:'Second',actorIdentityId:actorId});
 assert.equal(revised.currentRevision,2);
 const link=await repository.linkAttachment({tenantId,linkId,subjectId,objectId:'obj-1',objectRevision:2,fileName:'brief.pdf',actorIdentityId:actorId});
 assert.equal(link.fileName,'brief.pdf');
 assert.doesNotMatch(JSON.stringify(link),/objectKey|bucket|provider|encryption/i);
});

test('ownership change validates active membership and records one optimistic transition',async()=>{
 const f=scriptedPool(sql=>{
  if(sql.includes('/*subject:lock*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',owner_identity_id:null,version:1}],rowCount:1};
  if(sql.includes('/*membership:active*/'))return {rows:[{identity_id:ownerId}],rowCount:1};
  if(sql.includes('/*subject:owner-update*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',owner_identity_id:ownerId,version:2,created_at:now,updated_at:now}],rowCount:1};
  return {rows:[],rowCount:1};
 });
 const repository=createCrmRepository({tenantPool:f.pool,clock});
 const subject=await repository.changeSubjectOwner({tenantId,subjectId,newOwnerIdentityId:ownerId,expectedVersion:1,actorIdentityId:actorId});
 assert.equal(subject.ownerIdentityId,ownerId);
 assert.ok(f.calls.some(call=>call.sql.includes('/*ownership-event:insert*/')));
});

test('subject detail returns the tenant-scoped current owner and optimistic version',async()=>{
 const f=scriptedPool(sql=>sql.includes('/*subject:get*/')?{rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',owner_identity_id:ownerId,version:7,created_at:now,updated_at:now}],rowCount:1}:null);
 const subject=await createCrmRepository({tenantPool:f.pool,clock}).getSubject(tenantId,subjectId);
 assert.deepEqual(subject,{tenantId,subjectId,subjectType:'party',ownerIdentityId:ownerId,version:7,createdAt:now,updatedAt:now});
 assert.deepEqual(f.calls.find(call=>call.sql.includes('/*subject:get*/')).values,[tenantId,subjectId]);
});

test('assignment catalog requires core read and forwards only the authenticated tenant actor',async()=>{
 const calls=[],repository={createPerson(){},getSubjectType:async()=> 'party'},memberDirectory={listAssignmentMembers:async input=>(calls.push(input),[{identityId:ownerId,displayName:'Owner',role:'owner'}])},moduleService={authorize:async input=>({allowed:input.tenantId===tenantId&&input.code==='core'&&input.action==='read'})};
 const service=createCrmService({repository,moduleService,memberDirectory});
 assert.deepEqual(await service.listAssignmentMembers({tenantId,actorIdentityId:actorId,actorRole:'viewer'}),[{identityId:ownerId,displayName:'Owner',role:'owner'}]);
 assert.deepEqual(calls,[{tenantId,actorIdentityId:actorId}]);
 await assert.rejects(()=>service.listAssignmentMembers({tenantId:randomUUID(),actorIdentityId:actorId,actorRole:'viewer'}),error=>error.code===PERSISTENCE_CODES.ISOLATION);
});

test('work service requires core and sales capabilities for opportunity subjects',async()=>{
 const calls=[];
 const repository={
  createPerson(){},getSubjectType:async()=> 'opportunity',createActivity:async input=>input,
  getTaskSubject:async()=>({subjectId,subjectType:'opportunity'}),updateTask:async input=>input,
  getNoteSubject:async()=>({subjectId,subjectType:'opportunity'}),reviseNote:async input=>input
 };
 const moduleService={authorize:async input=>{calls.push(input);return {allowed:input.code==='core'};}};
 const service=createCrmService({repository,moduleService});
 await assert.rejects(()=>service.createActivity({tenantId,subjectId,actorRole:'staff'}),error=>error.code===PERSISTENCE_CODES.ISOLATION);
 assert.deepEqual(calls.map(call=>call.code),['core','sales']);
 calls.length=0;
 await assert.rejects(()=>service.updateTask({tenantId,taskId:randomUUID(),actorRole:'staff'}),error=>error.code===PERSISTENCE_CODES.ISOLATION);
 assert.deepEqual(calls.map(call=>call.code),['core','sales']);
});
