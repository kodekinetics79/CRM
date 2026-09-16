import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installReportingRoutes} from '../server/reporting.js';
// Preserve exact exported whitespace and multiline fields; the import parser
// intentionally trims values and returns keyed records rather than raw CSV rows.
function parseCSV(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=Number(text.startsWith('\uFEFF'));i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell);cell='';}
  else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 assert.equal(quoted,false);row.push(cell);rows.push(row);return rows;
}

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
 async function request(path,{payload,role='staff',tenant='first',csrf=true}={}){const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/custom-reports'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant,...(csrf?{'X-CSRF':'synthetic-csrf'}:{})},body:JSON.stringify(payload)});return {status:response.status,json:await response.json(),headers:response.headers};}
 const run=(payload,options={})=>request('/run',{payload,...options}),exportReport=(review,options={})=>request('/export?fingerprint='+review.sourceFingerprint,{payload:review.definition,...options});
 return {db,set,list,run,exportReport,request,reporter,users,transaction};
}
function documents(f){
 f.db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,collection TEXT,record_id TEXT,title TEXT,category TEXT,visibility TEXT,status TEXT,evidence_date TEXT,archived INTEGER,created_at TEXT,updated_at TEXT,retention_until TEXT);CREATE TABLE document_revisions(document_id TEXT,revision INTEGER,filename TEXT,mime TEXT,bytes BLOB,sha256 TEXT,actor TEXT,at TEXT,metadata TEXT,PRIMARY KEY(document_id,revision))');
 const id=randomUUID(),task=randomUUID();f.set('tasks',[{id:task,title:'Shared task'}]);f.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'tasks',task,'Shared current document','Attachment','Workspace','Draft',null,0,'2026-09-13','2026-09-13',null);
 const insert=f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?)');return {id,add:(revision,visibility='Workspace')=>insert.run(id,revision,visibility==='Workspace'?'shared-'+revision+'.txt':'PRIVATE_NAME.txt','text/plain',Buffer.from('PRIVATE_BYTES'),'1'.repeat(64),f.users.admin.id,'2026-09-13',JSON.stringify({title:visibility==='Workspace'?'Shared revision':'PRIVATE_TITLE',category:'Attachment',status:'Draft',visibility,evidenceDate:null}))};
}
function noFile(response,status){assert.equal(response.status,status,JSON.stringify({error:response.json.error,rowCount:response.json.rowCount,complete:response.json.complete}));assert.equal(response.json.csv,undefined);assert.equal(response.json.complete,undefined);assert.equal(response.json.rowCount,undefined);assert.equal(response.headers.get('content-disposition'),null);}

test('complete HTTP export includes all 301 native records and original long Unicode text beyond display page and cell caps',async t=>{
 const f=await fixture(t),long='warm 🌻, "quoted"\r\n'.repeat(1100),rows=Array.from({length:301},(_,i)=>gift(i,{notes:i===300?long:'ordinary note'}));f.set('gifts',rows);
 const first=await f.run(definition({columns:['id','notes','amount']}));assert.equal(first.status,200);assert.equal(first.json.rows.length,250);assert.equal(first.json.totalResultRows,301);
 const exported=await f.exportReport(first.json);assert.equal(exported.status,200,JSON.stringify(exported.json));const csv=parseCSV(exported.json.csv);assert.equal(csv.length,302);assert.equal(csv[301][1],long);assert.equal(csv[301][2],'100.01');assert.match(csv[0][2],/USD/);assert.equal(new Set(csv.slice(1).map(row=>row[0])).size,301);assert.equal(exported.json.rowCount,301);assert.equal(exported.json.matchedRows,301);assert.equal(exported.json.totalResultRows,301);assert.equal(exported.json.sourceFingerprint,first.json.sourceFingerprint);assert.equal(exported.json.complete,true);assert.equal(exported.json.textTruncated,false);assert.equal(exported.headers.get('cache-control'),'no-store');assert.equal(exported.json.csv[0],'\uFEFF');assert.equal(exported.json.rows,undefined);
 const truncated=await f.run(definition({columns:['notes'],filters:[{field:'externalRef',op:'eq',value:'300'}]}));assert.equal(truncated.json.textTruncated,true);const entire=await f.exportReport(truncated.json);assert.equal(entire.status,200);assert.equal(parseCSV(entire.json.csv)[1][0],long);
});

test('export serialization preserves exact integer cents including safe-range extremes and signed numeric cells',async t=>{
 const f=await fixture(t),amounts=[1,100,101,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER];f.set('gifts',amounts.map((amount,i)=>gift(i,{amount,allocations:[],netChange:-22})));const review=await f.run(definition({columns:['amount','netChange']}));assert.equal(review.status,200);const exported=await f.exportReport(review.json);assert.equal(exported.status,200);assert.deepEqual(parseCSV(exported.json.csv).slice(1),[['0.01','-22'],['1.00','-22'],['1.01','-22'],['90071992547409.91','-22'],['-90071992547409.91','-22']]);assert.equal(exported.json.format.money,'Exact decimal USD from integer cents');
 f.set('gifts',[gift(0,{amount:1.1})]);noFile(await f.request('/export?fingerprint='+review.json.sourceFingerprint,{payload:review.json.definition}),400);
});

test('all text and calculation labels are spreadsheet-safe while structured cells retain only clean allowlisted facts',async t=>{
 const f=await fixture(t),unsafe=['=HYPERLINK("x")','  +SUM(1,2)','\t@SUM(A1)','\u0000-DDE','\nplain','\u00a0=1'],rows=unsafe.map((externalRef,i)=>gift(i,{externalRef,contacts:[{label:'Office',value:'safe',password:'PRIVATE_PASSWORD',nested:{apiKey:'PRIVATE_KEY',note:'retained'}}]}));f.set('gifts',rows);const review=await f.run(definition({columns:['externalRef','contacts','amount']})),exported=await f.exportReport(review.json);assert.equal(exported.status,200,JSON.stringify(exported.json));const csv=parseCSV(exported.json.csv);for(let i=0;i<unsafe.length;i++){assert.equal(csv[i+1][0],"'"+unsafe[i]);assert.equal(csv[i+1][2],'100.01');assert.deepEqual(JSON.parse(csv[i+1][1]),[{label:'Office',value:'safe',nested:{note:'retained'}}]);}assert.doesNotMatch(exported.json.csv,/PRIVATE_PASSWORD|PRIVATE_KEY|password|apiKey/);
 const aggregate=await f.run(definition({columns:['amount'],aggregates:[{op:'sum',field:'amount',label:'  =SUM(1,2)'}]})),file=await f.exportReport(aggregate.json);assert.equal(file.status,200);assert.equal(parseCSV(file.json.csv)[0][0],"'=SUM(1,2) (USD)");assert.equal(parseCSV(file.json.csv)[1][0],'600.06');
});

test('complete grouped and allocation exports compute all matches once without multiplying gift income',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:301},(_,i)=>gift(i)));const grouped=await f.run(definition({columns:['externalRef'],groupBy:['externalRef'],aggregates:[{op:'sum',field:'amount'},{op:'count'}]}));assert.equal(grouped.json.rows.length,250);const file=await f.exportReport(grouped.json);assert.equal(file.status,200);assert.equal(file.json.rowCount,301);assert.equal(file.json.matchedRows,301);const csv=parseCSV(file.json.csv);assert.equal(csv.length,302);assert.equal(csv.slice(1).reduce((n,row)=>n+BigInt(row[1].replace('.','')),0n),3010301n);assert.equal(csv.slice(1).reduce((n,row)=>n+Number(row[2]),0),301);
 const split=await f.run(definition({entity:'giftAllocations',columns:['designationId','allocationAmount'],groupBy:['designationId'],aggregates:[{op:'sum',field:'allocationAmount'},{op:'count'}]})),splitFile=await f.exportReport(split.json);assert.equal(splitFile.status,200);assert.equal(splitFile.json.rowCount,2);assert.equal(splitFile.json.matchedRows,602);assert.deepEqual(parseCSV(splitFile.json.csv).slice(1).map(row=>row.slice(1)),[['18060.00','301'],['12043.01','301']]);
 const detail=await f.run(definition({entity:'giftAllocations',columns:['giftId','allocationAmount']})),detailFile=await f.exportReport(detail.json);assert.equal(detailFile.json.rowCount,602);
 const invalid=gift(0);invalid.allocations[0].amount++;f.set('gifts',[invalid]);noFile(await f.exportReport(split.json),400);
});

test('export requires exact reviewed proof and rejects changed definition, actor role, tenant or any projected source fact',async t=>{
 const f=await fixture(t),rows=Array.from({length:301},(_,i)=>gift(i));f.set('gifts',rows);const review=await f.run(definition({filters:[{field:'externalRef',op:'eq',value:'0'}]}));assert.equal(review.status,200);
 for(const query of ['', '?fingerprint=wrong','?fingerprint='+review.json.sourceFingerprint+'&offset=0','?fingerprint='+review.json.sourceFingerprint+'&fingerprint='+review.json.sourceFingerprint])noFile(await f.request('/export'+query,{payload:review.json.definition}),400);
 noFile(await f.exportReport(review.json,{payload:{...review.json.definition,name:'Other definition'}}),409);
 for(const options of [{role:'viewer'},{role:'admin'},{tenant:'other'}])noFile(await f.exportReport(review.json,options),409);
 rows[300].notes='Changed unmatched and unselected saved fact';f.set('gifts',rows);noFile(await f.exportReport(review.json),409);const fresh=await f.run(review.json.definition);assert.equal((await f.exportReport(fresh.json)).status,200);
 noFile(await f.exportReport(fresh.json,{csrf:false}),403);noFile(await f.exportReport(fresh.json,{role:'event-helper'}),403);noFile(await f.exportReport(fresh.json,{role:'missing'}),401);
});

test('complete export checks every matched historical document reference and excludes private original revisions',async t=>{
 const f=await fixture(t),d=documents(f);f.transaction(()=>{for(let i=1;i<=301;i++)d.add(i);d.add(302,'Administrators');});const review=await f.run(definition({entity:'documentRevisions',columns:['revision','filename']}));assert.equal(review.json.matchedRows,301);const file=await f.exportReport(review.json);assert.equal(file.status,200);assert.equal(file.json.documentRevisionPrivacy,1);assert.equal(file.json.documentRevisionSources.length,301);assert.equal(file.json.documentRevisionSources.at(-1).revision,301);assert.equal(parseCSV(file.json.csv).length,302);assert.doesNotMatch(JSON.stringify(file.json),/PRIVATE_BYTES|PRIVATE_TITLE|PRIVATE_NAME/);
 f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=301').run(JSON.stringify({visibility:'Administrators'}));noFile(await f.exportReport(review.json),409);const current=await f.run(review.json.definition);const fresh=await f.exportReport(current.json);assert.equal(fresh.status,200);assert.equal(fresh.json.rowCount,300);assert.equal(fresh.json.documentRevisionSources.some(ref=>ref.revision===301),false);
 f.db.prepare('UPDATE documents SET visibility=? WHERE id=?').run('Administrators',d.id);noFile(await f.exportReport(current.json),409);const admin=await f.run(review.json.definition,{role:'admin'});const adminFile=await f.exportReport(admin.json,{role:'admin'});assert.equal(adminFile.status,200);assert.equal(adminFile.json.rowCount,302);assert.equal(adminFile.json.requiredRole,'admin');
});

test('complete export preserves all-matched financial correction privacy provenance and requires current native gift visibility',async t=>{
 const f=await fixture(t),g=gift(0);f.set('gifts',[g]);f.db.exec('CREATE TABLE gift_financial_corrections(id TEXT PRIMARY KEY,gift_id TEXT,from_version INTEGER,to_version INTEGER,changed_fields TEXT,reason TEXT,actor_json TEXT,at TEXT,before_json TEXT,after_json TEXT,before_references TEXT,after_references TEXT)');const insert=f.db.prepare('INSERT INTO gift_financial_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');f.transaction(()=>{for(let i=0;i<301;i++)insert.run(randomUUID(),g.id,i+1,i+2,'["amount"]','Retained correction',JSON.stringify(f.users.admin),'2026-09-13',JSON.stringify({...g,amount:10000,allocations:[{designationId:fundA,amount:6000},{designationId:fundB,amount:4000}]}),JSON.stringify(g),'[]','[]');});
 const review=await f.run(definition({entity:'giftFinancialCorrections',columns:['beforeAmountCents','afterAmountCents','reason']}));assert.equal(review.status,200,JSON.stringify(review.json));const file=await f.exportReport(review.json);assert.equal(file.status,200,JSON.stringify(file.json));assert.equal(file.json.rowCount,301);assert.equal(file.json.giftCorrectionSources.length,301);assert.equal(file.json.giftCorrectionPrivacy,1);assert.equal(parseCSV(file.json.csv)[1][0],'100.00');f.set('gifts',[]);noFile(await f.exportReport(review.json),409);
});

test('zero matches return header-only detail CSV or one exact aggregate row with distinct source and result counts',async t=>{
 const f=await fixture(t);f.set('gifts',[gift(0)]);const filter=[{field:'externalRef',op:'eq',value:'never'}];const detail=await f.run(definition({filters:filter})),file=await f.exportReport(detail.json);assert.equal(file.status,200);assert.equal(file.json.rowCount,0);assert.equal(file.json.matchedRows,0);assert.equal(file.json.totalResultRows,0);assert.equal(file.json.csv.split('\r\n').length,1);assert.equal(file.json.complete,true);
 const aggregate=await f.run(definition({filters:filter,aggregates:[{op:'sum',field:'amount'},{op:'count'}]})),totals=await f.exportReport(aggregate.json);assert.equal(totals.status,200);assert.equal(totals.json.rowCount,1);assert.equal(totals.json.matchedRows,0);assert.deepEqual(parseCSV(totals.json.csv)[1],['0.00','0']);
});

test('8 MB CSV and 12 MB envelope limits fail closed without downloadable partial rows or incomplete provenance',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:9},(_,i)=>gift(i,{notes:'x'.repeat(900000)})));const review=await f.run(definition({columns:['notes']}));assert.equal(review.status,200);noFile(await f.exportReport(review.json),413);
 // Raw encoded source rows fit 12 MB and CSV is under 8 MB, but JSON escaping
 // expands the CSV envelope beyond 12 MB. Every field remains original or fails.
 f.set('gifts',Array.from({length:7},(_,i)=>gift(i,{notes:'\\'.repeat(857100)})));const escaped=await f.run(definition({columns:['notes']}));assert.equal(escaped.status,200);const overflow=await f.exportReport(escaped.json);noFile(overflow,413);assert.match(overflow.json.error,/12 MB/);
});

test('selected-source 100k row and 64 MB facts limits apply before filters, and administrator sources remain private',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:100001},(_,i)=>gift(i)));const oversized=await f.request('/export?fingerprint='+'0'.repeat(64),{payload:definition({filters:[{field:'externalRef',op:'eq',value:'no match'}]})});noFile(oversized,413);assert.match(oversized.json.error,/100,000/);
 f.set('gifts',Array.from({length:8},(_,i)=>gift(i,{notes:'x'.repeat(8000001)})));const bytes=await f.request('/export?fingerprint='+'0'.repeat(64),{payload:definition({columns:['id'],filters:[{field:'externalRef',op:'eq',value:'no match'}]})});noFile(bytes,413);assert.match(bytes.json.error,/64 MB/);
 const protectedSource=await f.run(definition({entity:'workspaceUsers',columns:['name']}),{role:'admin'});assert.equal(protectedSource.status,200);noFile(await f.exportReport(protectedSource.json,{role:'staff'}),403);assert.equal((await f.exportReport(protectedSource.json,{role:'admin'})).status,200);
});
