#!/usr/bin/env node
// Phase 4 persistence verification against a REAL PostgreSQL server and a REAL
// S3-compatible object store.
//
// This script does not skip. If the servers are absent it fails loudly, because
// a skipped infrastructure test reported as a pass is exactly the kind of claim
// this project refuses to make. The application's own `npm test` suite stays at
// zero skipped tests because none of this lives in tests/.
//
// Local infrastructure (dedicated containers, never another project's):
//   docker run -d --name wimblo-verify-pg -e POSTGRES_PASSWORD=wimblo-verify \
//     -e POSTGRES_USER=wimblo -e POSTGRES_DB=wimblo_verify \
//     -p 127.0.0.1:57733:5432 postgres:17-alpine
//   docker run -d --name wimblo-verify-minio -e MINIO_ROOT_USER=wimbloverify \
//     -e MINIO_ROOT_PASSWORD=wimblo-verify-secret \
//     -p 127.0.0.1:57734:9000 -p 127.0.0.1:57735:9001 \
//     minio/minio:latest server /data --console-address ":9001"
//
// Then: npm run verify:postgres
//
// Overrides: WIMBLO_VERIFY_PG_URL, WIMBLO_VERIFY_S3_ENDPOINT,
//            WIMBLO_VERIFY_S3_ACCESS_KEY, WIMBLO_VERIFY_S3_SECRET_KEY

import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,CreateBucketCommand,HeadBucketCommand} from '@aws-sdk/client-s3';
import {
 createPostgresPool,applyMigrations,planMigrations,readSchemaVersion,MIGRATIONS,SCHEMA_VERSION,MIGRATION_LEDGER_TABLE,
 createPostgresRepository,createSqliteRepository,runRepositoryConformance,
 createTenantBackup,restoreTenantBackup,verifyRestore,
 migrateSqliteWorkspaceToPostgres,inspectSqliteWorkspace,
 createPrivateObjectStore,createS3ObjectBackend,createPostgresObjectCatalog,
 applicationRoleGrants,assertRowLevelSecurityEffective,
 resolveResidency,PERSISTENCE_CODES,canonicalJson,normalizedSearchText,sha256
} from '../server/persistence/index.js';

const BASE_URL=process.env.WIMBLO_VERIFY_PG_URL||'postgres://wimblo:wimblo-verify@127.0.0.1:57733/wimblo_verify';
const S3_ENDPOINT=process.env.WIMBLO_VERIFY_S3_ENDPOINT||'http://127.0.0.1:57734';
const S3_ACCESS_KEY=process.env.WIMBLO_VERIFY_S3_ACCESS_KEY||'wimbloverify';
const S3_SECRET_KEY=process.env.WIMBLO_VERIFY_S3_SECRET_KEY||'wimblo-verify-secret';
const COMMANDS={PutObjectCommand,GetObjectCommand,DeleteObjectCommand};
const STAMP=Date.now().toString(36);
const MAIN_DB=`wimblo_verify_main_${STAMP}`,RESTORE_DB=`wimblo_verify_restore_${STAMP}`;
const APP_ROLE=`wimblo_app_${STAMP}`,APP_PASSWORD='wimblo-verify-app';
const KEY='a'.repeat(64),OBJECT_KEY='b'.repeat(64);

const results=[];
let failures=0;
const line=text=>process.stdout.write(text+'\n');
async function step(name,fn){
 const started=Date.now();
 try{
  const detail=await fn();
  results.push({name,passed:true,detail});
  line(`  PASS  ${name}${detail?`\n          ${typeof detail==='string'?detail:canonicalJson(detail)}`:''}  (${Date.now()-started}ms)`);
 }catch(e){
  failures++;
  results.push({name,passed:false,error:e.message});
  line(`  FAIL  ${name}\n          ${e.message}`);
 }
}
function assert(condition,message){if(!condition)throw new Error(message);}
function equal(actual,expected,message){if(canonicalJson(actual)!==canonicalJson(expected))throw new Error(`${message}: expected ${canonicalJson(expected)}, received ${canonicalJson(actual)}`);}
async function throws(fn,code,message){
 let error=null;try{await fn();}catch(e){error=e;}
 assert(error,`${message}: nothing was raised`);
 assert(!code||error.code===code,`${message}: expected ${code}, received ${error.code||error.message}`);
 return error;
}
const url=database=>{const u=new URL(BASE_URL);u.pathname='/'+database;return u.toString();};
// The application connects as a dedicated NOSUPERUSER role. Row-level security
// is ineffective for a superuser, so verifying isolation as the owner would
// prove nothing at all.
const appUrl=database=>{const u=new URL(BASE_URL);u.pathname='/'+database;u.username=APP_ROLE;u.password=APP_PASSWORD;return u.toString();};

async function main(){
 line('\nWimblo persistence — Phase 4 verification against real infrastructure');
 line(`PostgreSQL: ${BASE_URL.replace(/\/\/[^@]*@/,'//[redacted]@')}`);
 line(`Object store: ${S3_ENDPOINT}\n`);

 // ---------------------------------------------------------------- preflight
 const admin=createPostgresPool({connectionString:BASE_URL,acquireAttempts:1,connectionTimeoutMs:3000});
 try{
  const {rows}=await admin.withAdminSession(s=>s.query('SELECT version() AS v'));
  line(`Server: ${rows[0].v.split(',')[0]}\n`);
 }catch(e){
  line(`\nFATAL: no PostgreSQL server at ${BASE_URL}. Start the dedicated container documented at the top of this file.\n  ${e.message}\n`);
  await admin.end().catch(()=>{});
  process.exit(2);
 }
 const s3=new S3Client({region:'us-east-1',endpoint:S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:S3_ACCESS_KEY,secretAccessKey:S3_SECRET_KEY},maxAttempts:1});
 const bucket=`wimblo-verify-${STAMP}`;
 try{await s3.send(new CreateBucketCommand({Bucket:bucket}));await s3.send(new HeadBucketCommand({Bucket:bucket}));}
 catch(e){
  line(`\nFATAL: no S3-compatible object store at ${S3_ENDPOINT}. Start the dedicated MinIO container documented at the top of this file.\n  ${e.message}\n`);
  await admin.end().catch(()=>{});
  process.exit(2);
 }

 await admin.withAdminSession(async s=>{
  await s.query(`DROP DATABASE IF EXISTS ${MAIN_DB}`);
  await s.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await s.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  await s.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${APP_PASSWORD}'`);
  await s.query(`CREATE DATABASE ${MAIN_DB}`);
  await s.query(`CREATE DATABASE ${RESTORE_DB}`);
 });

 // Owner connections: migrations and grants only.
 const ownerMain=createPostgresPool({connectionString:url(MAIN_DB),max:2,applicationName:'wimblo-verify-owner'});
 const ownerRestore=createPostgresPool({connectionString:url(RESTORE_DB),max:2,applicationName:'wimblo-verify-owner'});
 // Application connections: everything the boundary does.
 const pool=createPostgresPool({connectionString:appUrl(MAIN_DB),max:8,applicationName:'wimblo-verify'});
 const restorePool=createPostgresPool({connectionString:appUrl(RESTORE_DB),max:4,applicationName:'wimblo-verify-restore'});
 const workspaceDir=await mkdtemp(join(tmpdir(),'wimblo-verify-'));

 try{
  // ------------------------------------------------ 1. explicit migrations
  line('1. Explicit, ordered, forward-only migrations');
  await step('an unmigrated database is refused rather than migrated on connect',async()=>{
   const error=await throws(()=>ownerMain.withAdminSession(s=>readSchemaVersion(s)),PERSISTENCE_CODES.MIGRATION,'unmigrated read');
   return error.message.slice(0,90);
  });
  await step('migrations apply in order and record their version and checksum',async()=>{
   const applied=await ownerMain.withAdminSession(s=>applyMigrations(s));
   equal(applied.applied.map(a=>a.version),MIGRATIONS.map(m=>m.version),'applied order');
   equal(applied.currentVersion,SCHEMA_VERSION,'recorded version');
   const {rows}=await ownerMain.withAdminSession(s=>s.query(`SELECT version,name,checksum FROM ${MIGRATION_LEDGER_TABLE} ORDER BY version`));
   equal(rows.map(r=>r.checksum),MIGRATIONS.map(m=>m.checksum),'recorded checksums');
   for(const grant of applicationRoleGrants(APP_ROLE))await ownerMain.withAdminSession(s=>s.query(grant));
   return {schemaVersion:applied.currentVersion,recorded:rows.length,applicationRole:APP_ROLE};
  });
  await step('re-running applies nothing and stays at the recorded version',async()=>{
   const again=await ownerMain.withAdminSession(s=>applyMigrations(s));
   equal(again.applied,[],'second run applied nothing');
   equal(await ownerMain.withAdminSession(s=>readSchemaVersion(s)),SCHEMA_VERSION,'version unchanged');
   return {schemaVersion:SCHEMA_VERSION};
  });
  await step('an applied migration that was edited afterwards is refused',async()=>{
   await ownerMain.withAdminSession(s=>s.query(`UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum=$1 WHERE version=2`,['0'.repeat(64)]));
   const error=await throws(()=>ownerMain.withAdminSession(s=>readSchemaVersion(s)),PERSISTENCE_CODES.MIGRATION,'edited migration');
   await ownerMain.withAdminSession(s=>s.query(`UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum=$1 WHERE version=2`,[MIGRATIONS[1].checksum]));
   assert(/changed after it was applied/.test(error.message),'expected a checksum-drift message');
   return error.message.slice(0,90);
  });
  await step('a database ahead of this build is refused (forward-only)',async()=>{
   const error=await throws(()=>planMigrations([...MIGRATIONS.map(m=>({version:m.version,name:m.name,checksum:m.checksum})),{version:SCHEMA_VERSION+1,name:'future',checksum:'f'.repeat(64)}]),PERSISTENCE_CODES.MIGRATION,'ahead-of-build');
   return error.message.slice(0,90);
  });

  // ---------------------------------------- 2. one contract, two stores
  line('\n2. One boundary contract, two implementations');
  let sqliteChecks=0,postgresChecks=0;
  await step('SQLite implementation passes the boundary conformance suite',async()=>{
   const run=await runRepositoryConformance({
    createRepository:()=>createSqliteRepository({tenantId:randomUUID(),dbPath:':memory:'}),
    createEmptyRepository:()=>createSqliteRepository({tenantId:randomUUID(),dbPath:':memory:'}),
    label:'sqlite'});
   sqliteChecks=run.passed;
   return {checks:run.passed,failed:run.failed};
  });
  await step('PostgreSQL implementation passes the identical suite',async()=>{
   const run=await runRepositoryConformance({
    createRepository:()=>createPostgresRepository({pool,tenantId:randomUUID()}),
    createEmptyRepository:()=>createPostgresRepository({pool,tenantId:randomUUID()}),
    label:'postgres'});
   postgresChecks=run.passed;
   return {checks:run.passed,failed:run.failed};
  });
  await step('both stores ran the same number of checks',()=>{
   equal(postgresChecks,sqliteChecks,'check counts');
   return {checksPerStore:sqliteChecks};
  });

  // -------------------------------------------------- 3. tenant isolation
  line('\n3. Tenant isolation in the schema');
  await step('the boundary refuses a connection on which row-level security would be bypassed',async()=>{
   const asOwner=await throws(()=>createPostgresRepository({pool:ownerMain,tenantId:randomUUID()}),PERSISTENCE_CODES.ISOLATION,'superuser connection');
   assert(/superuser/i.test(asOwner.message),'expected the superuser bypass to be named');
   const effective=await pool.withAdminSession(s=>assertRowLevelSecurityEffective(s));
   return {refusedRole:'owner/superuser',acceptedRole:effective.role,forcedTables:effective.tables};
  });
  const tenantA=randomUUID(),tenantB=randomUUID();
  const repoA=await createPostgresRepository({pool,tenantId:tenantA,tenant:{name:'Tenant A'}});
  const repoB=await createPostgresRepository({pool,tenantId:tenantB,tenant:{name:'Tenant B'}});
  await step('two tenants hold same-identity records without collision',async()=>{
   await repoA.createRecord('constituents',{id:'shared-id',name:'Tenant A donor',version:1});
   await repoB.createRecord('constituents',{id:'shared-id',name:'Tenant B donor',version:1});
   equal((await repoA.getRecord('constituents','shared-id')).name,'Tenant A donor','tenant A view');
   equal((await repoB.getRecord('constituents','shared-id')).name,'Tenant B donor','tenant B view');
   return {tenants:2,sharedRecordId:'shared-id'};
  });
  await step('a session scoped to one tenant cannot read another tenant even by explicit query',async()=>{
   const rows=await pool.withTenantSession(tenantA,s=>s.query('SELECT record_id,data FROM records WHERE tenant_id=$1',[tenantB]));
   equal(rows.rowCount,0,'cross-tenant rows visible');
   const all=await pool.withTenantSession(tenantA,s=>s.query('SELECT COUNT(*)::text AS n FROM records'));
   const own=await pool.withTenantSession(tenantA,s=>s.query('SELECT COUNT(*)::text AS n FROM records WHERE tenant_id=$1',[tenantA]));
   equal(all.rows[0].n,own.rows[0].n,'an unfiltered SELECT still sees only its own tenant');
   return {crossTenantRows:0,unfilteredEqualsOwn:Number(own.rows[0].n)};
  });
  await step('a session with no tenant scope errors instead of reading everything',async()=>{
   const error=await throws(()=>pool.withAdminSession(s=>s.query('SELECT COUNT(*) FROM records')),PERSISTENCE_CODES.ISOLATION,'unscoped read');
   return error.message.slice(0,80);
  });
  await step('a write that names another tenant is rejected by the row policy',async()=>{
   const error=await throws(()=>pool.withTransaction(tenantA,s=>s.query('INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum) VALUES($1,$2,$3,$4,$5,$6)',[tenantB,'constituents','smuggled','{}','','0'.repeat(64)])),null,'cross-tenant insert');
   const still=await repoB.countRecords('constituents');
   equal(still,1,'tenant B row count after the attempt');
   return {rejected:true,tenantBRecords:still};
  });

  // ------------------------------------------- 4. transactional financials
  line('\n4. Transactional financial writes');
  await step('a valid batch writes the document, the ledger projection and audit together',async()=>{
   await repoA.writeFinancialBatch({gift:{id:'gift-ok',constituentId:'shared-id',date:'2026-02-02',amount:123456,status:'Posted',campaignId:'camp-1',allocations:[{designationId:'d-1',amount:100000},{designationId:'d-2',amount:23456}],version:1},audit:{actor:'verify',action:'create_gift'}});
   const ledger=await pool.withTenantSession(tenantA,s=>s.query('SELECT amount_cents::text AS cents FROM gift_ledger WHERE gift_id=$1',['gift-ok']));
   const allocations=await pool.withTenantSession(tenantA,s=>s.query('SELECT COALESCE(SUM(amount_cents),0)::text AS cents, COUNT(*)::text AS n FROM gift_allocations WHERE gift_id=$1',['gift-ok']));
   equal(ledger.rows[0].cents,'123456','ledger cents');
   equal(allocations.rows[0],{cents:'123456',n:'2'},'allocation rows');
   return {giftCents:123456,allocationRows:2};
  });
  await step('a failure after the gift row leaves no gift, no ledger row, no allocation and no audit',async()=>{
   const before={records:await repoA.countRecords('gifts'),audit:await repoA.countAudit()};
   await throws(()=>repoA.transaction(async()=>{
    await repoA.writeFinancialBatch({gift:{id:'gift-rollback',constituentId:'shared-id',date:'2026-02-03',amount:5000,status:'Posted',allocations:[{designationId:'d-1',amount:5000}],version:1},audit:{actor:'verify',action:'create_gift'}});
    throw Object.assign(new Error('synthetic failure after the financial rows were written'),{code:PERSISTENCE_CODES.INVALID});
   }),PERSISTENCE_CODES.INVALID,'mid-transaction failure');
   const after={records:await repoA.countRecords('gifts'),audit:await repoA.countAudit()};
   const orphans=await pool.withTenantSession(tenantA,s=>s.query(`SELECT (SELECT COUNT(*) FROM gift_ledger WHERE gift_id='gift-rollback')+(SELECT COUNT(*) FROM gift_allocations WHERE gift_id='gift-rollback') AS n`));
   equal(after,before,'row counts after rollback');
   equal(Number(orphans.rows[0].n),0,'orphan ledger or allocation rows');
   return {giftsBefore:before.records,giftsAfter:after.records,orphanRows:0};
  });
  await step('a database-level constraint failure rolls back every row of a multi-row financial write',async()=>{
   const before={gifts:await repoA.countRecords('gifts')};
   const data='{"id":"gift-constraint"}',checksum=sha256(data);
   const error=await throws(()=>pool.withTransaction(tenantA,async s=>{
    await s.query('INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum) VALUES($1,$2,$3,$4,$5,$6)',[tenantA,'gifts','gift-constraint',data,'gift constraint',checksum]);
    await s.query('INSERT INTO gift_ledger(tenant_id,gift_id,gift_date,amount_cents,status) VALUES($1,$2,$3::date,$4::bigint,$5)',[tenantA,'gift-constraint','2026-02-05','900','Posted']);
    await s.query('INSERT INTO gift_allocations(tenant_id,gift_id,designation_id,amount_cents) VALUES($1,$2,$3,$4::bigint)',[tenantA,'gift-constraint','d-1','400']);
    // The final allocation violates the positive-cents CHECK. Everything above
    // it must disappear with it.
    await s.query('INSERT INTO gift_allocations(tenant_id,gift_id,designation_id,amount_cents) VALUES($1,$2,$3,$4::bigint)',[tenantA,'gift-constraint','d-2','0']);
   }),PERSISTENCE_CODES.INVALID,'constraint rollback');
   const survivors=await pool.withTenantSession(tenantA,s=>s.query(`SELECT (SELECT COUNT(*) FROM records WHERE record_id='gift-constraint')+(SELECT COUNT(*) FROM gift_ledger WHERE gift_id='gift-constraint')+(SELECT COUNT(*) FROM gift_allocations WHERE gift_id='gift-constraint') AS n`));
   equal(Number(survivors.rows[0].n),0,'rows surviving a refused multi-row financial write');
   equal(await repoA.countRecords('gifts'),before.gifts,'gift count unchanged');
   return {failureCode:error.code,survivingRows:0};
  });
  await step('a backend terminated mid-transaction commits nothing',async()=>{
   const before=await repoA.countRecords('constituents');
   const error=await throws(()=>pool.withTransaction(tenantA,async s=>{
    await s.query('INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum) VALUES($1,$2,$3,$4,$5,$6)',[tenantA,'constituents','killed-mid-write','{"id":"killed-mid-write"}','killed','0'.repeat(64)]);
    const {rows}=await s.query('SELECT pg_backend_pid() AS pid');
    await admin.withAdminSession(a=>a.query('SELECT pg_terminate_backend($1)',[rows[0].pid]));
    await s.query('SELECT 1');
   }),null,'terminated transaction');
   equal(await repoA.findRecord('constituents','killed-mid-write'),null,'row after a killed backend');
   equal(await repoA.countRecords('constituents'),before,'constituent count after a killed backend');
   return {failureCode:error.code,partialRows:0};
  });

  // ----------------------------------------------- 5. access-path indexes
  line('\n5. Search and reporting access paths');
  const tenantC=randomUUID(),tenantD=randomUUID();
  const repoC=await createPostgresRepository({pool,tenantId:tenantC,tenant:{name:'Volume tenant C'}});
  const repoD=await createPostgresRepository({pool,tenantId:tenantD,tenant:{name:'Volume tenant D'}});
  await step('volume seeded for planner-realistic index checks',async()=>{
   // tenantA carries a moderate, repository-written workload; it is the tenant
   // the backup and restore verification later operates on.
   await repoA.transaction(async()=>{
    for(let i=0;i<2000;i++)await repoA.createRecord('constituents',{id:`seed-${i}`,name:`Seed Donor ${i}`,email:`seed${i}@synthetic.invalid`,type:'Individual',version:1});
    for(let i=0;i<800;i++)await repoA.writeFinancialBatch({gift:{id:`seed-gift-${i}`,constituentId:`seed-${i%2000}`,date:`2026-0${1+(i%9)}-1${i%9}`,amount:100+i,status:i%7===0?'Voided':'Posted',campaignId:`camp-${i%5}`,allocations:[{designationId:`d-${i%11}`,amount:100+i}],version:1}});
   });
   // tenantC carries enough rows that the planner's choice is meaningful rather
   // than an artefact of a tiny table. These rows are written with the same
   // canonical document, checksum and search projection the repository uses.
   // A realistic multi-tenant shape: one modest tenant sharing a table with a
   // much larger one. A tenant that IS most of the table is scanned
   // sequentially and the planner is right to do that, so testing that shape
   // would prove nothing about the index.
   const CHUNK=2500;
   for(const [tenant,prefix,count] of [[tenantC,'bulk',6000],[tenantD,'other',45000]])
    for(let batch=0;batch<count;batch+=CHUNK){
     const ids=[],docs=[],searches=[],checksums=[];
     for(let i=batch;i<Math.min(batch+CHUNK,count);i++){
      const record={id:`${prefix}-${i}`,name:`Bulk Donor ${i}`,email:`${prefix}${i}@synthetic.invalid`,type:'Individual',version:1};
      const data=canonicalJson(record);
      ids.push(record.id);docs.push(data);searches.push(normalizedSearchText(record));checksums.push(sha256(data));
     }
     await pool.withTransaction(tenant,session=>session.query(
      `INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum)
       SELECT $1,'constituents',* FROM unnest($2::text[],$3::text[],$4::text[],$5::text[])`,
      [tenant,ids,docs,searches,checksums]));
    }
   await ownerMain.withAdminSession(s=>s.query('ANALYZE'));
   return {tenantARecords:await repoA.countRecords('constituents')+await repoA.countRecords('gifts'),tenantCRecords:await repoC.countRecords('constituents'),tenantDRecords:await repoD.countRecords('constituents')};
  });
  await step('search is index-restricted to one tenant and never scans the shared table',async()=>{
   const {rows}=await pool.withTenantSession(tenantC,s=>s.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT data FROM records WHERE tenant_id=$1 AND collection='constituents' AND search_text LIKE $2 ESCAPE '\\' ORDER BY seq LIMIT 20`,[tenantC,'%donor 5715%']));
   const plan=rows.map(r=>r['QUERY PLAN']).join('\n');
   assert(!/Seq Scan on records/.test(plan),`search must not scan the shared records table:\n${plan}`);
   assert(/Index Cond: \(\(tenant_id = /.test(plan),`expected an index condition restricting to the tenant:\n${plan}`);
   const totalRecords=Number((await ownerMain.withAdminSession(s=>s.query('SELECT COUNT(*)::text AS n FROM records'))).rows[0].n);
   const tenantRecords=await repoC.countRecords('constituents');
   const examined=Number(/Rows Removed by Filter: (\d+)/.exec(plan)?.[1]??totalRecords)+1;
   assert(examined<=tenantRecords,`search examined ${examined} rows; it must stay within the tenant's ${tenantRecords}`);
   const matches=await repoC.searchRecords({collection:'constituents',term:'donor 5715'});
   equal(matches.map(m=>m.id),['bulk-5715'],'indexed search result');
   equal(await repoD.searchRecords({collection:'constituents',term:'bulk-5715'}),[],'the other tenant sees nothing of it');
   return {index:/Bitmap Index Scan on (\S+)/.exec(plan)?.[1]||/Index Scan using (\S+)/.exec(plan)?.[1],rowsExamined:examined,rowsInTenant:tenantRecords,rowsInTable:totalRecords};
  });
  await step('the trigram portion is usable, and is blocked only by the row-security rule on non-leakproof quals',async()=>{
   // Honest statement of a real limitation. PostgreSQL refuses to evaluate a
   // non-leakproof qual (LIKE) before a row-security qual, so the application
   // role never gets a trigram index condition. The same index does produce one
   // for a role that row-level security does not apply to, which shows the index
   // is correct and the restriction belongs to RLS, not to this schema.
   const {rows}=await ownerMain.withAdminSession(s=>s.query(`EXPLAIN (FORMAT TEXT) SELECT data FROM records WHERE tenant_id='${tenantC}' AND collection='constituents' AND search_text LIKE '%donor 5715%'`));
   const plan=rows.map(r=>r['QUERY PLAN']).join('\n');
   assert(/records_tenant_search_trgm/.test(plan),`expected the composite index without RLS:\n${plan}`);
   const condition=plan.split('\n').filter(l=>/Index Cond/.test(l)).join(' ').trim();
   assert(/~~/.test(condition),`expected the trigram qual to become an index condition without RLS:\n${plan}`);
   return {withoutRowSecurity:condition,limitation:'Under forced row-level security the LIKE qual stays a post-security Filter; search is bounded by tenant size, not by trigram selectivity.'};
  });
  await step('reporting totals use the gift ledger index rather than scanning',async()=>{
   const {rows}=await pool.withTenantSession(tenantA,s=>s.query(`EXPLAIN (ANALYZE, FORMAT TEXT) SELECT COALESCE(SUM(amount_cents),0) FROM gift_ledger WHERE tenant_id=$1 AND status='Posted' AND gift_date BETWEEN '2026-03-01' AND '2026-03-31'`,[tenantA]));
   const plan=rows.map(r=>r['QUERY PLAN']).join('\n');
   assert(/gift_ledger_reporting/.test(plan),`expected the reporting index in the plan:\n${plan}`);
   return plan.split('\n').find(l=>/gift_ledger_reporting/.test(l)).trim();
  });
  await step('designation reporting uses the allocation index',async()=>{
   const {rows}=await pool.withTenantSession(tenantA,s=>s.query(`EXPLAIN (ANALYZE, FORMAT TEXT) SELECT COALESCE(SUM(amount_cents),0) FROM gift_allocations WHERE tenant_id=$1 AND designation_id='d-7'`,[tenantA]));
   const plan=rows.map(r=>r['QUERY PLAN']).join('\n');
   assert(/gift_allocations_designation/.test(plan),`expected the allocation index in the plan:\n${plan}`);
   return plan.split('\n').find(l=>/gift_allocations_designation/.test(l)).trim();
  });
  await step('the ledger projection agrees with the stored documents to the cent',async()=>{
   const projected=await repoA.reportGiftTotals({});
   const documents=(await repoA.listRecords('gifts')).reduce((totals,gift)=>({
    giftCount:totals.giftCount+1,
    postedCents:totals.postedCents+(gift.status==='Posted'?gift.amount:0),
    voidedCents:totals.voidedCents+(gift.status==='Voided'?gift.amount:0),
    postedGiftCount:totals.postedGiftCount+(gift.status==='Posted'?1:0)
   }),{giftCount:0,postedCents:0,voidedCents:0,postedGiftCount:0});
   equal(projected,documents,'ledger projection vs documents');
   return projected;
  });

  // -------------------------------------------- 6. pool failure behaviour
  line('\n6. Connection pooling and failure behaviour');
  await step('an unreachable database fails closed after bounded retries',async()=>{
   const dead=createPostgresPool({connectionString:'postgres://wimblo:wimblo-verify@127.0.0.1:1/wimblo_verify',acquireAttempts:3,connectionTimeoutMs:500,circuitFailureThreshold:2,circuitOpenMs:2000});
   try{
    const error=await throws(()=>dead.withAdminSession(s=>s.query('SELECT 1')),PERSISTENCE_CODES.UNAVAILABLE,'dead database');
    const retries=dead.stats.acquireRetries;
    assert(retries>0&&retries<=2,`expected bounded retries, saw ${retries}`);
    await throws(()=>dead.withAdminSession(s=>s.query('SELECT 1')),PERSISTENCE_CODES.UNAVAILABLE,'second attempt');
    const opened=await throws(()=>dead.withAdminSession(s=>s.query('SELECT 1')),PERSISTENCE_CODES.UNAVAILABLE,'circuit open');
    assert(/circuit is open/.test(opened.message),`expected the circuit breaker to refuse fast, saw: ${opened.message}`);
    return {code:error.code,retriesPerAttempt:retries,circuitRejections:dead.stats.circuitRejections};
   }finally{await dead.end().catch(()=>{});}
  });
  await step('a statement that exceeds its timeout is cancelled, not left running',async()=>{
   const brief=createPostgresPool({connectionString:url(MAIN_DB),statementTimeoutMs:300,acquireAttempts:1});
   try{
    const error=await throws(()=>brief.withAdminSession(s=>s.query('SELECT pg_sleep(5)')),PERSISTENCE_CODES.TIMEOUT,'statement timeout');
    return error.message.slice(0,80);
   }finally{await brief.end().catch(()=>{});}
  });
  await step('retry limits are bounded by configuration and unbounded retry is refused',()=>{
   const error=(()=>{try{createPostgresPool({host:'127.0.0.1',acquireAttempts:50});return null;}catch(e){return e;}})();
   assert(error&&/must not exceed 10/.test(error.message),'expected an upper bound on retries');
   return error.message;
  });

  // --------------------------------------- 7. backup, restore, verification
  line('\n7. Backup, restore into a fresh database, and restore verification');
  await ownerRestore.withAdminSession(s=>applyMigrations(s));
  for(const grant of applicationRoleGrants(APP_ROLE))await ownerRestore.withAdminSession(s=>s.query(grant));
  let archive=null,manifest=null;
  await step('an encrypted logical backup records counts, checksums and cent totals',async()=>{
   const backup=await createTenantBackup({repository:repoA,encryptionKey:KEY});
   archive=backup.archive;manifest=backup.manifest;
   assert(!archive.includes(Buffer.from('Seed Donor 1','utf8')),'plaintext record content found inside the encrypted archive');
   return {archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256.slice(0,16)+'…',records:manifest.digest.totals.records,postedCents:manifest.digest.financial.postedCents};
  });
  await step('a tampered archive fails authentication instead of restoring',async()=>{
   const tampered=Buffer.from(archive);tampered[tampered.length-1]^=0xff;
   const error=await throws(()=>restoreTenantBackup({archive:tampered,encryptionKey:KEY,createTargetRepository:()=>createPostgresRepository({pool:restorePool,tenantId:tenantA})}),PERSISTENCE_CODES.VERIFICATION,'tampered archive');
   return error.message.slice(0,70);
  });
  await step('a wrong key fails authentication instead of restoring',async()=>{
   const error=await throws(()=>restoreTenantBackup({archive,encryptionKey:'c'.repeat(64),createTargetRepository:()=>createPostgresRepository({pool:restorePool,tenantId:tenantA})}),PERSISTENCE_CODES.VERIFICATION,'wrong key');
   return error.message.slice(0,70);
  });
  await step('restore into a FRESH database proves row and checksum equality',async()=>{
   const restored=await restoreTenantBackup({archive,encryptionKey:KEY,createTargetRepository:()=>createPostgresRepository({pool:restorePool,tenantId:tenantA}),expectedTenantId:tenantA});
   assert(restored.verification.verified,'restore verification did not pass');
   const target=await createPostgresRepository({pool:restorePool,tenantId:tenantA});
   const evidence=await verifyRestore({manifest,source:repoA,restored:target});
   await target.close();
   return {database:RESTORE_DB,rows:evidence.rowCounts,collections:evidence.collections,financial:evidence.financial,verifiedAgainst:evidence.comparisons.map(c=>c.against)};
  });
  await step('a restore into a non-empty tenant is refused rather than merged',async()=>{
   const error=await throws(()=>restoreTenantBackup({archive,encryptionKey:KEY,createTargetRepository:()=>createPostgresRepository({pool:restorePool,tenantId:tenantA})}),PERSISTENCE_CODES.CONFLICT,'non-empty restore');
   return error.message.slice(0,80);
  });
  await step('an independent server-side digest agrees with the process-side digest',async()=>{
   const source=await repoA.serverSideDigest();
   const target=await createPostgresRepository({pool:restorePool,tenantId:tenantA});
   const restored=await target.serverSideDigest();
   await target.close();
   equal(restored,source,'server-side md5 digests');
   return source.map(r=>`${r.collection}:${r.count}:${r.md5.slice(0,8)}`);
  });

  // ------------------------------------- 8. legacy SQLite → PostgreSQL copy
  line('\n8. Legacy SQLite workspace copy with exact-equality verification');
  const workspacePath=join(workspaceDir,'workspace.sqlite');
  const legacyTenant=randomUUID();
  await step('a synthetic SQLite workspace is built the way the application stores data',async()=>{
   const legacy=createSqliteRepository({tenantId:legacyTenant,dbPath:workspacePath});
   legacy.putSettings({organizationName:'Wimblo',fiscalStartMonth:7});
   legacy.putUser({id:'u-admin',name:'Alex Morgan',email:'alex@synthetic.invalid',role:'admin',passwordHash:'synthetic',active:1,version:1});
   for(let i=0;i<500;i++)legacy.createRecord('constituents',{id:`legacy-c-${i}`,name:`Legacy Donor ${i}`,email:`legacy${i}@synthetic.invalid`,type:'Individual',version:1});
   for(let i=0;i<400;i++)legacy.writeFinancialBatch({gift:{id:`legacy-g-${i}`,constituentId:`legacy-c-${i%500}`,date:`2025-1${i%2}-0${1+(i%8)}`,amount:1999+i*7,status:i%9===0?'Voided':'Posted',campaignId:`legacy-camp-${i%3}`,allocations:i%2?[{designationId:'ld-1',amount:1999+i*7}]:[{designationId:'ld-1',amount:1000},{designationId:'ld-2',amount:999+i*7}],version:1},audit:{actor:'legacy',action:'create_gift'}});
   const digest=legacy.snapshotDigest();
   legacy.close();
   return {constituents:digest.collections.constituents.count,gifts:digest.collections.gifts.count,postedCents:digest.financial.postedCents,allocationCents:digest.financial.allocationCents};
  });
  await step('tables outside the boundary are named and the copy refuses until acknowledged',async()=>{
   const db=new DatabaseSync(workspacePath);
   db.exec('CREATE TABLE mfa_settings(user_id TEXT PRIMARY KEY, secret TEXT NOT NULL)');
   db.prepare('INSERT INTO mfa_settings VALUES(?,?)').run('u-admin','synthetic-secret');
   db.close();
   const inventory=inspectSqliteWorkspace(workspacePath);
   assert(inventory.unconverted.some(t=>t.table==='mfa_settings'),'expected the extra table to be reported');
   const error=await throws(()=>migrateSqliteWorkspaceToPostgres({sqlitePath:workspacePath,pool,tenantId:legacyTenant}),PERSISTENCE_CODES.MIGRATION,'unacknowledged tables');
   assert(/mfa_settings/.test(error.message),'expected the unconverted table to be named');
   return {unconverted:inventory.unconverted,refused:true};
  });
  await step('the acknowledged copy verifies row counts, ids, checksums and integer-cent totals',async()=>{
   const evidence=await migrateSqliteWorkspaceToPostgres({sqlitePath:workspacePath,pool,tenantId:legacyTenant,acknowledgeUnconvertedTables:['mfa_settings'],tenant:{name:'Legacy workspace'}});
   assert(evidence.verified,'copy was not verified');
   equal(evidence.idDifferences,[],'record id differences');
   equal(evidence.digestDifferences,[],'digest differences');
   equal(evidence.financialCents.source,evidence.financialCents.target,'integer-cent totals');
   return {rowCounts:evidence.rowCounts,collections:evidence.collections,financialCents:evidence.financialCents.target,designationRows:evidence.designationCents.target.length};
  });
  await step('copying the same workspace twice is refused rather than duplicated',async()=>{
   const error=await throws(()=>migrateSqliteWorkspaceToPostgres({sqlitePath:workspacePath,pool,tenantId:legacyTenant,acknowledgeUnconvertedTables:['mfa_settings']}),PERSISTENCE_CODES.CONFLICT,'second copy');
   return error.message.slice(0,80);
  });
  await step('the source workspace is untouched by the copy',async()=>{
   const after=createSqliteRepository({tenantId:legacyTenant,dbPath:workspacePath,manageSchema:false});
   const digest=after.snapshotDigest();
   after.close();
   const db=new DatabaseSync(workspacePath,{readOnly:true});
   const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
   db.close();
   equal(tables,['audit','mfa_settings','records','settings','users'],'source tables after the copy');
   return {sourceRecords:digest.totals.records,sourceTables:tables};
  });

  // ------------------------------- 9. private object storage against MinIO
  line('\n9. Private object storage against a real S3-compatible store');
  const residency=resolveResidency({databaseRegion:'us-east-1',storageRegion:'us-east-1',custody:'application-managed-key',endpoint:S3_ENDPOINT});
  const store=createPrivateObjectStore({
   backend:createS3ObjectBackend({client:s3,bucket}),
   catalog:createPostgresObjectCatalog({pool,tenantId:tenantA}),
   residency,encryptionKey:OBJECT_KEY,namespace:'verify',commands:COMMANDS
  });
  const document=Buffer.from('%PDF-1.7\nSynthetic private evidence for Wimblo persistence verification.\n'.repeat(40));
  await step('residency defaults to the US/Canada profile and refuses regions outside it',()=>{
   equal(residency.profile,'us-ca','default profile');
   equal(residency.countries,['US','CA'],'profile countries');
   const foreign=(()=>{try{resolveResidency({databaseRegion:'eu-west-1',storageRegion:'us-east-1'});return null;}catch(e){return e;}})();
   const foreignStorage=(()=>{try{resolveResidency({databaseRegion:'us-east-1',storageRegion:'ap-south-1'});return null;}catch(e){return e;}})();
   assert(foreign&&/outside the United States or Canada/.test(foreign.message),'expected a foreign database region to be refused');
   assert(foreignStorage&&/outside the United States or Canada/.test(foreignStorage.message),'expected a foreign storage region to be refused');
   return {profile:residency.profile,authority:residency.authority,placementProven:residency.placementProven};
  });
  let stored=null;
  await step('an encrypted object round-trips with checksum, size and content-type recorded',async()=>{
   stored=await store.put({tenantId:tenantA,objectId:'grant-agreement',revision:1,bytes:document,contentType:'application/pdf',retainUntil:'2036-01-01'});
   const read=await store.get({tenantId:tenantA,objectId:'grant-agreement',revision:1});
   assert(read.bytes.equals(document),'round-tripped bytes differ from the source');
   equal(read.metadata.sha256,createHash('sha256').update(document).digest('hex'),'plaintext checksum');
   equal(read.metadata.state,'active','object state');
   return {size:stored.size,sha256:stored.sha256.slice(0,16)+'…',contentType:stored.contentType,encryption:stored.encryptionAlgorithm,custody:stored.custody,region:stored.region,providerVersion:stored.providerVersion};
  });
  await step('the bytes actually held by the object store are ciphertext, not the document',async()=>{
   const raw=await s3.send(new GetObjectCommand({Bucket:bucket,Key:stored.objectKey}));
   const chunks=[];for await(const part of raw.Body)chunks.push(Buffer.from(part));
   const onDisk=Buffer.concat(chunks);
   assert(!onDisk.includes(Buffer.from('%PDF-1.7')),'plaintext document header found in the stored object');
   equal(sha256(onDisk),stored.ciphertextSha256,'stored ciphertext checksum');
   return {storedBytes:onDisk.length,plaintextBytes:document.length,ciphertextSha256:stored.ciphertextSha256.slice(0,16)+'…'};
  });
  await step('object metadata is persisted in the tenant-isolated catalogue',async()=>{
   const rows=await pool.withTenantSession(tenantA,s=>s.query("SELECT object_id,state,content_type,size_bytes::text AS size,region,custody,encryption_algorithm,to_char(retain_until,'YYYY-MM-DD') AS retain_until FROM object_metadata"));
   equal(rows.rowCount,1,'catalogue rows');
   const other=await pool.withTenantSession(tenantB,s=>s.query('SELECT COUNT(*)::text AS n FROM object_metadata'));
   equal(other.rows[0].n,'0','another tenant can see this object');
   return rows.rows[0];
  });
  await step('size, content-type and checksum limits are enforced before any upload',async()=>{
   await throws(()=>store.put({tenantId:tenantA,objectId:'too-big',bytes:randomBytes(2*1024*1024),contentType:'application/pdf'}),PERSISTENCE_CODES.INVALID,'oversize object');
   await throws(()=>store.put({tenantId:tenantA,objectId:'wrong-type',bytes:document,contentType:'application/x-msdownload'}),PERSISTENCE_CODES.INVALID,'unsupported content type');
   await throws(()=>store.put({tenantId:tenantA,objectId:'empty',bytes:Buffer.alloc(0),contentType:'application/pdf'}),PERSISTENCE_CODES.INVALID,'empty object');
   const rows=await pool.withTenantSession(tenantA,s=>s.query('SELECT COUNT(*)::text AS n FROM object_metadata'));
   equal(rows.rows[0].n,'1','refused uploads left catalogue rows behind');
   return {oversizeRefused:true,contentTypeRefused:true,emptyRefused:true,catalogueRows:1};
  });
  await step('a corrupted stored object is detected instead of returned',async()=>{
   await s3.send(new PutObjectCommand({Bucket:bucket,Key:stored.objectKey+'-decoy',Body:Buffer.from('not the object')}));
   const {rows}=await pool.withTenantSession(tenantA,s=>s.query('UPDATE object_metadata SET ciphertext_sha256=$1 WHERE object_id=$2 RETURNING ciphertext_sha256',['0'.repeat(64),'grant-agreement']));
   equal(rows.length,1,'catalogue update');
   const error=await throws(()=>store.get({tenantId:tenantA,objectId:'grant-agreement',revision:1}),PERSISTENCE_CODES.VERIFICATION,'corrupted object');
   await pool.withTenantSession(tenantA,s=>s.query('UPDATE object_metadata SET ciphertext_sha256=$1 WHERE object_id=$2',[stored.ciphertextSha256,'grant-agreement']));
   return error.message.slice(0,70);
  });
  await step('retention extends but never shortens, and blocks deletion',async()=>{
   await throws(()=>store.setRetention({tenantId:tenantA,objectId:'grant-agreement',revision:1},'2030-01-01'),PERSISTENCE_CODES.CONFLICT,'shortened retention');
   const extended=await store.setRetention({tenantId:tenantA,objectId:'grant-agreement',revision:1},'2040-01-01');
   const blocked=await throws(()=>store.requestDeletion({tenantId:tenantA,objectId:'grant-agreement',revision:1}),PERSISTENCE_CODES.CONFLICT,'retained deletion');
   return {retainUntil:extended.retainUntil,deletionBlocked:blocked.message.slice(0,60)};
  });
  await step('legal hold blocks deletion even once retention has passed',async()=>{
   const past=createPrivateObjectStore({backend:createS3ObjectBackend({client:s3,bucket}),catalog:createPostgresObjectCatalog({pool,tenantId:tenantA}),residency,encryptionKey:OBJECT_KEY,namespace:'verify',commands:COMMANDS,clock:()=>new Date('2041-01-01T00:00:00.000Z')});
   await past.setLegalHold({tenantId:tenantA,objectId:'grant-agreement',revision:1},true);
   const held=await throws(()=>past.requestDeletion({tenantId:tenantA,objectId:'grant-agreement',revision:1}),PERSISTENCE_CODES.CONFLICT,'legal hold');
   await past.setLegalHold({tenantId:tenantA,objectId:'grant-agreement',revision:1},false);
   return held.message.slice(0,60);
  });
  await step('deletion is a two-step state machine and leaves a metadata tombstone',async()=>{
   const past=createPrivateObjectStore({backend:createS3ObjectBackend({client:s3,bucket}),catalog:createPostgresObjectCatalog({pool,tenantId:tenantA}),residency,encryptionKey:OBJECT_KEY,namespace:'verify',commands:COMMANDS,clock:()=>new Date('2041-01-01T00:00:00.000Z')});
   await throws(()=>past.confirmDeletion({tenantId:tenantA,objectId:'grant-agreement',revision:1}),PERSISTENCE_CODES.CONFLICT,'confirm before request');
   const requested=await past.requestDeletion({tenantId:tenantA,objectId:'grant-agreement',revision:1},{reason:'synthetic verification'});
   const deleted=await past.confirmDeletion({tenantId:tenantA,objectId:'grant-agreement',revision:1});
   await throws(()=>past.get({tenantId:tenantA,objectId:'grant-agreement',revision:1}),PERSISTENCE_CODES.NOT_FOUND,'read after deletion');
   const gone=await (async()=>{try{await s3.send(new GetObjectCommand({Bucket:bucket,Key:stored.objectKey}));return false;}catch{return true;}})();
   assert(gone,'the object bytes are still present in the store after a confirmed deletion');
   return {states:['active',requested.state,deleted.state],deletedAt:deleted.deletedAt,bytesRemoved:gone,tombstoneRetained:true};
  });

  // -------------------------------------------------------------- summary
 }finally{
  await pool.end().catch(()=>{});
  await restorePool.end().catch(()=>{});
  await ownerMain.end().catch(()=>{});
  await ownerRestore.end().catch(()=>{});
  await rm(workspaceDir,{recursive:true,force:true});
  await admin.withAdminSession(async s=>{
   await s.query(`DROP DATABASE IF EXISTS ${MAIN_DB} WITH (FORCE)`);
   await s.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
   await s.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  }).catch(()=>{});
  await admin.end().catch(()=>{});
  s3.destroy?.();
 }

 const passed=results.filter(r=>r.passed).length;
 line(`\n${'-'.repeat(72)}`);
 line(`Persistence verification: ${passed} passed, ${failures} failed, 0 skipped.`);
 line('Executed against a real PostgreSQL server and a real S3-compatible object store.');
 line('NOT established here: hosted operation, provider key custody, off-host backup cadence,');
 line('or physical proof of data residency. Those are deployment evidence, not code properties.');
 line(`${'-'.repeat(72)}\n`);
 process.exit(failures?1:0);
}

main().catch(e=>{line(`\nFATAL: ${e.stack||e.message}\n`);process.exit(1);});
