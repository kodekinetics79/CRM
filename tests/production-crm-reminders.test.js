import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MIGRATIONS,SCHEMA_VERSION} from '../server/persistence/index.js';
import {createCrmRepository} from '../server/production/crmRepository.js';
import * as worker from '../server/production/worker.js';

const now='2026-11-12T02:00:00.000Z',reminderAt='2026-11-12T01:59:00.000Z';
const tenantId=randomUUID(),taskId=randomUUID(),subjectId=randomUUID(),ownerId=randomUUID(),jobId=randomUUID();
const taskRow=(changes={})=>({tenant_id:tenantId,task_id:taskId,subject_id:subjectId,title:'Call customer',details:null,status:'open',owner_identity_id:ownerId,due_at:null,reminder_at:reminderAt,completed_at:null,version:3,created_at:now,updated_at:now,validated_subject_id:subjectId,subject_type:'party',owner_active:true,...changes});

function scriptedPool(responder){
 const calls=[];
 const session={async query(sql,values=[]){const text=String(sql).trim();calls.push({sql:text,values});if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return {rows:[],rowCount:0};const result=responder(text,values,calls);if(!result)throw new Error(`Unexpected reminder query: ${text}`);return result;}};
 return {calls,pool:{async withTenantSession(id,fn){assert.equal(id,tenantId);return fn(session);},async withTransaction(id,fn){assert.equal(id,tenantId);await session.query('BEGIN');try{const out=await fn(session);await session.query('COMMIT');return out;}catch(error){await session.query('ROLLBACK');throw error;}}}};
}

test('migration 18 safely expands populated task history for reminder_due events',()=>{
 assert.equal(SCHEMA_VERSION,18);
 const migration=MIGRATIONS.find(entry=>entry.version===18);assert.ok(migration);
 const sql=migration.statements.join('\n');
 assert.match(sql,/ADD CONSTRAINT crm_task_events_action_expand_check CHECK \(action IN \('created','updated','completed','reopened','cancelled','reminder_due'\)\) NOT VALID/);
 assert.match(sql,/VALIDATE CONSTRAINT crm_task_events_action_expand_check/);
 assert.match(sql,/DROP CONSTRAINT crm_task_events_action_check/);
 assert.match(sql,/RENAME CONSTRAINT crm_task_events_action_expand_check TO crm_task_events_action_check/);
 assert.ok(sql.indexOf('VALIDATE CONSTRAINT crm_task_events_action_expand_check')<sql.indexOf('DROP CONSTRAINT crm_task_events_action_check'));
});

test('a due task reminder appends one deterministic visible event and clears the schedule atomically',async()=>{
 const f=scriptedPool((sql,values)=>{
  if(sql.includes('/*task-reminder:lock*/'))return {rows:[taskRow()],rowCount:1};
  if(sql.includes('/*task-reminder:event*/'))return {rows:[],rowCount:0};
  if(sql.includes('/*task-reminder:event-insert*/'))return {rows:[{event_id:jobId}],rowCount:1};
  if(sql.includes('/*task-reminder:clear*/'))return {rows:[taskRow({reminder_at:null,version:4})],rowCount:1};
 });
 const result=await createCrmRepository({tenantPool:f.pool,clock:()=>new Date(now)}).processTaskReminder({tenantId,taskId,expectedTaskVersion:3,jobId});
 assert.deepEqual(result,{outcome:'delivered',taskId,subjectId,eventId:jobId,replayed:false});
 const inserted=f.calls.find(call=>call.sql.includes('/*task-reminder:event-insert*/'));
 assert.equal(inserted.values[1],jobId);assert.equal(inserted.values[4],'reminder_due');assert.equal(inserted.values[5],ownerId);
 assert.ok(f.calls.some(call=>call.sql.includes('/*task-reminder:clear*/')));assert.equal(f.calls.at(-1).sql,'COMMIT');
});

test('a retry after the reminder transaction committed returns success from the existing event',async()=>{
 const f=scriptedPool(sql=>{
  if(sql.includes('/*task-reminder:lock*/'))return {rows:[taskRow({reminder_at:null,version:4})],rowCount:1};
  if(sql.includes('/*task-reminder:event*/'))return {rows:[{event_id:jobId,task_id:taskId,subject_id:subjectId,action:'reminder_due'}],rowCount:1};
 });
 const result=await createCrmRepository({tenantPool:f.pool,clock:()=>new Date(now)}).processTaskReminder({tenantId,taskId,expectedTaskVersion:3,jobId});
 assert.deepEqual(result,{outcome:'delivered',taskId,subjectId,eventId:jobId,replayed:true});
 assert.equal(f.calls.some(call=>call.sql.includes('event-insert')||call.sql.includes('reminder:clear')),false);
});

test('stale, rescheduled, terminal, unscheduled and unowned reminders are suppressed without history',async()=>{
 const cases=[
  ['stale',taskRow({version:4}),'stale_task'],
  ['rescheduled',taskRow({reminder_at:'2026-11-12T03:00:00.000Z'}),'rescheduled'],
  ['completed',taskRow({status:'completed',completed_at:now}),'completed'],
  ['cancelled',taskRow({status:'cancelled'}),'cancelled'],
  ['unscheduled',taskRow({reminder_at:null}),'unscheduled'],
  ['inactive owner',taskRow({owner_active:false}),'inactive_owner'],
  ['missing subject',taskRow({validated_subject_id:null,subject_type:null}),'missing_subject']
 ];
 for(const [label,row,reason] of cases){
  const f=scriptedPool(sql=>sql.includes('/*task-reminder:lock*/')?{rows:[row],rowCount:1}:sql.includes('/*task-reminder:event*/')?{rows:[],rowCount:0}:null);
  const result=await createCrmRepository({tenantPool:f.pool,clock:()=>new Date(now)}).processTaskReminder({tenantId,taskId,expectedTaskVersion:3,jobId});
  assert.deepEqual(result,{outcome:'suppressed',reason,taskId},label);
  assert.equal(f.calls.some(call=>call.sql.includes('event-insert')||call.sql.includes('reminder:clear')),false,label);
 }
});

test('every produced CRM reminder kind has a real handler that calls the durable processor',async()=>{
 const produced=[],processed=[];
 const jobs={async enqueueInTransaction(_session,input){produced.push(input);return input;}};
 const f=scriptedPool(sql=>{
  if(sql.includes('/*subject:get*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',version:1}],rowCount:1};
  if(sql.includes('/*membership:active*/'))return {rows:[{active:true}],rowCount:1};
  if(sql.includes('/*task:insert*/'))return {rows:[taskRow({version:1})],rowCount:1};
  if(sql.includes('/*task-event:insert*/'))return {rows:[],rowCount:1};
 });
 await createCrmRepository({tenantPool:f.pool,jobRepository:jobs,clock:()=>new Date(now)}).createTask({tenantId,taskId,subjectId,title:'Call customer',ownerIdentityId:ownerId,actorIdentityId:ownerId,reminderAt});
 const handlers=worker.createProductionJobHandlers({crmRepository:{async processTaskReminder(input){processed.push(input);}}});
 assert.equal(produced.length,1);assert.equal(typeof handlers[produced[0].kind],'function');assert.notEqual(handlers[produced[0].kind],handlers['platform.noop']);
 await handlers[produced[0].kind]({tenantId,jobId,payload:produced[0].payload});
 assert.deepEqual(processed,[{tenantId,taskId,expectedTaskVersion:1,jobId}]);
});
