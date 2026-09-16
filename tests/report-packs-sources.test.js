import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installReportingRoutes} from '../server/reporting.js';
import {install as installAccountStructure} from '../server/accountStructure.js';

// Representative scale from the accounts workstream: 1,622 designations. The
// joined read must stay indexed and stay a single query.
test('the account join stays indexed and single-pass at 1,622 designations',async t=>{
 const db=new DatabaseSync(':memory:'),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 t.after(()=>db.close());
 db.exec('CREATE TABLE records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id));CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const list=collection=>db.prepare("SELECT data FROM records WHERE collection=? ORDER BY rowid").all(collection).map(row=>JSON.parse(row.data));
 const app=express();
 // The real module installs the schema, indexes and retention triggers.
 installAccountStructure(app,{db,list,get:()=>({}),audit:()=>{},csrf:(req,res,next)=>next(),admin:(req,res,next)=>next(),transaction});
 const reporting=installReportingRoutes(app,{db,collections,list:(collection)=>list(collection),csrf:(req,res,next)=>next(),write:(req,res,next)=>next(),audit:()=>{},transaction});
 const now='2026-09-15T12:00:00.000Z';
 transaction(()=>{
  const location=db.prepare('INSERT INTO account_locations VALUES(?,?,?,?,1,?,?)'),func=db.prepare('INSERT INTO account_functions VALUES(?,?,?,?,1,?,?)');
  const pair=db.prepare('INSERT INTO account_pairs VALUES(?,?,?,?,?,1,?,?)'),link=db.prepare('INSERT INTO account_designation_links VALUES(?,?,1,1,?,?,?)');
  const record=db.prepare("INSERT INTO records VALUES('first','designations',?,?)");
  const locations=[],functions=[];
  for(let i=0;i<20;i++){const id=randomUUID(),code=String(100+i);location.run(id,code,'Location '+code,'Active',now,now);locations.push({id,code});}
  for(let i=0;i<8;i++){const id=randomUUID(),code=String(2000+i);func.run(id,code,'Function '+code,'Active',now,now);functions.push({id,code});}
  const pairs=[];
  for(const place of locations)for(const purpose of functions){const id=randomUUID();pair.run(id,place.id,purpose.id,place.code+'-'+purpose.code,'Active',now,now);pairs.push(id);}
  for(let i=0;i<1622;i++){
   const id=randomUUID();
   record.run(id,JSON.stringify({id,version:1,name:'Designation '+i,school:'School '+(i%7),accountCode:'X'+i}));
   link.run(id,pairs[i%pairs.length],now,now,'seed-actor');
  }
 });
 const plan=db.prepare('EXPLAIN QUERY PLAN '+reporting.accountLinkQuery).all().map(row=>row.detail);
 assert.equal(plan.filter(detail=>/TEMP B-TREE/.test(detail)).length,0,'the ordered read needs no temporary sort: '+JSON.stringify(plan));
 assert.equal(plan.filter(detail=>detail.startsWith('SCAN')).length,1,'only the driving link table is walked: '+JSON.stringify(plan));
 assert.match(plan[0],/^SCAN l USING INDEX/,'and it is walked in primary-key order');
 for(const alias of ['p','loc','fn']){
  const step=plan.find(detail=>detail.startsWith('SEARCH '+alias+' '));
  assert.ok(step&&/USING (COVERING )?INDEX|PRIMARY KEY/.test(step),alias+' is reached by index, not scanned: '+JSON.stringify(plan));
 }
 const structure=reporting.designationAccounts();
 assert.equal(structure.linkCount,1622);
 assert.equal(structure.accounts.size,1622);
 assert.equal(typeof structure.digest,'string');
 assert.equal(structure.digest.length,64);
 // 20 locations x 8 functions: one function serving twenty locations still
 // produces one account per location and one account per designation.
 assert.equal(new Set([...structure.accounts.values()].map(account=>account.pairId)).size,160);
 for(const account of structure.accounts.values()){assert.match(account.locationCode,/^\d{3}$/);assert.match(account.functionCode,/^\d{4}$/);}
 const changed=reporting.designationAccounts();
 assert.equal(changed.digest,structure.digest,'the same links produce the same pinned digest');

 // The account sources added for reporting must stay indexed at the same scale.
 const pairPlan=db.prepare('EXPLAIN QUERY PLAN '+reporting.accountSourceQueries.pairs).all().map(row=>row.detail);
 assert.equal(pairPlan.filter(detail=>/TEMP B-TREE/.test(detail)).length,0,'accounts are read in code order without a temporary sort: '+JSON.stringify(pairPlan));
 assert.ok(pairPlan.some(detail=>/SEARCH l USING (COVERING )?INDEX account_link_pair/.test(detail)),'the linked-designation count uses the link index instead of a scan per account: '+JSON.stringify(pairPlan));
 for(const alias of ['loc','fn']){
  const step=pairPlan.find(detail=>detail.startsWith('SEARCH '+alias+' '));
  assert.ok(step&&/USING (COVERING )?INDEX|PRIMARY KEY/.test(step),alias+' is reached by index in the account read: '+JSON.stringify(pairPlan));
 }
 // The append-only history is read in rowid order, which is its insertion order,
 // so no account source needs a temporary sort at this scale.
 for(const [name,query] of Object.entries(reporting.accountSourceQueries)){
  const plan=db.prepare('EXPLAIN QUERY PLAN '+query).all().map(row=>row.detail);
  assert.equal(plan.filter(detail=>/TEMP B-TREE/.test(detail)).length,0,name+' is read without a temporary sort: '+JSON.stringify(plan));
 }
 // And the counts are right at that scale: 160 accounts covering 1,622 links,
 // each link counted under exactly one account.
 const user={id:'user-admin',role:'admin'};
 const accounts=reporting.completeSection({name:'Accounts at scale',entity:'accountPairs',columns:['code','linkedDesignationCount'],filters:[],groupBy:[],aggregates:[],includeVoided:false},{user});
 assert.equal(accounts.rows.length,160);
 assert.equal(accounts.rows.reduce((total,row)=>total+row[1],0),1622,'every link is counted under exactly one account');
 const links=reporting.completeSection({name:'Links at scale',entity:'accountDesignationLinks',columns:['designationId','pairCode'],filters:[],groupBy:[],aggregates:[],includeVoided:false},{user});
 assert.equal(links.rows.length,1622);
 assert.equal(new Set(links.rows.map(row=>row[0])).size,1622,'no designation appears under two accounts');
});

test('a workspace with no account structure tables reports and assembles exactly as before',async t=>{
 const db=new DatabaseSync(':memory:'),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 t.after(()=>db.close());
 db.exec('CREATE TABLE records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id))');
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const id=randomUUID();
 db.prepare("INSERT INTO records VALUES('first','designations',?,?)").run(id,JSON.stringify({id,version:1,name:'STEM lab',school:'North elementary'}));
 const list=collection=>db.prepare("SELECT data FROM records WHERE collection=? ORDER BY rowid").all(collection).map(row=>JSON.parse(row.data));
 const app=express();
 const reporting=installReportingRoutes(app,{db,collections,list:collection=>list(collection),csrf:(req,res,next)=>next(),write:(req,res,next)=>next(),audit:()=>{},transaction});
 assert.equal(reporting.designationAccounts(),null,'no account tables means no account read at all');
 const user={id:'u1',role:'staff'};
 const section=reporting.completeSection({name:'Designations',entity:'designations',columns:['name','school'],filters:[],groupBy:[],aggregates:[],includeVoided:false},{user});
 assert.deepEqual(section.rows,[['STEM lab','North elementary']]);
 assert.equal(section.columns.some(column=>column.key.startsWith('account')),false,'no account column appears where no account structure exists');
});

// A local workspace that installs the real account-structure schema next to the
// reporting routes, so the five sources are exercised without booting the whole
// application. Role gating here is the same gate the application installs.
async function sources(t,{accounts=true}={}){
 const db=new DatabaseSync(':memory:'),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 db.exec('CREATE TABLE records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id));CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');
 const roles=['admin','staff','viewer','event-helper'],users=Object.fromEntries(roles.map(role=>[role,{id:'user-'+role,name:'Synthetic '+role,role,active:1}]));
 for(const user of Object.values(users))db.prepare('INSERT INTO users VALUES(?,?,?,?,1,1)').run(user.id,user.name,user.role+'@example.test',user.role);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const list=(collection,req)=>db.prepare('SELECT data FROM records WHERE tenant=? AND collection=? ORDER BY rowid').all(req?.tenantId||'first',collection).map(row=>JSON.parse(row.data));
 const set=(collection,rows,tenant='first')=>transaction(()=>{const insert=db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)');for(const row of rows)insert.run(tenant,collection,row.id,JSON.stringify(row));});
 const app=express();app.use(express.json({limit:'2mb'}));
 app.use((req,res,next)=>{req.user=users[req.get('X-Role')||'staff'];req.tenantId=req.get('X-Tenant')||'first';next();});
 const pass=(req,res,next)=>next();
 if(accounts)installAccountStructure(app,{db,list:collection=>list(collection),get:()=>({}),audit:()=>{},csrf:pass,admin:pass,transaction});
 const reporting=installReportingRoutes(app,{db,collections,list,csrf:pass,write:pass,audit:()=>{},transaction});
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const call=async(path,{method='POST',payload,role='staff',tenant='first'}={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant},...(method==='GET'?{}:{body:JSON.stringify(payload??{})})});
  return {status:response.status,json:await response.json()};
 };
 const now='2026-09-15T12:00:00.000Z';
 const seed=()=>transaction(()=>{
  const location=db.prepare('INSERT INTO account_locations VALUES(?,?,?,?,1,?,?)'),func=db.prepare('INSERT INTO account_functions VALUES(?,?,?,?,1,?,?)');
  const pair=db.prepare('INSERT INTO account_pairs VALUES(?,?,?,?,?,1,?,?)'),link=db.prepare('INSERT INTO account_designation_links VALUES(?,?,3,2,?,?,?)');
  const history=db.prepare('INSERT INTO account_structure_history VALUES(?,?,?,?,?,?,?)');
  location.run('loc-north','100','North Elementary','Active',now,now);location.run('loc-south','200','South Middle','Retired',now,now);
  func.run('fn-instruction','2000','Instruction','Active',now,now);
  pair.run('pair-north','loc-north','fn-instruction','100-2000','Active',now,now);
  pair.run('pair-south','loc-south','fn-instruction','200-2000','Retired',now,now);
  link.run('des-stem','pair-north',now,now,'user-admin');
  link.run('des-other-tenant','pair-south',now,now,'user-admin');
  history.run('hist-1','location','loc-north','created',JSON.stringify({code:'100',name:'North Elementary'}),'user-admin',now);
  history.run('hist-2','designation','des-stem','linked',JSON.stringify({pairCode:'100-2000',reason:'Reviewed account assignment'}),'user-admin',now);
 });
 return {db,call,set,seed,reporting,users,transaction,
  // The accounts workstream installing against this same workspace database.
  installAccounts:()=>installAccountStructure(express(),{db,list:collection=>list(collection),get:()=>({}),audit:()=>{},csrf:pass,admin:pass,transaction}),
  catalog:(options={})=>call('/api/custom-reports/catalog',{method:'GET',...options}),
  inspect:(entity,options={})=>call('/api/custom-reports/catalog?entity='+entity,{method:'GET',...options}),
  run:(definition,options={})=>call('/api/custom-reports/run',{payload:definition,...options})};
}
const definition=(entity,columns,patch={})=>({name:'Account structure check',entity,columns,filters:[],groupBy:[],aggregates:[],includeVoided:false,...patch});
const entityIds=response=>response.json.entities.map(entity=>entity.id);

test('the four structural account sources are reportable by every reporting role and the change history is not',async t=>{
 const f=await sources(t);f.seed();
 f.set('designations',[{id:'des-stem',version:3,name:'STEM lab',school:'North elementary'}]);
 for(const role of ['staff','viewer']){
  const catalog=await f.catalog({role});
  assert.equal(catalog.status,200);
  for(const entity of ['accountLocations','accountFunctions','accountPairs','accountDesignationLinks'])assert.ok(entityIds(catalog).includes(entity),role+' sees '+entity);
  assert.equal(entityIds(catalog).includes('accountStructureHistory'),false,role+' does not see the change history');
  for(const entity of catalog.json.entities.filter(item=>item.id.startsWith('account')))assert.equal(entity.requiredRole,'authenticated');
 }
 const admin=await f.catalog({role:'admin'});
 for(const entity of ['accountLocations','accountFunctions','accountPairs','accountDesignationLinks','accountStructureHistory'])assert.ok(entityIds(admin).includes(entity),'an administrator sees '+entity);
 assert.equal(admin.json.entities.find(entity=>entity.id==='accountStructureHistory').requiredRole,'admin');
 assert.deepEqual(admin.json.entities.find(entity=>entity.id==='accountLocations').fields.map(field=>field.key),['id','code','name','status','revision','createdAt','updatedAt']);
 assert.equal(admin.json.entities.find(entity=>entity.id==='accountPairs').fields.find(field=>field.key==='linkedDesignationCount').aggregateable,true);
});

test('the change history is refused for a non-administrator rather than merely hidden',async t=>{
 const f=await sources(t);f.seed();
 for(const role of ['staff','viewer']){
  const refused=await f.run(definition('accountStructureHistory',['action']),{role});
  assert.equal(refused.status,403,JSON.stringify(refused.json));
  assert.match(refused.json.error,/requires administrator access/);
  assert.equal(refused.json.rows,undefined);
  const inspected=await f.inspect('accountStructureHistory',{role});
  assert.equal(inspected.status,403);
  assert.equal(inspected.json.entities,undefined);
  const exported=await f.call('/api/custom-reports/export/xlsx?fingerprint='+'0'.repeat(64),{payload:definition('accountStructureHistory',['action']),role});
  assert.equal(exported.status,403);
  assert.equal(exported.json.file,undefined);
 }
 assert.equal((await f.run(definition('accountStructureHistory',['action']),{role:'event-helper'})).status,403);
 const admin=await f.run(definition('accountStructureHistory',['subject','subjectId','action','actor','detail']),{role:'admin'});
 assert.equal(admin.status,200,JSON.stringify(admin.json));
 assert.equal(admin.json.requiredRole,'admin');
 assert.deepEqual(admin.json.rows.map(row=>row.slice(0,4)),[['location','loc-north','created','user-admin'],['designation','des-stem','linked','user-admin']]);
 assert.deepEqual(JSON.parse(admin.json.rows[1][4]),{pairCode:'100-2000',reason:'Reviewed account assignment'});
 // A saved history definition stays administrator-only on listing and on rerun.
 const saved=await f.call('/api/custom-reports',{payload:definition('accountStructureHistory',['action']),role:'admin'});
 assert.equal(saved.status,201,JSON.stringify(saved.json));
 assert.equal((await f.call('/api/custom-reports',{method:'GET',role:'staff'})).json.reports.length,0);
 assert.equal((await f.call('/api/custom-reports',{method:'GET',role:'admin'})).json.reports.length,1);
 assert.equal((await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'staff'})).status,403);
 assert.equal((await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'admin'})).status,200);
});

test('each account source reports its registered facts exactly once, scoped to designations the reader can see',async t=>{
 const f=await sources(t);f.seed();
 f.set('designations',[{id:'des-stem',version:3,name:'STEM lab',school:'North elementary'}]);
 f.set('designations',[{id:'des-other-tenant',version:1,name:'Other workspace fund'}],'second');
 const locations=await f.run(definition('accountLocations',['code','name','status','revision']),{role:'viewer'});
 assert.equal(locations.status,200,JSON.stringify(locations.json));
 assert.deepEqual(locations.json.rows,[['100','North Elementary','Active',1],['200','South Middle','Retired',1]]);
 const functions=await f.run(definition('accountFunctions',['code','name','status']));
 assert.deepEqual(functions.json.rows,[['2000','Instruction','Active']]);
 const pairs=await f.run(definition('accountPairs',['code','locationCode','functionCode','locationName','functionName','status','linkedDesignationCount']));
 assert.deepEqual(pairs.json.rows,[['100-2000','100','2000','North Elementary','Instruction','Active',1],['200-2000','200','2000','South Middle','Instruction','Retired',1]]);
 // One function serving two locations is two accounts, each counting its own
 // linked designations once; the counts never sum to more than the links.
 assert.equal(pairs.json.rows.reduce((total,row)=>total+row[6],0),2);
 const links=await f.run(definition('accountDesignationLinks',['designationId','designationName','pairCode','locationCode','functionCode','designationRevision','revision','actor']));
 assert.equal(links.json.rows.length,1,'a link to a designation this workspace cannot see is not reported');
 assert.deepEqual(links.json.rows[0],['des-stem','STEM lab','100-2000','100','2000',3,2,'user-admin']);
 const other=await f.run(definition('accountDesignationLinks',['designationId','designationName']),{tenant:'second'});
 assert.deepEqual(other.json.rows,[['des-other-tenant','Other workspace fund']]);
 const grouped=await f.run(definition('accountDesignationLinks',['locationCode'],{groupBy:['locationCode'],aggregates:[{op:'count',label:'Linked designations'}]}));
 assert.deepEqual(grouped.json.rows,[['100',1]]);
});

test('a workspace with no account structure tables exposes none of the five sources and acquires nothing',async t=>{
 const f=await sources(t,{accounts:false});
 f.set('designations',[{id:'des-stem',version:3,name:'STEM lab',school:'North elementary'}]);
 const catalog=await f.catalog();
 assert.equal(catalog.status,200);
 for(const entity of ['accountLocations','accountFunctions','accountPairs','accountDesignationLinks','accountStructureHistory'])assert.equal(entityIds(catalog).includes(entity),false,entity+' is absent without its table');
 for(const entity of ['accountLocations','accountPairs','accountDesignationLinks']){
  const refused=await f.run(definition(entity,['code']));
  assert.equal(refused.status,400,entity+' cannot be reported');
  assert.equal(refused.json.rows,undefined);
 }
 assert.equal(f.reporting.designationAccounts(),null);
 const designations=await f.run(definition('designations',['name','school']));
 assert.deepEqual(designations.json.rows,[['STEM lab','North elementary']]);
 assert.equal(catalog.json.entities.find(entity=>entity.id==='designations').fields.some(field=>field.key.startsWith('account')&&field.key!=='accountCode'),false);
});

test('an existing saved report keeps its definition, columns and rows when the account structure appears, and only its source proof moves',async t=>{
 const f=await sources(t,{accounts:false});
 f.set('designations',[{id:'des-stem',version:3,name:'STEM lab',school:'North elementary'},{id:'des-food',version:1,name:'Food pantry',school:'South middle'}]);
 const saved=await f.call('/api/custom-reports',{payload:definition('designations',['name','school','accountCode']),role:'admin'});
 assert.equal(saved.status,201,JSON.stringify(saved.json));
 const before=await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'admin'});
 assert.equal(before.status,200);
 // The scheduler reruns a saved definition through exactly this entry point.
 const scheduledBefore=f.reporting.executeSavedReport(saved.json.report.id,f.users.admin,{tenantId:'first'});
 // Now the accounts workstream installs its tables into this same workspace and
 // links one designation.
 f.installAccounts();f.seed();
 const after=await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'admin'});
 assert.equal(after.status,200);
 assert.deepEqual(after.json.columns.map(column=>column.key),before.json.columns.map(column=>column.key),'the saved column list is untouched');
 assert.deepEqual(after.json.rows,before.json.rows,'every saved row is unchanged');
 assert.equal(after.json.version,before.json.version,'the saved definition was not rewritten');
 assert.deepEqual(after.json.definition,before.json.definition);
 const scheduledAfter=f.reporting.executeSavedReport(saved.json.report.id,f.users.admin,{tenantId:'first'});
 assert.deepEqual(scheduledAfter.rows,scheduledBefore.rows,'a scheduled rerun returns the same rows');
 assert.deepEqual(scheduledAfter.columns,scheduledBefore.columns);
 // What does move is the pinned source proof: the designation records now carry
 // their account facts, so the stale-source guard sees new source facts. That is
 // the guard working, not a break - it only invalidates a review already in
 // flight, and a fresh run exports normally.
 assert.notEqual(after.json.sourceFingerprint,before.json.sourceFingerprint,'the source proof moves once account facts join the designation records');
 const stale=await f.call('/api/custom-reports/export/xlsx?fingerprint='+before.json.sourceFingerprint,{payload:before.json.definition,role:'admin'});
 assert.equal(stale.status,409,JSON.stringify(stale.json));
 assert.equal(stale.json.file,undefined);
 assert.match(stale.json.error,/changed since the reviewed report/);
 const fresh=await f.call('/api/custom-reports/export/xlsx?fingerprint='+after.json.sourceFingerprint,{payload:after.json.definition,role:'admin'});
 assert.equal(fresh.status,200,JSON.stringify(fresh.json).slice(0,200));
 assert.equal(fresh.json.rowCount,2);
 // A later link change moves it again, for the same reason.
 const linked=await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'admin'});
 f.transaction(()=>f.db.prepare("DELETE FROM account_designation_links WHERE designation_id='des-stem'").run());
 const unlinked=await f.call('/api/custom-reports/'+saved.json.report.id+'/run',{method:'GET',role:'admin'});
 assert.notEqual(unlinked.json.sourceFingerprint,linked.json.sourceFingerprint);
 assert.deepEqual(unlinked.json.rows,linked.json.rows,'removing a link changes no saved designation row');
});
