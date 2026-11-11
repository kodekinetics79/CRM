import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installCrmRoutes} from '../server/production/crmRoutes.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const tenantId=randomUUID();
const pass=(req,res,next)=>next();
const refuse=(req,res)=>res.status(403).json({error:'refused',code:'MIDDLEWARE_REFUSED'});
const session=(role='staff',identityId=randomUUID())=>(req,res,next)=>{req.productionSession={tenantId,identityId,membership:{role}};next();};

function buildApp(service,{csrf=pass,recent=pass,actor='staff',identityId=randomUUID()}={}){
  const app=express();
  app.use(express.json({limit:'32kb',strict:true,type:'application/json'}));
  installCrmRoutes(app,{crmService:service,requireTenantSession:session(actor,identityId),requireCsrf:csrf,requireRecentAuthentication:recent});
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error.status||500;
    const safe=status>=500?{error:'Internal service error.',code:'INTERNAL_ERROR'}:{error:'Request was refused.',code:'REQUEST_REFUSED'};
    res.status(status).json(safe);
  });
  return app;
}

async function request(app,path,{method='GET',body,headers={}}={}){
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    return await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
}

test('staff can set up the default pipeline, create a lead, convert it and change stage',async()=>{
  const calls=[];
  const actorIdentityId=randomUUID();
  const service={
    ensureDefaultPipeline:async input=>{calls.push(['ensureDefaultPipeline',input]);return {pipelineId:randomUUID(),isDefault:true,stages:[]};},
    createLead:async input=>{calls.push(['createLead',input]);return {leadId:randomUUID(),status:'new'};},
    convertLead:async input=>{calls.push(['convertLead',input]);return {lead:{status:'converted'},opportunity:{opportunityId:randomUUID(),status:'open'}};},
    changeOpportunityStage:async input=>{calls.push(['changeOpportunityStage',input]);return {opportunityId:randomUUID(),status:'won'};},
    listPipelines:async()=>[],
    listLeads:async()=>[],
    listOpportunities:async()=>[]
  };
  const app=buildApp(service,{identityId:actorIdentityId});
  const stages=[
    {stageId:randomUUID(),name:'Discovery',kind:'open',position:1,probability:10},
    {stageId:randomUUID(),name:'Won',kind:'won',position:2,probability:100},
    {stageId:randomUUID(),name:'Lost',kind:'lost',position:3,probability:0}
  ];
  const pipeline=await request(app,'/api/crm/pipelines/default',{method:'POST',body:{name:'Default Sales Pipeline',stages}});
  const lead=await request(app,'/api/crm/leads',{method:'POST',body:{partyId:randomUUID(),pipelineId:randomUUID(),stageId:randomUUID(),source:'web',expectedValueCents:12500,currency:'USD',probability:10,expectedCloseDate:'2026-12-31'}});
  const convert=await request(app,`/api/crm/leads/${randomUUID()}/convert`,{method:'POST',body:{expectedVersion:1,name:'Expansion',amountCents:12500,currency:'USD',probability:10,expectedCloseDate:'2026-12-31'}});
  const stage=await request(app,`/api/crm/opportunities/${randomUUID()}/stage`,{method:'POST',body:{stageId:randomUUID(),expectedVersion:1}});
  assert.equal(pipeline.status,201);
  assert.equal(lead.status,201);
  assert.equal(convert.status,201);
  assert.equal(stage.status,200);
  for(const [,input] of calls){
    assert.equal(input.tenantId,tenantId);
    assert.equal(input.actorRole,'staff');
    assert.equal(input.actorIdentityId,actorIdentityId);
  }
});

test('all sales reads carry tenant and viewer context and return board facts',async()=>{
  const calls=[];
  const actorIdentityId=randomUUID();
  const service={
    listPipelines:async input=>{calls.push(['pipelines',input]);return [{pipelineId:randomUUID(),stages:[{kind:'open'}]}];},
    listLeads:async input=>{calls.push(['leads',input]);return [];},
    listOpportunities:async input=>{calls.push(['opportunities',input]);return [];}
  };
  const app=buildApp(service,{actor:'viewer',identityId:actorIdentityId});
  for(const path of ['/api/crm/pipelines','/api/crm/leads?status=new','/api/crm/opportunities?status=open'])assert.equal((await request(app,path)).status,200);
  assert.deepEqual(calls.map(([name])=>name),['pipelines','leads','opportunities']);
  for(const [,input] of calls){assert.equal(input.tenantId,tenantId);assert.equal(input.actorRole,'viewer');assert.equal(input.actorIdentityId,actorIdentityId);}
});

test('viewer cannot write sales records and missing CSRF or recent authentication is refused',async()=>{
  let writes=0;
  const service={listPipelines:async()=>[],listLeads:async()=>[],listOpportunities:async()=>[],ensureDefaultPipeline:async()=>{writes++;return {};},createLead:async()=>{writes++;return {};},convertLead:async()=>{writes++;return {};},changeOpportunityStage:async()=>{writes++;return {}}};
  const stages=[
    {stageId:randomUUID(),name:'Discovery',kind:'open',position:1,probability:10},
    {stageId:randomUUID(),name:'Won',kind:'won',position:2,probability:100},
    {stageId:randomUUID(),name:'Lost',kind:'lost',position:3,probability:0}
  ];
  const writesToTry=[
    ['/api/crm/pipelines/default',{name:'Default',stages}],
    ['/api/crm/leads',{partyId:randomUUID(),pipelineId:randomUUID(),stageId:randomUUID(),source:'web',expectedValueCents:1,currency:'USD',probability:1,expectedCloseDate:'2026-12-31'}],
    [`/api/crm/leads/${randomUUID()}/convert`,{expectedVersion:1,name:'Expansion',amountCents:1,currency:'USD',probability:1,expectedCloseDate:'2026-12-31'}],
    [`/api/crm/opportunities/${randomUUID()}/stage`,{stageId:randomUUID(),expectedVersion:1}]
  ];
  for(const options of [{actor:'viewer'},{csrf:refuse},{recent:refuse}]){
    const app=buildApp(service,options);
    for(const [path,body] of writesToTry)assert.equal((await request(app,path,{method:'POST',body})).status,403,path);
  }
  assert.equal(writes,0);
});

test('disabled module and stale version return safe errors without leaking internals',async()=>{
  const disabled={ensureDefaultPipeline:async()=>{throw new PersistenceError(PERSISTENCE_CODES.ISOLATION,'Capability is unavailable for this action.');}};
  const stale={changeOpportunityStage:async()=>{throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'Opportunity version conflict. Reload before retrying.');}};
  const disabledResponse=await request(buildApp(disabled),'/api/crm/pipelines/default',{method:'POST',body:{name:'Default',stages:[
    {stageId:randomUUID(),name:'Discovery',kind:'open',position:1,probability:10},
    {stageId:randomUUID(),name:'Won',kind:'won',position:2,probability:100},
    {stageId:randomUUID(),name:'Lost',kind:'lost',position:3,probability:0}
  ]}});
  const staleResponse=await request(buildApp(stale),`/api/crm/opportunities/${randomUUID()}/stage`,{method:'POST',body:{stageId:randomUUID(),expectedVersion:1}});
  assert.equal(disabledResponse.status,403);
  assert.equal(staleResponse.status,409);
  assert.doesNotMatch(JSON.stringify(await staleResponse.json()),/SQL|SELECT|INSERT|internal/i);
});
