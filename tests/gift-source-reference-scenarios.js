import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/persistence/openDatabase.js';
import {GIFT_SOURCE_REFERENCE_INDEX} from '../server/recordLookups.js';

// Gift source-reference uniqueness, written once and run on both engines: the SQLite
// test runs it as-is and the PostgreSQL test installs the adapter factory first. The
// manual-gift cases use the shape manual entry really sends: externalRef ''.
const password='FoundationDemo!2026';
export const manualGift=(donor,fund,changes={})=>({constituentId:donor.id,amount:2500,type:'Cash',method:'Check',date:'2026-09-13',campaignId:null,allocations:[{designationId:fund.id,amount:2500}],externalRef:'',notes:'',tribute:'',softCreditId:null,pledge:'',giftKind:'One-time',...changes});

export async function openWorkspace(t,dbPath){
 const app=createApp({dbPath,seed:true,reminderWorker:false,workflowWorker:false}),db=app.locals.db,server=app.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
 return {app,db,...await client(`http://127.0.0.1:${server.address().port}`)};
}

async function client(base){
 async function request(path,{method='GET',body,session}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrfToken;}const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alex@foundation.example',password})});
 assert.equal(login.status,200);
 const admin={...await login.json(),cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 const workspace=(await request('/api/workspace',{session:admin})).json.data;
 const donor=workspace.constituents[0],fund=workspace.designations[0];
 const gift=changes=>manualGift(donor,fund,changes);
 const create=body=>request('/api/records/gifts',{method:'POST',session:admin,body});
 return {request,admin,donor,fund,gift,create};
}

const giftRows=(db,where='1=1',...args)=>db.prepare(`SELECT id,data FROM records WHERE collection='gifts' AND ${where} ORDER BY rowid`).all(...args).map(r=>({id:r.id,data:r.data}));
const byReference=(db,ref)=>giftRows(db).filter(r=>JSON.parse(r.data).externalRef===ref);
const insertRaw=(db,collection,record)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run(collection,record.id,JSON.stringify(record));

export async function manualGiftsAllSucceed(f){
 const before=byReference(f.db,'').length;
 for(let i=0;i<4;i++){const r=await f.create(f.gift({notes:`Manual gift ${i}`}));assert.equal(r.status,201,JSON.stringify(r.json));assert.equal(r.json.record.externalRef,'');}
 // Omitted reference: the schema default stores the same empty string.
 const {externalRef,...omitted}=f.gift();const o=await f.create(omitted);assert.equal(o.status,201,JSON.stringify(o.json));assert.equal(o.json.record.externalRef,'');
 const imported=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows:[f.gift(),f.gift(),f.gift({amount:2500})]}});
 assert.equal(imported.status,201,JSON.stringify(imported.json));assert.equal(imported.json.imported,3);
 assert.equal(byReference(f.db,'').length,before+8);
}

export async function duplicatesAreRefusedByTheDatabase(f){
 const first=await f.create(f.gift({externalRef:'SRC-0001'}));assert.equal(first.status,201,JSON.stringify(first.json));
 const again=await f.create(f.gift({externalRef:'SRC-0001'}));assert.equal(again.status,409);assert.equal(again.json.error,'Duplicate externalRef');
 // An import is atomic: a duplicate anywhere in the file keeps every row out.
 const auditBefore=f.db.prepare('SELECT count(*) AS n FROM audit').get().n,giftsBefore=giftRows(f.db).length;
 const file=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows:[f.gift({externalRef:'SRC-NEW-BEFORE-DUPLICATE'}),f.gift({externalRef:'SRC-0001'})]}});
 assert.equal(file.status,409);assert.equal(file.json.error,'Duplicate externalRef');
 const inFile=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows:[f.gift({externalRef:'SRC-TWICE'}),f.gift({externalRef:'SRC-TWICE'})]}});
 assert.equal(inFile.status,409);assert.equal(inFile.json.error,'Duplicate externalRef');
 assert.equal(giftRows(f.db).length,giftsBefore);assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit').get().n,auditBefore);
 assert.equal(byReference(f.db,'SRC-NEW-BEFORE-DUPLICATE').length,0);assert.equal(byReference(f.db,'SRC-TWICE').length,0);
 // A financial correction onto a reference another gift holds is refused the same way, and retains nothing.
 const other=(await f.create(f.gift({externalRef:'SRC-0002'}))).json.record;
 const before=giftRows(f.db,'id=?',other.id),history=f.db.prepare('SELECT count(*) AS n FROM gift_financial_corrections').get().n;
 const corrected=await f.request(`/api/records/gifts/${other.id}`,{method:'PATCH',session:f.admin,body:{version:other.version,externalRef:'SRC-0001',correctionReason:'Transcribed the wrong source receipt'}});
 assert.equal(corrected.status,409);assert.equal(corrected.json.error,'Duplicate externalRef');
 assert.deepEqual(giftRows(f.db,'id=?',other.id),before);assert.equal(f.db.prepare('SELECT count(*) AS n FROM gift_financial_corrections').get().n,history);
 // A gift never conflicts with its own reference.
 const own=await f.request(`/api/records/gifts/${other.id}`,{method:'PATCH',session:f.admin,body:{version:other.version,notes:'Reviewed; reference unchanged'}});
 assert.equal(own.status,200,JSON.stringify(own.json));assert.equal(own.json.record.externalRef,'SRC-0002');
 assert.equal(byReference(f.db,'SRC-0001').length,1);
}

// The removed scan compared a validated string with ===. The index must refuse exactly
// what that refused: byte-identical non-empty strings, nothing else.
export async function onlyIdenticalStringReferencesConflict(f){
 for(const ref of ['Case-Ref','case-ref','CASE-REF',' Case-Ref','Case-Ref ','Case\tRef','é-receipt','e\u0301-receipt','12345']){const r=await f.create(f.gift({externalRef:ref}));assert.equal(r.status,201,`${JSON.stringify(ref)}: ${JSON.stringify(r.json)}`);}
 // Whitespace-only is a non-empty string, as the scan treated it: the second one conflicts.
 assert.equal((await f.create(f.gift({externalRef:'   '}))).status,201);assert.equal((await f.create(f.gift({externalRef:'   '}))).status,409);
 // Stored shapes validation never produces (earlier imports, direct repairs): numbers, NULL and a missing key
 // were never matched by the scan, so they neither block a string nor each other.
 const base=JSON.parse(giftRows(f.db)[0].data);
 for(const externalRef of [12345,12345,54321,null,null,undefined])insertRaw(f.db,'gifts',{...base,id:randomUUID(),externalRef});
 const numericText=await f.create(f.gift({externalRef:'54321'}));assert.equal(numericText.status,201,JSON.stringify(numericText.json));
 // The index is restricted to gifts: another collection carrying the same reference is not a gift source.
 insertRaw(f.db,'pledges',{id:randomUUID(),externalRef:'CROSS-COLLECTION'});insertRaw(f.db,'communications',{id:randomUUID(),externalRef:'CROSS-COLLECTION'});
 assert.equal((await f.create(f.gift({externalRef:'CROSS-COLLECTION'}))).status,201);
 assert.equal((await f.create(f.gift({externalRef:'CROSS-COLLECTION'}))).status,409);
}

export async function voidedGiftsKeepTheirReference(f){
 const gift=(await f.create(f.gift({externalRef:'VOID-SRC-1'}))).json.record;
 const voided=await f.request(`/api/gifts/${gift.id}/void`,{method:'POST',session:f.admin,body:{version:gift.version,reason:'Recorded against the wrong donor'}});
 assert.equal(voided.status,200,JSON.stringify(voided.json));assert.equal(JSON.parse(giftRows(f.db,'id=?',gift.id)[0].data).externalRef,'VOID-SRC-1');
 const reimport=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows:[f.gift({externalRef:'VOID-SRC-1'})]}});
 assert.equal(reimport.status,409);assert.match(reimport.json.error,/^Duplicate externalRef: a voided gift keeps this source reference/);assert.match(reimport.json.error,/financial correction/);
 assert.equal(byReference(f.db,'VOID-SRC-1').length,1);
}

// B3: a workspace that already holds duplicate references does not open, the error names
// every conflicting gift, and not one financial record is changed to make the index build.
export function existingDuplicatesRefuseToOpen(dbPath){
 const seed=openDatabase(dbPath);
 const gift=(id,externalRef,status='Posted')=>({id,constituentId:'c-1',amount:1000,type:'Cash',method:'Check',date:'2020-01-01',allocations:[{designationId:'d-1',amount:1000}],externalRef,status});
 const rows=[gift('gift-a','LEGACY-7'),gift('gift-b','LEGACY-7','Voided'),gift('gift-c','LEGACY-9'),gift('gift-d','LEGACY-9'),gift('gift-e','LEGACY-9'),gift('gift-f','UNIQUE-1'),gift('gift-g',''),gift('gift-h',''),gift('gift-i',null)];
 try{
  seed.exec('CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id))');
  for(const r of rows)seed.prepare('INSERT INTO records VALUES(?,?,?)').run('gifts',r.id,JSON.stringify(r));
 }finally{seed.close();}
 let refused;
 try{createApp({dbPath,seed:false,reminderWorker:false,workflowWorker:false});}catch(e){refused=e;}
 assert.ok(refused,'a workspace with duplicate gift source references must not open');
 assert.equal(refused.code,'WIMBLO_DUPLICATE_GIFT_SOURCE_REFERENCE');
 assert.deepEqual(refused.duplicateGiftSourceReferences,{'LEGACY-7':['gift-a','gift-b'],'LEGACY-9':['gift-c','gift-d','gift-e']});
 for(const id of ['gift-a','gift-b','gift-c','gift-d','gift-e'])assert.match(refused.message,new RegExp(`\\b${id}\\b`));
 assert.doesNotMatch(refused.message,/gift-f|gift-g|gift-h|gift-i/);
 assert.match(refused.message,/no gift was changed/);
 const check=openDatabase(dbPath);
 try{
  assert.deepEqual(check.prepare("SELECT id,data FROM records WHERE collection='gifts' ORDER BY id").all().map(r=>({id:r.id,data:JSON.parse(r.data)})),rows.map(r=>({id:r.id,data:r})).sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(GIFT_SOURCE_REFERENCE_INDEX),undefined);
 }finally{check.close();}
}

// Two server processes on one database, every reference sent to both at the same moment.
export async function concurrentCreatesCannotBothSucceed(t,dbPath,{nodeArgs=[],env={}}={}){
 const worker=fileURLToPath(new URL('./workspace-process.js',import.meta.url));
 const start=async()=>{
  const child=spawn(process.execPath,[...nodeArgs,worker],{env:{...process.env,...env,WIMBLO_TEST_DB_PATH:dbPath},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}});
  let out='',err='';child.stderr.on('data',c=>err+=c);
  const port=await new Promise((resolve,reject)=>{child.stdout.on('data',c=>{out+=c;const line=out.split('\n').find(l=>l.startsWith('{'));if(line)resolve(JSON.parse(line).port);});child.once('exit',code=>reject(new Error(`workspace process exited ${code}: ${err}`)));});
  return client(`http://127.0.0.1:${port}`);
 };
 const a=await start(),b=await start();// sequential: the first seeds, the second opens the seeded workspace
 const refs=Array.from({length:16},(_,i)=>`RACE-${i}-${randomUUID()}`);
 const results=await Promise.all(refs.flatMap(ref=>[a.create(a.gift({externalRef:ref})),b.create(b.gift({externalRef:ref}))]));
 for(let i=0;i<refs.length;i++){
  const pair=[results[2*i],results[2*i+1]];
  assert.deepEqual(pair.map(r=>r.status).sort(),[201,409],`${refs[i]}: ${JSON.stringify(pair)}`);
  assert.equal(pair.find(r=>r.status===409).json.error,'Duplicate externalRef');
 }
 const db=openDatabase(dbPath);
 try{for(const ref of refs)assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE collection='gifts' AND json_extract(data,'$.externalRef')=?").get(ref).n,1,ref);}finally{db.close();}
 const statuses=results.map(r=>r.status);
 return {refs,created:statuses.filter(s=>s===201).length,refused:statuses.filter(s=>s===409).length};
}

// The write-path checks that now read through indexed lookups still refuse exactly what
// the collection scans refused, including a linkage stored as a number, which the scan's
// === never counted and which PostgreSQL would extract as matching text.
export async function writePathLookupsKeepScanSemantics(f){
 const workspace=(await f.request('/api/workspace',{session:f.admin})).json.data;
 const person=workspace.constituents.find(c=>c.email==='taylor@example.test'),other=workspace.constituents.find(c=>c.email==='sam@example.test'),third=workspace.constituents.find(c=>c.email==='morgan@example.test');
 insertRaw(f.db,'pledges',{id:'777',name:'Numeric-id pledge',constituentId:person.id,amount:5000,startDate:'2026-07-01',installments:1,frequency:'Annual',designationId:null,campaignId:null,status:'Active',notes:'',version:1});
 insertRaw(f.db,'gifts',{...f.gift({constituentId:person.id,amount:5000,allocations:[{designationId:f.fund.id,amount:5000}]}),id:randomUUID(),pledgeId:777,status:'Posted',version:1});
 const receipt=changes=>f.create(f.gift({constituentId:person.id,giftKind:'Pledge fulfillment',pledgeId:'777',...changes}));
 const full=await receipt({amount:5000,allocations:[{designationId:f.fund.id,amount:5000}]});assert.equal(full.status,201,JSON.stringify(full.json));
 const over=await receipt({amount:1,allocations:[{designationId:f.fund.id,amount:1}]});assert.equal(over.status,409);assert.equal(over.json.error,'Gift exceeds outstanding pledge commitment');
 const record=(c,body)=>f.request(`/api/records/${c}`,{method:'POST',session:f.admin,body});
 const shift=async(start,end,capacity)=>{const r=await record('volunteerShifts',{name:`Lookup shift ${start}`,date:'2026-11-02',startTime:start,endTime:end,location:'',capacity,eventId:null,status:'Open',notes:''});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;};
 const s1=await shift('09:00','12:00',1),s2=await shift('11:00','13:00',5);
 const reserve=(s,p,status='Reserved')=>record('shiftReservations',{shiftId:s.id,constituentId:p.id,status,notes:''});
 const first=await reserve(s1,person);assert.equal(first.status,201,JSON.stringify(first.json));
 assert.equal((await reserve(s1,person,'Waitlisted')).json.error,'This person already has an active reservation or waitlist place');
 assert.equal((await reserve(s1,other)).json.error,'Shift is full; choose the waitlist');
 assert.equal((await reserve(s1,other,'Waitlisted')).status,201);
 assert.equal((await reserve(s2,person)).json.error,'This person has an overlapping reserved shift');
 assert.equal((await f.request(`/api/records/volunteerShifts/${s1.id}`,{method:'PATCH',session:f.admin,body:{version:s1.version,startTime:'08:00'}})).json.error,'Shift date, times and event cannot change after reservations; create a new shift');
 const cancelled=await f.request(`/api/records/shiftReservations/${first.json.record.id}`,{method:'PATCH',session:f.admin,body:{version:first.json.record.version,status:'Cancelled'}});assert.equal(cancelled.status,200,JSON.stringify(cancelled.json));
 assert.equal((await reserve(s2,person)).status,201);
 assert.equal((await reserve(s1,third)).status,201,'the cancelled place is free again');
}
