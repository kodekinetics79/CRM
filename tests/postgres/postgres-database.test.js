// Adapter tests for server/persistence/postgresDatabase.js. They need the LOCAL
// container (wimblo-migration-pg, 127.0.0.1:57900) and fail rather than skip when it
// is absent. Nothing here touches a hosted database. Run directly:
//   node --test tests/postgres/postgres-database.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPostgresPool,openPostgresDatabase,schemaNameFor} from '../../server/persistence/postgresDatabase.js';
import {createSyncPostgres} from '../../server/persistence/syncPostgres.js';

const URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const prefix=`wt_adapter${randomBytes(3).toString('hex')}_`;
const thrown=fn=>{try{fn();}catch(e){return e;}return assert.fail('expected a throw');};
let pool;
test.before(async()=>{
 try{pool=await createPostgresPool({url:URL,size:3,schemaPrefix:prefix});}
 catch(e){assert.fail(`The local PostgreSQL container is required at 127.0.0.1:57900: ${e.message}`);}
});
test.after(async()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{for(const {nspname} of db.prepare("SELECT nspname FROM pg_namespace WHERE starts_with(nspname,?)").all(prefix))db.exec(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);}finally{db.close();}
 await pool.close();
});
const path=()=>`/tmp/wimblo-adapter-${randomBytes(6).toString('hex')}/workspace.sqlite`;

test('a path maps to a deterministic bounded schema and reopening finds the same data',()=>{
 const p=path();
 assert.equal(schemaNameFor(p,prefix),schemaNameFor(p,prefix));
 assert.notEqual(schemaNameFor(':memory:',prefix),schemaNameFor(':memory:',prefix));
 assert.ok(Buffer.byteLength(schemaNameFor(p,prefix))<=63);
 const a=openPostgresDatabase(pool,p);
 a.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,body TEXT NOT NULL); INSERT INTO notes VALUES('n1','kept')");
 assert.equal(a.prepare('INSERT INTO notes VALUES(?,?)').run('n2','second').changes,1);
 a.close();a.close();
 const b=openPostgresDatabase(pool,p);
 try{assert.deepEqual(b.prepare('SELECT id,body FROM notes ORDER BY rowid').all().map(r=>({...r})),[{id:'n1',body:'kept'},{id:'n2',body:'second'}]);}finally{b.close();}
});

test(':memory: is private to one open and is dropped on close',()=>{
 const a=openPostgresDatabase(pool,':memory:'),schema=a.schema;
 a.exec('CREATE TABLE t(x INTEGER)');a.close();
 const b=openPostgresDatabase(pool,':memory:');
 try{assert.notEqual(b.schema,schema);assert.equal(b.prepare('SELECT 1 FROM pg_namespace WHERE nspname=?').get(schema),undefined);assert.equal(b.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='t'").get(),undefined);}finally{b.close();}
});

test('close returns the handle, rolls back an open transaction and resets session state',()=>{
 const p=path(),a=openPostgresDatabase(pool,p);
 a.exec('CREATE TABLE t(x INTEGER NOT NULL)');
 a.exec('BEGIN IMMEDIATE');a.prepare('INSERT INTO t VALUES(?)').run(1);assert.equal(a.isTransaction,true);
 const before=pool.stats.idle;a.close();
 assert.equal(pool.stats.idle,before+1);
 assert.throws(()=>a.prepare('SELECT 1'),/database is not open/);
 const b=openPostgresDatabase(pool,p);
 try{assert.equal(b.prepare('SELECT count(*) AS n FROM t').get().n,0);assert.equal(b.isTransaction,false);}finally{b.close();}
 const c=openPostgresDatabase(pool,':memory:');
 try{assert.equal(c.prepare('SELECT current_schema() AS s').get().s,c.schema);assert.equal(c.prepare("SELECT current_setting('default_transaction_read_only') AS v").get().v,'off');}finally{c.close();}
});

test('pool exhaustion names the pool size',()=>{
 const open=[];
 try{
  while(pool.stats.idle)open.push(openPostgresDatabase(pool,':memory:'));
  assert.match(thrown(()=>openPostgresDatabase(pool,':memory:')).message,/pool exhausted.*pool size 3/);
 }finally{for(const db of open)db.close();}
});

test('readOnly opens only an existing database and the server refuses every write',()=>{
 assert.match(thrown(()=>openPostgresDatabase(pool,path(),{readOnly:true})).message,/unable to open database file/);
 const p=path(),w=openPostgresDatabase(pool,p);
 w.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(7)");w.close();
 const r=openPostgresDatabase(pool,p,{readOnly:true});
 try{
  assert.equal(r.prepare('SELECT x FROM t').get().x,7);
  for(const attempt of [()=>r.prepare('INSERT INTO t VALUES(?)').run(8),()=>r.exec('UPDATE t SET x=9'),()=>r.exec('CREATE TABLE u(y TEXT)'),()=>{r.exec('BEGIN');try{r.exec('DELETE FROM t');}finally{r.exec('ROLLBACK');}}])
   assert.equal(thrown(attempt).code,'25006');
  assert.equal(r.prepare('SELECT x FROM t').get().x,7);
 }finally{r.close();}
 const next=openPostgresDatabase(pool,':memory:');
 try{next.exec('CREATE TABLE ok(x INTEGER)');}finally{next.close();}
});

test('SELECT * hides the rowid surrogate and follows DDL through the column cache',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{
  db.exec('CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT NOT NULL)');
  assert.deepEqual(db.columnsOf('people'),['id','name']);
  const all=db.prepare('SELECT * FROM people');
  db.prepare('INSERT INTO people VALUES(?,?)').run('p1','Ada');
  assert.deepEqual(Object.keys(all.get()),['id','name']);
  db.exec('ALTER TABLE people ADD COLUMN email TEXT');
  assert.deepEqual(db.columnsOf('people'),['id','name','email']);
  assert.deepEqual(Object.keys(all.get()),['id','name','email']);
  assert.match(thrown(()=>db.columnsOf('absent')).message,/^no such table: absent$/);
  db.exec('CREATE TABLE absent(z TEXT)');assert.deepEqual(db.columnsOf('absent'),['z']);
 }finally{db.close();}
});

test('a failed statement inside a transaction undoes only itself, as in SQLite, and trigger messages survive',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{
  db.exec("CREATE TABLE audit(id TEXT PRIMARY KEY,action TEXT NOT NULL); CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;");
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO audit VALUES(?,?)').run('a1','first');
  assert.equal(thrown(()=>db.prepare('INSERT INTO audit VALUES(?,?)').run('a1','duplicate')).code,'23505');
  assert.equal(thrown(()=>db.exec("UPDATE audit SET action='x'")).message,'Audit is append-only');
  // An application savepoint must not be released by the adapter's own.
  db.exec('SAVEPOINT app_step');db.prepare('INSERT INTO audit VALUES(?,?)').run('a2','undone');db.exec('ROLLBACK TO app_step; RELEASE app_step');
  db.prepare('INSERT INTO audit VALUES(?,?)').run('a3','third');
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('SELECT id FROM audit ORDER BY rowid').all().map(r=>r.id),['a1','a3']);
  assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

test('lastInsertRowid follows insertion order and exec interleaves DDL with data',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{
  db.exec("CREATE TABLE a(id TEXT PRIMARY KEY); INSERT INTO a VALUES('x'); CREATE TABLE b(id TEXT PRIMARY KEY); INSERT INTO b SELECT * FROM a;");
  assert.equal(db.prepare('SELECT id FROM b').get().id,'x');
  const insert=db.prepare('INSERT INTO a VALUES(?)');
  const first=insert.run('y').lastInsertRowid,second=insert.run('z').lastInsertRowid;
  assert.ok(second>first);
 }finally{db.close();}
});

test('the harness preload refuses any database that is not on loopback',()=>{
 const preload=fileURLToPath(new globalThis.URL('./harness/preload.mjs',import.meta.url));
 for(const url of ['postgres://u:p@example.neon.tech/neondb','postgres://u:p@10.0.0.5:5432/db','postgres://u:p@127.0.0.1:5432/db?host=example.com']){
  const r=spawnSync(process.execPath,['--import',preload,'-e','0'],{env:{...process.env,WIMBLO_PG_URL:url},encoding:'utf8'});
  assert.notEqual(r.status,0,url);assert.match(r.stderr,/only connects to a loopback server/,url);
 }
});

test('DROP TRIGGER resolves its table, drops the generated function, and refuses an ambiguous name',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 const fns=()=>db.prepare("SELECT count(*) AS n FROM pg_proc WHERE pronamespace=to_regnamespace(current_schema()) AND proname LIKE '%\\_raise\\_%'").get().n;
 try{
  db.exec("CREATE TABLE audit(action TEXT NOT NULL); CREATE TABLE other(action TEXT NOT NULL); CREATE TRIGGER synthetic_fault BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
  assert.equal(thrown(()=>db.prepare('INSERT INTO audit VALUES(?)').run('x')).message,'Synthetic audit unavailable');
  const before=fns();
  db.exec('DROP TRIGGER synthetic_fault');
  assert.equal(fns(),before-1);
  assert.equal(db.prepare('INSERT INTO audit VALUES(?)').run('x').changes,1);
  db.exec('DROP TRIGGER IF EXISTS synthetic_fault');
  assert.match(thrown(()=>db.exec('DROP TRIGGER synthetic_fault')).message,/no such trigger: synthetic_fault/);
  // SQLite would never allow this; PostgreSQL does, so the adapter refuses to guess.
  db.exec("CREATE TRIGGER twin BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'a'); END; CREATE TRIGGER twin BEFORE UPDATE ON other BEGIN SELECT RAISE(ABORT,'b'); END;");
  assert.match(thrown(()=>db.exec('DROP TRIGGER twin')).message,/exists on 2 tables/);
 }finally{db.close();}
});

test('a PostgreSQL WARNING is not an error',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{db.exec('PRAGMA foreign_keys=OFF');db.exec('PRAGMA foreign_keys=ON');assert.equal(db.prepare('SELECT 1 AS x').get().x,1);}finally{db.close();}
});

test('a terminated backend is rebuilt off the call path: fail fast, no committed pretence, same schema',async()=>{
 const admin=await createSyncPostgres({url:URL});
 const p=path(),db=openPostgresDatabase(pool,p);
 try{
  db.exec("CREATE TABLE ledger(id TEXT PRIMARY KEY); INSERT INTO ledger VALUES('committed')");
  const insert=db.prepare('INSERT INTO ledger VALUES(?)'),count=db.prepare('SELECT count(*) AS n FROM ledger');
  const pid=db.prepare('SELECT pg_backend_pid() AS pid').get().pid,busy=pool.stats.busy;
  db.exec('BEGIN IMMEDIATE');insert.run('uncommitted');
  assert.equal(admin.prepare('SELECT pg_terminate_backend($1) AS ok').get(pid).ok,true);
  // The in-flight call fails with the connection error itself.
  const inflight=thrown(()=>insert.run('in-flight'));
  assert.ok(!inflight.status,'the in-flight call reports the real connection failure');
  assert.equal(db.healthy,false);assert.equal(db.isTransaction,true,'a lost transaction is never reported as finished');
  // Next calls fail fast rather than hang, and COMMIT cannot pretend.
  const started=performance.now();
  for(let i=0;i<50;i++)assert.equal(thrown(()=>count.get()).code,'WIMBLO_TRANSACTION_LOST');
  assert.equal(thrown(()=>db.exec('COMMIT')).code,'WIMBLO_TRANSACTION_LOST');
  db.exec('ROLLBACK');
  assert.equal(db.isTransaction,false);
  const unavailable=thrown(()=>count.get());
  assert.equal(unavailable.status,503);assert.equal(unavailable.code,'WIMBLO_DATABASE_UNAVAILABLE');
  assert.ok(performance.now()-started<100,`fail-fast calls took ${performance.now()-started} ms`);
  // Two more observers while rebuilding: still one rebuild, no extra handle.
  thrown(()=>db.prepare('SELECT 1'));thrown(()=>db.exec('SELECT 1'));
  const waitStarted=performance.now();
  await Promise.all([db.whenReady(),db.whenReady()]);
  const r=db.recovery;
  assert.equal(r.rebuilds,1);assert.equal(r.attempts,1);assert.equal(db.healthy,true);
  assert.equal(pool.stats.busy,busy,'the dead handle was replaced, not added to');
  process.stdout.write(`recovery: lost->serving ${r.lastRecoveryMs} ms (await ${(performance.now()-waitStarted).toFixed(0)} ms)\n`);
  assert.equal(db.prepare('SELECT current_schema() AS s').get().s,db.schema);
  assert.notEqual(db.prepare('SELECT pg_backend_pid() AS pid').get().pid,pid);
  assert.deepEqual(db.prepare('SELECT id FROM ledger ORDER BY rowid').all().map(r=>r.id),['committed']);
  assert.equal(insert.run('after').changes,1);
  assert.equal(count.get().n,2);
 }finally{db.close();admin.close();}
 // The rebuilt handle goes back to the pool like any other.
 const again=openPostgresDatabase(pool,p);
 try{assert.equal(again.prepare('SELECT count(*) AS n FROM ledger').get().n,2);}finally{again.close();}
});

test('pooled handles killed while idle are skipped on open and refilled once the server answers',async()=>{
 const small=await createPostgresPool({url:URL,size:2,schemaPrefix:prefix}),admin=await createSyncPostgres({url:URL});
 try{
  const held=[openPostgresDatabase(small,':memory:'),openPostgresDatabase(small,':memory:')];
  const pids=held.map(db=>db.prepare('SELECT pg_backend_pid() AS pid').get().pid);
  for(const db of held)db.close();
  for(const pid of pids)admin.prepare('SELECT pg_terminate_backend($1)').get(pid);
  const e=thrown(()=>openPostgresDatabase(small,':memory:'));
  assert.equal(e.code,'WIMBLO_POOL_EXHAUSTED');assert.equal(e.status,503);
  const started=performance.now();
  while(small.stats.idle<2){if(performance.now()-started>10000)assert.fail(`pool did not refill: ${JSON.stringify(small.stats)}`);await new Promise(r=>setTimeout(r,20));}
  const db=openPostgresDatabase(small,':memory:');
  try{assert.equal(db.prepare('SELECT current_schema() AS s').get().s,db.schema);assert.ok(!pids.includes(db.prepare('SELECT pg_backend_pid() AS pid').get().pid));}finally{db.close();}
 }finally{admin.close();await small.close();}
});

test('isNotNull reports declared NOT NULL exactly, never throws, and follows DDL',()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{
  db.exec('CREATE TABLE audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,note TEXT)');
  assert.equal(db.isNotNull('audit','id'),true);assert.equal(db.isNotNull('audit','at'),true);
  assert.equal(db.isNotNull('audit','note'),false);assert.equal(db.isNotNull('absent','id'),false);assert.equal(db.isNotNull('audit','missing'),false);
  db.exec("CREATE TABLE later(x TEXT NOT NULL)");assert.equal(db.isNotNull('later','x'),true);
  db.exec("ALTER TABLE audit ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'");assert.equal(db.isNotNull('audit','actor'),true);
  // With NOT NULL known, DESC ordering needs no NULLS rewrite and the primary key index serves it.
  const plan=db.prepare('EXPLAIN SELECT * FROM audit ORDER BY id DESC LIMIT 250').all().map(r=>r['QUERY PLAN']).join('\n');
  assert.match(plan,/Index Scan Backward/);
 }finally{db.close();}
});
