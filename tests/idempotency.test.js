import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import {createApp} from '../server/app.js';
import {createIdempotencyMiddleware,commitIdempotencyMarker,canonicalJson} from '../server/idempotency.js';

const password='FoundationDemo!2026',sha=v=>createHash('sha256').update(v).digest('hex');
const HOUR=3600000;

async function listen(app){const server=app.listen(0,'127.0.0.1');await once(server,'listening');return {server,base:`http://127.0.0.1:${server.address().port}`};}
const stop=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve());});

// Real workspace application with a controllable idempotency clock and a restartable database file.
async function fixture(t,{idempotency={},tenantId=null,dir:shared=null}={}){
 const dir=shared||await mkdtemp(join(tmpdir(),'wimblo-idempotency-')),dbPath=join(dir,'workspace.sqlite'),clock={now:Date.parse('2026-09-16T12:00:00Z')};
 let app,server,base;
 async function open(){app=createApp({dbPath,seed:true,tenantId,reminderWorker:false,workflowWorker:false,extensions:{idempotency:{clock:()=>clock.now,pruneIntervalMs:0,...idempotency}}});({server,base}=await listen(app));}
 async function close(){if(server)await stop(server);server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();if(!shared)await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true,key}={}){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session)headers.Cookie=session.cookie;if(session&&csrf)headers['X-CSRF-Token']=typeof csrf==='string'?csrf:session.csrfToken;if(key!==undefined)headers['Idempotency-Key']=key;
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let json={};try{json=text?JSON.parse(text):{};}catch{}
  return {status:r.status,text,json,headers:r.headers};
 }
 async function login(email='alex@foundation.example'){const r=await request('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(r.status,200,r.text);return {...r.json,cookie:r.headers.get('set-cookie').split(';')[0]};}
 const f={dir,dbPath,clock,request,login,open,close,get app(){return app;},get db(){return app.locals.db;}};
 f.admin=await login();
 const ws=(await request('/api/workspace',{session:f.admin})).json;
 f.gift=(amount=2500,changes={})=>({constituentId:ws.data.constituents[0].id,amount,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:ws.data.designations[0].id,amount}],...changes});
 f.gifts=()=>f.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts'").get();
 f.rows=()=>f.db.prepare('SELECT * FROM idempotency_requests ORDER BY reserved_at,id').all();
 return f;
}

test('creating a gift twice with one key records exactly one gift and replays the byte-identical response',async t=>{
 const f=await fixture(t),before=f.gifts(),key=randomUUID();
 const first=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(4321),key});
 assert.equal(first.status,201,first.text);assert.equal(first.headers.get('idempotent-replayed'),null);
 const second=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(4321),key});
 assert.equal(second.status,201);assert.equal(second.headers.get('idempotent-replayed'),'true');
 assert.equal(second.text,first.text);assert.equal(second.headers.get('content-type'),first.headers.get('content-type'));
 const after=f.gifts();assert.equal(after.count,before.count+1);assert.equal(after.cents,before.cents+4321);
 const [row]=f.rows();assert.equal(row.state,'Completed');assert.ok(row.committed_at!=null,'the commit marker was written inside the business transaction');assert.equal(row.body_stored,1);
 assert.equal(row.key_hash,sha(key));assert.ok(!JSON.stringify(row).includes(key),'the raw key is not retained');
 // Reordered JSON keys are the same canonical request.
 const reordered=Object.fromEntries(Object.entries(f.gift(4321)).reverse());
 assert.equal((await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:reordered,key})).headers.get('idempotent-replayed'),'true');
 assert.equal(f.gifts().count,before.count+1);
});

test('POST /api/gifts/import replayed with the same key imports once',async t=>{
 const f=await fixture(t),before=f.gifts(),key=randomUUID(),rows=[f.gift(1000,{externalRef:'IMP-1'}),f.gift(2000,{externalRef:'IMP-2'}),f.gift(3000)];
 const first=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows},key});assert.equal(first.status,201,first.text);assert.deepEqual(first.json,{imported:3});
 const second=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows},key});assert.equal(second.status,201);assert.equal(second.text,first.text);assert.equal(second.headers.get('idempotent-replayed'),'true');
 const after=f.gifts();assert.equal(after.count,before.count+3);assert.equal(after.cents,before.cents+6000);
 // The unkeyed retry is the documented gap for manual gifts; imported references are guarded by the database (Part B), not by this header.
});

test('same key with a different body is refused with 422 and writes nothing',async t=>{
 const f=await fixture(t),key=randomUUID();
 assert.equal((await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(500),key})).status,201);
 const before=f.gifts(),auditBefore=f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
 const changed=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(50000),key});
 assert.equal(changed.status,422);assert.equal(changed.json.code,'IDEMPOTENCY_KEY_REUSED');
 assert.deepEqual(f.gifts(),before);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,auditBefore);assert.equal(f.rows().length,1);
 // A different route or method under the same key is a different scope, not a reuse.
 const other=await f.request('/api/gifts/import',{method:'POST',session:f.admin,body:{rows:[f.gift(700)]},key});assert.equal(other.status,201,other.text);
 assert.equal((await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(500),key:'bad key with spaces'})).status,400);
});

test('a CSRF-rejected keyed request is released and the same key then executes once',async t=>{
 const f=await fixture(t),key=randomUUID(),before=f.gifts();
 const rejected=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(900),key,csrf:'forged'});
 assert.equal(rejected.status,403);assert.equal(f.rows().length,0,'the reservation was released');assert.deepEqual(f.gifts(),before);
 const ok=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(900),key});assert.equal(ok.status,201,ok.text);assert.equal(ok.headers.get('idempotent-replayed'),null);
 const again=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(900),key});assert.equal(again.headers.get('idempotent-replayed'),'true');
 assert.equal(f.gifts().count,before.count+1);
 // Readonly (403) and unknown-record (404) rejections are released the same way.
 const viewer=await f.login('board@foundation.example'),viewerKey=randomUUID();
 assert.equal((await f.request('/api/records/gifts',{method:'POST',session:viewer,body:f.gift(900),key:viewerKey})).status,403);
 assert.equal((await f.request('/api/gifts/missing/void',{method:'POST',session:f.admin,body:{version:1,reason:'x'},key:viewerKey})).status,404);
 assert.equal(f.rows().length,1,'only the executed request is retained');
});

test('different users and different tenants using the same key are independent',async t=>{
 const f=await fixture(t),key='shared-key-1',before=f.gifts(),staff=await f.login('staff@foundation.example');
 const a=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(1111),key}),b=await f.request('/api/records/gifts',{method:'POST',session:staff,body:f.gift(1111),key});
 assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(b.headers.get('idempotent-replayed'),null);assert.notEqual(a.json.record.id,b.json.record.id);
 assert.equal(f.gifts().count,before.count+2);
 // Two tenant applications over one database file: same user id, same route, same body, same key.
 const dir=await mkdtemp(join(tmpdir(),'wimblo-idempotency-tenants-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const one=await fixture(t,{tenantId:randomUUID(),dir}),two=await fixture(t,{tenantId:randomUUID(),dir}),start=one.gifts();
 assert.equal(one.admin.user.id,two.admin.user.id);
 const x=await one.request('/api/records/gifts',{method:'POST',session:one.admin,body:one.gift(2222),key}),y=await two.request('/api/records/gifts',{method:'POST',session:two.admin,body:one.gift(2222),key});
 assert.equal(x.status,201);assert.equal(y.status,201);assert.equal(y.headers.get('idempotent-replayed'),null);
 assert.equal(one.gifts().count,start.count+2);assert.equal(new Set(one.rows().map(r=>r.tenant_id)).size,2);
});

test('absent header keeps today\'s behaviour: no reservation, and two posts create two gifts',async t=>{
 const f=await fixture(t),before=f.gifts();
 for(let i=0;i<2;i++){const r=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(300)});assert.equal(r.status,201);assert.equal(r.headers.get('idempotent-replayed'),null);}
 assert.equal(f.gifts().count,before.count+2);assert.equal(f.rows().length,0);
 // GET requests with a key are untouched.
 assert.equal((await f.request('/api/workspace',{session:f.admin,key:randomUUID()})).status,200);assert.equal(f.rows().length,0);
});

test('a write that rolls back after the marker was written leaves no marker and permits retry',async t=>{
 const f=await fixture(t),key=randomUUID(),before=f.gifts();
 // A deferred foreign key is only checked by COMMIT, which the shared helper issues AFTER commitIdempotencyMarker(db).
 f.db.exec(`CREATE TABLE idempotency_test_parent(id TEXT PRIMARY KEY);CREATE TABLE idempotency_test_child(parent TEXT REFERENCES idempotency_test_parent(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE TRIGGER idempotency_test_fail AFTER INSERT ON records WHEN NEW.collection='gifts' BEGIN INSERT INTO idempotency_test_child VALUES('missing'); END;`);
 const failed=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(777),key});
 assert.equal(failed.status,500,failed.text);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM idempotency_requests WHERE committed_at IS NOT NULL').get().n,0,'the marker rolled back with the gift');assert.equal(f.rows().length,0,'the 500 released the reservation');assert.deepEqual(f.gifts(),before);
 f.db.exec('DROP TRIGGER idempotency_test_fail');
 const retried=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(777),key});assert.equal(retried.status,201,retried.text);
 assert.equal(f.gifts().count,before.count+1);assert.ok(f.rows()[0].committed_at!=null);
});

test('lease recovery: a stale reservation without a marker re-executes; with a marker it returns 409 and never duplicates',async t=>{
 const f=await fixture(t,{idempotency:{leaseMs:60000}}),before=f.gifts(),body=f.gift(1500),stale=f.clock.now-120000;
 const reserve=(key,committed)=>f.db.prepare("INSERT INTO idempotency_requests(id,tenant_id,user_id,method,path,key_hash,fingerprint,state,lease_token,reserved_at,lease_expires,committed_at,expires_at) VALUES(?,?,?,?,?,?,?,'InProgress',?,?,?,?,?)").run(randomUUID(),'',f.admin.user.id,'POST','/api/records/gifts',sha(key),sha(canonicalJson(body)),randomUUID(),stale,stale+60000,committed?stale+10:null,stale+24*HOUR);
 const crashedBeforeCommit=randomUUID();reserve(crashedBeforeCommit,false);
 const fresh=randomUUID();f.db.prepare("INSERT INTO idempotency_requests(id,tenant_id,user_id,method,path,key_hash,fingerprint,state,lease_token,reserved_at,lease_expires,expires_at) VALUES(?,?,?,?,?,?,?,'InProgress',?,?,?,?)").run(randomUUID(),'',f.admin.user.id,'POST','/api/records/gifts',sha(fresh),sha(canonicalJson(body)),randomUUID(),f.clock.now,f.clock.now+60000,f.clock.now+24*HOUR);
 const live=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body,key:fresh});assert.equal(live.status,409);assert.equal(live.json.code,'IDEMPOTENCY_IN_PROGRESS');
 const recovered=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body,key:crashedBeforeCommit});
 assert.equal(recovered.status,201,recovered.text);assert.equal(f.gifts().count,before.count+1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='idempotency_lease_recovered'").get().n,1);
 const crashedAfterCommit=randomUUID();reserve(crashedAfterCommit,true);
 for(let i=0;i<2;i++){const r=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body,key:crashedAfterCommit});assert.equal(r.status,409);assert.equal(r.json.code,'IDEMPOTENCY_COMPLETED_RELOAD');assert.match(r.json.error,/already completed.*Reload/);}
 assert.equal(f.gifts().count,before.count+1,'the committed operation was not re-executed');
});

test('an oversized response completes without a body and replays as 409 reload, never truncated',async t=>{
 const f=await fixture(t,{idempotency:{maxResponseBytes:64}}),key=randomUUID(),before=f.gifts();
 const first=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(2000),key});assert.equal(first.status,201);assert.ok(first.text.length>64);
 const second=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(2000),key});
 assert.equal(second.status,409);assert.equal(second.json.code,'IDEMPOTENCY_COMPLETED_RELOAD');assert.equal(second.headers.get('idempotent-replayed'),'true');
 assert.equal(f.gifts().count,before.count+1);const [row]=f.rows();assert.equal(row.body_stored,0);assert.equal(row.response_body,null);assert.ok(row.committed_at!=null);
});

test('completed records expire after 24 hours and are deleted in bounded batches; pruning failure never breaks a request',async t=>{
 const f=await fixture(t,{idempotency:{pruneBatch:2}});
 for(let i=0;i<5;i++)assert.equal((await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(100+i),key:'expiring-'+i})).status,201);
 assert.equal(f.rows().length,5);
 f.clock.now+=23*HOUR;await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(1),key:'within-window'});assert.equal(f.rows().length,6,'nothing expires inside 24 hours');
 assert.equal((await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(100),key:'expiring-0'})).headers.get('idempotent-replayed'),'true');
 f.clock.now+=2*HOUR;
 await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(2),key:'prune-1'});assert.equal(f.rows().length,5,'one batch of two deleted, one row added');
 await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(3),key:'prune-2'});assert.equal(f.rows().length,4);
 await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(4),key:'prune-3'});assert.equal(f.rows().length,4);
 assert.ok(f.rows().every(r=>r.expires_at>f.clock.now));
 f.db.exec("CREATE TRIGGER idempotency_test_no_prune BEFORE DELETE ON idempotency_requests BEGIN SELECT RAISE(ABORT,'simulated pruning failure'); END;");
 f.clock.now+=48*HOUR;const errors=[],original=console.error;console.error=(...args)=>errors.push(args.join(' '));
 try{const r=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(5),key:'prune-fails'});assert.equal(r.status,201,r.text);}finally{console.error=original;}
 assert.ok(errors.some(e=>/pruning failed/.test(e)));
 f.db.exec('DROP TRIGGER idempotency_test_no_prune');
 const triggers=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='idempotency_requests'").all();assert.deepEqual(triggers,[],'operational table carries no immutability triggers');
});

test('replay survives a restart of the application on the same database',async t=>{
 const f=await fixture(t),key=randomUUID(),before=f.gifts();
 const first=await f.request('/api/records/gifts',{method:'POST',session:f.admin,body:f.gift(6000),key});assert.equal(first.status,201);
 await f.close();await f.open();const admin=await f.login();
 // A new session is the same authenticated user, so the scope and the replay hold.
 const second=await f.request('/api/records/gifts',{method:'POST',session:admin,body:f.gift(6000),key});
 assert.equal(second.status,201);assert.equal(second.headers.get('idempotent-replayed'),'true');assert.equal(second.text,first.text);
 assert.equal(f.gifts().count,before.count+1);
});

test('an async route handler keeps the request context across await and writes its marker in the business transaction',async t=>{
 const f=await fixture(t),key=randomUUID(),ws=(await f.request('/api/workspace',{session:f.admin})).json;
 const body={collection:'constituents',recordId:ws.data.constituents[0].id,title:'Evidence',category:'Report',visibility:'Workspace',status:'Draft',evidenceDate:null,filename:'evidence.txt',contentBase64:Buffer.from('evidence text').toString('base64')};
 const first=await f.request('/api/documents',{method:'POST',session:f.admin,body,key});assert.equal(first.status,201,first.text);
 const [row]=f.rows();assert.ok(row.committed_at!=null,'the marker was written after the handler awaited');
 const second=await f.request('/api/documents',{method:'POST',session:f.admin,body,key});assert.equal(second.headers.get('idempotent-replayed'),'true');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,1);
});

// Module-level harness: the real middleware and marker around a transaction helper identical to server/app.js,
// with handlers that can pause across await, hang (simulated crash) or fail at COMMIT.
async function moduleFixture(t,options={}){
 const db=new DatabaseSync(':memory:'),clock={now:1_000_000},audits=[];
 db.exec('CREATE TABLE writes(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL)');
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();commitIdempotencyMarker(db);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const middleware=createIdempotencyMiddleware({db,audit:(...a)=>audits.push(a),transaction,clock:()=>clock.now,options:{pruneIntervalMs:0,leaseMs:1000,...options}});
 const app=express(),gates=[];app.use(express.json());app.use('/api',(req,res,next)=>{req.user={id:req.get('X-User')||'u1'};next();},middleware);
 const gate=()=>new Promise(resolve=>gates.push(resolve));
 app.post('/api/slow',async(req,res,next)=>{try{await gate();await new Promise(r=>setTimeout(r,5));res.status(201).json({id:transaction(()=>Number(db.prepare('INSERT INTO writes(label) VALUES(?)').run(req.body.label).lastInsertRowid))});}catch(e){next(e);}});
 app.post('/api/crash-before-commit',async()=>{await new Promise(()=>{});});
 app.post('/api/crash-after-commit',async(req)=>{transaction(()=>db.prepare('INSERT INTO writes(label) VALUES(?)').run(req.body.label));await new Promise(()=>{});});
 app.post('/api/secret',(req,res)=>res.status(201).json({invitation:{id:'i1'},token:'shown-once-'+transaction(()=>db.prepare('INSERT INTO writes(label) VALUES(?)').run('secret').lastInsertRowid)}));
 app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
 const {server,base}=await listen(app);t.after(async()=>{await stop(server);db.close();});
 const post=(path,body,key,user)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(user?{'X-User':user}:{})},body:JSON.stringify(body)});
 const waitForGate=async n=>{for(let i=0;i<200&&gates.length<n;i++)await new Promise(r=>setTimeout(r,5));assert.equal(gates.length,n);};
 return {db,clock,audits,middleware,post,gates,waitForGate,writes:()=>db.prepare('SELECT COUNT(*) AS n FROM writes').get().n,row:()=>db.prepare('SELECT * FROM idempotency_requests').get()};
}

test('concurrent same-key requests: one executes across await, the other is refused while it runs',async t=>{
 const m=await moduleFixture(t),key=randomUUID();
 const first=m.post('/api/slow',{label:'a'},key);await m.waitForGate(1);
 const second=await m.post('/api/slow',{label:'a'},key);assert.equal(second.status,409);assert.equal((await second.json()).code,'IDEMPOTENCY_IN_PROGRESS');assert.equal(second.headers.get('retry-after'),'1');
 assert.equal(m.row().committed_at,null);m.gates[0]();
 const done=await first;assert.equal(done.status,201);const text=await done.text();
 assert.ok(m.row().committed_at!=null,'AsyncLocalStorage context survived two awaits into the transaction');
 const third=await m.post('/api/slow',{label:'a'},key);assert.equal(third.status,201);assert.equal(await third.text(),text);assert.equal(m.writes(),1);
 // Two truly simultaneous arrivals: only one reaches the handler.
 const k2=randomUUID(),pending=[m.post('/api/slow',{label:'b'},k2),m.post('/api/slow',{label:'b'},k2)];
 await m.waitForGate(2);await new Promise(r=>setTimeout(r,30));m.gates[1]();
 const statuses=(await Promise.all(pending)).map(r=>r.status).sort();
 assert.deepEqual(statuses,[201,409]);assert.equal(m.gates.length,2,'only one of the simultaneous requests reached the handler');assert.equal(m.writes(),2);
});

test('lease recovery after a real hang: no marker re-executes, a committed marker is never re-executed',async t=>{
 const m=await moduleFixture(t),before=randomUUID(),after=randomUUID();
 m.post('/api/crash-before-commit',{label:'x'},before).catch(()=>{});
 m.post('/api/crash-after-commit',{label:'y'},after).catch(()=>{});
 for(let i=0;i<100&&m.db.prepare('SELECT COUNT(*) AS n FROM idempotency_requests').get().n<2;i++)await new Promise(r=>setTimeout(r,5));
 for(let i=0;i<100&&m.writes()<1;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(m.writes(),1);
 assert.equal((await m.post('/api/crash-after-commit',{label:'y'},after)).status,409,'lease still live');
 m.clock.now+=2000;
 // The route hangs again, but it was admitted: its lease was taken over, not refused.
 m.post('/api/crash-before-commit',{label:'x'},before).catch(()=>{});
 for(let i=0;i<100&&!m.audits.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(m.audits.filter(a=>a[1]==='idempotency_lease_recovered').length,1);
 const refused=await m.post('/api/crash-after-commit',{label:'y'},after);assert.equal(refused.status,409);assert.equal((await refused.json()).code,'IDEMPOTENCY_COMPLETED_RELOAD');
 assert.equal(m.writes(),1,'the committed write was not repeated');
});

test('a slow attempt that lost its lease to a retry cannot commit a duplicate',async t=>{
 const m=await moduleFixture(t),key=randomUUID();
 const slow=m.post('/api/slow',{label:'z'},key);await m.waitForGate(1);
 m.clock.now+=2000;const retry=m.post('/api/slow',{label:'z'},key);await m.waitForGate(2);
 m.gates[0]();const lost=await slow;assert.equal(lost.status,409);assert.match((await lost.json()).error,/lost its reservation/);assert.equal(m.writes(),0,'the business write rolled back with the refused marker');
 m.gates[1]();assert.equal((await retry).status,201);assert.equal(m.writes(),1);
});

test('credential-bearing responses are completed without a stored body',async t=>{
 const m=await moduleFixture(t),key=randomUUID();
 assert.equal((await m.post('/api/secret',{},key)).status,201);
 const row=m.row();assert.equal(row.body_stored,0);assert.equal(row.response_body,null);
 const replay=await m.post('/api/secret',{},key);assert.equal(replay.status,409);assert.doesNotMatch(await replay.text(),/shown-once/);assert.equal(m.writes(),1);
});

test('pruning is bounded and failures are counted rather than thrown',async t=>{
 const m=await moduleFixture(t,{pruneBatch:3});
 for(let i=0;i<7;i++)m.db.prepare("INSERT INTO idempotency_requests(id,tenant_id,user_id,method,path,key_hash,fingerprint,state,lease_token,reserved_at,lease_expires,expires_at) VALUES(?,?,?,?,?,?,?,'Completed',?,?,?,?)").run(randomUUID(),'','u1','POST','/api/x',sha('k'+i),'f',randomUUID(),0,1,10);
 m.middleware.prune();assert.equal(m.middleware.stats.pruned,3);m.middleware.prune();m.middleware.prune();assert.equal(m.middleware.stats.pruned,7);
 m.db.exec('ALTER TABLE idempotency_requests RENAME TO idempotency_requests_moved');
 const original=console.error;console.error=()=>{};try{m.middleware.prune();}finally{console.error=original;}
 assert.equal(m.middleware.stats.pruneFailures,1);
 m.db.exec('ALTER TABLE idempotency_requests_moved RENAME TO idempotency_requests');
});
