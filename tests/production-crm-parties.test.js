import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCrmRepository,createCrmService} from '../server/production/crmService.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const now='2026-11-11T22:00:00.000Z';
const clock=()=>new Date(now);
const tenantId=randomUUID();

function scriptedPool(responder){
  const calls=[];
  const session={async query(sql,values=[]){
    const text=String(sql).trim();
    calls.push({sql:text,values});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(text))return {rows:[],rowCount:0};
    const response=responder(text,values,calls);
    if(!response)throw new Error(`Unexpected CRM query: ${text}`);
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

const personRow=(partyId,version=1)=>({
  tenant_id:tenantId,party_id:partyId,party_type:'person',display_name:'Ada Lovelace',status:'active',version,
  first_name:'Ada',middle_name:null,last_name:'Lovelace',preferred_name:null,birth_date:'1985-12-10',is_deceased:false,
  created_at:now,updated_at:now
});

const organizationRow=(partyId,version=1)=>({
  tenant_id:tenantId,party_id:partyId,party_type:'organization',display_name:'Wimblo Test Systems',status:'active',version,
  legal_name:'Wimblo Test Systems LLC',domain:'wimblo.test',industry:'technology',employee_count:12,founded_on:'2020-01-02',
  created_at:now,updated_at:now
});

test('repository creates one person party and its typed subtype in one transaction',async()=>{
  const partyId=randomUUID();
  const f=scriptedPool(sql=>sql.includes('INSERT INTO parties')?{rows:[personRow(partyId)],rowCount:1}:sql.includes('INSERT INTO people')?{rows:[{first_name:'Ada',middle_name:null,last_name:'Lovelace',preferred_name:null,birth_date:'1985-12-10',is_deceased:false}],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const created=await repository.createPerson({tenantId,partyId,displayName:' Ada Lovelace ',firstName:'Ada',lastName:'Lovelace',birthDate:'1985-12-10'});
  assert.deepEqual(created,{
    tenantId,partyId,partyType:'person',displayName:'Ada Lovelace',status:'active',version:1,createdAt:now,updatedAt:now,
    person:{firstName:'Ada',middleName:null,lastName:'Lovelace',preferredName:null,birthDate:'1985-12-10',isDeceased:false}
  });
  assert.ok(f.calls.some(call=>call.sql.includes('/*party:insert*/ INSERT INTO parties')));
  assert.ok(f.calls.some(call=>call.sql.includes('/*person:insert*/ INSERT INTO people')));
  assert.ok(f.calls.some(call=>call.sql.includes('/*party-event:insert*/ INSERT INTO party_events')));
  assert.equal(f.calls.at(-1).sql,'COMMIT');
});

test('repository creates organization parties with exact organization attributes',async()=>{
  const partyId=randomUUID();
  const f=scriptedPool(sql=>sql.includes('INSERT INTO parties')?{rows:[organizationRow(partyId)],rowCount:1}:sql.includes('INSERT INTO organizations')?{rows:[{legal_name:'Wimblo Test Systems LLC',domain:'wimblo.test',industry:'technology',employee_count:12,founded_on:'2020-01-02'}],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const created=await repository.createOrganization({tenantId,partyId,displayName:'Wimblo Test Systems',legalName:'Wimblo Test Systems LLC',domain:'Wimblo.test',industry:'technology',employeeCount:12,foundedOn:'2020-01-02'});
  assert.equal(created.partyType,'organization');
  assert.deepEqual(created.organization,{legalName:'Wimblo Test Systems LLC',domain:'wimblo.test',industry:'technology',employeeCount:12,foundedOn:'2020-01-02'});
  assert.ok(f.calls.some(call=>call.sql.includes('/*organization:insert*/ INSERT INTO organizations')));
});

test('repository normalizes contacts once and preserves their display value',async()=>{
  const partyId=randomUUID(),contactId=randomUUID();
  const f=scriptedPool(sql=>sql.includes('INSERT INTO contact_points')?{rows:[{
    tenant_id:tenantId,contact_id:contactId,party_id:partyId,type:'email',normalized_value:'ada@example.invalid',display_value:'Ada <ada@example.invalid>',status:'active',is_primary:true,verified_at:null,version:1,created_at:now,updated_at:now
  }],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const created=await repository.createContact({tenantId,contactId,partyId,type:'email',value:'  ADA@Example.INVALID  ',isPrimary:true});
  assert.equal(created.normalizedValue,'ada@example.invalid');
  assert.equal(created.displayValue,'Ada <ada@example.invalid>');
  const call=f.calls.find(item=>item.sql.includes('/*contact:insert*/ INSERT INTO contact_points'));
  assert.equal(call.values.includes('ada@example.invalid'),true);
  assert.equal(call.values.includes('  ADA@Example.INVALID  '),false);
});

test('repository refuses self-linked relationships before any SQL and maps database conflicts safely',async()=>{
  const f=scriptedPool(()=>({rows:[],rowCount:0}));
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const partyId=randomUUID();
  await assert.rejects(()=>repository.createRelationship({tenantId,relationshipId:randomUUID(),fromPartyId:partyId,toPartyId:partyId,type:'other',effectiveFrom:'2026-01-02'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.INVALID);
    assert.match(error.message,/same party/i);
    return true;
  });
  assert.equal(f.calls.length,0);

  const duplicate=scriptedPool(sql=>{
    if(sql.includes('/*contact:insert*/ INSERT INTO contact_points'))throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'duplicate key');
    return {rows:[],rowCount:0};
  });
  await assert.rejects(()=>createCrmRepository({tenantPool:duplicate.pool,clock}).createContact({tenantId,contactId:randomUUID(),partyId,type:'email',value:'ada@example.invalid'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
    assert.equal(duplicate.calls.some(call=>call.sql==='ROLLBACK'),true);
    return true;
  });
});

test('repository list and detail queries stay tenant-scoped and honor bounded paging',async()=>{
  const partyId=randomUUID();
  const f=scriptedPool((sql,values)=>{
    if(sql.includes('/*party:get*/'))return {rows:[personRow(partyId)],rowCount:1};
    if(sql.includes('/*party:list*/')){assert.deepEqual(values,[tenantId,'person',null,25,0]);return {rows:[personRow(partyId)],rowCount:1};}
    return {rows:[],rowCount:0};
  });
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const found=await repository.getParty(tenantId,partyId);
  assert.equal(found.partyId,partyId);
  const listed=await repository.listParties(tenantId,{type:'person',limit:25,offset:0});
  assert.equal(listed.length,1);
  const listCall=f.calls.find(call=>call.sql.includes('/*party:list*/'));
  assert.match(listCall.sql,/WHERE p\.tenant_id=\$1/);
});

test('repository stale party updates roll back without event history',async()=>{
  const f=scriptedPool(sql=>sql.includes('/*party:update*/')?{rows:[],rowCount:0}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  await assert.rejects(()=>repository.updateParty({tenantId,partyId:randomUUID(),displayName:'Changed',expectedVersion:2,actorIdentityId:randomUUID()}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
    assert.match(error.message,/version conflict/i);
    return true;
  });
  assert.equal(f.calls.some(call=>call.sql.includes('/*party-event:insert*/ INSERT INTO party_events')),false);
  assert.match(f.calls.find(call=>call.sql.includes('/*party:update*/')).sql,/AND version=\$6/);
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});

test('service denies disabled core and viewer writes, but permits enabled staff writes',async()=>{
  const partyId=randomUUID();
  const f=scriptedPool(sql=>sql.includes('INSERT INTO parties')?{rows:[personRow(partyId)],rowCount:1}:sql.includes('INSERT INTO people')?{rows:[{first_name:'Ada',middle_name:null,last_name:'Lovelace',preferred_name:null,birth_date:'1985-12-10',is_deceased:false}],rowCount:1}:{rows:[],rowCount:0});
  const repository=createCrmRepository({tenantPool:f.pool,clock});
  const moduleService={authorize:async({tenantId:tenant,code,action})=>({allowed:tenant===tenantId&&code==='core'&&action!=='write'})};
  const service=createCrmService({repository,moduleService});
  await assert.rejects(()=>service.createPerson({tenantId,partyId,displayName:'Ada',firstName:'Ada',lastName:'Lovelace',actorRole:'staff'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
    assert.match(error.message,/capability/i);
    return true;
  });
  assert.deepEqual(await service.listParties({tenantId,actorRole:'viewer'}),[]);
  const enabled={authorize:async()=>({allowed:true,state:'enabled'})};
  const allowedService=createCrmService({repository,moduleService:enabled});
  const created=await allowedService.createPerson({tenantId,partyId,displayName:'Ada',firstName:'Ada',lastName:'Lovelace',actorRole:'staff'});
  assert.equal(created.partyId,partyId);
  await assert.rejects(()=>allowedService.createPerson({tenantId,partyId:randomUUID(),displayName:'No',firstName:'No',lastName:'Write',actorRole:'viewer'}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
    assert.match(error.message,/role/i);
    return true;
  });
});
