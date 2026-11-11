// Stage 1 driver tests. These require the LOCAL migration container
// (wimblo-migration-pg on 127.0.0.1:57900) and deliberately FAIL rather than
// skip when it is absent: a silently skipped driver test is indistinguishable
// from a passing one. Nothing here touches a hosted database.

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createSyncPostgres} from '../../server/persistence/syncPostgres.js';

const URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const schema='sync_'+randomBytes(6).toString('hex');
// assert.throws() does not hand back the error, and these tests assert on its text.
const thrown=fn=>{try{fn();}catch(e){return e;}return assert.fail('expected a throw');};

async function handle(t,options={}){
 let db;
 try{db=await createSyncPostgres({url:URL,...options});}
 catch(e){assert.fail(`The local PostgreSQL container is required for these tests and is not reachable at 127.0.0.1:57900. Start wimblo-migration-pg and retry. Underlying failure: ${e.message}`);}
 t.after(()=>db.close());
 db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}; SET search_path=${schema}`);
 return db;
}

test.after(async()=>{
 const db=await createSyncPostgres({url:URL});
 try{db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{db.close();}
});

test('synchronous get, all, run and iterate return node:sqlite shapes',async t=>{
 const db=await handle(t);
 db.exec(`DROP TABLE IF EXISTS shapes; CREATE TABLE shapes(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, cents bigint NOT NULL)`);
 const insert=db.prepare('INSERT INTO shapes(name,cents) VALUES($1,$2)');
 assert.deepEqual(insert.run('first',10001),{changes:1,lastInsertRowid:1});
 assert.deepEqual(insert.run('second',-250),{changes:1,lastInsertRowid:2});

 const row=db.prepare('SELECT id,name,cents FROM shapes WHERE name=$1').get('first');
 assert.equal(Object.getPrototypeOf(row),null,'rows must be null-prototype like node:sqlite');
 assert.deepStrictEqual(row,Object.assign(Object.create(null),{id:1,name:'first',cents:10001}));
 assert.equal(db.prepare('SELECT id FROM shapes WHERE name=$1').get('absent'),undefined);

 const all=db.prepare('SELECT name FROM shapes ORDER BY id').all();
 assert.ok(Array.isArray(all));
 assert.deepEqual(all.map(r=>r.name),['first','second']);
 assert.deepEqual(db.prepare('SELECT name FROM shapes WHERE 1=0').all(),[]);

 const seen=[];
 for(const item of db.prepare('SELECT name FROM shapes ORDER BY id').iterate())seen.push(item.name);
 assert.deepEqual(seen,['first','second']);
 // Breaking early must not leave the driver wedged; the next call still works.
 for(const item of db.prepare('SELECT name FROM shapes ORDER BY id').iterate()){assert.equal(item.name,'first');break;}
 assert.equal(db.prepare('SELECT count(*) AS n FROM shapes').get().n,2);

 assert.deepEqual(db.prepare('UPDATE shapes SET cents=cents+1').run(),{changes:2,lastInsertRowid:0});
 assert.deepEqual(db.prepare('DELETE FROM shapes WHERE name=$1').run('second'),{changes:1,lastInsertRowid:0});
});

test('parameters bind by position across every supported value type',async t=>{
 const db=await handle(t);
 db.exec(`DROP TABLE IF EXISTS params; CREATE TABLE params(k text PRIMARY KEY, n bigint, flag boolean, blob bytea, missing text)`);
 const bytes=Uint8Array.from([0,1,254,255,10]);
 assert.equal(db.prepare('INSERT INTO params VALUES($1,$2,$3,$4,$5)').run('a',42,true,bytes,null).changes,1);
 const row=db.prepare('SELECT * FROM params WHERE k=$1').get('a');
 assert.equal(row.n,42);
 assert.equal(row.flag,true);
 assert.equal(row.missing,null);
 assert.ok(row.blob instanceof Uint8Array);
 assert.deepEqual([...row.blob],[...bytes]);
 assert.equal(db.prepare('SELECT $1::text AS a, $2::text AS b').get('one','two').b,'two');
 assert.equal(db.prepare('SELECT count(*) AS n FROM params WHERE n=$1').get(9n).n,0);
 assert.throws(()=>db.prepare('SELECT $1::text').get({not:'supported'}),/Unsupported parameter type object/);
});

test('exec runs multiple statements including trigger bodies that contain semicolons',async t=>{
 const db=await handle(t);
 db.exec(`DROP TABLE IF EXISTS ledger;
  CREATE TABLE ledger(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, memo text NOT NULL, cents bigint NOT NULL);
  CREATE OR REPLACE FUNCTION ${schema}.ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
    RAISE EXCEPTION 'Audit is append-only';
    RETURN NULL;
   END;
  $fn$;
  CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ${schema}.ledger_append_only();
  INSERT INTO ledger(memo,cents) VALUES('opening',100), ('second',200);`);
 assert.equal(db.prepare('SELECT count(*) AS n FROM ledger').get().n,2);
 assert.equal(db.prepare("SELECT count(*) AS n FROM pg_trigger WHERE tgname='ledger_no_update'").get().n,1);
});

test('a PL/pgSQL RAISE EXCEPTION message reaches the caller unchanged',async t=>{
 const db=await handle(t);
 db.exec(`DROP TABLE IF EXISTS guarded;
  CREATE TABLE guarded(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, memo text NOT NULL);
  CREATE OR REPLACE FUNCTION ${schema}.guarded_refuse() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN RAISE EXCEPTION 'Audit is append-only'; END;
  $fn$;
  CREATE TRIGGER guarded_no_update BEFORE UPDATE ON guarded FOR EACH ROW EXECUTE FUNCTION ${schema}.guarded_refuse();
  INSERT INTO guarded(memo) VALUES('kept');`);
 const error=thrown(()=>db.prepare('UPDATE guarded SET memo=$1 WHERE memo=$2').run('changed','kept'));
 assert.equal(error.message,'Audit is append-only','the trigger refusal is asserted verbatim by the suite and shown to users');
 assert.equal(error.code,'P0001');
 db.exec('ROLLBACK'); // the implicit transaction around the failed statement is already closed; this is a no-op guard
 assert.equal(db.prepare('SELECT memo FROM guarded').get().memo,'kept');

 const constraintError=thrown(()=>db.prepare('INSERT INTO guarded(id,memo) OVERRIDING SYSTEM VALUE VALUES($1,$2)').run(1,'clash'));
 assert.match(constraintError.message,/duplicate key value violates unique constraint/);
 assert.equal(constraintError.code,'23505');
});

test('transactions commit, roll back and report isTransaction from the backend',async t=>{
 const db=await handle(t);
 db.exec('DROP TABLE IF EXISTS tx; CREATE TABLE tx(k text PRIMARY KEY)');
 assert.equal(db.isTransaction,false);

 db.exec('BEGIN');
 assert.equal(db.isTransaction,true);
 db.prepare('INSERT INTO tx VALUES($1)').run('kept');
 db.exec('COMMIT');
 assert.equal(db.isTransaction,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM tx').get().n,1);

 db.exec('BEGIN');
 db.prepare('INSERT INTO tx VALUES($1)').run('discarded');
 assert.equal(db.prepare('SELECT count(*) AS n FROM tx').get().n,2,'the same connection sees its own uncommitted write');
 db.exec('ROLLBACK');
 assert.equal(db.isTransaction,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM tx').get().n,1);

 // A failed statement leaves the block open and needing ROLLBACK; isTransaction
 // must still say the transaction is open, exactly as SQLite would.
 db.exec('BEGIN');
 assert.throws(()=>db.prepare('INSERT INTO tx VALUES($1)').run('kept'),/duplicate key value/);
 assert.equal(db.isTransaction,true);
 db.exec('ROLLBACK');
 assert.equal(db.isTransaction,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM tx').get().n,1);

 // server/identity.js drives a savepoint through exec() as one multi-statement
 // string; savepoints are connection state, so this proves the single client.
 db.exec('BEGIN');
 db.exec('SAVEPOINT identity_preview');
 db.prepare('INSERT INTO tx VALUES($1)').run('preview');
 db.exec('ROLLBACK TO identity_preview; RELEASE identity_preview');
 assert.equal(db.isTransaction,true);
 assert.equal(db.prepare('SELECT count(*) AS n FROM tx').get().n,1);
 db.exec('COMMIT');
});

test('integers round-trip exactly, and an unrepresentable one throws instead of losing precision',async t=>{
 const db=await handle(t);
 db.exec('DROP TABLE IF EXISTS money; CREATE TABLE money(k text PRIMARY KEY, cents bigint NOT NULL)');
 const insert=db.prepare('INSERT INTO money VALUES($1,$2)');
 const values=[0,1,-1,10001,999999999999,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER];
 values.forEach((cents,index)=>insert.run('k'+index,cents));
 values.forEach((cents,index)=>assert.equal(db.prepare('SELECT cents FROM money WHERE k=$1').get('k'+index).cents,cents));
 assert.equal(db.prepare('SELECT sum(cents) AS total FROM money WHERE k IN ($1,$2)').get('k3','k4').total,10001+999999999999);

 insert.run('huge','9223372036854775807');
 assert.throws(()=>db.prepare('SELECT cents FROM money WHERE k=$1').get('huge'),/outside JavaScript's safe integer range/);
 const big=db.prepare('SELECT cents FROM money WHERE k=$1');
 big.setReadBigInts(true);
 assert.equal(big.get('huge').cents,9223372036854775807n);
 const counted=db.prepare('SELECT count(*) AS n FROM money');
 counted.setReadBigInts(true);
 assert.equal(counted.get().n,8n);
 // No float anywhere: a fractional numeric is handed back as exact text, never
 // silently converted to a double.
 assert.equal(db.prepare('SELECT 1.5::numeric AS v').get().v,'1.5');
 assert.equal(db.prepare('SELECT 12::numeric AS v').get().v,12);
});

test('lastInsertRowid is the identity value, and exactly zero everywhere else',async t=>{
 const db=await handle(t);
 db.exec(`DROP TABLE IF EXISTS with_identity; DROP TABLE IF EXISTS no_identity; DROP TABLE IF EXISTS with_serial;
  CREATE TABLE with_identity(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, memo text NOT NULL);
  CREATE TABLE with_serial(id serial PRIMARY KEY, memo text NOT NULL);
  CREATE TABLE no_identity(k text PRIMARY KEY, memo text NOT NULL)`);
 assert.equal(db.prepare('INSERT INTO with_identity(memo) VALUES($1)').run('a').lastInsertRowid,1);
 assert.equal(db.prepare('INSERT INTO with_identity(memo) VALUES($1)').run('b').lastInsertRowid,2);
 assert.equal(db.prepare('INSERT INTO with_serial(memo) VALUES($1)').run('a').lastInsertRowid,1);
 assert.equal(db.prepare('INSERT INTO no_identity VALUES($1,$2)').run('k','a').lastInsertRowid,0,'a table without an identity column reports 0');
 assert.equal(db.prepare('INSERT INTO no_identity VALUES($1,$2) ON CONFLICT DO NOTHING').run('k','again').changes,0);
 assert.equal(db.prepare('INSERT INTO with_identity(memo) VALUES($1) RETURNING id').run('c').lastInsertRowid,0,'a caller-written RETURNING clause is never rewritten');
 assert.equal(db.prepare('UPDATE with_identity SET memo=$1').run('x').lastInsertRowid,0);
 // A multi-row insert reports the LAST identity assigned, like SQLite.
 assert.equal(db.prepare('INSERT INTO with_identity(memo) VALUES($1),($2)').run('d','e').lastInsertRowid,5);
});

test('a result larger than the shared buffer is refused loudly and the handle survives',async t=>{
 const db=await handle(t,{bufferBytes:64*1024});
 assert.equal(db.bufferBytes,65536);
 const error=thrown(()=>db.prepare('SELECT repeat($1::text,$2::int) AS big').all('x',200000));
 assert.match(error.message,/exceeds the 65536-byte shared result buffer/);
 assert.match(error.message,/No rows were returned/);
 assert.throws(()=>db.prepare('SELECT repeat($1::text,$2::int) AS big').get('x',200000),/exceeds the 65536-byte shared result buffer/);
 // The protocol is intact: a refusal is not a poisoning.
 assert.equal(db.prepare('SELECT $1::int AS n').get(7).n,7);
 assert.equal(db.prepare('SELECT repeat($1::text,$2::int) AS big').get('x',100).big.length,100);
});

test('the blocking protocol stays in step over repeated calls and never yields the event loop',async t=>{
 const db=await handle(t);
 db.exec('DROP TABLE IF EXISTS loadtest; CREATE TABLE loadtest(n bigint PRIMARY KEY, label text NOT NULL)');
 let ticks=0;
 const timer=setInterval(()=>{ticks++;},1);
 setImmediate(()=>{ticks+=1000;});
 Promise.resolve().then(()=>{ticks+=1000000;});
 const insert=db.prepare('INSERT INTO loadtest VALUES($1,$2)');
 for(let i=0;i<300;i++){
  insert.run(i,'label-'+i);
  const back=db.prepare('SELECT n,label FROM loadtest WHERE n=$1').get(i);
  assert.equal(back.n,i,'reply #'+i+' must belong to request #'+i);
  assert.equal(back.label,'label-'+i);
  assert.equal(db.prepare('SELECT $1::int AS echo, $2::text AS text').get(i,'t'+i).echo,i);
 }
 clearInterval(timer);
 assert.equal(ticks,0,'no timer, immediate or microtask may interleave with a blocked call');
 assert.equal(db.prepare('SELECT count(*) AS n FROM loadtest').get().n,300);
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(ticks>=1000,'the event loop resumes normally once the driver is idle');
});

test('a startup failure rejects the factory rather than hanging a blocked main thread',async()=>{
 await assert.rejects(
  ()=>createSyncPostgres({url:'postgres://wimblo:wrong-password@127.0.0.1:57900/wimblo_dev',connectionTimeoutMs:4000}),
  /Database worker could not connect/);
 await assert.rejects(()=>createSyncPostgres({url:'postgres://wimblo:wimblo-dev@127.0.0.1:1/wimblo_dev',connectionTimeoutMs:2000}),/Database worker could not connect/);
 await assert.rejects(()=>createSyncPostgres({}),/requires an explicit connection URL/);
 await assert.rejects(()=>createSyncPostgres({url:URL,bufferBytes:1024}),/bufferBytes must be at least 64 KiB/);
});

test('a call that does not answer in time throws and poisons the handle instead of hanging',async t=>{
 const db=await handle(t,{timeoutMs:300,statementTimeoutMs:60000});
 assert.throws(()=>db.prepare('SELECT pg_sleep($1)').get(5),/did not answer within 300 ms/);
 assert.throws(()=>db.prepare('SELECT 1 AS n').get(),/did not answer within 300 ms/,'the abandoned buffer is never read again');
});

test('a lost connection surfaces as a throw on the next call, never as a hang',async t=>{
 const victim=await handle(t),killer=await handle(t);
 const pid=victim.prepare('SELECT pg_backend_pid() AS pid').get().pid;
 killer.prepare('SELECT pg_terminate_backend($1) AS done').get(pid);
 assert.throws(()=>victim.prepare('SELECT 1 AS n').get());
 assert.throws(()=>victim.prepare('SELECT 1 AS n').get(),/Database connection was lost|not open/);
 assert.equal(killer.prepare('SELECT 1 AS n').get().n,1,'an unrelated handle is unaffected');
});

test('close ends the connection and every later call is refused',async()=>{
 const db=await createSyncPostgres({url:URL});
 assert.equal(db.isOpen,true);
 assert.equal(db.prepare('SELECT 1 AS n').get().n,1);
 db.close();
 assert.equal(db.isOpen,false);
 db.close(); // idempotent
 assert.throws(()=>db.prepare('SELECT 1 AS n').get(),/The database is not open\./);
 assert.throws(()=>db.exec('SELECT 1'),/The database is not open\./);
});
