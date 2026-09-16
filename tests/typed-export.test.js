import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {installReportingRoutes} from '../server/reporting.js';
import {unzip,sheetCells,unescapeXml,readPdf,readRtf} from './typed-export-readers.js';

const donor=randomUUID(),other=randomUUID(),fundA=randomUUID(),fundB=randomUUID(),campaign=randomUUID();
const definition=patch=>({name:'Board reviewed facts',entity:'gifts',columns:['id','externalRef','amount'],...patch});
const gift=(n,patch={})=>({id:randomUUID(),version:1,constituentId:donor,campaignId:campaign,amount:10001,date:'2026-09-13',type:'Cash',method:'Check',status:'Posted',externalRef:String(n),allocations:[{designationId:fundA,amount:6000},{designationId:fundB,amount:4001}],...patch});
async function fixture(t){
 const db=new DatabaseSync(':memory:'),collections=['constituents','gifts','designations','campaigns','tasks','events','grants','pledges'];
 db.exec('CREATE TABLE records(tenant TEXT,collection TEXT,id TEXT,data TEXT,PRIMARY KEY(tenant,collection,id));CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');
 const users=Object.fromEntries(['admin','staff','viewer','event-helper'].map(role=>[role,{id:randomUUID(),name:'Synthetic '+role,role,active:1}]));
 for(const u of Object.values(users))db.prepare('INSERT INTO users VALUES(?,?,?,?,1,1)').run(u.id,u.name,u.role+'@example.test',u.role);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const set=(collection,rows,tenant='first')=>transaction(()=>{db.prepare('DELETE FROM records WHERE tenant=? AND collection=?').run(tenant,collection);const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?)');for(const row of rows)insert.run(tenant,collection,row.id,JSON.stringify(row));});
 const list=(collection,req)=>db.prepare('SELECT data FROM records WHERE tenant=? AND collection=? ORDER BY rowid').all(req?.tenantId||'first',collection).map(row=>JSON.parse(row.data));
 set('constituents',[{id:donor,name:'Synthetic donor'},{id:other,name:'Second donor'}]);set('designations',[{id:fundA,name:'First fund',school:'North school'},{id:fundB,name:'Second fund',school:'South school'}]);set('campaigns',[{id:campaign,name:'Synthetic campaign'}]);
 const app=express();app.use(express.json({limit:'1mb'}));app.use((req,res,next)=>{req.user=users[req.get('X-Role')||'staff'];req.tenantId=req.get('X-Tenant')||'first';next();});
 const csrf=(req,res,next)=>req.get('X-CSRF')==='synthetic-csrf'?next():res.status(403).json({error:'CSRF validation required'}),write=(req,res,next)=>['admin','staff'].includes(req.user?.role)?next():res.status(403).json({error:'Readonly'});
 const reporter=installReportingRoutes(app,{db,collections,list,csrf,write,audit:()=>{},transaction});app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 async function request(path,{payload,role='staff',tenant='first',csrf=true}={}){
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/custom-reports'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant,...(csrf?{'X-CSRF':'synthetic-csrf'}:{})},body:JSON.stringify(payload)});
  return {status:response.status,json:await response.json(),headers:response.headers};
 }
 const run=(payload,options={})=>request('/run',{payload,...options});
 const typed=(review,format,options={})=>request('/export/'+format+'?fingerprint='+review.sourceFingerprint,{payload:review.definition,...options});
 return {db,set,list,run,typed,request,reporter,users,transaction};
}
function noFile(response,status){
 assert.equal(response.status,status,JSON.stringify({error:response.json.error,bytes:response.json.fileBytes}));
 for(const key of ['file','fileBytes','sha256','complete','rowCount','csv'])assert.equal(response.json[key],undefined,'no '+key+' is returned with a refusal');
}
const bytes=response=>Buffer.from(response.json.file,'base64');
function documents(f){
 f.db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,collection TEXT,record_id TEXT,title TEXT,category TEXT,visibility TEXT,status TEXT,evidence_date TEXT,archived INTEGER,created_at TEXT,updated_at TEXT,retention_until TEXT);CREATE TABLE document_revisions(document_id TEXT,revision INTEGER,filename TEXT,mime TEXT,bytes BLOB,sha256 TEXT,actor TEXT,at TEXT,metadata TEXT,PRIMARY KEY(document_id,revision))');
 const id=randomUUID(),task=randomUUID();f.set('tasks',[{id:task,title:'Shared task'}]);
 f.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'tasks',task,'Shared current document','Attachment','Workspace','Draft',null,0,'2026-09-13','2026-09-13',null);
 const insert=f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?)');
 return {id,add:(revision,visibility='Workspace')=>insert.run(id,revision,visibility==='Workspace'?'shared-'+revision+'.txt':'PRIVATE_NAME.txt','text/plain',Buffer.from('PRIVATE_BYTES'),'1'.repeat(64),f.users.admin.id,'2026-09-13',JSON.stringify({title:visibility==='Workspace'?'Shared revision':'PRIVATE_TITLE',category:'Attachment',status:'Draft',visibility,evidenceDate:null}))};
}

test('workbook is a structurally valid Office Open XML package whose declared parts all resolve',async t=>{
 const f=await fixture(t);f.set('gifts',[gift(0),gift(1,{constituentId:other})]);
 const review=await f.run(definition({columns:['date','donorName','amount']}));assert.equal(review.status,200);
 const exported=await f.typed(review.json,'xlsx');assert.equal(exported.status,200,JSON.stringify(exported.json));
 const files=unzip(bytes(exported));
 assert.deepEqual([...files.keys()],['[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/_rels/workbook.xml.rels','xl/styles.xml','xl/worksheets/sheet1.xml']);
 const types=files.get('[Content_Types].xml').toString(),workbook=files.get('xl/workbook.xml').toString(),rels=files.get('xl/_rels/workbook.xml.rels').toString();
 for(const [,part] of types.matchAll(/PartName="\/([^"]+)"/g))assert.ok(files.has(part),'declared content type part '+part+' exists');
 for(const [,target] of rels.matchAll(/Target="([^"]+)"/g))assert.ok(files.has('xl/'+target),'workbook relationship target '+target+' exists');
 for(const [,id] of workbook.matchAll(/r:id="([^"]+)"/g))assert.ok(rels.includes('Id="'+id+'"'),'sheet relationship '+id+' is declared');
 assert.match(files.get('_rels/.rels').toString(),/Target="xl\/workbook.xml"/);
 assert.match(files.get('xl/styles.xml').toString(),/<numFmt numFmtId="164"/);
 assert.equal(exported.json.format.mime,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 assert.equal(exported.json.filename,'wimblo-Board-reviewed-facts.xlsx');
 assert.equal(exported.json.fileBytes,bytes(exported).length);
 assert.equal(exported.headers.get('cache-control'),'no-store');
 assert.match(exported.json.format.verified,/not verified here/);
});

test('workbook cells carry real types: money as exact cent-derived numbers, dates as date serials, text as inline strings',async t=>{
 const f=await fixture(t);
 f.set('gifts',[gift(0,{amount:1,date:'2026-09-13'}),gift(1,{amount:Number.MAX_SAFE_INTEGER,date:'1899-01-02',allocations:[]}),gift(2,{amount:-Number.MAX_SAFE_INTEGER,date:'2000-02-29',allocations:[],notes:'plain text'})]);
 const review=await f.run(definition({columns:['date','notes','amount','allocationCount']}));assert.equal(review.status,200,JSON.stringify(review.json));
 const exported=await f.typed(review.json,'xlsx');assert.equal(exported.status,200,JSON.stringify(exported.json));
 const rows=sheetCells(unzip(exported.json.file?bytes(exported):null).get('xl/worksheets/sheet1.xml').toString());
 assert.equal(rows.length,4);
 assert.deepEqual(rows[0].cells.map(c=>[c.type,unescapeXml(c.raw)]),[['inlineStr','Date'],['inlineStr','Notes'],['inlineStr','Amount (USD)'],['inlineStr','Allocation count']]);
 const money=rows.map(row=>row.cells.find(cell=>cell.reference.startsWith('C')));
 assert.deepEqual(money.slice(1).map(cell=>[cell.type,cell.raw,cell.style]),[['n','0.01','2'],['n','90071992547409.91','2'],['n','-90071992547409.91','2']]);
 for(const cell of money.slice(1))assert.equal(cell.formula,false,'a value cell never becomes a formula');
 // 2026-09-13 is serial 46278; 2000-02-29 is 36585. A pre-1900 date cannot be
 // represented without the spreadsheet leap-year defect, so it stays text.
 assert.deepEqual(rows.slice(1).map(row=>[row.cells[0].type,row.cells[0].raw,row.cells[0].style]),[['n','46278','3'],['inlineStr','1899-01-02',null],['n','36585','3']]);
 assert.deepEqual(rows.slice(1).map(row=>row.cells.find(cell=>cell.reference.startsWith('D'))).map(cell=>[cell.type,cell.raw]),[['n','2',null],['n','0',null],['n','0',null]].map(([type,raw])=>[type,raw]));
 assert.equal(rows[3].cells[1].type,'inlineStr');assert.equal(rows[3].cells[1].raw,'plain text');
 assert.equal(BigInt(money[1].raw.replace('.','')),1n);
 assert.equal(BigInt(money[2].raw.replace('.','')),BigInt(Number.MAX_SAFE_INTEGER));
});

test('typed workbook keeps the spreadsheet formula guard and encodes text XML cannot carry, while PDF and RTF stay literal',async t=>{
 const f=await fixture(t);
 const unsafe=['=HYPERLINK("x")','  +SUM(1,2)','\t@SUM(A1)','-DDE'];
 f.set('gifts',unsafe.map((externalRef,i)=>gift(i,{externalRef})).concat([gift(9,{externalRef:'carriage\rreturn & <angle> _x0041_ ok'})]));
 const review=await f.run(definition({columns:['externalRef','amount']}));
 const workbook=await f.typed(review.json,'xlsx');assert.equal(workbook.status,200,JSON.stringify(workbook.json));
 const cells=sheetCells(unzip(bytes(workbook)).get('xl/worksheets/sheet1.xml').toString()).slice(1).map(row=>row.cells[0].raw);
 for(let i=0;i<unsafe.length;i++)assert.equal(unescapeXml(cells[i]),"'"+unsafe[i],'workbook text keeps the leading quote guard');
 assert.match(cells[4],/_x000D_/,'a carriage return uses the spreadsheet escape rather than breaking the XML');
 assert.match(cells[4],/&amp;/);assert.match(cells[4],/&lt;angle&gt;/);
 assert.match(cells[4],/_x005F_x0041_/,'a literal escape prefix in saved text cannot invent a control character');
 assert.equal(workbook.json.format.formulaProtected,true);
 const pdf=await f.typed(review.json,'pdf'),rtf=await f.typed(review.json,'rtf');
 assert.equal(pdf.status,200);assert.equal(rtf.status,200);
 assert.match(readPdf(bytes(pdf)).text,/=HYPERLINK/);
 assert.match(readRtf(bytes(rtf)).plain,/=HYPERLINK/);
 assert.equal(pdf.json.format.formulaProtected,false);assert.equal(rtf.json.format.formulaProtected,false);
});

test('PDF is a valid document with resolvable objects and the complete reviewed rows and provenance',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:120},(_,i)=>gift(i)));
 const review=await f.run(definition({columns:['externalRef','amount']}));assert.equal(review.json.rows.length,120);
 const exported=await f.typed(review.json,'pdf');assert.equal(exported.status,200,JSON.stringify(exported.json));
 const pdf=readPdf(bytes(exported));
 assert.ok(pdf.pageCount>=2,'long reports paginate');
 assert.match(pdf.text,/Board reviewed facts/);
 assert.match(pdf.text,/Source fingerprint/);
 assert.ok(pdf.text.includes(review.json.sourceFingerprint),'the exported PDF carries its source proof');
 assert.ok(pdf.text.includes(f.users.staff.id+' (staff)'),'the exported PDF carries the acting user and role');
 assert.match(pdf.text,/Exact decimal USD derived from saved integer cents/);
 assert.match(pdf.text,/100\.01/);
 assert.equal([...pdf.text.matchAll(/^100\.01$/gm)].length,120,'every reviewed row is rendered once');
 assert.equal(exported.json.rowCount,120);
 assert.equal(exported.json.format.standard,'PDF 1.4');
});

test('RTF is a balanced table document carrying every row and full Unicode, with no character substituted',async t=>{
 const f=await fixture(t);f.set('gifts',[gift(0,{externalRef:'warm 🌻 sunflower — “quoted”'}),gift(1)]);
 const review=await f.run(definition({columns:['externalRef','amount']}));
 const exported=await f.typed(review.json,'rtf');assert.equal(exported.status,200,JSON.stringify(exported.json));
 const rtf=readRtf(bytes(exported));
 assert.equal(rtf.rows,3,'a header row and one row per reviewed result row');
 assert.equal(rtf.cells,6);
 assert.match(rtf.text,/\\u-10180\?\\u-8389\?/,'an astral character is written as a signed RTF surrogate pair');
 assert.match(rtf.plain,/sunflower/);
 assert.match(rtf.text,/100\.01/);
 assert.equal(exported.json.format.textSubstituted,false);
 // The PDF's base-14 font is WinAnsi, so it reports its own substitution.
 const pdf=await f.typed(review.json,'pdf');assert.equal(pdf.json.format.textSubstituted,true);
 assert.match(readPdf(bytes(pdf)).text,/warm \? sunflower/);
});

test('every typed format refuses a changed definition, fingerprint, role or tenant and returns no file',async t=>{
 const f=await fixture(t),rows=Array.from({length:12},(_,i)=>gift(i));f.set('gifts',rows);
 const review=await f.run(definition({filters:[{field:'externalRef',op:'eq',value:'0'}]}));assert.equal(review.status,200);
 for(const format of ['xlsx','pdf','rtf']){
  assert.equal((await f.typed(review.json,format)).status,200,format+' exports from the reviewed proof');
  noFile(await f.request('/export/'+format,{payload:review.json.definition}),400);
  noFile(await f.request('/export/'+format+'?fingerprint=wrong',{payload:review.json.definition}),400);
  noFile(await f.typed(review.json,format,{payload:{...review.json.definition,name:'Other definition'}}),409);
  for(const options of [{role:'viewer'},{role:'admin'},{tenant:'other'}])noFile(await f.typed(review.json,format,options),409);
  noFile(await f.typed(review.json,format,{csrf:false}),403);
  noFile(await f.typed(review.json,format,{role:'event-helper'}),403);
  noFile(await f.typed(review.json,format,{role:'missing'}),401);
 }
 noFile(await f.typed(review.json,'docx'),400);
 rows[11].notes='Changed unmatched and unselected saved fact';f.set('gifts',rows);
 for(const format of ['xlsx','pdf','rtf'])noFile(await f.typed(review.json,format),409);
 const fresh=await f.run(review.json.definition);
 for(const format of ['xlsx','pdf','rtf'])assert.equal((await f.typed(fresh.json,format)).status,200);
});

test('typed exports recheck matched document privacy beyond the displayed page and exclude private revisions',async t=>{
 const f=await fixture(t),d=documents(f);
 f.transaction(()=>{for(let i=1;i<=301;i++)d.add(i);d.add(302,'Administrators');});
 const review=await f.run(definition({entity:'documentRevisions',columns:['revision','filename']}));
 assert.equal(review.json.rows.length,250);assert.equal(review.json.matchedRows,301);
 const exported=await f.typed(review.json,'xlsx');assert.equal(exported.status,200,JSON.stringify(exported.json));
 assert.equal(exported.json.documentRevisionPrivacy,1);
 assert.equal(exported.json.documentRevisionSources.length,301);
 assert.equal(exported.json.rowCount,301);
 const rows=sheetCells(unzip(bytes(exported)).get('xl/worksheets/sheet1.xml').toString());
 assert.equal(rows.length,302,'rows beyond the reviewed page are exported');
 assert.equal(rows[301].cells[0].raw,'301');
 assert.doesNotMatch(bytes(exported).toString('latin1'),/PRIVATE_NAME/);
 for(const format of ['pdf','rtf'])assert.doesNotMatch(bytes(await f.typed(review.json,format)).toString('latin1'),/PRIVATE_NAME|PRIVATE_TITLE/);
 f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=301').run(JSON.stringify({visibility:'Administrators'}));
 for(const format of ['xlsx','pdf','rtf'])noFile(await f.typed(review.json,format),409);
 const current=await f.run(review.json.definition),after=await f.typed(current.json,'xlsx');
 assert.equal(after.status,200);assert.equal(after.json.rowCount,300);
 assert.equal(after.json.documentRevisionSources.some(reference=>reference.revision===301),false);
});

test('an administrator source stays private in every typed format and grouped money is summed once',async t=>{
 const f=await fixture(t);f.set('gifts',Array.from({length:40},(_,i)=>gift(i,{constituentId:i%2?donor:other})));
 const grouped=await f.run(definition({columns:['donorName'],groupBy:['donorName'],aggregates:[{op:'sum',field:'amount'},{op:'count'}]}));
 const exported=await f.typed(grouped.json,'xlsx');assert.equal(exported.status,200);
 const rows=sheetCells(unzip(bytes(exported)).get('xl/worksheets/sheet1.xml').toString());
 assert.equal(rows.length,3);
 assert.equal(rows.slice(1).reduce((total,row)=>total+BigInt(row.cells[1].raw.replace('.','')),0n),BigInt(40*10001));
 assert.equal(rows.slice(1).reduce((total,row)=>total+Number(row.cells[2].raw),0),40);
 const split=await f.run(definition({entity:'giftAllocations',columns:['school','allocationAmount'],groupBy:['school'],aggregates:[{op:'sum',field:'allocationAmount'},{op:'count'}]}));
 const splitFile=await f.typed(split.json,'xlsx');assert.equal(splitFile.status,200);
 const splitRows=sheetCells(unzip(bytes(splitFile)).get('xl/worksheets/sheet1.xml').toString());
 assert.deepEqual(splitRows.slice(1).map(row=>[unescapeXml(row.cells[0].raw),row.cells[1].raw,row.cells[2].raw]),[['North school','2400.00','40'],['South school','1600.40','40']]);
 assert.equal(splitRows.slice(1).reduce((total,row)=>total+BigInt(row.cells[1].raw.replace('.','')),0n),BigInt(40*10001),'allocation splits reconcile to the gift total exactly once');
 const protectedSource=await f.run(definition({entity:'workspaceUsers',columns:['name']}),{role:'admin'});
 for(const format of ['xlsx','pdf','rtf'])noFile(await f.typed(protectedSource.json,format,{role:'staff'}),403);
 assert.equal((await f.typed(protectedSource.json,'xlsx',{role:'admin'})).status,200);
});

test('size limits refuse a typed export outright rather than returning a partial or truncated file',async t=>{
 const f=await fixture(t);
 f.set('gifts',Array.from({length:9},(_,i)=>gift(i,{notes:'x'.repeat(900000)})));
 const review=await f.run(definition({columns:['notes']}));assert.equal(review.status,200);
 // The RTF carries every character, so 8.1 MB of retained text exceeds the 8 MB
 // file limit and the whole document is refused rather than shortened.
 const rtf=await f.typed(review.json,'rtf');noFile(rtf,413);assert.match(rtf.json.error,/8 MB/);
 // Repetitive text compresses, so the same facts fit a workbook. Random text of
 // the same order exceeds the bounded assembly budget and is refused instead.
 assert.equal((await f.typed(review.json,'xlsx')).status,200);
 f.set('gifts',Array.from({length:40},(_,i)=>gift(i,{notes:randomText(400000,i)})));
 const random=await f.run(definition({columns:['notes']}));assert.equal(random.status,200);
 const refused=await f.typed(random.json,'xlsx');noFile(refused,413);
 assert.match(refused.json.error,/no partial export was generated/);
 f.set('gifts',Array.from({length:100001},(_,i)=>gift(i)));
 const oversized=await f.request('/export/xlsx?fingerprint='+'0'.repeat(64),{payload:definition({filters:[{field:'externalRef',op:'eq',value:'no match'}]})});
 noFile(oversized,413);assert.match(oversized.json.error,/100,000/);
});

// The honest limit of the PDF: it is a laid-out page, so a cell wider than its
// column is visually clipped and the file says so. The workbook and the CSV
// remain the complete-text artifacts; nothing silently drops text.
test('a PDF reports its own visual clipping while the workbook keeps the whole retained cell',async t=>{
 const f=await fixture(t);const long='retained '.repeat(400);
 f.set('gifts',[gift(0,{notes:long})]);
 const review=await f.run(definition({columns:['notes','amount']}));
 const pdf=await f.typed(review.json,'pdf');assert.equal(pdf.status,200);
 assert.equal(pdf.json.format.textClipped,true);
 assert.ok(readPdf(bytes(pdf)).text.includes('\u0085'),'the clipped cell shows a WinAnsi ellipsis');
 const workbook=await f.typed(review.json,'xlsx');assert.equal(workbook.status,200);
 assert.equal(workbook.json.format.textClipped,false);
 assert.equal(sheetCells(unzip(bytes(workbook)).get('xl/worksheets/sheet1.xml').toString())[1].cells[0].raw,long);
});
function randomText(length,seed){let state=seed+1,out='';const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';for(let i=0;i<length;i++){state=(state*1103515245+12345)&0x7fffffff;out+=alphabet[state%alphabet.length];}return out;}

test('an empty result still produces a complete, valid, header-only file in every typed format',async t=>{
 const f=await fixture(t);f.set('gifts',[gift(0)]);
 const review=await f.run(definition({columns:['externalRef','amount'],filters:[{field:'externalRef',op:'eq',value:'never'}]}));
 assert.equal(review.json.totalResultRows,0);
 const workbook=await f.typed(review.json,'xlsx');assert.equal(workbook.status,200);
 assert.equal(workbook.json.rowCount,0);assert.equal(workbook.json.complete,true);
 assert.equal(sheetCells(unzip(bytes(workbook)).get('xl/worksheets/sheet1.xml').toString()).length,1);
 const pdf=readPdf(bytes(await f.typed(review.json,'pdf')));
 assert.match(pdf.text,/No matching rows\./);
 assert.equal(readRtf(bytes(await f.typed(review.json,'rtf'))).rows,2);
});
