#!/usr/bin/env node
// Index audit, step 2: read the plan of every distinct statement captured by
// capture-preload.mjs, on SQLite and on PostgreSQL, against a workspace populated at
// buyer scale. Writes a JSON evidence file; index-audit.md is written from it.
//   node scripts/index-audit/audit.mjs <captureDir> <out.json> [--no-postgres] [--without-new-indexes]
// --without-new-indexes drops the indexes added by server/recordLookups.js after the
// schema is built, reproducing the schema the captured statements originally ran against.
// PostgreSQL is only ever the local loopback container; Neon is refused.
import {readdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {createApp} from '../../server/app.js';
import {setDatabaseFactory} from '../../server/persistence/openDatabase.js';
import {createPostgresPool,openPostgresDatabase} from '../../server/persistence/postgresDatabase.js';
import {translateQuery} from '../../server/persistence/sqliteQuery.js';
import {populateBuyerScale} from '../../tests/buyer-scale-fixture.js';
import {classify} from './classify.mjs';
import {RECORD_LOOKUP_INDEXES,GIFT_SOURCE_REFERENCE_INDEX} from '../../server/recordLookups.js';

const [captureDir,outFile]=process.argv.slice(2).filter(a=>!a.startsWith('--'));
const withPostgres=!process.argv.includes('--no-postgres'),withoutNewIndexes=process.argv.includes('--without-new-indexes');
const NEW_INDEXES=[GIFT_SOURCE_REFERENCE_INDEX,...Object.values(RECORD_LOOKUP_INDEXES).flatMap(Object.values)];
const dropNewIndexes=db=>{if(withoutNewIndexes)for(const name of NEW_INDEXES)db.exec(`DROP INDEX IF EXISTS ${name}`);};
const URL=process.env.WIMBLO_PG_URL||'postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
if(!['127.0.0.1','localhost','::1','[::1]'].includes(new globalThis.URL(URL).hostname))throw new Error('The index audit only reads plans from the local loopback PostgreSQL container, never Neon.');
if(!captureDir||!outFile)throw new Error('usage: audit.mjs <captureDir> <out.json>');

// ---- merge captures
const merged=new Map();let files=0;
for(const file of readdirSync(captureDir).filter(f=>f.endsWith('.json'))){
 files++;
 for(const s of JSON.parse(readFileSync(join(captureDir,file),'utf8')).statements){
  const key=s.sql.trim();let m=merged.get(key);
  if(!m){m={sql:key,executions:0,prepares:0,collections:{},sites:{},siteCollections:{}};merged.set(key,m);}
  m.executions+=s.executions;m.prepares+=s.prepares;
  for(const [k,v] of Object.entries(s.collections))m.collections[k]=(m.collections[k]||0)+v;
  for(const [k,v] of Object.entries(s.sites))m.sites[k]=(m.sites[k]||0)+v;
  for(const [k,v] of Object.entries(s.siteCollections||{}))m.siteCollections[k]=(m.siteCollections[k]||0)+v;
 }
}
const SKIP=/^\s*(PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END|CREATE|ALTER|DROP|VACUUM|ANALYZE|EXPLAIN)\b/i;
const plannable=[...merged.values()].filter(s=>!SKIP.test(s.sql)&&!/;\s*\S/.test(s.sql.replace(/'(?:[^']|'')*'/g,"''")));

// ---- SQLite at buyer scale
const dir=mkdtempSync(join(tmpdir(),'wimblo-index-audit-'));
const sqliteApp=createApp({dbPath:join(dir,'sqlite','workspace.sqlite'),seed:true,reminderWorker:false,workflowWorker:false});
const sdb=sqliteApp.locals.db;
dropNewIndexes(sdb);
populateBuyerScale(sdb);
sdb.exec('ANALYZE');
const tableRows=Object.fromEntries(sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>[name,sdb.prepare(`SELECT count(*) n FROM "${name}"`).get().n]));
const collectionRows=Object.fromEntries(sdb.prepare('SELECT collection,count(*) n FROM records GROUP BY collection').all().map(r=>[r.collection,r.n]));
for(const s of plannable){
 try{s.sqlitePlan=sdb.prepare('EXPLAIN QUERY PLAN '+s.sql).all().map(r=>r.detail);}
 catch(e){s.sqliteError=e.message;}
}
sqliteApp.locals.close();

// ---- PostgreSQL at buyer scale (same fixture, through the real adapter and translators)
let pgInfo=null;
if(withPostgres){
 const pool=await createPostgresPool({url:URL,size:2,schemaPrefix:'indexaudit_'});
 setDatabaseFactory((path,options)=>openPostgresDatabase(pool,path,options));
 const pgApp=createApp({dbPath:join(dir,'pg','workspace.sqlite'),seed:true,reminderWorker:false,workflowWorker:false});
 const pdb=pgApp.locals.db,schema=pdb.schema;
 dropNewIndexes(pdb);
 // The same fixture rows, bulk-loaded in batches rather than one synchronous round trip per row.
 const pending=[];populateBuyerScale({exec(){},prepare:sql=>({run:(...args)=>pending.push([sql,args])})});
 const started=Date.now();
 const client=new pg.Client({connectionString:URL,application_name:'wimblo-index-audit'});await client.connect();
 await client.query(`SET search_path TO "${schema}"`);
 await client.query('BEGIN');
 for(const [sql,columns] of [['INSERT INTO records(collection,id,data) VALUES(?,?,?)','records(collection,id,data)'],['INSERT INTO audit(actor,action,collection,record_id,at,details) VALUES(?,?,?,?,?,?)','audit(actor,action,collection,record_id,at,details)']]){
  const rows=pending.filter(([s])=>s===sql).map(([,args])=>args);
  for(let i=0;i<rows.length;i+=1000){const batch=rows.slice(i,i+1000),width=batch[0].length;await client.query(`INSERT INTO ${columns} VALUES ${batch.map((_,r)=>'('+Array.from({length:width},(_,c)=>'$'+(r*width+c+1)).join(',')+')').join(',')}`,batch.flat());}
 }
 await client.query('COMMIT');
 // Only this schema's tables; a bare ANALYZE would also process every other schema in the shared container.
 for(const {tablename} of (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows)await client.query(`ANALYZE "${tablename}"`);
 pgInfo={schema,populateMs:Date.now()-started,version:(await client.query('SHOW server_version')).rows[0].server_version};
 for(const s of plannable){
  let translated;
  try{translated=translateQuery(s.sql,{columnsOf:pdb.columnsOf});}catch(e){s.pgError='translation: '+e.message;continue;}
  s.pgSql=translated;
  try{await client.query('BEGIN');s.pgPlan=(await client.query('EXPLAIN (GENERIC_PLAN) '+translated)).rows.map(r=>r['QUERY PLAN']);}
  catch(e){s.pgError=e.message;}
  finally{await client.query('ROLLBACK');}
 }
 await client.end();
 pgApp.locals.close();
 const drop=new pg.Client({connectionString:URL});await drop.connect();await drop.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await drop.end();
 await pool.close();setDatabaseFactory(null);
}
rmSync(dir,{recursive:true,force:true});

classify(plannable,{tableRows,collectionRows});
plannable.sort((a,b)=>b.score-a.score||b.executions-a.executions);
writeFileSync(outFile,JSON.stringify({generatedAt:new Date().toISOString(),newIndexes:withoutNewIndexes?'dropped':'present',captureFiles:files,distinctStatements:merged.size,plannable:plannable.length,tableRows,collectionRows,postgres:pgInfo,statements:plannable},null,1));
console.log(`test-only ${plannable.filter(s=>s.testOnly).length} | app growing scans ${plannable.filter(s=>s.grows&&!s.testOnly).length} | `+`captures ${files} | distinct ${merged.size} | plannable ${plannable.length} | sqlite errors ${plannable.filter(s=>s.sqliteError).length} | pg errors ${plannable.filter(s=>s.pgError).length} | growing scans ${plannable.filter(s=>s.grows).length}`);
