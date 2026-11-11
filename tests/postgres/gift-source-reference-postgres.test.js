// Gift source-reference uniqueness and the indexed write-path lookups on PostgreSQL,
// through the real adapter and translators. Needs the LOCAL container
// (wimblo-migration-pg, 127.0.0.1:57900); it fails rather than skips when absent, and
// never touches a hosted database. Run directly:
//   node --test tests/postgres/gift-source-reference-postgres.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPostgresPool,openPostgresDatabase} from '../../server/persistence/postgresDatabase.js';
import {setDatabaseFactory} from '../../server/persistence/openDatabase.js';
import {createApp} from '../../server/app.js';
import {GIFT_SOURCE_REFERENCE_INDEX,RECORD_LOOKUP_INDEXES} from '../../server/recordLookups.js';
import {openWorkspace,manualGiftsAllSucceed,duplicatesAreRefusedByTheDatabase,onlyIdenticalStringReferencesConflict,voidedGiftsKeepTheirReference,existingDuplicatesRefuseToOpen,concurrentCreatesCannotBothSucceed,writePathLookupsKeepScanSemantics} from '../gift-source-reference-scenarios.js';
import {writeEdgeCases,assertLookupEquivalence,ORIGINAL_SCANS,PROBES} from '../record-lookups-equivalence.js';

const URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const run=`gsr${randomBytes(3).toString('hex')}`,prefix=`wt_${run}_`;
const path=()=>`/tmp/wimblo-gift-source-${randomBytes(6).toString('hex')}/workspace.sqlite`;
let pool;
test.before(async()=>{
 try{pool=await createPostgresPool({url:URL,size:8,schemaPrefix:prefix});}
 catch(e){assert.fail(`The local PostgreSQL container is required at 127.0.0.1:57900: ${e.message}`);}
 setDatabaseFactory((p,options)=>openPostgresDatabase(pool,p,options));
});
test.after(async()=>{
 setDatabaseFactory(null);
 const db=openPostgresDatabase(pool,':memory:');
 try{for(const {nspname} of db.prepare('SELECT nspname FROM pg_namespace WHERE starts_with(nspname,?)').all(prefix))db.exec(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);}finally{db.close();}
 await pool.close();
});

test('the source-reference and lookup indexes are built on PostgreSQL from the same module DDL',async t=>{
 const f=await openWorkspace(t,path());
 assert.match(f.db.prepare('SELECT version() AS v').get().v,/^PostgreSQL/);
 const defs=Object.fromEntries(f.db.prepare('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=?').all('records').map(r=>[r.indexname,r.indexdef]));
 assert.equal(defs[GIFT_SOURCE_REFERENCE_INDEX].replace(` ON ${f.db.schema}.records `,' ON records '),"CREATE UNIQUE INDEX records_gift_source_reference ON records USING btree ((((data)::jsonb ->> 'externalRef'::text))) WHERE ((collection = 'gifts'::text) AND (jsonb_typeof(((data)::jsonb -> 'externalRef'::text)) = 'string'::text) AND (((data)::jsonb ->> 'externalRef'::text) <> ''::text))");
 for(const fields of Object.values(RECORD_LOOKUP_INDEXES))for(const name of Object.values(fields))assert.ok(defs[name],`${name} exists`);
});

test('several manual gifts with the real empty reference all succeed on PostgreSQL',async t=>{
 await manualGiftsAllSucceed(await openWorkspace(t,path()));
});

test('a duplicate source reference is refused with the preserved 409 on PostgreSQL',async t=>{
 await duplicatesAreRefusedByTheDatabase(await openWorkspace(t,path()));
});

test('only byte-identical non-empty string references conflict on PostgreSQL, including a number stored beside its text',async t=>{
 await onlyIdenticalStringReferencesConflict(await openWorkspace(t,path()));
});

test('a voided gift keeps its reference on PostgreSQL',async t=>{
 await voidedGiftsKeepTheirReference(await openWorkspace(t,path()));
});

test('a PostgreSQL workspace that already holds duplicate references refuses to open and changes nothing',()=>{
 existingDuplicatesRefuseToOpen(path());
});

test('each indexed lookup equals the original scan on PostgreSQL, where numbers and booleans extract as text',t=>{
 const app=createApp({seed:false,reminderWorker:false,workflowWorker:false});t.after(()=>app.locals.close());
 writeEdgeCases(app.locals.db);
 const {comparisons}=assertLookupEquivalence(app.locals.db);
 assert.equal(comparisons,ORIGINAL_SCANS.length*PROBES.length);
});

test('write-path checks that use indexed lookups refuse exactly what the scans refused on PostgreSQL',async t=>{
 await writePathLookupsKeepScanSemantics(await openWorkspace(t,path()));
});

test('an uncommitted reference blocks a second PostgreSQL writer that the old scan would have let through',async t=>{
 const p=path(),f=await openWorkspace(t,p);
 const gift=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' LIMIT 1").get().data);
 const a=openPostgresDatabase(pool,p),b=openPostgresDatabase(pool,p);t.after(()=>{a.close();b.close();});
 const insert=(db,id)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run('gifts',id,JSON.stringify({...gift,id,externalRef:'INTERLEAVED-PG'}));
 const holders=db=>db.prepare("SELECT id FROM records WHERE collection='gifts' AND json_extract(data,'$.externalRef')=?").all('INTERLEAVED-PG').map(r=>r.id);
 a.exec('BEGIN');insert(a,'writer-a');
 b.exec("SET lock_timeout='250ms'");b.exec('BEGIN');
 assert.deepEqual(holders(b),[],'read committed: the removed scan would have found no duplicate here');
 assert.throws(()=>insert(b,'writer-b'),e=>e.code==='55P03');
 a.exec('COMMIT');
 assert.throws(()=>insert(b,'writer-b'),e=>e.code==='23505'&&e.constraint===GIFT_SOURCE_REFERENCE_INDEX);
 b.exec('ROLLBACK');
 assert.deepEqual(holders(f.db),['writer-a']);
});

test('two server processes on one PostgreSQL workspace creating the same references at once: exactly one succeeds for each',async t=>{
 const preload=fileURLToPath(new globalThis.URL('./harness/preload.mjs',import.meta.url));
 const result=await concurrentCreatesCannotBothSucceed(t,path(),{nodeArgs:['--import',preload],env:{WIMBLO_PG_URL:URL,WIMBLO_PG_RUN:run,WIMBLO_PG_POOL_SIZE:'2'}});
 assert.equal(result.created,result.refs.length);assert.equal(result.refused,result.refs.length);
});
