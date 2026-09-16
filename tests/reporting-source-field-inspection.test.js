import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installReportingRoutes} from '../server/reporting.js';

const donor=randomUUID(),fundA=randomUUID(),fundB=randomUUID(),campaign=randomUUID();
const definition=patch=>({name:'Complete reviewed facts',entity:'gifts',columns:['id','externalRef','amount'],...patch});
const gift=(n,patch={})=>({id:randomUUID(),version:1,constituentId:donor,campaignId:campaign,amount:10001,date:'2026-09-13',type:'Cash',method:'Check',status:'Posted',externalRef:String(n),allocations:[{designationId:fundA,amount:6000},{designationId:fundB,amount:4001}],...patch});
async function fixture(t){
 const db=new DatabaseSync(':memory:'),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 db.exec('CREATE TABLE records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id));CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');
 const users=Object.fromEntries(['admin','staff','viewer','event-helper'].map(role=>[role,{id:randomUUID(),name:'Synthetic '+role,role,active:1}]));for(const u of Object.values(users))db.prepare('INSERT INTO users VALUES(?,?,?,?,1,1)').run(u.id,u.name,u.role+'@example.test',u.role);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const set=(collection,rows,tenant='first')=>transaction(()=>{db.prepare('DELETE FROM records WHERE tenant=? AND collection=?').run(tenant,collection);const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?)');for(const row of rows)insert.run(tenant,collection,row.id,JSON.stringify(row));});
 const list=(collection,req)=>db.prepare('SELECT data FROM records WHERE tenant=? AND collection=? ORDER BY rowid').all(req?.tenantId||'first',collection).map(row=>JSON.parse(row.data));
 set('constituents',[{id:donor,name:'Synthetic donor'}]);set('designations',[{id:fundA,name:'First fund'},{id:fundB,name:'Second fund'}]);set('campaigns',[{id:campaign,name:'Synthetic campaign'}]);
 const app=express();app.use(express.json({limit:'1mb'}));app.use((req,res,next)=>{req.user=users[req.get('X-Role')||'staff'];req.tenantId=req.get('X-Tenant')||'first';next();});
 const csrf=(req,res,next)=>req.get('X-CSRF')==='synthetic-csrf'?next():res.status(403).json({error:'CSRF validation required'}),write=(req,res,next)=>['admin','staff'].includes(req.user?.role)?next():res.status(403).json({error:'Readonly'});
 const reporter=installReportingRoutes(app,{db,collections,list,csrf,write,audit:()=>{},transaction});app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 async function request(path,{payload,role='staff',tenant='first',csrf=true}={}){const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/custom-reports'+path,{method:path.startsWith('/catalog')?'GET':'POST',headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant,...(csrf?{'X-CSRF':'synthetic-csrf'}:{})},...(path.startsWith('/catalog')?{}:{body:JSON.stringify(payload)})});return {status:response.status,json:await response.json(),headers:response.headers};}
 const run=(payload,options={})=>request('/run',{payload,...options}),exportReport=(review,options={})=>request('/export?fingerprint='+review.sourceFingerprint,{payload:review.definition,...options});
 const inspect=(entity,options={})=>request('/catalog?entity='+encodeURIComponent(entity),options);
 return {db,set,list,run,exportReport,request,reporter,users,transaction,inspect};
}
function documents(f){
 f.db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,collection TEXT,record_id TEXT,title TEXT,category TEXT,visibility TEXT,status TEXT,evidence_date TEXT,archived INTEGER,created_at TEXT,updated_at TEXT,retention_until TEXT);CREATE TABLE document_revisions(document_id TEXT,revision INTEGER,filename TEXT,mime TEXT,bytes BLOB,sha256 TEXT,actor TEXT,at TEXT,metadata TEXT,PRIMARY KEY(document_id,revision))');
 const id=randomUUID(),task=randomUUID();f.set('tasks',[{id:task,title:'Shared task'}]);f.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'tasks',task,'Shared current document','Attachment','Workspace','Draft',null,0,'2026-09-13','2026-09-13',null);
 const insert=f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?)');return {id,add:(revision,visibility='Workspace')=>insert.run(id,revision,visibility==='Workspace'?'shared-'+revision+'.txt':'PRIVATE_NAME.txt','text/plain',Buffer.from('PRIVATE_BYTES'),'1'.repeat(64),f.users.admin.id,'2026-09-13',JSON.stringify({title:visibility==='Workspace'?'Shared revision':'PRIVATE_TITLE',category:'Attachment',status:'Draft',visibility,evidenceDate:null}))};
}
function fields(response){return response.json.entities[0].fields.map(field=>field.key);}
function noCatalog(response,status){assert.equal(response.status,status,JSON.stringify({error:response.json.error}));assert.equal(response.json.entities,undefined);assert.equal(response.json.inspection,undefined);}

test('explicit inspection discovers a rare optional revision field after the sampled metadata first 100 rows without exposing values',async t=>{
 const f=await fixture(t),d=documents(f);f.transaction(()=>{for(let i=1;i<=151;i++)d.add(i);});f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=151').run(JSON.stringify({title:'Shared revision',visibility:'Workspace',evidenceDate:'2024-07-03'}));
 // Remove this optional path entirely from earlier revisions; field discovery
 // must inspect actual authorized metadata rows, not a static placeholder.
 f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision<151').run(JSON.stringify({title:'Shared revision',visibility:'Workspace'}));
 const sampled=await f.request('/catalog');assert.equal(sampled.status,200);assert.equal(sampled.json.metadataSchemaSampleRows,100);assert.equal(sampled.json.inspection,undefined);assert.equal(sampled.json.entities.find(entity=>entity.id==='documentRevisions').fields.some(field=>field.key==='metadata.evidenceDate'),false);
 const inspected=await f.inspect('documentRevisions');assert.equal(inspected.status,200,JSON.stringify(inspected.json));assert.deepEqual(inspected.json.entities.map(entity=>entity.id),['documentRevisions']);assert.ok(fields(inspected).includes('metadata.evidenceDate'));assert.equal(inspected.json.inspection.sourceRowsInspected,151);assert.equal(inspected.json.inspection.fieldCount,fields(inspected).length);assert.equal(inspected.json.inspection.entity,'documentRevisions');assert.equal(inspected.json.inspection.depthLimit,4);assert.equal(inspected.json.inspection.arrayItemLimit,100);assert.equal(inspected.headers.get('cache-control'),'no-store');assert.doesNotMatch(JSON.stringify(inspected.json),/2024-07-03|Shared revision|PRIVATE_BYTES|shared-151\.txt/);
 f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=151').run(JSON.stringify({title:'Shared revision',visibility:'Workspace',status:'Approved'}));const fresh=await f.inspect('documentRevisions');assert.equal(fresh.status,200);assert.equal(fields(fresh).includes('metadata.evidenceDate'),false);assert.ok(fields(fresh).includes('metadata.status'));
});

test('selected current and historical privacy prevent private field paths or dependency catalogs from leaking',async t=>{
 const f=await fixture(t),d=documents(f);f.db.prepare('DELETE FROM document_revisions').run();d.add(1);d.add(2,'Administrators');f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=1').run(JSON.stringify({title:'Public value',visibility:'Workspace'}));f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=2').run(JSON.stringify({title:'PRIVATE_TITLE',visibility:'Administrators',category:'PRIVATE_CATEGORY',evidenceDate:'PRIVATE_DATE'}));
 f.set('constituents',[{id:donor,name:'PRIVATE_DEPENDENCY_VALUE',unrelatedRareDependency:'PRIVATE_DEPENDENCY_VALUE'}]);const staff=await f.inspect('documentRevisions');assert.equal(staff.status,200);assert.equal(staff.json.inspection.sourceRowsInspected,1);assert.equal(fields(staff).includes('metadata.category'),false);assert.equal(fields(staff).includes('metadata.evidenceDate'),false);assert.equal(fields(staff).includes('unrelatedRareDependency'),false);assert.doesNotMatch(JSON.stringify(staff.json),/PRIVATE_/);
 const admin=await f.inspect('documentRevisions',{role:'admin'});assert.equal(admin.status,200);assert.equal(admin.json.inspection.sourceRowsInspected,2);assert.ok(fields(admin).includes('metadata.category'));assert.doesNotMatch(JSON.stringify(admin.json),/PRIVATE_/);
 f.db.prepare('UPDATE documents SET visibility=? WHERE id=?').run('Administrators',d.id);const hidden=await f.inspect('documentRevisions');assert.equal(hidden.status,200);assert.equal(hidden.json.inspection.sourceRowsInspected,0);assert.equal(fields(hidden).includes('metadata.category'),false);
});

test('inspection preserves bounded nested discovery and removes protected paths while reporting its explicit limitations',async t=>{
 const f=await fixture(t),array=Array.from({length:101},(_,i)=>({usual:'retained',...(i===100?{tooLate:'VALUE_AFTER_100'}:{})}));f.set('tasks',[{id:randomUUID(),title:'Synthetic task',custom:{a:{b:{c:{d:{tooDeep:'DEEP_VALUE'}}}}},items:array,apiKey:'PRIVATE_KEY',nested:{password:'PRIVATE_PASSWORD',safeField:'SAFE_VALUE'}}]);const inspected=await f.inspect('tasks');assert.equal(inspected.status,200);const keys=fields(inspected);assert.ok(keys.includes('nested.safeField'));assert.ok(keys.includes('items.usual'));assert.equal(keys.includes('items.tooLate'),false);assert.equal(keys.includes('custom.a.b.c.d.tooDeep'),false);assert.equal(keys.some(key=>/apiKey|password/.test(key)),false);assert.match(inspected.json.inspection.scope,/depth 4.*first 100/);assert.doesNotMatch(JSON.stringify(inspected.json),/PRIVATE_|SAFE_VALUE|DEEP_VALUE|VALUE_AFTER_100/);
});

test('field inspection includes authorized voided gift fields without changing report defaults or stored money',async t=>{
 const f=await fixture(t),posted=gift(0),voided=gift(1,{status:'Voided',rareHistoricalField:'AUTHORIZED_OLD_VALUE'});f.set('gifts',[posted,voided]);const before=f.list('gifts',{tenantId:'first'}),inspected=await f.inspect('gifts');assert.equal(inspected.status,200);assert.equal(inspected.json.inspection.sourceRowsInspected,2);assert.equal(inspected.json.inspection.includesVoidedGiftRows,true);assert.ok(fields(inspected).includes('rareHistoricalField'));assert.doesNotMatch(JSON.stringify(inspected.json),/AUTHORIZED_OLD_VALUE/);
 const split=await f.inspect('giftAllocations');assert.equal(split.status,200);assert.equal(split.json.inspection.sourceRowsInspected,4);assert.equal(split.json.inspection.includesVoidedGiftRows,true);const report=await f.run(definition({columns:['amount'],aggregates:[{op:'sum',field:'amount'}]}));assert.equal(report.status,200);assert.equal(report.json.matchedRows,1);assert.deepEqual(report.json.rows,[[10001]]);assert.equal(report.json.definition.includeVoided,false);assert.deepEqual(f.list('gifts',{tenantId:'first'}),before);const tasks=await f.inspect('tasks');assert.equal(tasks.json.inspection.includesVoidedGiftRows,false);
});

test('selected allocation fields count derived split rows and bound underlying acquisition before discovery',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:301},(_,i)=>gift(i)));const inspected=await f.inspect('giftAllocations');assert.equal(inspected.status,200);assert.deepEqual(inspected.json.entities.map(entity=>entity.id),['giftAllocations']);assert.equal(inspected.json.inspection.sourceRowsInspected,602);assert.ok(fields(inspected).includes('allocationAmount'));assert.equal(fields(inspected).includes('amount'),false);
 const bad=gift(0);bad.allocations[0].amount++;f.set('gifts',[bad]);noCatalog(await f.inspect('giftAllocations'),400);
 f.set('gifts',Array.from({length:50001},(_,i)=>gift(i)));const splits=await f.inspect('giftAllocations');noCatalog(splits,413);assert.match(splits.json.error,/100,000/);
 f.set('gifts',Array.from({length:100001},(_,i)=>({id:'synthetic-'+i,status:'Voided',allocations:[]})));const native=await f.inspect('giftAllocations');noCatalog(native,413);assert.match(native.json.error,/acquisition/);
});

test('auth, administrator source gates and strict query validation precede selected field access',async t=>{
 const f=await fixture(t);for(const options of [{role:'missing'},{role:'event-helper'}])noCatalog(await f.inspect('gifts',options),options.role==='missing'?401:403);
 for(const role of ['staff','viewer'])noCatalog(await f.inspect('workspaceUsers',{role}),403);const admin=await f.inspect('workspaceUsers',{role:'admin'});assert.equal(admin.status,200);assert.equal(admin.json.inspection.sourceRowsInspected,4);assert.deepEqual(admin.json.entities.map(entity=>entity.id),['workspaceUsers']);assert.doesNotMatch(JSON.stringify(admin.json),/@example\.test|Synthetic staff/);
 for(const query of ['?entity=','?entity=noSuchSource','?entity=constructor','?entity=gifts&entity=tasks','?entity[]=gifts','?entity=gifts&limit=100','?filter=gifts'])noCatalog(await f.request('/catalog'+query),400);
 noCatalog(await f.inspect('tributes',{role:'admin'}),400);
 // This is an authenticated read; no CSRF token or record-write privilege is
 // needed by a viewer. Mutation routes retain their separate protection.
 assert.equal((await f.inspect('gifts',{role:'viewer',csrf:false})).status,200);
});

test('source inspection uses fresh tenant-visible records and never changes records or saved definitions',async t=>{
 const f=await fixture(t),task=randomUUID();f.set('tasks',[{id:task,title:'First workspace',onlyFirst:'FIRST_VALUE'}]);f.set('tasks',[{id:task,title:'Second workspace',onlySecond:'SECOND_VALUE'}],'other');const before=f.db.prepare('SELECT collection,id,data FROM records ORDER BY tenant,collection,id').all(),definitions=f.db.prepare('SELECT * FROM custom_reports').all();const first=await f.inspect('tasks'),second=await f.inspect('tasks',{tenant:'other'});assert.ok(fields(first).includes('onlyFirst'));assert.equal(fields(first).includes('onlySecond'),false);assert.ok(fields(second).includes('onlySecond'));assert.equal(fields(second).includes('onlyFirst'),false);assert.doesNotMatch(JSON.stringify(first.json),/FIRST_VALUE|SECOND_VALUE/);assert.deepEqual(f.db.prepare('SELECT collection,id,data FROM records ORDER BY tenant,collection,id').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM custom_reports').all(),definitions);
 f.set('tasks',[{id:task,title:'First workspace',updatedPath:'UPDATED_VALUE'}]);const refreshed=await f.inspect('tasks');assert.ok(fields(refreshed).includes('updatedPath'));assert.equal(fields(refreshed).includes('onlyFirst'),false);
});

test('selected 100k rows, 64 MB clean facts and 1 MB field response limits reject rather than publish a partial schema',async t=>{
 const f=await fixture(t);f.set('constituents',Array.from({length:100001},(_,i)=>({id:'synthetic-'+i,name:'Synthetic'})));const rows=await f.inspect('constituents');noCatalog(rows,413);assert.match(rows.json.error,/100,000/);
 f.set('constituents',[{id:donor,name:'Synthetic donor'}]);f.set('tasks',Array.from({length:8},(_,i)=>({id:'synthetic-'+i,title:'Synthetic',safeFacts:'x'.repeat(8000001)})));const bytes=await f.inspect('tasks');noCatalog(bytes,413);assert.match(bytes.json.error,/64 MB/);
 const wide={id:randomUUID(),title:'Synthetic'};for(let i=0;i<12000;i++)wide['syntheticField'+i]='';f.set('tasks',[wide]);const catalog=await f.inspect('tasks');noCatalog(catalog,413);assert.match(catalog.json.error,/1 MB/);
});
