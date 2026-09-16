// Legacy SQLite compatibility during the transition.
//
// The documented, tested path for moving one workspace from the SQLite store
// the application runs on today into the PostgreSQL store, and PROVING the copy
// is exact before anything is cut over.
//
// How to run it
// -------------
//   1. Stop writers. This copy is a point-in-time snapshot; it does not follow
//      changes made while it runs, and it says so rather than pretending to.
//   2. Migrate the target database explicitly (applyMigrations). This function
//      refuses an unmigrated target; it never migrates one as a side effect.
//   3. Call migrateSqliteWorkspaceToPostgres() with the workspace path, a pool
//      and the tenant UUID. The source is opened READ-ONLY, so a failure cannot
//      damage the workspace the application is still serving.
//   4. Read the returned evidence. The copy is only reported as verified when
//      every one of these is equal on both stores:
//        - per-collection row counts
//        - the exact set of record ids in every collection
//        - the SHA-256 digest of every collection's canonical documents
//        - user, audit and settings digests
//        - integer-cent totals: posted, voided, and the sum of all allocations
//      Any difference throws with the differing fields named.
//
// What this does NOT do
// ---------------------
//   * It does not convert tables outside the boundary's own four (records,
//     users, settings, audit). Feature modules have created additional SQLite
//     tables — MFA, document revisions, and others. Those are listed by name
//     and row count in the evidence and the copy is REFUSED unless the caller
//     explicitly acknowledges leaving them behind. Silence would be the bug.
//   * It does not move private object bytes. Those live in the object store and
//     have their own custody and verification path.
//   * It does not switch the application over. Cutover is an operational
//     decision with its own evidence.

import {DatabaseSync} from 'node:sqlite';
import {PERSISTENCE_CODES,persistenceFail,assertTenantId,canonicalJson} from './contract.js';
import {createSqliteRepository,WORKSPACE_TABLES} from './sqliteRepository.js';
import {createPostgresRepository} from './postgresRepository.js';

const UNCONVERTED_IGNORED=/^sqlite_/;

export function inspectSqliteWorkspace(dbPath){
 const db=new DatabaseSync(dbPath,{readOnly:true});
 try{
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>r.name).filter(name=>!UNCONVERTED_IGNORED.test(name));
  const missing=WORKSPACE_TABLES.filter(name=>!tables.includes(name));
  if(missing.length)persistenceFail(PERSISTENCE_CODES.MIGRATION,`This file is not a Wimblo workspace; missing ${missing.join(', ')}.`);
  const unconverted=tables.filter(name=>!WORKSPACE_TABLES.includes(name)).map(name=>({
   table:name,
   rows:Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"','""')}"`).get().n)
  }));
  const converted=WORKSPACE_TABLES.map(name=>({table:name,rows:Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n)}));
  return {dbPath,converted,unconverted,unconvertedRows:unconverted.reduce((n,t)=>n+t.rows,0)};
 }finally{db.close();}
}

function compareDigests(source,target){
 const differences=[];
 const fields=['schemaVersion','totals','financial','users','audit','settings'];
 for(const field of fields)if(canonicalJson(source[field])!==canonicalJson(target[field]))differences.push({field,source:source[field],target:target[field]});
 const collections=new Set([...Object.keys(source.collections),...Object.keys(target.collections)]);
 for(const collection of collections){
  const a=source.collections[collection],b=target.collections[collection];
  if(canonicalJson(a)!==canonicalJson(b))differences.push({field:`collections.${collection}`,source:a??null,target:b??null});
 }
 return differences;
}

/**
 * @param {object} options
 * @param {string} options.sqlitePath                     workspace file to copy from (opened read-only)
 * @param {object} options.pool                           a createPostgresPool() instance for the target
 * @param {string} options.tenantId                       tenant UUID for the copied workspace
 * @param {string[]} [options.acknowledgeUnconvertedTables] tables the caller accepts leaving behind
 * @param {object} [options.tenant]                       tenant name/residency for registration
 */
export async function migrateSqliteWorkspaceToPostgres({sqlitePath,pool,tenantId,acknowledgeUnconvertedTables=[],tenant={},dryRun=false}={}){
 const tenant_id=assertTenantId(tenantId);
 if(typeof sqlitePath!=='string'||!sqlitePath)persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit SQLite workspace path is required.');
 const inventory=inspectSqliteWorkspace(sqlitePath);
 const acknowledged=new Set(acknowledgeUnconvertedTables);
 const unacknowledged=inventory.unconverted.filter(t=>!acknowledged.has(t.table));
 if(unacknowledged.length)persistenceFail(PERSISTENCE_CODES.MIGRATION,
  `This workspace holds ${unacknowledged.length} table(s) outside the persistence boundary: ${unacknowledged.map(t=>`${t.table} (${t.rows} rows)`).join(', ')}. Convert them or acknowledge them explicitly; they are not copied and will not exist in PostgreSQL.`,
  {unconverted:inventory.unconverted});

 const source=createSqliteRepository({tenantId:tenant_id,dbPath:sqlitePath,readOnly:true,manageSchema:false,tenant});
 let target=null;
 try{
  const sourceDigest=source.snapshotDigest();
  if(dryRun)return {dryRun:true,tenantId:tenant_id,inventory,sourceDigest,verified:false,notice:'Dry run: nothing was written to PostgreSQL.'};
  // createPostgresRepository refuses an unmigrated or mismatched database.
  target=await createPostgresRepository({pool,tenantId:tenant_id,tenant});
  const dump=source.exportTenant();
  // One transaction for the whole workspace: a failure part-way leaves the
  // target tenant exactly as empty as it started.
  const counts=await target.importTenant(dump);

  const targetDigest=await target.snapshotDigest();
  const digestDifferences=compareDigests(sourceDigest,targetDigest);

  // Independent id-set equality per collection, computed from listRecords on
  // both stores rather than from the digest that is already being compared.
  const idDifferences=[];
  for(const collection of Object.keys(sourceDigest.collections)){
   const sourceIds=source.listRecords(collection).map(r=>r.id).sort();
   const targetIds=(await target.listRecords(collection)).map(r=>r.id).sort();
   if(canonicalJson(sourceIds)!==canonicalJson(targetIds))idDifferences.push({
    collection,
    sourceCount:sourceIds.length,targetCount:targetIds.length,
    missingInTarget:sourceIds.filter(id=>!targetIds.includes(id)).slice(0,20),
    unexpectedInTarget:targetIds.filter(id=>!sourceIds.includes(id)).slice(0,20)
   });
  }

  // Independent integer-cent equality, read through the reporting access path
  // on both stores (a JSON scan on SQLite, the ledger projection on PostgreSQL).
  const financial={source:source.reportGiftTotals({}),target:await target.reportGiftTotals({})};
  const designations={source:source.reportDesignationTotals({}),target:await target.reportDesignationTotals({})};
  const financialEqual=canonicalJson(financial.source)===canonicalJson(financial.target)&&canonicalJson(designations.source)===canonicalJson(designations.target);

  const verified=!digestDifferences.length&&!idDifferences.length&&financialEqual;
  const evidence={
   tenantId:tenant_id,
   sourcePath:sqlitePath,
   inventory,
   acknowledgedUnconvertedTables:[...acknowledged],
   counts,
   rowCounts:{source:sourceDigest.totals,target:targetDigest.totals},
   collections:Object.fromEntries(Object.keys(sourceDigest.collections).map(c=>[c,{source:sourceDigest.collections[c].count,target:targetDigest.collections[c]?.count??0,digestEqual:sourceDigest.collections[c].digest===targetDigest.collections[c]?.digest}])),
   financialCents:financial,
   designationCents:designations,
   digestDifferences,idDifferences,financialEqual,verified,
   notice:'Point-in-time copy of one workspace. Writers must be stopped; this path does not follow concurrent changes. Tables outside the boundary are not copied.'
  };
  if(!verified)persistenceFail(PERSISTENCE_CODES.VERIFICATION,`SQLite to PostgreSQL copy is NOT exact: ${canonicalJson({digestDifferences,idDifferences,financialEqual}).slice(0,600)}`,{evidence});
  return evidence;
 }finally{
  source.close();
  if(target)await target.close();
 }
}
