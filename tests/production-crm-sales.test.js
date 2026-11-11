import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  planMigrations,
  applicationRoleGrants,
  controlPlaneRoleGrants,
  TENANT_TABLES
} from '../server/persistence/index.js';
import {createCrmRepository,createCrmService} from '../server/production/crmService.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const now='2026-11-11T23:00:00.000Z';
const clock=()=>new Date(now);
const tenantId=randomUUID();
const partyId=randomUUID();
const pipelineId=randomUUID();
const openStageId=randomUUID();
const wonStageId=randomUUID();
const lostStageId=randomUUID();
const leadId=randomUUID();
const opportunityId=randomUUID();

function scriptedPool(responder){
  const calls=[];
  const session={async query(sql,values=[]){
    const text=String(sql).trim();
    calls.push({sql:text,values});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return {rows:[],rowCount:0};
    const response=responder(text,values,calls);
    if(!response)throw new Error(`Unexpected sales query: ${text}`);
    return response;
  }};
  return {calls,pool:{
    async withTenantSession(tenant,fn){assert.equal(tenant,tenantId);return fn(session);},
    async withTransaction(tenant,fn){
      assert.equal(tenant,tenantId);
      await session.query('BEGIN');
      try{const result=await fn(session);await session.query('COMMIT');return result;}
      catch(error){await session.query('ROLLBACK');throw error;}
    }
  }};
}

const stageRows=[
  {tenant_id:tenantId,stage_id:openStageId,pipeline_id:pipelineId,name:'Discovery',kind:'open',position:1,probability:10,version:1,created_at:now,updated_at:now},
  {tenant_id:tenantId,stage_id:wonStageId,pipeline_id:pipelineId,name:'Won',kind:'won',position:2,probability:100,version:1,created_at:now,updated_at:now},
  {tenant_id:tenantId,stage_id:lostStageId,pipeline_id:pipelineId,name:'Lost',kind:'lost',position:3,probability:0,version:1,created_at:now,updated_at:now}
];

const pipelineRow={tenant_id:tenantId,pipeline_id:pipelineId,name:'Default Sales Pipeline',is_default:true,status:'active',version:1,created_at:now,updated_at:now};

test('sales migration 14 appends after the canonical party migration',()=>{
  assert.equal(SCHEMA_VERSION,14);
  assert.deepEqual(MIGRATIONS.map(entry=>entry.version),[
    1,2,3,4,5,6,7,8,9,10,11,12,13,14
  ]);
  const certified=MIGRATIONS.slice(0,13);
  const plan=planMigrations(certified.map(({version,name,checksum})=>({version,name,checksum})));
  assert.equal(plan.currentVersion,13);
  assert.equal(plan.targetVersion,14);
  assert.deepEqual(plan.pending.map(entry=>entry.version),[14]);
});

test('migration 14 defines pipelines, stages, leads, opportunities and append-only stage history',()=>{
  const sql=MIGRATIONS.find(entry=>entry.version===14)?.statements.join('\n')??'';
  for(const table of ['pipelines','pipeline_stages','leads','opportunities','opportunity_stage_events']){
    assert.match(sql,new RegExp(`CREATE TABLE ${table}\\(`));
    assert.ok(TENANT_TABLES.includes(table),`${table} must be a tenant business table`);
    assert.match(sql,new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql,new RegExp(`CREATE POLICY ${table}_tenant_isolation`));
  }
  assert.match(sql,/CREATE UNIQUE INDEX pipelines_one_default ON pipelines\(tenant_id\) WHERE is_default/);
  assert.match(sql,/CHECK \(kind IN \('open','won','lost'\)\)/);
  assert.match(sql,/CHECK \(position BETWEEN 1 AND 100\)/);
  assert.match(sql,/CHECK \(probability BETWEEN 0 AND 100\)/);
  assert.match(sql,/amount_cents bigint NOT NULL CHECK \(amount_cents >= 0 AND amount_cents <= 9007199254740991\)/);
  assert.match(sql,/amount_cents <= 9007199254740991/);
  assert.match(sql,/expected_value_cents <= 9007199254740991/);
  assert.match(sql,/CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  assert.match(sql,/UNIQUE \(tenant_id, pipeline_id, position\)/);
  assert.match(sql,/UNIQUE \(tenant_id, pipeline_id, stage_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, pipeline_id\) REFERENCES pipelines\(tenant_id, pipeline_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, pipeline_id, stage_id\) REFERENCES pipeline_stages\(tenant_id, pipeline_id, stage_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, owner_identity_id\) REFERENCES wimblo_platform\.memberships\(tenant_id, identity_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, lead_id\) REFERENCES leads\(tenant_id, lead_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, converted_opportunity_id\) REFERENCES opportunities\(tenant_id, opportunity_id\)/);
  assert.match(sql,/CHECK \(\(status = 'converted'\) = \(converted_opportunity_id IS NOT NULL\)\)/);
  assert.match(sql,/UNIQUE \(tenant_id, pipeline_id, opportunity_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, pipeline_id, opportunity_id\) REFERENCES opportunities\(tenant_id, pipeline_id, opportunity_id\)/);
  assert.match(sql,/pipeline_id uuid NOT NULL,[\s\S]*FOREIGN KEY \(tenant_id, pipeline_id, from_stage_id\) REFERENCES pipeline_stages/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, pipeline_id, to_stage_id\) REFERENCES pipeline_stages/);
  assert.match(sql,/opportunity_stage_event_no_update/);
  assert.match(sql,/opportunity_stage_event_no_delete/);
});

test('sales indexes cover stage views, owner worklists, forecasts and lead qualification',()=>{
  const sql=MIGRATIONS.find(entry=>entry.version===14)?.statements.join('\n')??'';
  assert.match(sql,/CREATE INDEX pipeline_stages_view ON pipeline_stages\(tenant_id, pipeline_id, position\)/);
  assert.match(sql,/CREATE INDEX opportunities_owner_status ON opportunities\(tenant_id, owner_identity_id, status, expected_close_date\)/);
  assert.match(sql,/CREATE INDEX opportunities_forecast ON opportunities\(tenant_id, expected_close_date\) INCLUDE \(amount_cents, probability, currency\)/);
  assert.match(sql,/CREATE INDEX leads_qualification ON leads\(tenant_id, status, probability, expected_value_cents\)/);
});

test('application and control roles receive distinct least-privilege sales access',()=>{
  const tenant=applicationRoleGrants('wimblo_app');
  const control=controlPlaneRoleGrants('wimblo_control');
  for(const table of ['pipelines','pipeline_stages','leads','opportunities']){
    assert.ok(tenant.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO wimblo_app`),table);
    assert.ok(control.includes(`REVOKE ALL PRIVILEGES ON ${table} FROM wimblo_control`),table);
    assert.equal(control.some(sql=>sql.startsWith('GRANT SELECT, INSERT, UPDATE, DELETE')&&sql.includes(table)),false,table);
  }
  assert.ok(tenant.includes('GRANT SELECT, INSERT ON opportunity_stage_events TO wimblo_app'));
  assert.equal(tenant.some(sql=>/GRANT .*UPDATE|DELETE/.test(sql)&&sql.includes('opportunity_stage_events')),false);
  assert.ok(tenant.includes('GRANT SELECT, INSERT ON party_events TO wimblo_app'));
  assert.equal([...tenant,...control].some(sql=>/GRANT ALL|SUPERUSER|BYPASSRLS/.test(sql)),false);
});

test('pipeline setup rejects contradictory terminal ordering and probabilities before SQL',async()=>{
  const f=scriptedPool(()=>({rows:[],rowCount:0}));
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  for(const stages of [
    [
      {stageId:wonStageId,name:'Won',kind:'won',position:1,probability:100},
      {stageId:openStageId,name:'Discovery',kind:'open',position:2,probability:10},
      {stageId:lostStageId,name:'Lost',kind:'lost',position:3,probability:0}
    ],
    [
      {stageId:openStageId,name:'Discovery',kind:'open',position:1,probability:10},
      {stageId:wonStageId,name:'Won',kind:'won',position:2,probability:80},
      {stageId:lostStageId,name:'Lost',kind:'lost',position:3,probability:20}
    ]
  ])await assert.rejects(()=>repository.ensureDefaultPipeline({tenantId,pipelineId,name:'Invalid',stages}),/terminal|won|lost|order/i);
  assert.equal(f.calls.length,0);
});

test('repository creates one default pipeline with ordered open, won and lost stages',async()=>{
  const f=scriptedPool((sql,values)=>{
    if(sql.includes('/*pipeline:lock*/'))return {rows:[{}],rowCount:1};
    if(sql.includes('/*pipeline:default*/'))return {rows:[],rowCount:0};
    if(sql.includes('/*pipeline:insert*/'))return {rows:[pipelineRow],rowCount:1};
    if(sql.includes('/*pipeline-stage:insert*/'))return {rows:[stageRows[values[5]-1]],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const pipeline=await repository.ensureDefaultPipeline({tenantId,pipelineId,name:'Default Sales Pipeline',stages:[
    {stageId:lostStageId,name:'Lost',kind:'lost',position:3,probability:0},
    {stageId:openStageId,name:'Discovery',kind:'open',position:1,probability:10},
    {stageId:wonStageId,name:'Won',kind:'won',position:2,probability:100}
  ]});
  assert.equal(pipeline.pipelineId,pipelineId);
  assert.equal(pipeline.isDefault,true);
  assert.deepEqual(pipeline.stages.map(stage=>[stage.kind,stage.position]),[['open',1],['won',2],['lost',3]]);
  assert.ok(f.calls.some(call=>call.sql.includes('/*pipeline:insert*/ INSERT INTO pipelines')));
  assert.equal(f.calls.at(-1).sql,'COMMIT');
});

test('concurrent default setup serializes and returns the one existing pipeline',async()=>{
  const calls=[];
  let lockTail=Promise.resolve(),created=false;
  const makeSession=()=>{
    let releaseLock=()=>{};
    return {async query(sql,values=[]){
      const text=String(sql).trim();calls.push({sql:text,values});
      if(text==='BEGIN')return {rows:[],rowCount:0};
      if(['COMMIT','ROLLBACK'].includes(text)){releaseLock();return {rows:[],rowCount:0};}
      if(text.includes('/*pipeline:lock*/')){
        const prior=lockTail;
        lockTail=new Promise(resolve=>{releaseLock=resolve;});
        await prior;
        return {rows:[],rowCount:0};
      }
      if(text.includes('/*pipeline:default*/'))return created?{rows:[pipelineRow],rowCount:1}:{rows:[],rowCount:0};
      if(text.includes('/*pipeline:insert*/')){created=true;return {rows:[pipelineRow],rowCount:1};}
      if(text.includes('/*pipeline-stage:insert*/'))return {rows:[stageRows[values[5]-1]],rowCount:1};
      if(text.includes('/*pipeline-stage:list*/'))return {rows:stageRows,rowCount:stageRows.length};
      throw new Error(`Unexpected concurrent query: ${text}`);
    }};
  };
  const pool={
    async withTenantSession(){throw new Error('not used');},
    async withTransaction(tenant,fn){
      assert.equal(tenant,tenantId);
      const session=makeSession();
      await session.query('BEGIN');
      try{const result=await fn(session);await session.query('COMMIT');return result;}
      catch(error){await session.query('ROLLBACK');throw error;}
    }
  };
  const repository=createCrmRepository({tenantPool:pool,clock});
  const input={tenantId,pipelineId,name:'Default Sales Pipeline',stages:stageRows.map(stage=>({stageId:stage.stage_id,name:stage.name,kind:stage.kind,position:stage.position,probability:stage.probability}))};
  const [first,second]=await Promise.all([repository.ensureDefaultPipeline(input),repository.ensureDefaultPipeline(input)]);
  assert.equal(first.pipelineId,second.pipelineId);
  assert.equal(calls.filter(call=>call.sql.includes('/*pipeline:insert*/')).length,1);
});

test('repository creates leads with exact cents, currency and tenant-safe stage references',async()=>{
  const f=scriptedPool((sql,values)=>{
    if(sql.includes('/*pipeline-stage:get*/'))return {rows:[stageRows[0]],rowCount:1};
    if(sql.includes('/*lead:insert*/'))return {rows:[{
      tenant_id:tenantId,lead_id:leadId,party_id:partyId,pipeline_id:pipelineId,stage_id:openStageId,source:'web',status:'new',owner_identity_id:null,expected_value_cents:12500,currency:'USD',probability:10,expected_close_date:'2026-12-31',converted_opportunity_id:null,version:1,created_at:now,updated_at:now
    }],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const lead=await repository.createLead({tenantId,leadId,partyId,pipelineId,stageId:openStageId,source:'web',expectedValueCents:12500,currency:'usd',probability:10,expectedCloseDate:'2026-12-31'});
  assert.equal(lead.expectedValueCents,12500);
  assert.equal(lead.currency,'USD');
  const call=f.calls.find(item=>item.sql.includes('/*lead:insert*/ INSERT INTO leads'));
  assert.equal(call.values.includes('USD'),true);
});

test('repository rejects terminal lead stages and unsafe cent amounts',async()=>{
  const terminal=scriptedPool(sql=>sql.includes('/*pipeline-stage:get*/')?{rows:[stageRows[1]],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:terminal.pool,clock});
  await assert.rejects(()=>repository.createLead({tenantId,partyId,pipelineId,stageId:wonStageId,source:'web',expectedValueCents:1,currency:'USD',probability:1,expectedCloseDate:'2026-12-31'}),/open stage/i);
  await assert.rejects(()=>repository.createLead({tenantId,partyId,pipelineId,stageId:openStageId,source:'web',expectedValueCents:Number.MAX_SAFE_INTEGER+1,currency:'USD',probability:1,expectedCloseDate:'2026-12-31'}),/safe|cents/i);
});

test('repository converts a lead and creates its opportunity in one atomic transaction',async()=>{
  const f=scriptedPool((sql,values)=>{
    if(sql.includes('/*pipeline-stage:get*/'))return {rows:[stageRows[0]],rowCount:1};
    if(sql.includes('/*lead:lock*/'))return {rows:[{tenant_id:tenantId,lead_id:leadId,party_id:partyId,pipeline_id:pipelineId,stage_id:openStageId,status:'new',version:1}],rowCount:1};
    if(sql.includes('/*opportunity:insert*/'))return {rows:[{
      tenant_id:tenantId,opportunity_id:opportunityId,party_id:partyId,pipeline_id:pipelineId,stage_id:openStageId,lead_id:leadId,name:'Ada expansion',amount_cents:12500,currency:'USD',probability:10,expected_close_date:'2026-12-31',status:'open',owner_identity_id:null,version:1,created_at:now,updated_at:now
    }],rowCount:1};
    if(sql.includes('/*lead:convert*/'))return {rows:[{tenant_id:tenantId,lead_id:leadId,party_id:partyId,pipeline_id:pipelineId,stage_id:openStageId,source:'web',status:'converted',owner_identity_id:null,expected_value_cents:12500,currency:'USD',probability:10,expected_close_date:'2026-12-31',converted_opportunity_id:opportunityId,version:2,created_at:now,updated_at:now}],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const result=await repository.convertLead({tenantId,leadId,opportunityId,expectedVersion:1,name:'Ada expansion',amountCents:12500,currency:'USD',probability:10,expectedCloseDate:'2026-12-31'});
  assert.equal(result.lead.status,'converted');
  assert.equal(result.opportunity.leadId,leadId);
  assert.ok(f.calls.some(call=>call.sql.includes('/*opportunity:insert*/ INSERT INTO opportunities')));
  assert.ok(f.calls.some(call=>call.sql.includes('/*lead:convert*/ UPDATE leads')));
  assert.ok(f.calls.some(call=>call.sql.includes('/*stage-event:insert*/ INSERT INTO opportunity_stage_events')));
  assert.equal(f.calls.at(-1).sql,'COMMIT');
});

test('repository stage changes require the current version and append history atomically',async()=>{
  const f=scriptedPool(sql=>{
    if(sql.includes('/*pipeline-stage:get*/'))return {rows:[stageRows[1]],rowCount:1};
    if(sql.includes('/*opportunity:lock*/'))return {rows:[{tenant_id:tenantId,opportunity_id:opportunityId,pipeline_id:pipelineId,stage_id:openStageId,status:'open',version:1}],rowCount:1};
    if(sql.includes('/*opportunity:stage*/'))return {rows:[{
      tenant_id:tenantId,opportunity_id:opportunityId,party_id:partyId,pipeline_id:pipelineId,stage_id:wonStageId,lead_id:null,name:'Ada expansion',amount_cents:12500,currency:'USD',probability:100,expected_close_date:'2026-12-31',status:'won',owner_identity_id:null,version:2,created_at:now,updated_at:now
    }],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const changed=await repository.changeOpportunityStage({tenantId,opportunityId,stageId:wonStageId,expectedVersion:1});
  assert.equal(changed.status,'won');
  assert.equal(changed.version,2);
  assert.ok(f.calls.some(call=>call.sql.includes('/*stage-event:insert*/ INSERT INTO opportunity_stage_events')));
  const event=f.calls.find(call=>call.sql.includes('/*stage-event:insert*/'));
  assert.match(event.sql,/pipeline_id/);
  assert.equal(event.values.includes(pipelineId),true);
});

test('repository pipeline reads include ordered stages for board reconstruction',async()=>{
  const f=scriptedPool(sql=>{
    if(sql.includes('/*pipeline:list*/'))return {rows:[pipelineRow],rowCount:1};
    if(sql.includes('/*pipeline-stage:list-many*/'))return {rows:[stageRows[0],stageRows[1],stageRows[2]],rowCount:3};
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const [pipeline]=await repository.listPipelines(tenantId);
  assert.deepEqual(pipeline.stages.map(stage=>stage.kind),['open','won','lost']);
});

test('repository refuses a stale stage version without history or partial update',async()=>{
  const f=scriptedPool(sql=>sql.includes('/*opportunity:lock*/')?{rows:[{tenant_id:tenantId,opportunity_id:opportunityId,pipeline_id:pipelineId,stage_id:openStageId,status:'open',version:2}],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  await assert.rejects(()=>repository.changeOpportunityStage({tenantId,opportunityId,stageId:wonStageId,expectedVersion:1}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
    assert.match(error.message,/version conflict/i);
    return true;
  });
  assert.equal(f.calls.some(call=>call.sql.includes('/*stage-event:insert*/ INSERT INTO opportunity_stage_events')),false);
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});

test('service gates sales writes by module and role',async()=>{
  const repository=createCrmRepository({tenantPool:scriptedPool(()=>({rows:[],rowCount:0})).pool,clock});
  const moduleService={authorize:async({action})=>({allowed:action==='read'})};
  const service=createCrmService({repository,moduleService});
  await assert.rejects(()=>service.ensureDefaultPipeline({tenantId,pipelineId,name:'Default',stages:[],actorRole:'staff'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
    assert.match(error.message,/capability/i);
    return true;
  });
  const enabled={authorize:async()=>({allowed:true,state:'enabled'})};
  const allowedService=createCrmService({repository,moduleService:enabled});
  await assert.rejects(()=>allowedService.ensureDefaultPipeline({tenantId,pipelineId,name:'Default',stages:[],actorRole:'viewer'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
    assert.match(error.message,/role/i);
    return true;
  });
});
