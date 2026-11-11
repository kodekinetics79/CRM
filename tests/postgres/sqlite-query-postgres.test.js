// Differential verification: the same fixture rows loaded into node:sqlite and
// into the LOCAL container, the original SQL run against SQLite and the
// translated SQL against PostgreSQL, and the answers compared.
//
// This file is deliberately OUTSIDE the tests/*.test.js glob that `npm test`
// uses, because it needs the container. Run it with:
//   node --test tests/postgres/sqlite-query-postgres.test.js
// Target is always the local container; never a hosted database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {readFileSync} from 'node:fs';
import {translateQuery,translateExec,translateStatement,SUPPORT_SQL} from '../../server/persistence/sqliteQuery.js';
import {translateDdl,preludeStatements} from '../../server/persistence/sqliteDdl.js';

const URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const SCHEMA='dialect_probe';

const GIFTS=[
 ['gifts','g1',{id:'g1',amount:10001,status:'Posted',type:'Cash',date:'2026-02-01',campaignId:'c1',constituentId:'p1',allocations:[{designationId:'d1',amount:10001}]}],
 ['gifts','g2',{id:'g2',amount:2500,status:'Voided',type:'Cash',date:'2026-02-02',campaignId:'c1',constituentId:'p2',allocations:[{designationId:'d1',amount:2500}]}],
 ['gifts','g3',{id:'g3',amount:700,status:'Posted',type:'Fee payment',date:'2026-03-05',campaignId:'c2',constituentId:'p1',allocations:[{designationId:'d2',amount:600}]}],
 ['constituents','p1',{id:'p1',name:'Ada Lovelace',email:'ada@example.test',mergedInto:null}],
 ['constituents','p2',{id:'p2',name:'Grace Hopper',email:'grace©example.test'}],
 ['constituents','p3',{id:'p3',name:'Merged Person',email:'merged@example.test',mergedInto:'p1'}]
];
const BATCHES=[
 ['b1','crm',JSON.stringify({summary:{rows:3,controlTotals:{cents:13201}},reconciliation:{ok:true,expectedNewControlTotals:1,actualNewControlTotals:1},valid:true,replayed:false})],
 ['b2','csv',JSON.stringify({summary:{rows:0,controlTotals:{cents:0}},reconciliation:{ok:false,expectedNewControlTotals:0,actualNewControlTotals:2},valid:false,replayed:true})]
];

function sqlite(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE records(collection TEXT,id TEXT,data TEXT,PRIMARY KEY(collection,id));CREATE TABLE import_batches(id TEXT PRIMARY KEY,source TEXT,result TEXT);CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT);CREATE TABLE automation_recovery_markers(id TEXT,at TEXT,archive_sha256 TEXT,source_sha256 TEXT)');
 for(const [c,id,data] of GIFTS)db.prepare('INSERT INTO records VALUES(?,?,?)').run(c,id,JSON.stringify(data));
 for(const b of BATCHES)db.prepare('INSERT INTO import_batches VALUES(?,?,?)').run(...b);
 return db;
}

async function postgres(){
 const client=new pg.Client({connectionString:URL});
 await client.connect();
 await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;CREATE SCHEMA ${SCHEMA};`);
 await client.query(`SET search_path TO ${SCHEMA}`);
 await client.query(SUPPORT_SQL);
 await client.query('CREATE TABLE records(collection text,id text,data text,PRIMARY KEY(collection,id));CREATE TABLE import_batches(id text PRIMARY KEY,source text,result text);CREATE TABLE settings(id integer PRIMARY KEY,data text);CREATE TABLE automation_recovery_markers(id text,at text,archive_sha256 text,source_sha256 text)');
 for(const [c,id,data] of GIFTS)await client.query('INSERT INTO records VALUES($1,$2,$3)',[c,id,JSON.stringify(data)]);
 for(const b of BATCHES)await client.query('INSERT INTO import_batches VALUES($1,$2,$3)',b);
 return client;
}

// pg returns int8 and numeric as strings; the driver is expected to install
// type parsers for those. Normalising here keeps this file about the dialect
// and leaves that hazard to work/postgres-type-audit.md, item 1.
const norm=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='string'&&/^-?\d+$/.test(v)?Number(v):v])));

async function bothAgree(t,client,db,sql,params=[]){
 const expected=db.prepare(sql).all(...params);
 const translated=translateQuery(sql);
 const {rows}=await client.query(translated,params);
 assert.deepEqual(norm(rows),norm(expected),`${sql}\n  -> ${translated}`);
 return {rows,translated};
}

test('translated runtime queries return the same answers as SQLite',async t=>{
 const db=sqlite(),client=await postgres();
 t.after(async()=>{await client.query(`DROP SCHEMA ${SCHEMA} CASCADE`);await client.end();db.close();});

 await t.test('json_extract text paths with bound parameters (peerFundraising.js:54)',async()=>{
  await bothAgree(t,client,db,"SELECT id FROM records WHERE collection='gifts' AND json_extract(data,'$.status')=? AND json_extract(data,'$.campaignId')=? ORDER BY id",['Posted','c1']);
 });

 await t.test('a ? inside a literal is not a parameter',async()=>{
  const {rows}=await client.query(translateQuery("SELECT id FROM records WHERE collection='constituents' AND json_extract(data,'$.name')<>'who? me' AND id=? ORDER BY id"),['p1']);
  assert.deepEqual(rows,[{id:'p1'}]);
 });

 await t.test('money aggregation (dataQuality.js:92)',async()=>{
  await bothAgree(t,client,db,"SELECT COUNT(*) AS n,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts' AND COALESCE(json_extract(data,'$.status'),'Posted')<>'Voided' AND COALESCE(json_extract(data,'$.type'),'') NOT IN ('Fee payment','In-kind') AND json_extract(data,'$.date')>=? AND json_extract(data,'$.date')<=?",['2026-01-01','2026-12-31']);
 });

 await t.test('json_each + json_type integrity probe (accountStructure.js:28)',async()=>{
  await bothAgree(t,client,db,"SELECT COUNT(*) AS n FROM records g,json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a WHERE g.collection='gifts' AND (json_type(a.value,'$.amount')<>'integer' OR json_type(a.value,'$.designationId')<>'text' OR json_extract(a.value,'$.amount')<1)");
 });

 await t.test('unaliased derived table with IS NOT (accountStructure.js:29)',async()=>{
  await bothAgree(t,client,db,"SELECT COUNT(*) AS n FROM (SELECT json_extract(g.data,'$.amount') AS amount,(SELECT SUM(json_extract(a.value,'$.amount')) FROM json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a) AS allocated FROM records g WHERE g.collection='gifts' AND COALESCE(json_extract(g.data,'$.status'),'Posted')<>'Voided') WHERE amount IS NOT allocated");
 });

 await t.test('posted gift totals (accountStructure.js:30)',async()=>{
  await bothAgree(t,client,db,"SELECT COUNT(*) AS gifts,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts' AND COALESCE(json_extract(data,'$.status'),'Posted')<>'Voided'");
 });

 await t.test('json booleans survive as 0/1, so Boolean() still discriminates (migration.js:458-460)',async()=>{
  const sql="SELECT id,json_remove(json_extract(result,'$.summary'),'$.controlTotals') AS summary,json_remove(json_extract(result,'$.reconciliation'),'$.expectedNewControlTotals','$.actualNewControlTotals') AS reconciliation,json_extract(result,'$.valid') AS valid,json_extract(result,'$.replayed') AS replayed FROM import_batches ORDER BY id";
  const expected=db.prepare(sql).all(),{rows}=await client.query(translateQuery(sql));
  assert.equal(rows.length,2);
  for(let i=0;i<2;i++){
   assert.equal(Boolean(rows[i].valid),Boolean(expected[i].valid));
   assert.equal(Boolean(rows[i].replayed),Boolean(expected[i].replayed));
   assert.deepEqual(JSON.parse(rows[i].summary),JSON.parse(expected[i].summary));
   assert.deepEqual(JSON.parse(rows[i].reconciliation),JSON.parse(expected[i].reconciliation));
  }
  assert.equal(Boolean(rows[1].valid),false,'a failed batch must not read as valid');
 });

 await t.test('the surviving-constituent guard (marketingResponses.js:36-37)',async()=>{
  const surviving="(json_type(data,'$.mergedInto') IS NULL OR json_type(data,'$.mergedInto')='null' OR (json_type(data,'$.mergedInto') IN ('false','integer','real') AND json_extract(data,'$.mergedInto')=0) OR (json_type(data,'$.mergedInto')='text' AND json_extract(data,'$.mergedInto')=''))";
  await bothAgree(t,client,db,"SELECT id FROM records WHERE collection='constituents' AND lower(json_extract(data,'$.email'))=? AND "+surviving+' ORDER BY id LIMIT 2',['ada@example.test']);
  await bothAgree(t,client,db,"SELECT id FROM records WHERE collection='constituents' AND "+surviving+' ORDER BY id');
 });

 await t.test('typeof(json_extract(...)) + GLOB + INDEXED BY (marketingResponses.js:38)',async()=>{
  await bothAgree(t,client,db,"SELECT json_extract(data,'$.email') AS email FROM records WHERE collection='constituents' AND typeof(json_extract(data,'$.email'))='text' AND json_extract(data,'$.email') GLOB '*[^ -~]*' ORDER BY email");
  // the INDEXED BY form the real site uses; the index does not exist here, which
  // is the point — stripping the hint is what lets the statement run at all.
  const {rows}=await client.query(translateQuery("SELECT json_extract(data,'$.email') AS email FROM records INDEXED BY marketing_native_unicode_email WHERE collection='constituents' AND typeof(json_extract(data,'$.email'))='text' AND json_extract(data,'$.email') GLOB '*[^ -~]*'"));
  assert.deepEqual(rows,[{email:'grace©example.test'}]);
 });

 await t.test('json_each over a bound parameter with a predicate operand (eventHelperAccess.js:41-43)',async()=>{
  const ddl='CREATE TABLE event_tickets(id TEXT,event_id TEXT,constituent_id TEXT,status TEXT,version INTEGER,checked_in_at TEXT)';
  db.exec(ddl);await client.query(ddl.replace(/TEXT/g,'text').replace('INTEGER','integer'));
  const tickets=[['t1','e1','p1','Issued',1,'2026-02-01T10:00:00.000Z'],['t2','e1','p2','Issued',1,null]];
  for(const row of tickets){db.prepare('INSERT INTO event_tickets VALUES(?,?,?,?,?,?)').run(...row);await client.query('INSERT INTO event_tickets VALUES($1,$2,$3,$4,$5,$6)',row);}
  const roster=JSON.stringify([{constituentId:'p1',checkedIn:true},{constituentId:'p2',checkedIn:false}]);
  const sql="SELECT t.id,t.version,t.checked_in_at,json_extract(c.data,'$.name') AS attendee_name FROM event_tickets t JOIN records c ON c.collection='constituents' AND c.id=t.constituent_id"
   +" WHERE t.event_id=? AND t.status='Issued' AND t.id>? AND json_extract(c.data,'$.mergedInto') IS NULL"
   +" AND EXISTS(SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.constituentId')=t.constituent_id AND COALESCE(json_extract(r.value,'$.checkedIn'),0)=(t.checked_in_at IS NOT NULL)) ORDER BY t.id";
  await bothAgree(t,client,db,sql,['e1','',roster]);
  const {rows}=await client.query(translateQuery(sql),['e1','',roster]);
  assert.deepEqual(rows.map(r=>r.id),['t1','t2'],'both roster rows agree with their check-in state');
 });

 await t.test('nested json path through json_each (constituentTimeline.js:58)',async()=>{
  await client.query("CREATE TABLE correspondence_preparations(id text,snapshot text,at text)");
  db.exec('CREATE TABLE correspondence_preparations(id TEXT,snapshot TEXT,at TEXT)');
  const snapshot=JSON.stringify({items:[{recipient:{id:'p1',name:'Ada'}},{recipient:{id:'p2'}}]});
  await client.query('INSERT INTO correspondence_preparations VALUES($1,$2,$3)',['cp1',snapshot,'2026-02-01']);
  db.prepare('INSERT INTO correspondence_preparations VALUES(?,?,?)').run('cp1',snapshot,'2026-02-01');
  await bothAgree(t,client,db,"SELECT id FROM correspondence_preparations WHERE EXISTS(SELECT 1 FROM json_each(snapshot,'$.items') i WHERE json_extract(i.value,'$.recipient.id')=?) ORDER BY at,id",['p2']);
 });

 await t.test('INSERT OR IGNORE is idempotent (app.js:101)',async()=>{
  const sql='INSERT OR IGNORE INTO settings VALUES(1,?)';
  const first=await client.query(translateQuery(sql),['{"organizationName":"Wimblo"}']);
  const second=await client.query(translateQuery(sql),['{"organizationName":"Replaced"}']);
  assert.equal(first.rowCount,1);assert.equal(second.rowCount,0);
  const {rows}=await client.query('SELECT data FROM settings WHERE id=1');
  assert.equal(rows[0].data,'{"organizationName":"Wimblo"}');
 });

 await t.test('sqlite_master/sqlite_schema queries answer with the expected columns',async()=>{
  const present=await client.query(translateQuery("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=$1"),['records']);
  assert.equal(present.rowCount,1);
  const absent=await client.query(translateQuery("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=$1"),['no_such_table']);
  assert.equal(absent.rowCount,0);
  // `events` vs `event_tickets`: a glibc locale would swap them; relname is type name, collation "C", and the cast keeps it
  await client.query('CREATE TABLE events(id text)');db.exec('CREATE TABLE events(id TEXT)');
  const listing="SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
  const names=await client.query(translateQuery(listing));
  assert.deepEqual(names.rows.map(r=>r.name),db.prepare(listing).all().map(r=>r.name));
  assert.ok(names.rows.some(r=>r.name==='records'));
  assert.deepEqual(names.rows.map(r=>r.name).filter(n=>n.startsWith('event')),['event_tickets','events']);
  const full=await client.query(translateQuery("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name"));
  assert.deepEqual(Object.keys(full.rows[0]),['type','name','tbl_name','sql']);
  // backup.js:75 reads .sql off a trigger row and re-executes it
  await client.query("CREATE FUNCTION probe_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit is append-only'; END $$;CREATE TRIGGER probe_no_update BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION probe_guard()");
  const trigger=await client.query(translateQuery("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name=$1 AND tbl_name=$2"),['probe_no_update','records']);
  assert.equal(trigger.rows[0].name,'probe_no_update');
  assert.match(trigger.rows[0].sql,/CREATE TRIGGER probe_no_update/);
 });

 await t.test('PRAGMA table_info feeds the additive migrations (backup.js:116, app.js:98)',async()=>{
  const expected=db.prepare('PRAGMA table_info(automation_recovery_markers)').all();
  const {rows}=await client.query(translateQuery('PRAGMA table_info(automation_recovery_markers)'));
  assert.deepEqual(rows.map(c=>c.name),expected.map(c=>c.name));
  assert.equal(rows.map(c=>c.name).join(','),'id,at,archive_sha256,source_sha256');
  assert.equal(rows.every(c=>c.type==='TEXT'),true);
  // the app.js:98 / platform.js:50 shape: does the column exist yet?
  const columns=new Set((await client.query(translateQuery('PRAGMA table_info(records)'))).rows.map(c=>c.name));
  assert.equal(columns.has('collection'),true);
  assert.equal(columns.has('data_mode'),false);
  assert.equal((await client.query(translateQuery('PRAGMA table_info(no_such_table)'))).rowCount,0);
 });

 await t.test('ORDER BY rowid reproduces insertion order through the __rowid surrogate (app.js:104)',async()=>{
  // sqliteDdl.js appends `__rowid BIGINT GENERATED ALWAYS AS IDENTITY`; this is
  // the runtime half of that contract.
  await client.query('CREATE TABLE ordered(id text,at text,"__rowid" bigint GENERATED ALWAYS AS IDENTITY)');
  db.exec('CREATE TABLE ordered(id TEXT,at TEXT)');
  for(const row of [['c','2026-01-01'],['a','2026-01-01'],['b','2026-01-01']]){
   db.prepare('INSERT INTO ordered(id,at) VALUES(?,?)').run(...row);
   await client.query('INSERT INTO ordered(id,at) VALUES($1,$2)',row);
  }
  await bothAgree(t,client,db,'SELECT id FROM ordered ORDER BY rowid');
  await bothAgree(t,client,db,'SELECT id FROM ordered ORDER BY at,rowid');
  await bothAgree(t,client,db,'SELECT id FROM ordered ORDER BY at DESC,rowid DESC LIMIT 1');
 });

 await t.test('NULL ordering matches SQLite in both directions, though the engines differ underneath',async()=>{
  // work/postgres-type-audit.md, hazard 3. The raw engine behaviour is still
  // asserted, so a PostgreSQL that changed it would not go unnoticed.
  await client.query("CREATE TABLE nulls(a text,b text)");
  db.exec("CREATE TABLE nulls(a TEXT,b TEXT)");
  for(const row of [['x','2026-01-01'],['y',null],['z','2026-02-01'],['w',null]]){
   db.prepare('INSERT INTO nulls VALUES(?,?)').run(...row);
   await client.query('INSERT INTO nulls VALUES($1,$2)',row);
  }
  const desc='SELECT a FROM nulls ORDER BY b DESC,a',asc='SELECT a FROM nulls ORDER BY b ASC,a';
  assert.deepEqual(db.prepare(desc).all().map(r=>r.a),['z','x','w','y'],'SQLite DESC puts NULL last');
  assert.deepEqual((await client.query(desc)).rows.map(r=>r.a),['w','y','z','x'],'untranslated PostgreSQL DESC puts NULL first');
  assert.deepEqual(db.prepare(asc).all().map(r=>r.a),['w','y','x','z'],'SQLite ASC puts NULL first');
  assert.deepEqual((await client.query(asc)).rows.map(r=>r.a),['x','z','w','y'],'untranslated PostgreSQL ASC puts NULL last');
  for(const sql of [desc,asc,'SELECT a FROM nulls ORDER BY b,a DESC','SELECT a,(SELECT n.a FROM nulls n ORDER BY n.b DESC,n.a LIMIT 1) AS top FROM nulls ORDER BY b DESC,a',
   'SELECT a,row_number() OVER (ORDER BY b,a) AS rn FROM nulls ORDER BY a',"SELECT string_agg(a,',' ORDER BY b DESC,a) AS s FROM nulls",'SELECT a FROM nulls ORDER BY b IS NULL,b DESC,a'])
   await bothAgree(t,client,db,sql);
 });

 await t.test('the separation-of-duties approval in force is the same row on both engines (tenantAdministration.js:297)',async()=>{
  // The real DDL, read out of the module, translated by sqliteDdl.js.
  const source=readFileSync(new globalThis.URL('../../server/tenantAdministration.js',import.meta.url),'utf8');
  const ddl='CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);'+/CREATE TABLE IF NOT EXISTS duty_reviews\([^;]*\);/.exec(source)[0];
  db.exec(ddl);
  for(const sql of preludeStatements())await client.query(sql);
  for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const catalog=new Map((await client.query(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND column_name<>'__rowid' GROUP BY 1`)).rows.map(r=>[r.table_name,r.c]));
  const columnsOf=table=>catalog.get(table);
  const notNull=new Set((await client.query(`SELECT table_name||'.'||column_name AS k FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND is_nullable='NO'`)).rows.map(r=>r.k));
  const isNotNull=(table,column)=>notNull.has(table+'.'+column);
  const insert='INSERT INTO users VALUES(?)';
  for(const id of ['preparer','approver']){db.prepare(insert).run(id);await client.query(translateQuery(insert),[id]);}
  const review=(id,status,decidedAt)=>[id,'gift.refund','gifts','g1',3,'Refund',500,'preparer','admin',1,'binding',status,status==='Prepared'?null:'approver','admin','ok',decidedAt,2,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'];
  const write='INSERT INTO duty_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  // the latest decided approval, then an approval with no decision timestamp written after it
  for(const row of [review('r-old','Approved','2026-03-01T00:00:00.000Z'),review('r-current','Approved','2026-04-01T00:00:00.000Z'),review('r-rejected','Rejected','2026-05-01T00:00:00.000Z'),review('r-null','Approved',null)]){
   db.prepare(write).run(...row);await client.query(translateQuery(write),row);
  }
  const sql="SELECT * FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Approved' ORDER BY decided_at DESC,rowid DESC LIMIT 1";
  const expected=db.prepare(sql).get('gift.refund','g1');
  assert.equal(expected.id,'r-current','SQLite selects the latest decided approval');
  const translated=translateQuery(sql,{columnsOf,isNotNull});
  // nullable decided_at keeps SQLite's placement; the NOT NULL rowid surrogate needs none
  assert.match(translated,/ORDER BY decided_at DESC NULLS LAST,"__rowid" DESC LIMIT 1$/);
  const {rows}=await client.query(translated,['gift.refund','g1']);
  assert.equal(rows[0].id,'r-current',translated);
  // the whole row, with exactly SQLite's columns in SQLite's order and no rowid surrogate
  assert.deepEqual(Object.keys(rows[0]),Object.keys(expected));
  assert.deepEqual(norm(rows),norm([{...expected}]));
  // without the NULLS rewrite PostgreSQL would have picked the undecided row
  assert.equal((await client.query(`SELECT id FROM duty_reviews WHERE duty=$1 AND subject_id=$2 AND status='Approved' ORDER BY decided_at DESC,"__rowid" DESC LIMIT 1`,['gift.refund','g1'])).rows[0].id,'r-null');
 });

 await t.test('a NOT NULL primary key is walked by its index, in SQLite\'s order (app.js:301 audit)',async()=>{
  const source=readFileSync(new globalThis.URL('../../server/app.js',import.meta.url),'utf8');
  const ddl=/CREATE TABLE IF NOT EXISTS audit\([^;]*\);/.exec(source)[0];
  db.exec(ddl);for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const write='INSERT INTO audit(actor,action,collection,record_id,at,details) VALUES(?,?,?,?,?,?)';
  for(let i=0;i<600;i++){const row=['u'+(i%7),'update',i%3?'gifts':null,i%5?'r'+i:null,'2026-01-01T00:00:00.000Z','{}'];db.prepare(write).run(...row);await client.query(translateQuery(write),row);}
  const catalog=async()=>({
   columns:new Map((await client.query(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND column_name<>'__rowid' GROUP BY 1`)).rows.map(r=>[r.table_name,r.c])),
   notNull:new Set((await client.query(`SELECT table_name||'.'||column_name AS k FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND is_nullable='NO'`)).rows.map(r=>r.k))});
  const {columns,notNull}=await catalog();
  const options={columnsOf:table=>columns.get(table),isNotNull:(table,column)=>notNull.has(table+'.'+column)};
  const sql='SELECT * FROM audit ORDER BY id DESC LIMIT 250';
  const before=translateQuery(sql,{columnsOf:options.columnsOf}),after=translateQuery(sql,options);
  assert.match(before,/ORDER BY id DESC NULLS LAST LIMIT 250$/);
  assert.match(after,/ORDER BY id DESC LIMIT 250$/);
  // same rows, same order, same columns as SQLite
  const expected=db.prepare(sql).all().map(r=>({...r})),{rows}=await client.query(after);
  assert.deepEqual(norm(rows),norm(expected));assert.deepEqual(Object.keys(rows[0]),Object.keys(expected[0]));
  // at scale the NULLS-free form is an index scan; the conservative form sorts the table
  await client.query(`INSERT INTO audit(actor,action,collection,record_id,at,details) SELECT 'u','update','gifts','r'||i,'2026-01-01T00:00:00.000Z','{}' FROM generate_series(1,200000) i;ANALYZE audit`);
  const plan=async text=>(await client.query('EXPLAIN '+text)).rows.map(r=>r['QUERY PLAN']).join('\n');
  assert.match(await plan(after),/^Limit[^\n]*\n\s*->\s+Index Scan Backward using audit_pkey on audit/);
  assert.doesNotMatch(await plan(after),/Sort|Seq Scan/);
  assert.match(await plan(before),/Sort Key: id DESC NULLS LAST/);
  // a nullable key on the same table still sorts with SQLite's NULL placement
  assert.match(translateQuery('SELECT id FROM audit ORDER BY collection DESC,id DESC LIMIT 5',options),/ORDER BY collection DESC NULLS LAST,id DESC LIMIT 5$/);
 });

 await t.test('SELECT *, alias.* and RETURNING * return exactly SQLite\'s columns and values',async()=>{
  const ddl='CREATE TABLE tickets(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,seat INTEGER,note TEXT);CREATE TABLE ticket_transitions(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),status TEXT NOT NULL,at TEXT NOT NULL)';
  db.exec(ddl);for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const catalog=new Map((await client.query(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND column_name<>'__rowid' GROUP BY 1`)).rows.map(r=>[r.table_name,r.c]));
  const columnsOf=table=>catalog.get(table);
  for(const [sql,params] of [['INSERT INTO tickets VALUES(?,?,?,?)',['t1','e1',12,null]],['INSERT INTO tickets VALUES(?,?,?,?)',['t2','e1',null,'aisle']],['INSERT INTO ticket_transitions VALUES(?,?,?,?)',['x1','t1','Issued','2026-01-01']],['INSERT INTO ticket_transitions VALUES(?,?,?,?)',['x2','t2','Issued','2026-01-02']]]){
   db.prepare(sql).run(...params);await client.query(translateQuery(sql,{columnsOf}),params);
  }
  const compare=async(sql,params=[])=>{
   const expected=db.prepare(sql).all(...params),translated=translateQuery(sql,{columnsOf}),{rows,fields}=await client.query(translated,params);
   assert.deepEqual(fields.map(f=>f.name),db.prepare(sql).columns().map(c=>c.name),translated);
   assert.equal(fields.some(f=>f.name==='__rowid'),false);
   assert.deepEqual(norm(rows),norm(expected.map(r=>({...r}))),translated);
  };
  // the raw snapshot shape four tests deep-equal, and backup.js:30
  await compare('SELECT * FROM tickets ORDER BY rowid');
  await compare('SELECT * FROM "ticket_transitions"');
  await compare('SELECT h.*,t.event_id FROM ticket_transitions h JOIN tickets t ON t.id=h.ticket_id WHERE t.event_id=? ORDER BY h.at',['e1']);
  await compare('SELECT t.id,h.* FROM tickets t LEFT JOIN ticket_transitions h ON h.ticket_id=t.id ORDER BY t.id');
  await compare('SELECT * FROM (SELECT * FROM tickets WHERE seat IS NULL) s');
  await compare('SELECT COUNT(*) AS n FROM tickets WHERE EXISTS(SELECT * FROM ticket_transitions x WHERE x.ticket_id=tickets.id)');
  await compare("UPDATE tickets SET note='moved' WHERE id=? RETURNING *",['t1']);
  // untranslated, PostgreSQL would have leaked the surrogate
  assert.deepEqual((await client.query('SELECT * FROM tickets LIMIT 1')).fields.map(f=>f.name),['id','event_id','seat','note','__rowid']);
 });

 await t.test('PRAGMA foreign_keys=OFF defers foreign keys only inside a transaction',async()=>{
  const ddl='CREATE TABLE fk_parents(id TEXT PRIMARY KEY);CREATE TABLE fk_children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES fk_parents(id))';
  for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  await client.query("INSERT INTO fk_parents VALUES('p1');INSERT INTO fk_children VALUES('c1','p1')");
  // inside a transaction: a temporarily dangling reference repaired before COMMIT is accepted
  await client.query('BEGIN');
  await client.query(translateStatement('PRAGMA foreign_keys=OFF'));
  await client.query("UPDATE fk_children SET parent_id='p2' WHERE id='c1'");
  await client.query("INSERT INTO fk_parents VALUES('p2')");
  await client.query(translateStatement('PRAGMA foreign_keys=ON'));
  await client.query('COMMIT');
  // turning enforcement back on inside the transaction checks what is pending, as SQLite's ON would
  await client.query('BEGIN');
  await client.query(translateStatement('PRAGMA foreign_keys=OFF'));
  await client.query("UPDATE fk_children SET parent_id='gone' WHERE id='c1'");
  await assert.rejects(client.query(translateStatement('PRAGMA foreign_keys=ON')),e=>e.code==='23503');
  await client.query('ROLLBACK');
  // Recorded divergence: tests/communication-workflow-reporting.test.js:80 issues the
  // pragma OUTSIDE any transaction and then commits a dangling entry_id that later
  // requests must read. SET CONSTRAINTS outside a transaction is a WARNING and does
  // nothing, and even inside one the check still runs at COMMIT, so PostgreSQL
  // refuses the write that SQLite accepts. No transaction-scoped deferral can do this.
  const warnings=[];const listen=n=>warnings.push(n.message);client.on('notice',listen);
  await client.query(translateExec('PRAGMA foreign_keys=OFF; SELECT 1'));
  await assert.rejects(client.query(translateQuery("UPDATE fk_children SET parent_id=? WHERE id=?"),['dangling','c1']),e=>e.code==='23503');
  await client.query(translateStatement('PRAGMA foreign_keys=OFF'));
  client.off('notice',listen);
  assert.ok(warnings.includes('SET CONSTRAINTS can only be used in transaction blocks'),JSON.stringify(warnings));
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(ddl+";INSERT INTO fk_parents VALUES('p1');INSERT INTO fk_children VALUES('c1','p1');PRAGMA foreign_keys=ON");
  sqlite.exec('PRAGMA foreign_keys=OFF');sqlite.prepare('UPDATE fk_children SET parent_id=? WHERE id=?').run('dangling','c1');
  assert.equal(sqlite.prepare('SELECT parent_id FROM fk_children').get().parent_id,'dangling','SQLite commits the dangling reference');
  sqlite.close();
  assert.equal((await client.query("SELECT parent_id FROM fk_children")).rows[0].parent_id,'p2','PostgreSQL never does');
 });

 await t.test('ON CONFLICT DO UPDATE counters really increment (observability.js:137,236)',async()=>{
  const source=readFileSync(new globalThis.URL('../../server/observability.js',import.meta.url),'utf8');
  const ddl=/CREATE TABLE IF NOT EXISTS observability_counters\([^;]*\);\s*CREATE TABLE IF NOT EXISTS observability_heartbeat\([^;]*\);/.exec(source)[0];
  db.exec(ddl);for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const counter='INSERT INTO observability_counters VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET count=count+excluded.count,updated_at=excluded.updated_at';
  const heartbeat='INSERT INTO observability_heartbeat VALUES(?,?,1) ON CONFLICT(tenant_id) DO UPDATE SET at=excluded.at,writes=writes+1';
  assert.ok(source.includes(counter)&&source.includes(heartbeat),'the statements are the ones the module issues');
  for(const [n,add] of [[1,1],[2,5],[3,2]]){
   for(const args of [['t1','requests',add,'2026-01-0'+n],['t2','requests',1,'2026-01-0'+n]]){db.prepare(counter).run(...args);await client.query(translateQuery(counter),args);}
   db.prepare(heartbeat).run('t1','2026-01-0'+n);await client.query(translateQuery(heartbeat),['t1','2026-01-0'+n]);
  }
  await bothAgree(t,client,db,'SELECT tenant_id,name,count,updated_at FROM observability_counters ORDER BY tenant_id');
  await bothAgree(t,client,db,'SELECT tenant_id,at,writes FROM observability_heartbeat');
  assert.deepEqual(norm((await client.query('SELECT count FROM observability_counters ORDER BY tenant_id')).rows).map(r=>r.count),[8,3]);
  assert.equal(Number((await client.query('SELECT writes FROM observability_heartbeat')).rows[0].writes),3);
 });

 await t.test('scalar MAX/MIN propagate NULL exactly as SQLite (documents.js retention_until)',async()=>{
  const ddl='CREATE TABLE retention(id TEXT PRIMARY KEY,retention_until TEXT,n INTEGER)';
  db.exec(ddl);for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const seed=[['a','2030-01-01',5],['b',null,null],['c','Zed',1],['d','2040-06-30',-2]];
  for(const row of seed){db.prepare('INSERT INTO retention VALUES(?,?,?)').run(...row);await client.query('INSERT INTO retention(id,retention_until,n) VALUES($1,$2,$3)',row);}
  // the real statement shape, applied with a later date, an earlier date and NULL, to set and NULL rows
  const update='UPDATE retention SET retention_until=MAX(retention_until,?) WHERE id=?';
  for(const args of [['2031-01-01','a'],['2020-01-01','d'],['2035-01-01','b'],[null,'c'],['apple','c']]){db.prepare(update).run(...args);await client.query(translateQuery(update),args);}
  await bothAgree(t,client,db,'SELECT id,retention_until FROM retention ORDER BY id');
  assert.deepEqual(db.prepare('SELECT retention_until FROM retention ORDER BY id').all().map(r=>r.retention_until),['2031-01-01',null,null,'2040-06-30']);
  for(const sql of ['SELECT id,max(n,?) AS hi,min(n,?) AS lo FROM retention ORDER BY id','SELECT id,max(n,1,?) AS hi,min(n,?,4) AS lo FROM retention ORDER BY id','SELECT max(n) AS agg,min(retention_until) AS first FROM retention'])
   for(const params of [[0,0],[null,3],[10,null]])await bothAgree(t,client,db,sql,sql.includes('?')?params:[]);
  for(const params of [['2035-01-01','m'],[null,'a'],['Zed',null]])await bothAgree(t,client,db,'SELECT id,max(retention_until,?) AS hi,min(retention_until,?,\'n\') AS lo FROM retention ORDER BY id',params);
  // Recorded divergence: SQLite orders mixed storage classes (INTEGER before TEXT); PostgreSQL
  // resolves one type for the VALUES list. No call site compares a number with text.
  assert.equal(db.prepare("SELECT min('2031-01-01',3) AS m").get().m,3);
 });

 await t.test('json_set stores what SQLite stores',async()=>{
  const ddl='CREATE TABLE docs(id TEXT PRIMARY KEY,data TEXT)';
  db.exec(ddl);for(const sql of translateDdl(ddl,{strict:true}).statements)await client.query(sql);
  const seed=[['d1','{"version":2,"name":"Fund","allocations":[{"designationId":"x","amount":10001}],"nested":{"k":[1, 2]},"parentId":"p0"}'],['d2','{}'],['d3',null],['d4','[1,2]']];
  for(const row of seed){db.prepare('INSERT INTO docs VALUES(?,?)').run(...row);await client.query('INSERT INTO docs(id,data) VALUES($1,$2)',row);}
  const cases=[
   ["json_set(data,'$.amount',10002,'$.allocations[0].amount',10002)",[]],
   ["json_set(data,'$.version',json_extract(data,'$.version')+1,'$.name','Changed during retrieval')",[]],
   ["json_set(data,'$.parentId',json('null'),'$.gone',NULL,'$.copy',json_extract(data,'$.nested'))",[]],
   ["json_set(data,'$.mergedInto',?)",['canonical']],
   ["json_set(data,'$.title','it''s \"quoted\" / é \\ tab\t','$.a.b.c',1)",[]],
   ["json_set(data,'$.allocations[1]',3,'$.allocations[5]',4,'$.name.inner',1,'$.rate',2.5)",[]],
   ["json_set(data,'$.made[0].b',1,'$.skipped[3]',1,'$.deep.x[0]',2,'$.allocations[1].x',7)",[]],
   ["json_set(data,'$',json('{\"replaced\":true}'))",[]],
  ];
  for(const [expr,params] of cases)await bothAgree(t,client,db,`SELECT id,${expr} AS data FROM docs ORDER BY id`,params);
  // and through UPDATE, as the fault triggers and tests write it
  const update="UPDATE docs SET data=json_set(data,'$.preference','Do not contact','$.version',json_extract(data,'$.version')+1) WHERE id=?";
  db.prepare(update).run('d1');await client.query(translateQuery(update),['d1']);
  await bothAgree(t,client,db,'SELECT id,data FROM docs ORDER BY id');
  // Recorded divergence: a bound JS number. SQLite stores 5.0; the untyped parameter is text on PostgreSQL.
  assert.equal(db.prepare("SELECT json_set('{}','$.a',?) AS j").get(5).j,'{"a":5.0}');
  assert.equal((await client.query(translateQuery("SELECT json_set('{}','$.a',?) AS j"),[5])).rows[0].j,'{"a":"5"}');
 });

 await t.test('PRAGMA integrity_check and quick_check return one ok row',async()=>{
  for(const p of ['PRAGMA integrity_check','PRAGMA quick_check']){
   const {rows}=await client.query(translateQuery(p));
   assert.equal(rows.length,1);
   assert.equal(Object.values(rows[0])[0],'ok');
  }
 });

 await t.test('connection PRAGMAs and BEGIN IMMEDIATE execute',async()=>{
  await client.query(translateExec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'));
  assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout,'5s');
  await client.query(translateStatement('BEGIN IMMEDIATE'));
  await client.query(translateStatement('ROLLBACK'));
  await client.query(translateExec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;'));
 });
});
