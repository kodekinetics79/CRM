import test from 'node:test';
import assert from 'node:assert/strict';
import {
 MIGRATIONS,SCHEMA_VERSION,MIGRATION_LEDGER_TABLE,validateMigrations,planMigrations,applyMigrations,
 createPostgresPool,classifyError,applicationRoleGrants,TENANT_TABLES,
 PERSISTENCE_CODES
} from '../server/persistence/index.js';

const recorded=list=>list.map(m=>({version:m.version,name:m.name,checksum:m.checksum}));

test('migrations are contiguous, uniquely versioned, checksummed and forward-only',()=>{
 assert.equal(validateMigrations(),MIGRATIONS);
 assert.equal(SCHEMA_VERSION,MIGRATIONS.length);
 MIGRATIONS.forEach((entry,index)=>{
  assert.equal(entry.version,index+1);
  assert.match(entry.checksum,/^[a-f0-9]{64}$/);
  assert.ok(entry.statements.length);
  assert.equal(entry.down,undefined);
  assert.equal(entry.rollback,undefined);
  assert.ok(Object.isFrozen(entry));
 });
 assert.equal(new Set(MIGRATIONS.map(m=>m.checksum)).size,MIGRATIONS.length);
 assert.throws(()=>validateMigrations([MIGRATIONS[0],MIGRATIONS[2]]),/contiguous and ordered/);
 assert.throws(()=>validateMigrations([MIGRATIONS[0],MIGRATIONS[0]]),/contiguous and ordered/);
 assert.throws(()=>validateMigrations([]),/At least one migration/);
 assert.throws(()=>validateMigrations([{...MIGRATIONS[0],down:['DROP TABLE records']}]),/forward-only/);
 assert.throws(()=>validateMigrations([{...MIGRATIONS[0],statements:['  ']}]),/empty statement/);
});

test('a migration whose statements changed after it was applied is refused, naming both checksums',()=>{
 const applied=recorded(MIGRATIONS);
 assert.deepEqual(planMigrations(applied).pending,[]);
 const drifted=applied.map((row,index)=>index===2?{...row,checksum:'0'.repeat(64)}:row);
 assert.throws(()=>planMigrations(drifted),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
  assert.match(error.message,/changed after it was applied/);
  assert.match(error.message,new RegExp(MIGRATIONS[2].checksum));
  return true;
 });
 assert.throws(()=>planMigrations(applied.map((row,i)=>i===0?{...row,name:'renamed'}:row)),/renamed after it was applied/);
});

test('a database ahead of the build, or with a gap, is refused instead of guessed at',()=>{
 assert.throws(()=>planMigrations([...recorded(MIGRATIONS),{version:SCHEMA_VERSION+1,name:'future',checksum:'f'.repeat(64)}]),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
  assert.match(error.message,/ahead of this build/);
  return true;
 });
 assert.throws(()=>planMigrations([recorded(MIGRATIONS)[0],recorded(MIGRATIONS)[2]]),/non-contiguous/);
});

test('an empty database plans every migration in order and nothing is applied without being asked',async()=>{
 const plan=planMigrations([]);
 assert.equal(plan.currentVersion,0);
 assert.equal(plan.targetVersion,SCHEMA_VERSION);
 assert.deepEqual(plan.pending.map(p=>p.version),MIGRATIONS.map(m=>m.version));

 const statements=[];
 const session={async query(text,values){statements.push(text.trim());return text.includes('SELECT version')?{rows:[]}:{rows:[],rowCount:0,values};}};
 const dry=await applyMigrations(session,{dryRun:true});
 assert.equal(dry.dryRun,true);
 assert.deepEqual(dry.applied,[]);
 // A dry run creates the ledger and reads it; it never executes a migration.
 assert.equal(statements.filter(s=>s.startsWith('CREATE TABLE tenants')).length,0);
 assert.ok(statements[0].includes(MIGRATION_LEDGER_TABLE));
});

test('each migration commits with its own ledger row, and a failure rolls that migration back',async()=>{
 const executed=[];
 const failing=new Set(['CREATE TABLE gift_ledger']);
 const session={async query(text){
  const sql=text.trim();executed.push(sql);
  if(sql.startsWith('SELECT version'))return {rows:[]};
  if([...failing].some(f=>sql.startsWith(f)))throw Object.assign(new Error('synthetic DDL failure'),{code:'42601'});
  return {rows:[],rowCount:0};
 }};
 await assert.rejects(()=>applyMigrations(session),error=>{
  assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
  assert.match(error.message,/Migration 2 \(financial-ledger-projection-in-integer-cents\) failed and was rolled back/);
  return true;
 });
 assert.ok(executed.includes('ROLLBACK'),'the failed migration must be rolled back');
 // Migration 1 committed with its ledger row; migration 2 recorded nothing.
 const ledgerInserts=executed.filter(s=>s.startsWith(`INSERT INTO ${MIGRATION_LEDGER_TABLE}`));
 assert.equal(ledgerInserts.length,1);
 assert.equal(executed.filter(s=>s==='COMMIT').length,1);
});

test('tenant isolation is part of the schema: every tenant table is enabled, forced and policied',()=>{
 const isolation=MIGRATIONS.find(m=>m.name==='forced-row-level-tenant-isolation');
 assert.ok(isolation,'a tenant isolation migration must exist');
 for(const table of TENANT_TABLES){
  assert.ok(isolation.statements.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),`${table} row level security`);
  assert.ok(isolation.statements.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`),`${table} forced row level security`);
  assert.ok(isolation.statements.some(s=>s.startsWith(`CREATE POLICY ${table}_tenant_isolation`)&&s.includes('wimblo_current_tenant()')),`${table} tenant policy`);
 }
 // The scoping function must refuse an unset scope rather than defaulting to one.
 const foundation=MIGRATIONS[0].statements.join('\n');
 assert.match(foundation,/RAISE EXCEPTION 'wimblo\.tenant_id is not set/);
 // Tenant-scoped keys and constraints, not merely a filtered column.
 assert.match(foundation,/PRIMARY KEY \(tenant_id, collection, record_id\)/);
 assert.match(foundation,/CREATE UNIQUE INDEX users_tenant_email ON users\(tenant_id, lower\(email\)\)/);
 // Audit stays append-only on this store as it is on SQLite.
 assert.match(foundation,/CREATE TRIGGER audit_entries_no_update/);
 assert.match(foundation,/CREATE TRIGGER audit_entries_no_delete/);
});

test('the schema carries the access paths search and reporting depend on, and exact-cent constraints',()=>{
 const indexes=MIGRATIONS.flatMap(m=>m.statements).filter(s=>s.startsWith('CREATE INDEX')||s.startsWith('CREATE UNIQUE INDEX'));
 assert.ok(indexes.some(s=>/records_tenant_search_trgm .*gin .*gin_trgm_ops/.test(s)),'a search index');
 assert.ok(indexes.some(s=>/gift_ledger_reporting/.test(s)),'a gift reporting index');
 assert.ok(indexes.some(s=>/gift_allocations_designation/.test(s)),'a designation reporting index');
 const financial=MIGRATIONS[1].statements.join('\n');
 assert.match(financial,/amount_cents bigint NOT NULL CHECK \(amount_cents >= 0\)/);
 assert.match(financial,/amount_cents bigint NOT NULL CHECK \(amount_cents > 0\)/);
 assert.match(financial,/REFERENCES records\(tenant_id, collection, record_id\) ON DELETE CASCADE/);
});

test('the application role receives only the grants it needs, and its name is validated',()=>{
 const grants=applicationRoleGrants('wimblo_app');
 assert.equal(grants.length,TENANT_TABLES.length+1);
 for(const table of TENANT_TABLES)assert.ok(grants.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO wimblo_app`));
 assert.ok(grants.includes(`GRANT SELECT ON ${MIGRATION_LEDGER_TABLE} TO wimblo_app`));
 assert.equal(grants.some(g=>/GRANT ALL|SUPERUSER|BYPASSRLS/.test(g)),false);
 for(const bad of ['Robert; DROP TABLE records','wimblo app','','1role'])assert.throws(()=>applicationRoleGrants(bad),/lower-case identifier/);
});

test('pool configuration is validated and never discovers a database implicitly',async()=>{
 assert.throws(()=>createPostgresPool({}),/explicit connection string or host/);
 assert.throws(()=>createPostgresPool({host:'127.0.0.1',acquireAttempts:50}),/must not exceed 10 attempts/);
 assert.throws(()=>createPostgresPool({host:'127.0.0.1',statementTimeoutMs:0}),/statementTimeoutMs must be a positive integer/);
 assert.throws(()=>createPostgresPool({host:'127.0.0.1',max:-1}),/max must be a positive integer/);
 const pool=createPostgresPool({host:'127.0.0.1',port:1,database:'unused',acquireAttempts:1});
 try{
  assert.equal(pool.config.password,undefined);
  assert.equal(pool.stats.circuitOpen,false);
 }finally{await pool.end();}
});

test('failure classification separates refusal, timeout, isolation and ambiguity from ordinary errors',()=>{
 const cases=[
  [{code:'57014',message:'canceling statement due to statement timeout'},PERSISTENCE_CODES.TIMEOUT],
  [{message:'Query read timeout'},PERSISTENCE_CODES.TIMEOUT],
  [{code:'42501',message:'permission denied'},PERSISTENCE_CODES.ISOLATION],
  [{message:'wimblo.tenant_id is not set'},PERSISTENCE_CODES.ISOLATION],
  [{code:'23505',message:'duplicate key'},PERSISTENCE_CODES.CONFLICT],
  [{code:'23514',message:'check constraint'},PERSISTENCE_CODES.INVALID],
  [{code:'23503',message:'foreign key'},PERSISTENCE_CODES.INVALID],
  [{code:'ECONNREFUSED',message:'connect ECONNREFUSED'},PERSISTENCE_CODES.UNAVAILABLE],
  [{code:'57P01',message:'admin shutdown'},PERSISTENCE_CODES.UNAVAILABLE],
  [{message:'Connection terminated unexpectedly'},PERSISTENCE_CODES.UNAVAILABLE],
  [{code:PERSISTENCE_CODES.NOT_FOUND,message:'a boundary error from caller code'},PERSISTENCE_CODES.NOT_FOUND]
 ];
 for(const [error,expected] of cases)assert.equal(classifyError(error).code,expected,error.message);
 // Only a connection failure that proves no statement ran may be retried.
 assert.equal(classifyError({code:'ECONNREFUSED',message:'x'}).detail.retryable,true);
 assert.notEqual(classifyError({message:'Connection terminated unexpectedly'}).detail.retryable,true);
 assert.notEqual(classifyError({code:'23505',message:'x'}).detail.retryable,true);
});
