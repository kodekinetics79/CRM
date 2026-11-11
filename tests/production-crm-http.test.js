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
const session=(role='staff')=>(req,res,next)=>{req.productionSession={tenantId,identityId:randomUUID(),membership:{role}};next();};
const party={tenantId,partyId:randomUUID(),partyType:'person',displayName:'Ada Lovelace',status:'active',version:1,person:{firstName:'Ada',lastName:'Lovelace'}};

function buildApp(service,{csrf=pass,recent=pass,actor='staff'}={}){
  const app=express();
  app.use(express.json({limit:'16kb',strict:true,type:'application/json'}));
  installCrmRoutes(app,{crmService:service,requireTenantSession:session(actor),requireCsrf:csrf,requireRecentAuthentication:recent});
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

test('staff can create person and organization parties, then read their tenant-scoped records',async()=>{
  const calls=[];
  const service={
    createPerson:async input=>{calls.push(['createPerson',input]);return party;},
    createOrganization:async input=>{calls.push(['createOrganization',input]);return {...party,partyType:'organization'};},
    getParty:async input=>{calls.push(['getParty',input]);return party;},
    listParties:async input=>{calls.push(['listParties',input]);return [party];}
  };
  const app=buildApp(service);
  const person=await request(app,'/api/crm/people',{method:'POST',body:{partyId:party.partyId,displayName:'Ada Lovelace',firstName:'Ada',lastName:'Lovelace'}});
  const organization=await request(app,'/api/crm/organizations',{method:'POST',body:{displayName:'Wimblo Test Systems',legalName:'Wimblo Test Systems LLC'}});
  const list=await request(app,'/api/crm/parties?type=person');
  const detail=await request(app,`/api/crm/parties/${party.partyId}`);
  assert.equal(person.status,201);
  assert.equal(organization.status,201);
  assert.equal(list.status,200);
  assert.equal(detail.status,200);
  assert.equal(calls[0][1].tenantId,tenantId);
  assert.equal(calls[0][1].actorRole,'staff');
});

test('viewer reads work but viewer writes are refused before the service',async()=>{
  let writes=0;
  const service={listParties:async()=>[party],createPerson:async()=>{writes++;return party;}};
  const app=buildApp(service,{actor:'viewer'});
  const list=await request(app,'/api/crm/parties');
  const write=await request(app,'/api/crm/people',{method:'POST',body:{displayName:'No',firstName:'No',lastName:'Write'}});
  assert.equal(list.status,200);
  assert.equal(write.status,403);
  assert.equal(writes,0);
  assert.equal((await write.json()).code,'REQUEST_REFUSED');
});

test('writes require CSRF and recent authentication, and malformed payloads return safe 400 errors',async()=>{
  let writes=0;
  const service={createPerson:async()=>{writes++;return party;}};
  const noCsrf=buildApp(service,{csrf:refuse});
  assert.equal((await request(noCsrf,'/api/crm/people',{method:'POST',body:{displayName:'Ada',firstName:'Ada',lastName:'Lovelace'}})).status,403);
  const staleAuth=buildApp(service,{recent:refuse});
  assert.equal((await request(staleAuth,'/api/crm/people',{method:'POST',body:{displayName:'Ada',firstName:'Ada',lastName:'Lovelace'}})).status,403);
  const malformed=buildApp(service);
  const response=await request(malformed,'/api/crm/people',{method:'POST',body:{displayName:'A',firstName:'',lastName:'L'}});
  assert.equal(response.status,400);
  assert.equal((await response.json()).code,'REQUEST_REFUSED');
  assert.equal(writes,0);
});

test('disabled module and stale versions return safe errors without leaking SQL or internals',async()=>{
  const disabled={createPerson:async()=>{throw new PersistenceError(PERSISTENCE_CODES.ISOLATION,'Capability is unavailable for this action.');}};
  const stale={createPerson:async()=>{throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'Party version conflict. Reload before retrying.');}};
  const disabledResponse=await request(buildApp(disabled),'/api/crm/people',{method:'POST',body:{displayName:'Ada',firstName:'Ada',lastName:'Lovelace'}});
  const staleResponse=await request(buildApp(stale),'/api/crm/people',{method:'POST',body:{displayName:'Ada',firstName:'Ada',lastName:'Lovelace'}});
  assert.equal(disabledResponse.status,403);
  assert.equal(staleResponse.status,409);
  assert.doesNotMatch(JSON.stringify(await staleResponse.json()),/SQL|SELECT|INSERT|internal/i);
});
