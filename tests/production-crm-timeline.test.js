import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {PERSISTENCE_CODES} from '../server/persistence/index.js';

const tenantId=randomUUID(),subjectId=randomUUID(),otherSubjectId=randomUUID();
const now='2026-11-12T03:00:00.000Z';
const clock=()=>new Date(now);

function poolWithRows(rows){const calls=[];const session={async query(sql,values=[]){calls.push({sql:String(sql),values});if(String(sql).includes('/*timeline:list*/'))return {rows,rowCount:rows.length};if(String(sql).includes('/*subject:get*/'))return {rows:[{tenant_id:tenantId,subject_id:subjectId,subject_type:'party',version:1}],rowCount:1};return {rows:[],rowCount:0};}};return {calls,pool:{withTenantSession:async(id,fn)=>fn(session),withTransaction:async(id,fn)=>fn(session)}};}

test('timeline merges safe canonical facts in stable keyset order',async()=>{
 const rows=[
  {source_kind:'activity',source_rank:5,source_key:randomUUID(),source_version:1,occurred_at:'2026-11-12T02:00:00.000Z',summary:'Called client'},
  {source_kind:'task',source_rank:4,source_key:randomUUID(),source_version:2,occurred_at:'2026-11-12T01:00:00.000Z',summary:'Task completed'},
  {source_kind:'note',source_rank:3,source_key:randomUUID(),source_version:2,occurred_at:'2026-11-12T00:00:00.000Z',summary:'Note revised'}
 ];
 const f=poolWithRows(rows),repository=createCrmRepository({tenantPool:f.pool,clock});
 const page=await repository.listTimeline({tenantId,subjectId,limit:2});
 assert.equal(page.items.length,2);
 assert.ok(page.nextCursor);
 assert.doesNotMatch(JSON.stringify(page),/body|object_key|bucket|encryption/i);
 const call=f.calls.find(entry=>entry.sql.includes('/*timeline:list*/'));
 assert.match(call.sql,/UNION ALL/);
 assert.match(call.sql,/occurred_at DESC,source_rank DESC,source_key DESC,source_version DESC/);
 assert.match(call.sql,/recorded_at <= \$3::timestamptz/);
 assert.match(call.sql,/created_at AS recorded_at,summary FROM crm_activities/);
 assert.match(call.sql,/CASE WHEN action='reminder_due' THEN 'Task reminder due' ELSE 'Task ' \|\| action END FROM crm_task_events/);
 assert.equal(call.values[0],tenantId);
 assert.equal(call.values[1],subjectId);
});

test('timeline continuation keeps the first page asOf so later backdated inserts cannot enter',async()=>{
 const rows=[
  {source_kind:'activity',source_rank:5,source_key:randomUUID(),source_version:1,occurred_at:'2026-11-12T02:00:00.000Z',summary:'One'},
  {source_kind:'activity',source_rank:5,source_key:randomUUID(),source_version:1,occurred_at:'2026-11-12T01:00:00.000Z',summary:'Two'}
 ];
 const f=poolWithRows(rows),repository=createCrmRepository({tenantPool:f.pool,clock});
 const first=await repository.listTimeline({tenantId,subjectId,limit:1});
 await repository.listTimeline({tenantId,subjectId,limit:1,cursor:first.nextCursor});
 const timelineCalls=f.calls.filter(entry=>entry.sql.includes('/*timeline:list*/'));
 assert.equal(timelineCalls.length,2);
 assert.equal(timelineCalls[0].values[2],timelineCalls[1].values[2]);
 assert.match(timelineCalls[1].sql,/recorded_at <= \$3::timestamptz/);
});

test('timeline cursor is bound to tenant and subject and malformed cursors fail generically',async()=>{
 const f=poolWithRows([]),repository=createCrmRepository({tenantPool:f.pool,clock});
 const first=await repository.listTimeline({tenantId,subjectId,limit:1});
 for(const cursor of ['not-base64',Buffer.from(JSON.stringify({tenantId,subjectId:otherSubjectId})).toString('base64url')]){
  await assert.rejects(()=>repository.listTimeline({tenantId,subjectId,limit:1,cursor}),error=>error.code===PERSISTENCE_CODES.INVALID&&/cursor/i.test(error.message));
 }
 assert.equal(first.items.length,0);
});

test('timeline cursor strictly rejects invalid timestamps, ranks, keys and versions before SQL',async()=>{
 const f=poolWithRows([]),repository=createCrmRepository({tenantPool:f.pool,clock});
 const valid={tenantId,subjectId,asOf:now,lastAt:'2026-11-12T02:00:00.000Z',lastRank:5,lastKey:randomUUID(),lastVersion:1};
 const invalid=[
  {...valid,asOf:'not-a-date'},
  {...valid,lastAt:'2026-99-99T00:00:00.000Z'},
  {...valid,lastRank:0},
  {...valid,lastRank:6},
  {...valid,lastKey:'not-a-uuid'},
  {...valid,lastVersion:0},
  {...valid,lastAt:'2026-11-13T00:00:00.000Z'}
 ];
 for(const value of invalid){const cursor=Buffer.from(JSON.stringify(value)).toString('base64url');await assert.rejects(()=>repository.listTimeline({tenantId,subjectId,limit:1,cursor}),error=>error.code===PERSISTENCE_CODES.INVALID&&/cursor/i.test(error.message));}
 assert.equal(f.calls.length,0);
});
