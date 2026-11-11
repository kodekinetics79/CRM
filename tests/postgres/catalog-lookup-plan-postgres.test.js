// The adapter's per-table catalog lookups (columnsOf, isNotNull) must reach pg_class
// through its (relname, relnamespace) index. Every workspace is a schema in ONE
// database, so a sequential scan of pg_class costs time proportional to the number of
// workspaces. Measured before this guard existed: 28-38 ms per table with ~140 schemas
// (4.4 s of event-loop block for one 150-table snapshot, enough to outlive Node's 5 s
// keep-alive timeout and reset HTTP connections), versus 0.04-0.2 ms through the index.
// Needs the LOCAL container (wimblo-migration-pg, 127.0.0.1:57900); never a hosted database.
//   node --test tests/postgres/catalog-lookup-plan-postgres.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPostgresPool,openPostgresDatabase} from '../../server/persistence/postgresDatabase.js';
import {createSyncPostgres} from '../../server/persistence/syncPostgres.js';

const URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const prefix=`wt_catplan${randomBytes(3).toString('hex')}_`;
let pool,probe;
const captured=[];
test.before(async()=>{
 try{pool=await createPostgresPool({url:URL,size:2,schemaPrefix:prefix});probe=await createSyncPostgres({url:URL});}
 catch(e){assert.fail(`The local PostgreSQL container is required at 127.0.0.1:57900: ${e.message}`);}
 // Record every catalog statement the adapter prepares, with the values it binds.
 const acquire=pool.acquire;
 pool.acquire=function(...args){
  const handle=acquire.apply(this,args);
  if(!handle.__captured){
   handle.__captured=true;const prepare=handle.prepare;
   handle.prepare=function(sql){const st=prepare.call(this,sql);if(/\bpg_attribute\b/.test(sql))for(const m of ['get','all']){const f=st[m];st[m]=(...values)=>{captured.push({sql,values});return f(...values);};}return st;};
  }
  return handle;
 };
});
test.after(async()=>{
 const db=openPostgresDatabase(pool,':memory:');
 try{for(const {nspname} of db.prepare('SELECT nspname FROM pg_namespace WHERE starts_with(nspname,?)').all(prefix))db.exec(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);}finally{db.close();}
 probe?.close();await pool.close();
});

const scans=node=>[...(node['Node Type']?.includes('Seq Scan')?[node['Relation Name']]:[]),...(node.Plans||[]).flatMap(scans)];

test('columnsOf and isNotNull reach pg_class through its name index and stay scoped to their own schema',()=>{
 const a=openPostgresDatabase(pool,':memory:'),b=openPostgresDatabase(pool,':memory:');
 try{
  a.exec('CREATE TABLE shared_name(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  b.exec('CREATE TABLE shared_name(other TEXT)');
  captured.length=0;
  assert.deepEqual(a.columnsOf('shared_name'),['id','body']);
  assert.deepEqual(b.columnsOf('shared_name'),['other']);
  assert.equal(a.isNotNull('shared_name','body'),true);
  assert.equal(b.isNotNull('shared_name','other'),false);
  const kinds=new Set(captured.map(c=>/attnotnull/.test(c.sql)?'isNotNull':'columnsOf'));
  assert.deepEqual([...kinds].sort(),['columnsOf','isNotNull'],'both lookups must have been observed');
  for(const {sql,values} of captured){
   const [row]=probe.prepare('EXPLAIN (FORMAT JSON) '+sql).all(...values);
   const plan=JSON.parse(row['QUERY PLAN'])[0].Plan;
   assert.deepEqual(scans(plan).filter(r=>r==='pg_class'),[],`catalog lookup scans pg_class sequentially:\n${sql}\n${JSON.stringify(plan)}`);
   assert.match(JSON.stringify(plan),/pg_class_relname_nsp_index/,sql);
  }
 }finally{a.close();b.close();}
});
