import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installReportingRoutes} from '../server/reporting.js';
import {install as installReportPacks} from '../server/reportPacks.js';
import {unzip,sheetCells,readPdf,readRtf} from './typed-export-readers.js';

const donor='11111111-1111-4111-8111-111111111111',business='22222222-2222-4222-8222-222222222222',teacher='33333333-3333-4333-8333-333333333333';
const stem='44444444-4444-4444-8444-444444444444',pantry='55555555-5555-4555-8555-555555555555';
const north='66666666-6666-4666-8666-666666666666',south='77777777-7777-4777-8777-777777777777';
const roles=['admin','staff','viewer','event-helper'];
const userId=role=>'00000000-0000-4000-8000-00000000000'+(roles.indexOf(role)+1);
const gift=(patch={})=>({id:randomUUID(),version:1,constituentId:donor,campaignId:north,amount:10001,date:'2026-03-04',type:'Cash',method:'Check',status:'Posted',giftKind:'One-time',externalRef:'r',allocations:[{designationId:stem,amount:6000},{designationId:pantry,amount:4001}],...patch});
const whole=(amount,patch={})=>gift({amount,allocations:[{designationId:patch.designationId||stem,amount}],...patch});

async function fixture(t,{file=':memory:',seed=true}={}){
 const db=new DatabaseSync(file),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 db.exec('CREATE TABLE IF NOT EXISTS records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id));CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');
 const users=Object.fromEntries(roles.map(role=>[role,{id:userId(role),name:'Synthetic '+role,role,active:1}]));
 for(const user of Object.values(users))db.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?,?,1,1)').run(user.id,user.name,user.role+'@example.test',user.role);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const set=(collection,rows,tenant='first')=>transaction(()=>{db.prepare('DELETE FROM records WHERE tenant=? AND collection=?').run(tenant,collection);const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?)');for(const row of rows)insert.run(tenant,collection,row.id,JSON.stringify(row));});
 const list=(collection,req)=>db.prepare('SELECT data FROM records WHERE tenant=? AND collection=? ORDER BY rowid').all(req?.tenantId||'first',collection).map(row=>JSON.parse(row.data));
 if(seed)for(const tenant of ['first','second']){
  set('constituents',[{id:donor,name:'Ada Donor'},{id:business,name:'Bay Hardware'},{id:teacher,name:'Cy Teacher'}],tenant);
  set('designations',[{id:stem,name:'STEM lab',school:'North elementary',accountCode:'100-2000'},{id:pantry,name:'Food pantry',school:'South middle',accountCode:'200-3000'}],tenant);
  set('campaigns',[{id:north,name:'Annual fund'},{id:south,name:'Capital drive'}],tenant);
 }
 const app=express();app.use(express.json({limit:'4mb'}));
 app.use((req,res,next)=>{req.user=users[req.get('X-Role')||'staff'];req.tenantId=req.get('X-Tenant')||'first';next();});
 const csrf=(req,res,next)=>req.get('X-CSRF')==='synthetic-csrf'?next():res.status(403).json({error:'CSRF validation required'});
 const write=(req,res,next)=>['admin','staff'].includes(req.user?.role)?next():res.status(403).json({error:'Readonly'});
 const audits=[],audit=(user,action,collection,record,details)=>audits.push({actor:user?.id??null,action,collection,record,details});
 const reporting=installReportingRoutes(app,{db,collections,list,csrf,write,audit,transaction});
 const packs=installReportPacks(app,{db,list,audit,csrf,write,transaction,collections,services:{reporting}});
 app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const call=async(path,{method='POST',payload,role='staff',tenant='first',csrf=true}={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant,...(csrf?{'X-CSRF':'synthetic-csrf'}:{})},...(method==='GET'?{}:{body:JSON.stringify(payload??{})})});
  return {status:response.status,json:await response.json(),headers:response.headers};
 };
 return {db,set,list,audits,packs,users,transaction,
  catalog:(options={})=>call('/api/report-packs',{method:'GET',...options}),
  run:(payload={},options={})=>call('/api/report-packs/board/run',{payload,...options}),
  save:(assembled,format,options={})=>call('/api/report-packs/board/export',{payload:{...(assembled.range||{}),format,fingerprint:assembled.sourceFingerprint},...options})};
}
const section=(pack,id)=>pack.sections.find(entry=>entry.id===id);
const bytes=response=>Buffer.from(response.json.file,'base64');
function noFile(response,status){
 assert.equal(response.status,status,JSON.stringify({error:response.json.error,bytes:response.json.fileBytes}));
 for(const key of ['file','fileBytes','sha256','complete','rowCount','sections','totals'])assert.equal(response.json[key],undefined,'a refusal returns no '+key);
}
function seedMixedGiving(f,tenant='first'){
 const rows=[
  whole(250000,{constituentId:donor,campaignId:north,date:'2025-09-12',designationId:stem}),
  whole(50000,{constituentId:donor,campaignId:north,date:'2026-07-15',designationId:pantry}),
  whole(200000,{constituentId:business,campaignId:south,date:'2026-08-20',type:'In-kind',method:'In-kind',designationId:stem}),
  whole(12500,{constituentId:teacher,campaignId:north,date:'2026-01-05',type:'Employee giving',method:'Payroll',designationId:pantry}),
  whole(1,{constituentId:teacher,campaignId:south,date:'2026-02-06',type:'Cash',method:'In-kind',designationId:stem}),
  whole(99999,{constituentId:business,campaignId:null,date:'2026-03-07',designationId:pantry}),
  whole(400000,{constituentId:donor,campaignId:north,date:'2026-09-01',status:'Voided',designationId:stem})
 ];
 f.set('gifts',rows,tenant);
 return rows;
}
const POSTED=250000+50000+200000+12500+1+99999;

test('a board pack assembles the named drilldowns and reconciles every one to the standard totals',async t=>{
 const f=await fixture(t);seedMixedGiving(f);
 const catalog=await f.catalog();assert.equal(catalog.status,200);
 assert.deepEqual(catalog.json.packs[0].sections.map(entry=>entry.id),['totals','campaign','support','location','program','donor']);
 const response=await f.run();assert.equal(response.status,200,JSON.stringify(response.json));
 const pack=response.json;
 assert.equal(pack.totals.totalCents,POSTED,'a voided gift is excluded from every board total');
 assert.equal(pack.totals.giftCount,6);
 assert.equal(pack.totals.donorCount,3);
 assert.equal(pack.totals.firstGiftDate,'2025-09-12');
 assert.equal(pack.totals.lastGiftDate,'2026-08-20');
 assert.equal(pack.totals.smallestGiftCents,1);
 assert.equal(pack.totals.largestGiftCents,250000);
 assert.deepEqual(section(pack,'campaign').rows,[['Annual fund',312500,3],['Capital drive',200001,2],[null,99999,1]]);
 // No account structure exists in this workspace, so every location row falls
 // back to the designation school field and says so. The figures are unchanged.
 assert.deepEqual(section(pack,'location').rows,[['North elementary','Designation school field',450001,3,1],['South middle','Designation school field',162499,3,1]]);
 assert.equal(pack.accountStructure.available,false);
 assert.equal(pack.totals.accountLocationCents,0);
 assert.equal(pack.totals.designationSchoolCents,POSTED);
 assert.equal(pack.totals.locationUnrecordedCents,0);
 assert.deepEqual(section(pack,'program').rows,[['STEM lab',450001,3],['Food pantry',162499,3]]);
 // In-kind is a recorded type or method, not a gift kind; the classification is
 // stated on the section and the two forms add back to the same saved cents.
 assert.deepEqual(section(pack,'support').rows,[['Ada Donor','Monetary support',300000,2],['Bay Hardware','In-kind support',200000,1],['Bay Hardware','Monetary support',99999,1],['Cy Teacher','Monetary support',12500,1],['Cy Teacher','In-kind support',1,1]]);
 assert.equal(pack.totals.inKindCents+pack.totals.monetaryCents,POSTED);
 assert.deepEqual(section(pack,'donor').rows,[['Ada Donor','2025-09-12','2026-07-15',300000,2],['Bay Hardware','2026-03-07','2026-08-20',299999,2],['Cy Teacher','2026-01-05','2026-02-06',12501,2]]);
 for(const id of ['campaign','program'])assert.equal(section(pack,id).rows.reduce((sum,row)=>sum+BigInt(row[1]),0n),BigInt(POSTED),id+' sums the same saved cents once');
 assert.equal(section(pack,'location').rows.reduce((sum,row)=>sum+BigInt(row[2]),0n),BigInt(POSTED),'location sums the same saved cents once');
 assert.match(pack.scope,/not an audited financial statement/);
 assert.equal(response.headers.get('cache-control'),'no-store');
});

test('the pack period filters every section consistently and keeps first and last gift dates inside it',async t=>{
 const f=await fixture(t);seedMixedGiving(f);
 const response=await f.run({startDate:'2026-01-01',endDate:'2026-06-30'});
 assert.equal(response.status,200,JSON.stringify(response.json));
 const pack=response.json;
 assert.equal(pack.totals.totalCents,12500+1+99999);
 assert.equal(pack.totals.giftCount,3);
 assert.equal(pack.totals.firstGiftDate,'2026-01-05');
 assert.equal(pack.totals.lastGiftDate,'2026-03-07');
 assert.deepEqual(pack.range,{startDate:'2026-01-01',endDate:'2026-06-30'});
 for(const body of [{startDate:'not-a-date'},{startDate:'2026-02-31'},{startDate:'2026-06-30',endDate:'2026-01-01'},{unexpected:'x'},{startDate:['2026-01-01']}]){
  const refused=await f.run(body);assert.equal(refused.status,400,JSON.stringify(refused.json));assert.equal(refused.json.sections,undefined);
 }
});

test('reporting roles assemble and export a pack; other roles and missing proof get nothing',async t=>{
 const f=await fixture(t);seedMixedGiving(f);
 for(const role of ['admin','staff','viewer']){
  const pack=await f.run({},{role});assert.equal(pack.status,200,role+' may assemble');
  assert.equal((await f.save(pack.json,'xlsx',{role})).status,200,role+' may export');
 }
 noFile(await f.run({},{role:'event-helper'}),403);
 noFile(await f.run({},{role:'missing'}),401);
 noFile(await f.run({},{csrf:false}),403);
 assert.equal((await f.catalog({role:'event-helper'})).status,403);
 const pack=await f.run();
 noFile(await f.save(pack.json,'xlsx',{role:'event-helper'}),403);
 noFile(await f.save(pack.json,'xlsx',{csrf:false}),403);
 noFile(await f.save(pack.json,'docx'),400);
 noFile(await f.save({sourceFingerprint:'short'},'xlsx'),400);
 noFile(await f.save({},'xlsx'),400);
});

test('a pack is pinned to its own tenant, actor role and sources, and a changed gift refuses the export whole',async t=>{
 const f=await fixture(t);seedMixedGiving(f,'first');
 const other=[whole(700,{constituentId:donor,campaignId:north,date:'2026-04-04',designationId:stem})];
 f.set('gifts',other,'second');
 const first=await f.run(),second=await f.run({},{tenant:'second'});
 assert.equal(first.json.totals.totalCents,POSTED);
 assert.equal(second.json.totals.totalCents,700);
 assert.notEqual(first.json.sourceFingerprint,second.json.sourceFingerprint);
 noFile(await f.save(first.json,'xlsx',{tenant:'second'}),409);
 noFile(await f.save(first.json,'xlsx',{role:'admin'}),409);
 noFile(await f.save(first.json,'xlsx',{payload:{format:'xlsx',fingerprint:first.json.sourceFingerprint,startDate:'2026-01-01'}}),409);
 assert.equal((await f.save(first.json,'xlsx')).status,200);
 const changed=seedMixedGiving(f,'first');changed[0].notes='Corrected after the pack was assembled';f.set('gifts',changed,'first');
 for(const format of ['xlsx','pdf','rtf'])noFile(await f.save(first.json,format),409);
 const fresh=await f.run();
 for(const format of ['xlsx','pdf','rtf'])assert.equal((await f.save(fresh.json,format)).status,200,format+' exports from a fresh assembly');
});

test('exported pack files carry every section, exact integer cents and the proof the pack was pinned to',async t=>{
 const f=await fixture(t);seedMixedGiving(f);
 const pack=await f.run();
 const workbook=await f.save(pack.json,'xlsx');assert.equal(workbook.status,200,JSON.stringify(workbook.json));
 const files=unzip(bytes(workbook));
 assert.equal([...files.keys()].filter(name=>name.startsWith('xl/worksheets/')).length,7,'a totals sheet plus one sheet per section');
 const names=files.get('xl/workbook.xml').toString().match(/name="[^"]+"/g);
 assert.deepEqual(names,['name="Totals"','name="Standard totals"','name="Giving by campaign"','name="In-kind and monetary support by"','name="Giving by school location"','name="Giving by program"','name="Donor first and last gift"']);
 const location=sheetCells(files.get('xl/worksheets/sheet5.xml').toString());
 assert.deepEqual(location.slice(1).map(row=>[row.cells[0].raw,row.cells[1].raw,row.cells[2].raw,row.cells[2].type,row.cells[2].style,row.cells[3].raw]),[['North elementary','Designation school field','4500.01','n','2','3'],['South middle','Designation school field','1624.99','n','2','3']]);
 assert.equal(location.slice(1).reduce((sum,row)=>sum+BigInt(row.cells[2].raw.replace('.','')),0n),BigInt(POSTED));
 const donors=sheetCells(files.get('xl/worksheets/sheet7.xml').toString());
 assert.deepEqual(donors[1].cells.map(cell=>[cell.type,cell.raw,cell.style]),[['inlineStr','Ada Donor',null],['n','45912','3'],['n','46218','3'],['n','3000.00','2'],['n','2',null]]);
 assert.equal(workbook.json.sections.length,6);
 assert.equal(workbook.json.sourceFingerprint,pack.json.sourceFingerprint);
 assert.equal(workbook.json.totals.totalCents,POSTED);
 assert.equal(workbook.json.filename,'wimblo-Board-reporting-pack.xlsx');
 const pdf=readPdf(bytes(await f.save(pack.json,'pdf')));
 assert.ok(pdf.text.includes(pack.json.sourceFingerprint),'the PDF carries the pack fingerprint');
 assert.ok(pdf.text.includes(userId('staff')+' (staff)'),'the PDF carries the acting user and role');
 assert.match(pdf.text,/North elementary/);assert.match(pdf.text,/4500\.01/);assert.match(pdf.text,/Donor first and last gift/);
 const rtf=readRtf(bytes(await f.save(pack.json,'rtf')));
 assert.match(rtf.plain,/Bay Hardware/);assert.match(rtf.plain,/In-kind support/);
 assert.match(rtf.plain,/2000\.00/);
});

test('rows beyond the displayed page are exported in full and the pack says its display was capped',async t=>{
 const f=await fixture(t);
 const people=Array.from({length:140},(_,i)=>({id:'aaaaaaaa-0000-4000-8000-'+String(i).padStart(12,'0'),name:'Donor '+String(i).padStart(3,'0')}));
 f.set('constituents',people);
 f.set('gifts',people.map((person,i)=>whole(1000+i,{constituentId:person.id,campaignId:north,date:'2026-0'+(1+i%9)+'-0'+(1+i%9),designationId:i%2?stem:pantry})));
 const pack=await f.run();assert.equal(pack.status,200);
 const donors=section(pack.json,'donor');
 assert.equal(donors.rowCount,140);
 assert.equal(donors.rows.length,100);
 assert.equal(donors.displayedRows,100);
 assert.equal(donors.truncated,true);
 assert.equal(pack.json.displayRowLimit,100);
 const workbook=await f.save(pack.json,'xlsx');assert.equal(workbook.status,200);
 const rows=sheetCells(unzip(bytes(workbook)).get('xl/worksheets/sheet7.xml').toString());
 assert.equal(rows.length,141,'every donor beyond the displayed page is in the file');
 const total=rows.slice(1).reduce((sum,row)=>sum+BigInt(row.cells[3].raw.replace('.','')),0n);
 assert.equal(total,BigInt(people.reduce((sum,person,i)=>sum+1000+i,0)));
 assert.equal(workbook.json.totals.donorCount,140);
 // 10 totals rows (including the three location-source coverage figures), 1
 // standard-total row, 1 campaign, 140 support, 2 location, 2 program and 140
 // donor rows, each of the seven tables carrying its own header row.
 assert.equal(readRtf(bytes(await f.save(pack.json,'rtf'))).rows,10+1+1+140+2+2+140+7,'every section row reaches the RTF tables');
});

test('an assembled pack survives a restart because it is derived from saved records only',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'wimblo-board-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const file=join(directory,'workspace.db');
 const before=await fixture(t,{file});seedMixedGiving(before);
 const first=await before.run();assert.equal(first.status,200);
 const exported=await before.save(first.json,'xlsx');assert.equal(exported.status,200);
 const after=await fixture(t,{file,seed:false});
 const second=await after.run();assert.equal(second.status,200);
 assert.equal(second.json.sourceFingerprint,first.json.sourceFingerprint,'the same saved records assemble the same pinned pack');
 assert.deepEqual(second.json.totals,first.json.totals);
 const again=await after.save(second.json,'xlsx');assert.equal(again.status,200);
 assert.equal(again.json.sha256,exported.json.sha256,'identical saved facts produce an identical file');
});

test('a source that cannot be reconciled refuses the whole pack and retains no audit or partial file',async t=>{
 const f=await fixture(t);seedMixedGiving(f);
 assert.equal((await f.run()).status,200);
 const broken=seedMixedGiving(f);broken[0].allocations=[{designationId:stem,amount:broken[0].amount+1}];f.set('gifts',broken);
 const refused=await f.run();
 assert.equal(refused.status,400,JSON.stringify(refused.json));
 assert.match(refused.json.error,/allocations do not reconcile/);
 assert.equal(refused.json.sections,undefined);
 const repaired=seedMixedGiving(f);f.set('gifts',repaired);
 const pack=await f.run();assert.equal(pack.status,200);
 const before=f.audits.length;
 noFile(await f.save(pack.json,'xlsx',{tenant:'second'}),409);
 assert.equal(f.audits.length,before,'a refused export retains no audit entry');
 const saved=await f.save(pack.json,'xlsx');assert.equal(saved.status,200);
 const entry=f.audits.at(-1);
 assert.equal(entry.action,'export');assert.equal(entry.collection,'reportPacks');assert.equal(entry.record,'board');
 assert.equal(entry.actor,userId('staff'));
 assert.equal(entry.details.fingerprint,pack.json.sourceFingerprint);
 assert.equal(entry.details.sha256,saved.json.sha256);
 assert.equal(entry.details.format,'xlsx');
 assert.equal(entry.details.fileBytes,bytes(saved).length);
});

test('an oversized pack is refused whole at its export limit and an empty pack is still a valid file',async t=>{
 const f=await fixture(t);
 const people=Array.from({length:2000},(_,i)=>({id:'bbbbbbbb-0000-4000-8000-'+String(i).padStart(12,'0'),name:'Donor '+String(i).padStart(4,'0')+' '+'n'.repeat(2100)}));
 f.set('constituents',people);
 f.set('gifts',people.map((person,i)=>whole(100+i,{constituentId:person.id,campaignId:north,date:'2026-05-05',designationId:stem})));
 const pack=await f.run();assert.equal(pack.status,200,JSON.stringify(pack.json).slice(0,300));
 const refused=await f.save(pack.json,'rtf');noFile(refused,413);
 assert.match(refused.json.error,/8 MB/);
 assert.match(refused.json.error,/no partial export was generated/);
 assert.equal((await f.save(pack.json,'xlsx')).status,200,'the same facts still fit a compressed workbook');
 f.set('gifts',[]);
 const empty=await f.run();assert.equal(empty.status,200);
 assert.equal(empty.json.totals.totalCents,0);
 assert.equal(empty.json.totals.giftCount,0);
 assert.equal(empty.json.totals.donorCount,0);
 assert.equal(empty.json.totals.firstGiftDate,null);
 assert.equal(section(empty.json,'donor').rowCount,0);
 const workbook=await f.save(empty.json,'xlsx');assert.equal(workbook.status,200);
 assert.equal(sheetCells(unzip(bytes(workbook)).get('xl/worksheets/sheet7.xml').toString()).length,1);
 assert.match(readPdf(bytes(await f.save(empty.json,'pdf'))).text,/No matching rows\./);
});
