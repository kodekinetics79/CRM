import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {createApp} from '../../server/app.js';
import {translateDdl,preludeStatements} from '../../server/persistence/sqliteDdl.js';
import {readFileSync,readdirSync} from 'node:fs';
import {translateQuery,SUPPORT_SQL} from '../../server/persistence/sqliteQuery.js';
import {createSyncPostgres} from '../../server/persistence/syncPostgres.js';

// Execution proof for sqliteDdl.js: the real schema, translated and actually run.
//
// This file is deliberately OUTSIDE the tests/*.test.js glob that `npm test`
// uses, because it needs the container. Run it with:
//   node --test tests/postgres/sqlite-ddl-postgres.test.js
// The pure translation lives in tests/sqlite-ddl.test.js and needs nothing.
// Target is always the local container; never a hosted database
// (NEON-MIGRATION-PLAN.md non-negotiable 6).
const URL=process.env.MIGRATION_POSTGRES_URL||'postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
assert.match(URL,/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\])[:/]/,'refusing to run against anything but the local migration container');

// Every DDL string the real server modules hand to db.exec while a full app is
// constructed: 160 tables, 233 triggers and 63 indexes, loop-generated blocks
// included. Nothing here is a sample chosen by hand.
// It also keeps the finished SQLite database open, as the reference to compare with.
let reference;
function realDdl(){
 const original=DatabaseSync.prototype.exec,captured=[];
 DatabaseSync.prototype.exec=function(sql){captured.push(sql);return original.call(this,sql);};
 try{reference=createApp({dbPath:':memory:',seed:true,reminderWorker:false,workflowWorker:false}).locals;}
 finally{DatabaseSync.prototype.exec=original;}
 return captured.join(';\n');
}

const translated=translateDdl(realDdl());
test.after(()=>reference.close?.());

async function connect(){
 const client=new pg.Client(URL);
 await client.connect();
 return client;
}
async function schema(client){
 const name='ddl_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
 await client.query(`CREATE SCHEMA ${name}`);
 await client.query(`SET search_path TO ${name},public`);
 for(const s of preludeStatements())await client.query(s);
 return name;
}

// The whole translated schema, applied for real. A statement that does not
// execute is a translation failure, not a skipped case.
test('every translated statement executes against PostgreSQL',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const failed=[];
 for(const sql of translated.statements){try{await client.query(sql);}catch(e){failed.push(`${e.message} :: ${sql.slice(0,180)}`);}}
 assert.deepEqual(failed,[]);
 // tests/sqlite-ddl.test.js pins the inventory by name; here the catalog must match it
 assert.equal(translated.statements.length,1157);
 const count=async q=>Number((await client.query(q)).rows[0].count);
 assert.equal(await count(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${name}' AND table_type='BASE TABLE'`),160);
 assert.equal(await count(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${name}' AND NOT g.tgisinternal`),233);
 assert.equal(await count(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${name}' AND p.proname NOT LIKE 'sqlite_json_%'`),233);
 for(const unit of translated.units.filter(u=>u.kind==='index'))
  assert.equal(await count(`SELECT count(*) FROM pg_indexes WHERE schemaname='${name}' AND indexname='${unit.name}'`),1,unit.name);
 // no float anywhere in the schema PostgreSQL actually built
 assert.deepEqual((await client.query(`SELECT DISTINCT data_type FROM information_schema.columns WHERE table_schema='${name}' AND table_name<>'sqlite_schema' ORDER BY 1`)).rows.map(r=>r.data_type),['bigint','bytea','text']);
 // every text column PostgreSQL built is byte-ordered, except the two COLLATE NOCASE columns
 assert.deepEqual((await client.query(`SELECT collation_name,count(*)::int AS n FROM information_schema.columns WHERE table_schema='${name}' AND table_name<>'sqlite_schema' AND data_type='text' GROUP BY 1 ORDER BY 1`)).rows,[{collation_name:'C',n:(await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='${name}' AND table_name<>'sqlite_schema' AND data_type='text'`)).rows[0].n-2},{collation_name:'nocase',n:2}]);
 assert.deepEqual((await client.query(`SELECT table_name||'.'||column_name AS c FROM information_schema.columns WHERE table_schema='${name}' AND collation_name='nocase' ORDER BY 1`)).rows.map(r=>r.c),['event_seating.name','households.name']);
 // every foreign key is deferrable and checked immediately unless deferred
 const fks=(await client.query(`SELECT c.condeferrable,c.condeferred,count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='${name}' GROUP BY 1,2`)).rows;
 assert.equal(fks.length,1);assert.equal(fks[0].condeferrable,true);assert.equal(fks[0].condeferred,false);assert.ok(fks[0].n>70,String(fks[0].n));
 // and applying the whole thing a second time is a no-op, which is what
 // IF NOT EXISTS / CREATE OR REPLACE TRIGGER have to buy us
 const again=[];
 for(const sql of translated.statements){try{await client.query(sql);}catch(e){again.push(e.message);}}
 assert.deepEqual(again,[]);
});

// No refusal message in the schema today carries an apostrophe, so the escaping
// path is proved against PostgreSQL itself rather than against the generated text.
test('a refusal message with an apostrophe and a percent sign arrives byte-identical',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const messages=[
  "Financial correction history retains this source record; deletion would orphan original source provenance.",
  "Retire the donor's pledge before deleting; the workspace's history can't be rewritten.",
  "100% of receipts are retained -- %s and %I are literal text here",
  'Audit is append-only',
 ];
 for(const [i,message] of messages.entries()){
  const sqlite=`CREATE TABLE IF NOT EXISTS probe_${i}(id TEXT PRIMARY KEY,note TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS probe_${i}_no_update BEFORE UPDATE ON probe_${i} BEGIN SELECT RAISE(ABORT,'${message.replace(/'/g,"''")}'); END;
   CREATE TRIGGER IF NOT EXISTS probe_${i}_no_delete BEFORE DELETE ON probe_${i} BEGIN SELECT RAISE(ABORT,'${message.replace(/'/g,"''")}'); END;`;
  const unit=translateDdl(sqlite,{strict:true});
  for(const sql of unit.statements)await client.query(sql);
  await client.query(`INSERT INTO probe_${i}(id,note) VALUES('a','b')`);
  for(const attempt of [`UPDATE probe_${i} SET note='c'`,`DELETE FROM probe_${i}`])
   await assert.rejects(()=>client.query(attempt),e=>{assert.equal(e.message,message);return true;});
  // and a permitted write is still permitted
  await client.query(`INSERT INTO probe_${i}(id,note) VALUES('b','b')`);
  assert.equal((await client.query(`SELECT count(*) FROM probe_${i}`)).rows[0].count,'2');
 }
});

// Synthesise the smallest legal row for a table: primary-key and NOT NULL columns
// only, so that single-column CHECK constraints on nullable columns stay NULL and
// therefore satisfied.
function tableShape(sql){
 const m=/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*)\)$/.exec(sql.trim());
 const items=[];let cur='',depth=0,i=0;
 while(i<m[2].length){const c=m[2][i];
  if(c==="'"){let j=i+1;while(j<m[2].length){if(m[2][j]==="'"){if(m[2][j+1]==="'"){j+=2;continue;}break;}j++;}cur+=m[2].slice(i,j+1);i=j+1;continue;}
  if(c==='(')depth++;if(c===')')depth--;
  if(c===','&&depth===0){items.push(cur.trim());cur='';i++;continue;}
  cur+=c;i++;}
 if(cur.trim())items.push(cur.trim());
 const columns=[],constraints=[];
 for(const item of items){
  if(/^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(item)){constraints.push(item);continue;}
  const c=/^(\w+)\s+(TEXT|INTEGER|BLOB)([\s\S]*)$/i.exec(item);
  if(c)columns.push({name:c[1],type:c[2].toUpperCase(),tail:c[3]||''});
 }
 const pk=(/PRIMARY KEY\s*\(([^)]*)\)/i.exec(constraints.join(' '))||[,''])[1].split(',').map(s=>s.trim());
 return {table:m[1],columns,constraints,required:columns.filter(c=>/NOT NULL|PRIMARY KEY/i.test(c.tail)||pk.includes(c.name))};
}
function literal(column,constraints,n){
 const where=[column.tail,...constraints].join(' '),name=column.name;
 for(const [re,pick] of [
  [new RegExp(`\\b${name}\\s+IN\\s*\\(\\s*('(?:[^']|'')*'|-?\\d+)`),m=>m[1]],
  [new RegExp(`\\b${name}\\s*=\\s*('(?:[^']|'')*'|-?\\d+)`),m=>m[1]],
  [new RegExp(`\\b${name}\\s*>=\\s*(-?\\d+)`),m=>m[1]],
  [new RegExp(`\\b${name}\\s*>\\s*(-?\\d+)`),m=>String(Number(m[1])+1)]]){
  const m=re.exec(where);if(m)return pick(m);
 }
 if(column.type==='INTEGER')return '0';
 if(column.type==='BLOB')return `'\\x00'::bytea`;
 return name==='data'||/_json$/.test(name)?`'{}'`:`'synthetic-${n}'`;
}

// The integrity guarantee the migration actually has to preserve: the refusal
// still fires, and the message is byte-for-byte the SQLite one.
test('every unconditional trigger still refuses, with the identical message',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 // Foreign keys are dropped so one synthetic row per table can exercise its
 // triggers; the triggers themselves are untouched.
 for(const row of (await client.query(`SELECT conrelid::regclass::text AS rel,conname FROM pg_constraint c JOIN pg_class k ON k.oid=c.conrelid JOIN pg_namespace n ON n.oid=k.relnamespace WHERE c.contype='f' AND n.nspname='${name}'`)).rows)
  await client.query(`ALTER TABLE ${row.rel} DROP CONSTRAINT "${row.conname}"`);

 const shapes=new Map(translated.units.filter(u=>u.kind==='table').map(u=>[u.name,tableShape(u.source)]));
 const triggers=translated.units.filter(u=>u.kind==='trigger');
 const unconditional=triggers.filter(u=>!/ WHEN /.test(u.source)&&!/BEFORE UPDATE OF/i.test(u.source));
 assert.equal(unconditional.length,208);
 const byTable=new Map();
 for(const u of unconditional){if(!byTable.has(u.table))byTable.set(u.table,[]);byTable.get(u.table).push(u);}

 await client.query('BEGIN');
 let proved=0,rows=0;const problems=[];
 let n=0;
 for(const [table,list] of byTable){
  const shape=shapes.get(table);
  const cols=shape.required.map(c=>`"${c.name}"`),values=shape.required.map(c=>literal(c,shape.constraints,++n));
  await client.query('SAVEPOINT row');
  try{await client.query(`INSERT INTO "${table}"(${cols.join(',')}) VALUES(${values.join(',')})`);}
  catch(e){problems.push(`${table}: could not seed a synthetic row: ${e.message}`);await client.query('ROLLBACK TO SAVEPOINT row');continue;}
  rows++;
  // the rowid surrogate is populated by PostgreSQL without being inserted
  assert.notEqual((await client.query(`SELECT __rowid FROM "${table}"`)).rows[0].__rowid,null);
  for(const trigger of list){
   const attempt=/BEFORE DELETE/i.test(trigger.source)?`DELETE FROM "${table}"`:`UPDATE "${table}" SET ${cols[0]}=${cols[0]}`;
   await client.query('SAVEPOINT attempt');
   try{await client.query(attempt);problems.push(`${trigger.name}: did not refuse`);}
   catch(e){e.message===trigger.message?proved++:problems.push(`${trigger.name}: expected ${JSON.stringify(trigger.message)} got ${JSON.stringify(e.message)}`);}
   await client.query('ROLLBACK TO SAVEPOINT attempt');
  }
  await client.query('ROLLBACK TO SAVEPOINT row');
 }
 await client.query('ROLLBACK');
 assert.deepEqual(problems,[]);
 assert.equal(rows,byTable.size);
 assert.equal(proved,unconditional.length);
});

// A WHEN condition has to refuse when it is true and stay out of the way when it
// is false; an over-firing guard would break the product just as badly.
test('conditional triggers refuse only when their condition holds',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 for(const row of (await client.query(`SELECT conrelid::regclass::text AS rel,conname FROM pg_constraint c JOIN pg_class k ON k.oid=c.conrelid JOIN pg_namespace n ON n.oid=k.relnamespace WHERE c.contype='f' AND n.nspname='${name}'`)).rows)
  await client.query(`ALTER TABLE ${row.rel} DROP CONSTRAINT "${row.conname}"`);
 const shapes=new Map(translated.units.filter(u=>u.kind==='table').map(u=>[u.name,tableShape(u.source)]));

 // Immutability guards of the form NEW.col IS NOT OLD.col OR ... : changing that
 // first column must refuse, leaving it alone must not.
 const guards=translated.units.filter(u=>u.kind==='trigger'&&/ WHEN /.test(u.source))
  .map(u=>({u,col:(/NEW\.(\w+)\s*(?:IS NOT|<>|!=)\s*OLD\.\1/.exec((/ WHEN ([\s\S]*?) BEGIN /.exec(u.source)||[,''])[1])||[])[1]}))
  .filter(g=>g.col);
 assert.equal(guards.length,14);
 await client.query('BEGIN');
 let refused=0,allowed=0;const problems=[];let n=0;
 for(const {u,col} of guards){
  const shape=shapes.get(u.table);
  const column=shape.columns.find(c=>c.name===col);
  // the guarded column is always seeded, so guards written as
  // `OLD.col IS NOT NULL AND NEW.col IS NOT OLD.col` are genuinely armed
  const seeded=[...new Set([...shape.required.map(c=>c.name),col])].map(name=>shape.columns.find(c=>c.name===name));
  const cols=seeded.map(c=>`"${c.name}"`),values=seeded.map(c=>literal(c,shape.constraints,++n));
  await client.query('SAVEPOINT row');
  try{await client.query(`INSERT INTO "${u.table}"(${cols.join(',')}) VALUES(${values.join(',')})`);}
  catch(e){problems.push(`${u.name}: could not seed ${u.table}: ${e.message}`);await client.query('ROLLBACK TO SAVEPOINT row');continue;}
  const changed=column.type==='INTEGER'?`COALESCE("${col}",0)+1`:`COALESCE("${col}",'')||'x'`;
  await client.query('SAVEPOINT attempt');
  try{await client.query(`UPDATE "${u.table}" SET "${col}"=${changed}`);problems.push(`${u.name}: mutating ${col} was allowed`);}
  catch(e){e.message===u.message?refused++:problems.push(`${u.name}: expected ${JSON.stringify(u.message)} got ${JSON.stringify(e.message)}`);}
  await client.query('ROLLBACK TO SAVEPOINT attempt');
  await client.query('SAVEPOINT idle');
  try{await client.query(`UPDATE "${u.table}" SET "${col}"="${col}"`);allowed++;}
  catch(e){if(e.message===u.message)problems.push(`${u.name}: refused an update that changed nothing`);else allowed++;}
  await client.query('ROLLBACK TO SAVEPOINT idle');
  await client.query('ROLLBACK TO SAVEPOINT row');
 }
 await client.query('ROLLBACK');
 assert.deepEqual(problems,[]);
 assert.equal(refused,guards.length);
 assert.equal(allowed,guards.length);
});

// The three conditional shapes the generic sweep above cannot reach: a closed-state
// guard, an UPDATE OF column guard, and the subquery WHEN that had to move into the
// PL/pgSQL body because PostgreSQL forbids a subquery in a trigger WHEN clause.
test('named conditional triggers: closed state, UPDATE OF, and the subquery guard',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 for(const row of (await client.query(`SELECT conrelid::regclass::text AS rel,conname FROM pg_constraint c JOIN pg_class k ON k.oid=c.conrelid JOIN pg_namespace n ON n.oid=k.relnamespace WHERE c.contype='f' AND n.nspname='${name}'`)).rows)
  await client.query(`ALTER TABLE ${row.rel} DROP CONSTRAINT "${row.conname}"`);
 const shapes=new Map(translated.units.filter(u=>u.kind==='table').map(u=>[u.name,tableShape(u.source)]));
 const message=n=>translated.units.find(u=>u.kind==='trigger'&&u.name===n).message;
 const seed=async(table,overrides={})=>{
  const shape=shapes.get(table);
  const columns=[...new Set([...shape.required.map(c=>c.name),...Object.keys(overrides)])];
  const values=columns.map((c,i)=>c in overrides?overrides[c]:literal(shape.columns.find(x=>x.name===c),shape.constraints,i));
  await client.query(`INSERT INTO "${table}"(${columns.map(c=>`"${c}"`).join(',')}) VALUES(${values.join(',')})`);
 };
 const refuses=async(sql,expected)=>{
  await client.query('SAVEPOINT a');
  await assert.rejects(()=>client.query(sql),e=>{assert.equal(e.message,expected);return true;});
  await client.query('ROLLBACK TO SAVEPOINT a');
 };
 await client.query('BEGIN');

 // WHEN OLD.status='Cancelled' AND NEW.status!='Cancelled'
 await seed('recurring_intentions',{id:`'r1'`,status:`'Cancelled'`});
 await refuses(`UPDATE recurring_intentions SET status='Active' WHERE id='r1'`,message('recurring_intention_cancelled'));
 await client.query(`UPDATE recurring_intentions SET status='Cancelled' WHERE id='r1'`);

 // BEFORE UPDATE OF write_attempted ... WHEN OLD.write_attempted=1 AND NEW.write_attempted IS NOT 1
 await seed('messaging_recipients',{id:`'m1'`,write_attempted:'1'});
 await refuses(`UPDATE messaging_recipients SET write_attempted=0 WHERE id='m1'`,message('messaging_recipient_attempt_retained'));

 // WHEN EXISTS(SELECT ...) -- evaluated inside the trigger function
 await seed('mailchimp_contact_sync_intents',{id:`'i1'`});
 await client.query(`UPDATE mailchimp_contact_sync_intents SET status=status WHERE id='i1'`);   // no disposition yet: allowed
 await seed('mailchimp_contact_sync_dispositions',{intent_id:`'i1'`});
 await refuses(`UPDATE mailchimp_contact_sync_intents SET status=status WHERE id='i1'`,message('mailchimp_contact_sync_closed_immutable'));

 await client.query('ROLLBACK');
});

// SQLite rowid decides the order every collection is returned in; the surrogate
// has to reproduce insertion order exactly.
test('the rowid surrogate reproduces SQLite insertion order',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const records=translated.units.find(u=>u.kind==='table'&&u.name==='records');
 assert.ok(records,'the records table is the one app.js reads with ORDER BY rowid');
 assert.deepEqual(records.columns,['collection','id','data']);
 for(const sql of records.statements)await client.query(sql);
 // positional INSERT, exactly as the application writes it, with no value for the
 // surrogate: PostgreSQL supplies it because the column is appended last
 for(const id of ['c','a','b'])
  await client.query(`INSERT INTO records VALUES('constituents','${id}','{}')`);
 assert.deepEqual((await client.query(`SELECT id FROM records WHERE collection='constituents' ORDER BY __rowid`)).rows.map(r=>r.id),['c','a','b']);
 assert.deepEqual((await client.query(`SELECT id FROM records WHERE collection='constituents' ORDER BY __rowid DESC`)).rows.map(r=>r.id),['b','a','c']);
});

// Hazard 1. SQLite compares TEXT as bytes; this container is glibc, like Neon, so a
// column without COLLATE "C" sorts by locale here. Both halves are asserted: the
// translated schema matches SQLite, and the untranslated collation really differs.
const MIXED=['Zebra','apple','Banana','banana','10 Downing','9 Elms','_underscore','-dash','~tilde','(paren)','Émile','émile','Eve','zoë','Zoe','Ωmega','日本','😀','','a b','a-b','ab','A'];
test('TEXT ordering on the glibc container matches SQLite byte order exactly',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 assert.deepEqual((await client.query("SELECT x FROM (VALUES ('apple'),('Banana'),('Zebra')) v(x) ORDER BY x")).rows.map(r=>r.x),['apple','Banana','Zebra'],'this container must sort by locale, or it cannot prove anything');
 const ddl='CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT)';
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(ddl);
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 for(const sql of translateDdl(ddl.replace('people','people_locale'),{strict:true,textCollation:null}).statements)await client.query(sql);
 for(const [i,value] of MIXED.entries()){
  db.prepare('INSERT INTO people VALUES(?,?,?)').run(`p${String(i).padStart(2,'0')}`,value,i%3?value:null);
  for(const table of ['people','people_locale'])await client.query(`INSERT INTO ${table}(id,name,note) VALUES($1,$2,$3)`,[`p${String(i).padStart(2,'0')}`,value,i%3?value:null]);
 }
 // the shapes the application issues: app.js:334 ORDER BY name, tenantAdministration.js:319 ORDER BY name,id
 for(const sql of ['SELECT id,name FROM people ORDER BY name','SELECT id,name FROM people ORDER BY name,id','SELECT id,name FROM people ORDER BY name DESC,id','SELECT note FROM people ORDER BY note DESC','SELECT id FROM people WHERE name>? ORDER BY lower(name),id','SELECT max(name) AS hi,min(name) AS lo FROM people']){
  const params=sql.includes('?')?['Zebra']:[];
  const expected=db.prepare(sql).all(...params),actual=(await client.query(translateQuery(sql),params)).rows;
  assert.deepEqual(actual,expected.map(r=>({...r})),sql);
 }
 const sqliteOrder=db.prepare('SELECT name FROM people ORDER BY name').all().map(r=>r.name);
 assert.deepEqual(sqliteOrder.slice(0,3),['','(paren)','-dash']);
 assert.notDeepEqual((await client.query('SELECT name FROM people_locale ORDER BY name')).rows.map(r=>r.name),sqliteOrder,'without COLLATE "C" the glibc container reorders');
});

test('COLLATE "C" leaves equality and UNIQUE exactly as SQLite has them',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const ddl='CREATE TABLE codes(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,label TEXT)';
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(ddl);
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 await client.query('BEGIN');
 const attempts=[['a','apple'],['b','Apple'],['c','APPLE'],['d','apple'],['e','Émile'],['f','émile'],['g','Émile'],['h','e\u0301'],['i','\u00e9'],['j',''],['k','']];
 const outcomes={sqlite:[],postgres:[]};
 for(const [id,code] of attempts){
  try{db.prepare('INSERT INTO codes(id,code) VALUES(?,?)').run(id,code);outcomes.sqlite.push('ok');}catch{outcomes.sqlite.push('duplicate');}
  await client.query('SAVEPOINT s');
  try{await client.query('INSERT INTO codes(id,code) VALUES($1,$2)',[id,code]);outcomes.postgres.push('ok');await client.query('RELEASE SAVEPOINT s');}
  catch(e){assert.equal(e.code,'23505');outcomes.postgres.push('duplicate');await client.query('ROLLBACK TO SAVEPOINT s');}
 }
 assert.deepEqual(outcomes.postgres,outcomes.sqlite);
 assert.deepEqual(outcomes.sqlite,['ok','ok','ok','duplicate','ok','ok','duplicate','ok','ok','ok','duplicate']);
 for(const probe of ['apple','APPLE','émile','\u00e9','e\u0301',''])
  assert.deepEqual((await client.query(translateQuery('SELECT id FROM codes WHERE code=? ORDER BY id'),[probe])).rows,db.prepare('SELECT id FROM codes WHERE code=? ORDER BY id').all(probe).map(r=>({...r})),probe);
});

// Recorded, not fixed: the two COLLATE NOCASE columns keep their ICU mapping by
// decision, and ICU is not SQLite NOCASE. SQLite NOCASE folds ASCII letters only
// and otherwise compares bytes; ICU level2 folds every script's case and orders
// punctuation, symbols and digits by the Unicode collation algorithm.
test('recorded divergence: COLLATE NOCASE ordering and non-ASCII equality differ from SQLite',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const ddl='CREATE TABLE households(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE)';
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(ddl);
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 const rows=['b','A','_x','1a','É','e','Zed','zebra',''];
 for(const [i,value] of rows.entries()){db.prepare('INSERT INTO households VALUES(?,?)').run('h'+i,value);await client.query('INSERT INTO households(id,name) VALUES($1,$2)',['h'+i,value]);}
 // ASCII case-insensitive equality agrees -- the identity.js:38 duplicate-household guard
 assert.throws(()=>db.prepare('INSERT INTO households VALUES(?,?)').run('dup','ZEBRA'),/UNIQUE/);
 await assert.rejects(client.query('INSERT INTO households(id,name) VALUES($1,$2)',['dup','ZEBRA']),e=>e.code==='23505');
 assert.equal(db.prepare('SELECT id FROM households WHERE name=?').get('ZED').id,(await client.query('SELECT id FROM households WHERE name=$1',['ZED'])).rows[0].id);
 // identity.js:33 ORDER BY name,id: same rows, different order
 const sql='SELECT name FROM households ORDER BY name,id';
 assert.deepEqual(db.prepare(sql).all().map(r=>r.name),['','1a','_x','A','b','e','zebra','Zed','É']);
 assert.deepEqual((await client.query(translateQuery(sql))).rows.map(r=>r.name),['','_x','1a','A','b','e','É','zebra','Zed']);
 // and non-ASCII case: SQLite treats É/é as different names, ICU as the same one
 db.prepare('INSERT INTO households VALUES(?,?)').run('lower-e-acute','é');
 await assert.rejects(client.query('INSERT INTO households(id,name) VALUES($1,$2)',['lower-e-acute','é']),e=>e.code==='23505');
});

// Hazard: int4 caps integer cents at 2,147,483,647 while the app validates up to 1e12.
test('BIGINT by default: a 1e12-cent amount round-trips through the synchronous driver as a JS number',async t=>{
 const client=await connect();
 const name=await schema(client);
 const db=await createSyncPostgres({url:URL});
 t.after(async()=>{db.close();await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 db.exec(`SET search_path TO ${name},public`);
 const ddl="CREATE TABLE gifts(id TEXT PRIMARY KEY,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),status TEXT NOT NULL)";
 for(const sql of translateDdl(ddl,{strict:true}).statements)db.exec(sql);
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(ddl);
 for(const [id,cents] of [['g1',1e12],['g2',1e12-1],['g3',2147483648]]){
  sqlite.prepare('INSERT INTO gifts VALUES(?,?,?)').run(id,cents,'Posted');
  db.prepare(translateQuery('INSERT INTO gifts(id,amount_cents,status) VALUES(?,?,?)')).run(id,cents,'Posted');
 }
 for(const sql of ['SELECT id,amount_cents FROM gifts ORDER BY id','SELECT SUM(amount_cents) AS cents,MAX(amount_cents) AS top FROM gifts']){
  const rows=db.prepare(translateQuery(sql)).all();
  assert.deepEqual(rows.map(r=>({...r})),sqlite.prepare(sql).all().map(r=>({...r})),sql);
 }
 const row=db.prepare(translateQuery('SELECT amount_cents FROM gifts WHERE id=?')).get('g1');
 assert.equal(row.amount_cents,1e12);assert.equal(typeof row.amount_cents,'number');
 // the old int4 default would have refused the same value
 for(const sql of translateDdl(ddl.replace('gifts','gifts_int4'),{strict:true,integerType:'INTEGER'}).statements)await client.query(sql);
 await assert.rejects(client.query(`INSERT INTO ${name}.gifts_int4(id,amount_cents,status) VALUES('g1',1000000000000,'Posted')`),/integer out of range/);
});

// Foreign keys stay enforced per statement by default; DEFERRABLE only means a
// transaction may choose to defer them to COMMIT.
test('DEFERRABLE INITIALLY IMMEDIATE foreign keys still refuse immediately, and defer only on request',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const ddl='CREATE TABLE parents(id TEXT PRIMARY KEY);CREATE TABLE children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE RESTRICT)';
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 await client.query("INSERT INTO parents(id) VALUES('p1')");
 await assert.rejects(client.query("INSERT INTO children(id,parent_id) VALUES('c1','missing')"),e=>e.code==='23503');
 await client.query('BEGIN');
 await assert.rejects(client.query("INSERT INTO children(id,parent_id) VALUES('c1','missing')"),e=>e.code==='23503','immediate inside a transaction too');
 await client.query('ROLLBACK');
 // deferred: the child may precede its parent inside one transaction
 await client.query('BEGIN');
 await client.query('SET CONSTRAINTS ALL DEFERRED');
 await client.query("INSERT INTO children(id,parent_id) VALUES('c2','p2')");
 await client.query("INSERT INTO parents(id) VALUES('p2')");
 await client.query('COMMIT');
 // but a reference still dangling at COMMIT is refused
 await client.query('BEGIN');
 await client.query('SET CONSTRAINTS ALL DEFERRED');
 await client.query("INSERT INTO children(id,parent_id) VALUES('c3','never')");
 await assert.rejects(client.query('COMMIT'),e=>e.code==='23503');
 assert.deepEqual((await client.query('SELECT id FROM children ORDER BY id')).rows.map(r=>r.id),['c2']);
});

// Hazard 5 over the WHOLE real schema: for every table, SELECT * (expanded through
// columnsOf) and PRAGMA table_info name exactly SQLite's columns, in SQLite's order,
// and never the rowid surrogate.
test('SELECT * and PRAGMA table_info expose exactly SQLite\'s columns for every real table',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 const catalog=new Map();
 for(const r of (await client.query(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='${name}' AND column_name<>'__rowid' GROUP BY 1`)).rows)catalog.set(r.table_name,r.columns);
 const columnsOf=table=>catalog.get(table);
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 sqlite.exec(translated.units.map(u=>u.source).join(';\n')+';');
 const tables=translated.units.filter(u=>u.kind==='table').map(u=>u.name);
 assert.equal(tables.length,160);
 const problems=[];
 for(const table of tables){
  const expected=sqlite.prepare(`SELECT * FROM "${table}"`).columns().map(c=>c.name);
  const sql=translateQuery(`SELECT * FROM "${table}"`,{columnsOf});
  const {fields}=await client.query(sql);
  const actual=fields.map(f=>f.name);
  if(JSON.stringify(actual)!==JSON.stringify(expected))problems.push(`${table}: SELECT * ${actual} != ${expected}`);
  const info=(await client.query(translateQuery(`PRAGMA table_info(${table})`))).rows;
  const sqliteInfo=sqlite.prepare(`PRAGMA table_info(${table})`).all();
  if(JSON.stringify(info.map(c=>[c.cid,c.name]))!==JSON.stringify(sqliteInfo.map(c=>[c.cid,c.name])))problems.push(`${table}: table_info ${info.map(c=>c.name)} != ${sqliteInfo.map(c=>c.name)}`);
 }
 assert.deepEqual(problems,[]);
});

// server/idempotency.js. Its CHECKs must refuse exactly what SQLite refuses.
test('idempotency_requests executes and its CHECK constraints refuse as SQLite does',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const units=translated.units.filter(u=>u.name==='idempotency_requests'||u.name==='idempotency_requests_expiry');
 assert.deepEqual(units.map(u=>u.kind).sort(),['index','table']);
 for(const u of units)for(const sql of u.statements)await client.query(sql);
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const u of units)sqlite.exec(u.source);
 const insert='INSERT INTO idempotency_requests(id,tenant_id,user_id,method,path,key_hash,fingerprint,state,lease_token,reserved_at,lease_expires,expires_at,body_stored) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
 const row=(id,state,body,key=id)=>[id,'t','u','POST','/api/gifts',key,'f',state,'l',1,2,1e12,body];
 await client.query('BEGIN');
 const outcomes={sqlite:[],postgres:[]};
 for(const values of [row('a','InProgress',0),row('b','Completed',1),row('c','Pending',0),row('d','Completed',2),row('e','completed',0),row('f','InProgress',0,'a')]){
  try{sqlite.prepare(insert).run(...values);outcomes.sqlite.push('ok');}catch(e){outcomes.sqlite.push(/UNIQUE/.test(e.message)?'unique':'check');}
  await client.query('SAVEPOINT s');
  try{await client.query(translateQuery(insert),values);outcomes.postgres.push('ok');await client.query('RELEASE SAVEPOINT s');}
  catch(e){outcomes.postgres.push(e.code==='23505'?'unique':e.code==='23514'?'check':e.message);await client.query('ROLLBACK TO SAVEPOINT s');}
 }
 await client.query('ROLLBACK');
 assert.deepEqual(outcomes.postgres,outcomes.sqlite);
 assert.deepEqual(outcomes.sqlite,['ok','ok','check','check','check','unique']);
 assert.equal((await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='${name}' AND indexname='idempotency_requests_expiry'`)).rows[0].indexdef.endsWith('(expires_at)'),true);
});

// An expression index is only used when the query spells the index expression. Every
// JSON index in the real schema, loaded at scale, answering its real lookup through the
// translator, must be an index scan on that index -- including under a generic plan,
// which is what a prepared statement with parameters gets.
test('every JSON expression index serves its real lookup with an index scan',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('DEALLOCATE ALL').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const wanted=['records_gift_source_reference','records_gift_pledge','records_gift_grant','records_gift_acknowledgment_communication','records_shift_reservation_shift','records_shift_reservation_constituent','records_volunteer_time_volunteer','marketing_native_primary_email','marketing_native_unicode_email','peer_one_active_fundraiser'];
 for(const u of translated.units.filter(u=>(u.kind==='table'&&['records','peer_fundraisers'].includes(u.name))||(u.kind==='index'&&wanted.includes(u.name))))for(const sql of u.statements)await client.query(sql);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='${name}' AND indexname=ANY($1)`,[wanted])).rows[0].n,wanted.length);
 await client.query(`INSERT INTO records(collection,id,data) SELECT 'gifts','g'||i,json_build_object('pledgeId','pl-'||i,'grantId','gr-'||i,'externalRef','ref-'||i,'acknowledgment',json_build_object('communicationId','cm-'||i),'amount',i)::text FROM generate_series(1,30000) i;
  INSERT INTO records(collection,id,data) SELECT 'shiftReservations','s'||i,json_build_object('shiftId','sh-'||(i%500),'constituentId','p-'||i)::text FROM generate_series(1,10000) i;
  INSERT INTO records(collection,id,data) SELECT 'volunteerTime','v'||i,json_build_object('volunteerId','v-'||(i%900))::text FROM generate_series(1,10000) i;
  INSERT INTO records(collection,id,data) SELECT 'constituents','p'||i,json_build_object('email',CASE WHEN i%1000=0 THEN 'ü'||i||'@example.test' ELSE 'P'||i||'@example.test' END)::text FROM generate_series(1,10000) i;
  INSERT INTO peer_fundraisers(id,version,data,created_at,updated_at) SELECT 'f'||i,1,json_build_object('status',CASE WHEN i%2=0 THEN 'Active' ELSE 'Closed' END,'campaignId','c-'||(i%10),'constituentId','p-'||i)::text,'x','x' FROM generate_series(1,20000) i;
  ANALYZE records;ANALYZE peer_fundraisers`);
 const surviving="(json_type(data,'$.mergedInto') IS NULL OR json_type(data,'$.mergedInto')='null' OR (json_type(data,'$.mergedInto') IN ('false','integer','real') AND json_extract(data,'$.mergedInto')=0) OR (json_type(data,'$.mergedInto')='text' AND json_extract(data,'$.mergedInto')=''))";
 const lookup=path=>`SELECT data FROM records WHERE collection=? AND json_extract(data,'$.${path}')=? ORDER BY rowid`;
 // the statements the modules issue (recordLookups.js inlines the collection literal)
 const cases=[
  ['records_gift_source_reference',"SELECT data FROM records WHERE collection='gifts' AND typeof(json_extract(data,'$.externalRef'))='text' AND json_extract(data,'$.externalRef')<>'' AND json_extract(data,'$.externalRef')=? AND id<>?",['ref-77','g1'],1],
  ['records_gift_pledge',lookup('pledgeId').replace('collection=?',"collection='gifts'"),['pl-77'],1],
  ['records_gift_grant',lookup('grantId').replace('collection=?',"collection='gifts'"),['gr-77'],1],
  ['records_gift_acknowledgment_communication',lookup('acknowledgment.communicationId').replace('collection=?',"collection='gifts'"),['cm-77'],1],
  ['records_shift_reservation_shift',lookup('shiftId').replace('collection=?',"collection='shiftReservations'"),['sh-77'],20],
  ['records_shift_reservation_constituent',lookup('constituentId').replace('collection=?',"collection='shiftReservations'"),['p-77'],1],
  ['records_volunteer_time_volunteer',lookup('volunteerId').replace('collection=?',"collection='volunteerTime'"),['v-77'],12],
  ['marketing_native_primary_email',`SELECT id FROM records WHERE collection='constituents' AND lower(json_extract(data,'$.email'))=? AND ${surviving} LIMIT 2`,['p77@example.test'],1],
  ['marketing_native_unicode_email',`SELECT json_extract(data,'$.email') AS email FROM records INDEXED BY marketing_native_unicode_email WHERE collection='constituents' AND typeof(json_extract(data,'$.email'))='text' AND json_extract(data,'$.email') GLOB '*[^ -~]*' AND ${surviving}`,[],10],
  ['peer_one_active_fundraiser',"SELECT 1 FROM peer_fundraisers WHERE json_extract(data,'$.status')='Active' AND json_extract(data,'$.campaignId')=? AND json_extract(data,'$.constituentId')=?",['c-8','p-78'],1],
 ];
 const problems=[];
 for(const mode of ['auto','force_generic_plan']){
  await client.query(`SET plan_cache_mode=${mode}`);
  for(const [index,sql,params,rows] of cases){
   const text=translateQuery(sql);
   await client.query('DEALLOCATE ALL');
   await client.query(`PREPARE lookup AS ${text}`);
   const plan=(await client.query(`EXPLAIN EXECUTE lookup${params.length?`(${params.map(p=>`'${p}'`).join(',')})`:''}`)).rows.map(r=>r['QUERY PLAN']).join('\n');
   if(!new RegExp(`(Index Scan|Index Only Scan|Bitmap Index Scan) (using|on) ${index}\\b`).test(plan)||/Seq Scan/.test(plan))problems.push(`${mode} ${index}:\n${plan}`);
   const found=(await client.query(text,params)).rowCount;
   if(found!==rows)problems.push(`${index}: ${found} rows, expected ${rows}`);
  }
 }
 assert.deepEqual(problems,[]);
});

// sqlite_schema.sql reads back SQLite's own text for every object SQLite stores one for,
// ALTER TABLE ADD COLUMN rewrites included.
test('sqlite_schema returns the same type, name, table and sql as SQLite for the real schema',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 const listing="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
 const expected=reference.db.prepare(listing).all().map(r=>({...r}));
 const actual=new Map((await client.query(translateQuery(listing))).rows.map(r=>[r.type+':'+r.name,r]));
 const problems=expected.filter(r=>JSON.stringify(actual.get(r.type+':'+r.name))!==JSON.stringify(r)).map(r=>`${r.type} ${r.name}: ${JSON.stringify(actual.get(r.type+':'+r.name)?.sql)?.slice(0,160)} != ${JSON.stringify(r.sql).slice(0,160)}`);
 assert.deepEqual(problems,[]);
 assert.equal(expected.length,160+63+233);
});

// tests/document-migration-reporting.test.js:67 reads a guard's sql, drops the trigger, and
// re-executes the sql later. The text must go back through the translator and refuse again.
test('a guard trigger read from sqlite_schema, dropped and re-executed refuses again, schema-qualified or not',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const ddl=`CREATE TABLE IF NOT EXISTS guarded(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS guarded_no_update BEFORE UPDATE ON guarded BEGIN SELECT RAISE(ABORT,'Guarded rows are immutable'); END;CREATE TRIGGER qualified_no_delete BEFORE DELETE ON ${name}.guarded BEGIN SELECT RAISE(ABORT,'Guarded rows are retained'); END`;
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 await client.query("INSERT INTO guarded(id,tenant_id) VALUES('g','t1')");
 await assert.rejects(client.query('DELETE FROM guarded'),{message:'Guarded rows are retained'});
 const saved=(await client.query(translateQuery("SELECT sql FROM sqlite_schema WHERE name='guarded_no_update'"))).rows[0].sql;
 assert.equal(saved,"CREATE TRIGGER guarded_no_update BEFORE UPDATE ON guarded BEGIN SELECT RAISE(ABORT,'Guarded rows are immutable'); END");
 await client.query('DROP TRIGGER guarded_no_update ON guarded');
 await client.query("UPDATE guarded SET tenant_id='t2'");
 for(const sql of translateDdl(saved,{strict:true}).statements)await client.query(sql);
 await assert.rejects(client.query("UPDATE guarded SET tenant_id='t1'"),{message:'Guarded rows are immutable'});
 assert.equal((await client.query('SELECT tenant_id FROM guarded')).rows[0].tenant_id,'t2');
});

// The fault-injection shapes the integrity tests install, executed for real: each must do
// on PostgreSQL what it does on SQLite.
test('UPDATE, INSERT and mixed trigger bodies change the same rows as SQLite and fail at COMMIT where SQLite does',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query('ROLLBACK').catch(()=>{});await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const ddl=`CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
  CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,record_id TEXT);
  CREATE TABLE commit_parent(id TEXT PRIMARY KEY);
  CREATE TABLE commit_child(parent_id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE TRIGGER synthetic_hosted_fault AFTER INSERT ON records WHEN NEW.collection='gifts' BEGIN UPDATE records SET data=json_set(data,'$.amount',10002,'$.allocations[0].amount',10002) WHERE collection=NEW.collection AND id=NEW.id; END;
  CREATE TRIGGER synthetic_designation_drift AFTER INSERT ON audit WHEN NEW.action='link' BEGIN UPDATE records SET data=json_set(data,'$.version',json_extract(data,'$.version')+1,'$.parentId',json('null')) WHERE collection='designations' AND id=NEW.record_id; END;
  CREATE TRIGGER synthetic_commit_fault AFTER INSERT ON audit WHEN NEW.action='commit' BEGIN INSERT INTO commit_child VALUES('absent'); END;
  CREATE TRIGGER synthetic_mixed BEFORE INSERT ON audit WHEN NEW.action='refuse' BEGIN UPDATE records SET data='{}' WHERE id='d1'; SELECT RAISE(ABORT,'Refused after a write'); END`;
 sqlite.exec(ddl);
 for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
 const both=async(sql,params=[])=>{
  let a,b;
  try{sqlite.prepare(sql).run(...params);a='ok';}catch(e){a=e.message;}
  try{await client.query(translateQuery(sql),params);b='ok';}catch(e){b=e.message;}
  return [a,b];
 };
 const rows=async()=>[sqlite.prepare('SELECT collection,id,data FROM records ORDER BY collection,id').all().map(r=>({...r,data:JSON.parse(r.data)})),(await client.query('SELECT collection,id,data FROM records ORDER BY collection,id')).rows.map(r=>({...r,data:JSON.parse(r.data)}))];
 assert.deepEqual(await both('INSERT INTO records VALUES(?,?,?)',['gifts','g1',JSON.stringify({amount:10001,allocations:[{designationId:'d1',amount:10001}],status:'Posted'})]),['ok','ok']);
 assert.deepEqual(await both('INSERT INTO records VALUES(?,?,?)',['designations','d1',JSON.stringify({version:4,parentId:'p0',name:'Fund'})]),['ok','ok']);
 assert.deepEqual(await both('INSERT INTO audit(action,record_id) VALUES(?,?)',['link','d1']),['ok','ok']);
 const [expected,actual]=await rows();
 assert.deepEqual(actual,expected);
 assert.equal(expected[1].data.amount,10002);assert.equal(expected[1].data.allocations[0].amount,10002);assert.equal(expected[0].data.version,5);assert.equal(expected[0].data.parentId,null);
 // the stored text itself is SQLite's
 assert.deepEqual((await client.query('SELECT data FROM records ORDER BY collection,id')).rows.map(r=>r.data),sqlite.prepare('SELECT data FROM records ORDER BY collection,id').all().map(r=>r.data));
 // BEFORE trigger: the refusal message is identical and its write is rolled back with the statement
 const [a,b]=await both('INSERT INTO audit(action) VALUES(?)',['refuse']);
 assert.equal(a,'Refused after a write');assert.equal(b,'Refused after a write');
 const [e2,a2]=await rows();assert.deepEqual(a2,e2);
 // a deferred foreign key written by a trigger fails at COMMIT on both
 sqlite.exec('BEGIN');sqlite.prepare("INSERT INTO audit(action) VALUES('commit')").run();
 assert.throws(()=>sqlite.exec('COMMIT'),/FOREIGN KEY/);
 await client.query('BEGIN');await client.query("INSERT INTO audit(action) VALUES('commit')");
 await assert.rejects(client.query('COMMIT'),e=>e.code==='23503');
 assert.equal((await client.query("SELECT count(*)::int AS n FROM audit WHERE action='commit'")).rows[0].n,0);
});

// Case-bearing aliases: every aliased SELECT in the real server source, prepared on SQLite
// and run on PostgreSQL through the translator, must name its columns identically.
test('every case-bearing alias in the server source returns SQLite\'s row keys',async t=>{
 const client=await connect();
 const name=await schema(client);
 t.after(async()=>{await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const sql of translated.statements)await client.query(sql);
 const statements=[];
 for(const file of readdirSync(new globalThis.URL('../../server/',import.meta.url)).filter(f=>f.endsWith('.js'))){
  const source=readFileSync(new globalThis.URL(`../../server/${file}`,import.meta.url),'utf8');
  for(const m of source.matchAll(/\b(?:prepare|exec)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)){
   const sql=m[2];
   if(sql.includes('${')||!/^\s*(SELECT|WITH)\b/i.test(sql))continue;
   if(/\bAS\s+[A-Za-z_]*[A-Z][A-Za-z_]*\b/.test(sql.replace(/'(?:[^']|'')*'/g,"''")))statements.push({file,sql:sql.replace(/\\'/g,"'")});
  }
 }
 assert.equal(statements.length,7,statements.map(s=>s.file).join(','));
 const problems=[];
 for(const {file,sql} of statements){
  const expected=reference.db.prepare(sql).columns().map(c=>c.name);
  const text=translateQuery(sql),count=(text.match(/\$\d+/g)||[]).length;
  const {fields}=await client.query(text,new Array(count).fill(null));
  const actual=fields.map(f=>f.name);
  if(JSON.stringify(actual)!==JSON.stringify(expected))problems.push(`${file}: ${actual} != ${expected}`);
 }
 assert.deepEqual(problems,[]);
 assert.ok(statements.some(s=>/AS sourceId/.test(s.sql)));
});

// Every workspace is a schema in one database. The catalog view must stay an index lookup
// in the current schema however many workspaces exist, and must not see their objects.
test('sqlite_schema is an index lookup scoped to the current schema, however many schemas exist',async t=>{
 const client=await connect();
 const name=await schema(client);
 const others=Array.from({length:120},(_,i)=>`${name}_o${i}`);
 t.after(async()=>{for(const o of others)await client.query(`DROP SCHEMA IF EXISTS ${o} CASCADE`);await client.query(`DROP SCHEMA ${name} CASCADE`);await client.end();});
 for(const o of others)await client.query(`CREATE SCHEMA ${o};`+Array.from({length:40},(_,j)=>`CREATE TABLE ${o}.t${j}(id text PRIMARY KEY);`).join('')+`CREATE TABLE ${o}.records(id text)`);
 await client.query(`SET search_path TO ${name},public`);
 await client.query("CREATE TABLE records(id text)");
 const lookup=translateQuery("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'");
 // tenant isolation: another workspace's tables are invisible, including a same-named one
 assert.equal((await client.query(lookup,['records'])).rowCount,1);
 assert.equal((await client.query(lookup,['t0'])).rowCount,0);
 const plan=(await client.query('EXPLAIN '+lookup.replace('$1',"'records'"))).rows.map(r=>r['QUERY PLAN']).join('\n');
 assert.match(plan,/Index Scan using pg_class_relname_nsp_index on pg_class/);
 assert.doesNotMatch(plan,/Seq Scan/);
 // measured against the previous definition on the same catalog
 await client.query(`CREATE VIEW previous_schema AS SELECT 'table'::text AS type, c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')`);
 const time=async(sql,runs=20)=>{const start=performance.now();for(let i=0;i<runs;i++)await client.query(sql,['records']);return (performance.now()-start)/runs;};
 await time(lookup,3);
 const now=await time(lookup),before=await time(lookup.replace('sqlite_schema','previous_schema'));
 t.diagnostic(`sqlite_schema name lookup ${now.toFixed(2)} ms; previous definition ${before.toFixed(2)} ms; ${(await client.query('SELECT count(*)::int AS n FROM pg_class')).rows[0].n} catalog relations`);
 assert.ok(now<before,`${now} < ${before}`);
 assert.ok(now<10,`${now} ms`);
});
