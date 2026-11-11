import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CAPABILITY_CATALOG,createModuleService,requireModule} from '../server/production/moduleService.js';

function poolFixture(){
 const rows=new Map(),events=[];
 const session={async query(sql,values=[]){
  if(sql.includes('/*module:list*/'))return {rows:[...rows.values()].map(value=>({...value}))};
  if(sql.includes('/*module:get*/')){const row=rows.get(values[1]);return {rows:row?[{...row}]:[],rowCount:row?1:0};}
  if(sql.includes('/*module:upsert*/')){const previous=rows.get(values[1]),row={tenant_id:values[0],module_key:values[1],state:values[2],config:JSON.parse(values[3]),version:(previous?.version??0)+1,enabled_at:values[2]==='enabled'?(previous?.enabled_at??values[4]):previous?.enabled_at??null,updated_at:values[4]};rows.set(values[1],row);return {rows:[{...row}],rowCount:1};}
  if(sql.includes('/*module:event*/')){events.push({tenantId:values[0],moduleKey:values[1],eventType:values[3],details:JSON.parse(values[5])});return {rows:[],rowCount:1};}
  throw new Error(`Unexpected SQL: ${sql}`);
 }};
 return {rows,events,pool:{withTenantSession:async(tenant,fn)=>fn(session),withTransaction:async(tenant,fn)=>fn(session)}};
}

test('the neutral catalog has immutable codes, explicit dependencies and versions',()=>{
 assert.deepEqual(CAPABILITY_CATALOG.map(item=>item.code),['core','sales','marketing','service','events','membership','fundraising','grants','volunteer','payments','intelligence']);
 for(const item of CAPABILITY_CATALOG){assert.ok(Object.isFrozen(item));assert.ok(Object.isFrozen(item.dependencies));assert.ok(Number.isInteger(item.version)&&item.version>=1);}
 assert.deepEqual(CAPABILITY_CATALOG.find(item=>item.code==='sales').dependencies,['core']);
 assert.throws(()=>createModuleService({tenantPool:poolFixture().pool,catalog:[...CAPABILITY_CATALOG,{code:'sales',version:2,dependencies:[]}]}),/duplicate/i);
});

test('unknown modules and unmet dependencies are refused',async()=>{
 const f=poolFixture(),tenantId=randomUUID(),service=createModuleService({tenantPool:f.pool});
 await assert.rejects(()=>service.enable({tenantId,code:'unknown',expectedVersion:0,reason:'test'}),/unknown capability/i);
 await assert.rejects(()=>service.enable({tenantId,code:'sales',expectedVersion:0,reason:'test'}),/dependency.*core/i);
});

test('failed enablement stays non-callable, records reason and retries idempotently after repair',async()=>{
 const f=poolFixture(),tenantId=randomUUID();let healthy=false;
 const catalog=CAPABILITY_CATALOG.map(item=>item.code==='core'?{...item,admission:async()=>{if(!healthy)throw new Error('schema unavailable');}}:item);
 const service=createModuleService({tenantPool:f.pool,catalog});
 await assert.rejects(()=>service.enable({tenantId,code:'core',expectedVersion:0,reason:'initial enable'}),/schema unavailable/);
 assert.equal((await service.authorize({tenantId,code:'core',action:'read'})).allowed,false);
 assert.equal(f.events.at(-1).eventType,'enable_failed');
 assert.match(f.events.at(-1).details.reason,/schema unavailable/);
 healthy=true;const enabled=await service.enable({tenantId,code:'core',expectedVersion:1,reason:'repair verified'});
 assert.equal(enabled.state,'enabled');
 assert.equal((await service.authorize({tenantId,code:'core',action:'write'})).allowed,true);
 const same=await service.enable({tenantId,code:'core',expectedVersion:enabled.version,reason:'safe replay'});assert.equal(same.version,enabled.version);
});

test('suspension permits read/export only; reviewed retirement disables routes without deleting retained state',async()=>{
 const f=poolFixture(),tenantId=randomUUID(),service=createModuleService({tenantPool:f.pool});
 const enabled=await service.enable({tenantId,code:'core',expectedVersion:0,reason:'launch'});
 const suspended=await service.suspend({tenantId,code:'core',expectedVersion:enabled.version,reason:'incident'});
 assert.equal((await service.authorize({tenantId,code:'core',action:'read'})).allowed,true);
 assert.equal((await service.authorize({tenantId,code:'core',action:'export'})).allowed,true);
 assert.equal((await service.authorize({tenantId,code:'core',action:'write'})).allowed,false);
 await assert.rejects(()=>service.beginRetirement({tenantId,code:'core',expectedVersion:suspended.version,reason:'retire',dependencyReview:false,exportReview:true}),/dependency review/i);
 const retiring=await service.beginRetirement({tenantId,code:'core',expectedVersion:suspended.version,reason:'retire',dependencyReview:true,exportReview:true});
 const disabled=await service.disable({tenantId,code:'core',expectedVersion:retiring.version,reason:'retained and disabled'});
 assert.equal(disabled.state,'disabled');assert.ok(f.rows.has('core'));
 assert.equal((await service.authorize({tenantId,code:'core',action:'read'})).allowed,false);
 const reenabled=await service.enable({tenantId,code:'core',expectedVersion:disabled.version,reason:'compatible re-enable'});assert.equal(reenabled.state,'enabled');
});

test('requireModule exposes only authorized capabilities to routes',async()=>{
 const middleware=requireModule('sales','write'),req={tenantId:randomUUID(),moduleService:{authorize:async()=>({allowed:false,state:'suspended'})}};
 const response={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};await middleware(req,response,()=>{response.next=true;});
 assert.equal(response.statusCode,403);assert.equal(response.next,undefined);assert.doesNotMatch(JSON.stringify(response.body),/config|record/i);
});
