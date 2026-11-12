import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installCrmRoutes} from '../server/production/crmRoutes.js';
import {PERSISTENCE_CODES,persistenceFail} from '../server/persistence/contract.js';

const tenantId=randomUUID(),identityId=randomUUID(),batchId=randomUUID();
const pass=(req,res,next)=>next(),refuse=(req,res)=>res.status(403).json({error:'refused'});
const session=role=>(req,res,next)=>{req.productionSession={tenantId,identityId,membership:{role}};next();};
const core={listParties:async()=>[],getParty:async()=>({}),createPerson:async()=>({}),createOrganization:async()=>({}),updateParty:async()=>({}),listContacts:async()=>[],createContact:async()=>({}),listRelationships:async()=>[],createRelationship:async()=>({}),listPipelines:async()=>[],ensureDefaultPipeline:async()=>({}),listLeads:async()=>[],createLead:async()=>({}),convertLead:async()=>({}),listOpportunities:async()=>[],changeOpportunityStage:async()=>({}),createActivity:async()=>({}),createTask:async()=>({}),updateTask:async()=>({}),createNote:async()=>({}),reviseNote:async()=>({}),linkAttachment:async()=>({}),changeSubjectOwner:async()=>({}),listTimeline:async()=>({items:[],nextCursor:null})};

function appFor({role='staff',csrf=pass,recent=pass,calls=[],reportingOverride={},importsOverride={}}={}){
 const app=express();app.use('/api/crm/imports',express.text({type:'text/csv',limit:'1mb'}));app.use(express.json());
 const reporting={dashboard:async input=>(calls.push(['dashboard',input]),{total:1}),executeReport:async input=>(calls.push(['executeReport',input]),{rows:[]}),saveReport:async input=>(calls.push(['saveReport',input]),{}),updateReport:async input=>(calls.push(['updateReport',input]),{}),exportReport:async input=>(calls.push(['exportReport',input]),{csv:'name\r\nAda\r\n',filename:'wimblo-parties.csv',rowCount:1}),...reportingOverride};
 const imports={previewPeople:async input=>(calls.push(['previewPeople',input]),{batchId}),commitPeople:async input=>(calls.push(['commitPeople',input]),{batchId,status:'committed'}),...importsOverride};
 installCrmRoutes(app,{crmService:core,crmReportingService:reporting,crmImportService:imports,requireTenantSession:session(role),requireCsrf:csrf,requireRecentAuthentication:recent});
 app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||500).json({error:'refused'});});return app;
}
async function request(app,path,{method='GET',body,type='application/json',headers={}}={}){const server=app.listen(0,'127.0.0.1');await once(server,'listening');try{return await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':type,...headers},body:body===undefined?undefined:type==='application/json'?JSON.stringify(body):body});}finally{await new Promise(resolve=>server.close(resolve));}}

test('reporting and import routes propagate tenant actor and bounded acquisition',async()=>{
 const calls=[],app=appFor({calls});
 assert.equal((await request(app,'/api/crm/dashboard?dataset=opportunities&from=2026-01-01&to=2026-12-31')).status,200);
 assert.equal((await request(app,'/api/crm/reports/execute',{method:'POST',body:{definition:{dataset:'parties',columns:['displayName']}}})).status,200);
 const reportId=randomUUID();
 assert.equal((await request(app,`/api/crm/reports/${reportId}`,{method:'PATCH',body:{name:'Updated',expectedVersion:1,definition:{dataset:'parties',columns:['displayName']}}})).status,200);
 const exported=await request(app,'/api/crm/exports',{method:'POST',body:{definition:{dataset:'parties',columns:['displayName']}}});assert.equal(exported.status,200);assert.match(exported.headers.get('content-type'),/text\/csv/);assert.equal(exported.headers.get('x-content-type-options'),'nosniff');
 const csv='external_key,display_name,first_name,last_name\r\n1,Ada,Ada,Lovelace\r\n';
 assert.equal((await request(app,'/api/crm/imports/preview',{method:'POST',body:csv,type:'text/csv',headers:{'Idempotency-Key':'i-1','X-Source-System':'legacy'}})).status,201);
 assert.equal((await request(app,`/api/crm/imports/${batchId}/commit`,{method:'POST',body:csv,type:'text/csv',headers:{'Idempotency-Key':'i-1','X-Source-System':'legacy','If-Match':'1','X-Source-SHA256':'a'.repeat(64)}})).status,200);
 for(const [,input] of calls){assert.equal(input.tenantId,tenantId);assert.equal(input.actorIdentityId,identityId);}
 assert.equal(calls.find(([name])=>name==='previewPeople')[1].csv,csv);
 assert.equal(calls.find(([name])=>name==='updateReport')[1].reportId,reportId);
 assert.equal(calls.find(([name])=>name==='commitPeople')[1].batchId,batchId);
});

test('viewer can read dashboards but cannot save, export or import and middleware blocks writes',async()=>{
 assert.equal((await request(appFor({role:'viewer'}),'/api/crm/dashboard?dataset=parties&from=2026-01-01&to=2026-01-02')).status,200);
 const body={definition:{dataset:'parties',columns:['displayName']}};
 const csv='external_key,display_name,first_name,last_name\n1,A,A,A\n',importHeaders={'Idempotency-Key':'x','X-Source-System':'legacy'};
 for(const [path,method,payload,type,headers] of [
  ['/api/crm/reports','POST',{...body,name:'My report'},'application/json',{}],
  [`/api/crm/reports/${randomUUID()}`,'PATCH',{...body,name:'My report',expectedVersion:1},'application/json',{}],
  ['/api/crm/exports','POST',body,'application/json',{}],
  ['/api/crm/imports/preview','POST',csv,'text/csv',importHeaders],
  [`/api/crm/imports/${batchId}/commit`,'POST',csv,'text/csv',{...importHeaders,'If-Match':'1','X-Source-SHA256':'a'.repeat(64)}]
 ]){
  assert.equal((await request(appFor({role:'viewer'}),path,{method,body:payload,type,headers})).status,403);
  assert.equal((await request(appFor({csrf:refuse}),path,{method,body:payload,type,headers})).status,403);
  assert.equal((await request(appFor({recent:refuse}),path,{method,body:payload,type,headers})).status,403);
 }
});

test('stale sources and unknown or cross-tenant artifact IDs return safe refusals',async()=>{
 const csv='external_key,display_name,first_name,last_name\n1,A,A,A\n',headers={'Idempotency-Key':'x','X-Source-System':'legacy','If-Match':'1','X-Source-SHA256':'a'.repeat(64)};
 const stale=appFor({importsOverride:{commitPeople:async()=>persistenceFail(PERSISTENCE_CODES.CONFLICT,'sensitive stale source detail')}});
 const staleResponse=await request(stale,`/api/crm/imports/${batchId}/commit`,{method:'POST',body:csv,type:'text/csv',headers});
 assert.equal(staleResponse.status,409);assert.deepEqual(await staleResponse.json(),{error:'refused'});
 for(const artifactId of [randomUUID(),randomUUID()]){
  const app=appFor({
   reportingOverride:{updateReport:async()=>persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'cross-tenant report detail')},
   importsOverride:{commitPeople:async()=>persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'cross-tenant batch detail')}
  });
  const reportResponse=await request(app,`/api/crm/reports/${artifactId}`,{method:'PATCH',body:{name:'Updated',expectedVersion:1,definition:{dataset:'parties',columns:['displayName']}}});
  const batchResponse=await request(app,`/api/crm/imports/${artifactId}/commit`,{method:'POST',body:csv,type:'text/csv',headers});
  assert.equal(reportResponse.status,404);assert.deepEqual(await reportResponse.json(),{error:'refused'});
  assert.equal(batchResponse.status,404);assert.deepEqual(await batchResponse.json(),{error:'refused'});
 }
});
