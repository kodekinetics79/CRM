// The PostgreSQL side of the persistence boundary.
//
// Same contract, same answers, different storage properties:
//   * tenant isolation is enforced by the schema and by forced row-level
//     security, not by the calling code remembering to add a WHERE clause;
//   * search uses a trigram index on a deterministic projection of the record;
//   * reporting reads an integer-cent ledger projection that is written in the
//     same transaction as the gift document, so a reporting total and a stored
//     document can never disagree without the verification step saying so;
//   * a financial write is one transaction across records, gift_ledger,
//     gift_allocations and audit_entries. Any failure leaves none of them.
//
// This store is NOT wired into the running application. It is the candidate
// destination that Phase 4 proves out.

import {AsyncLocalStorage} from 'node:async_hooks';
import {
 PERSISTENCE_CODES,persistenceFail,assertTenantId,canonicalJson,digestOf,sha256,
 isCollection,isRecordId,normalizedSearchText,normalizeSearchTerm,assertSearchLimit,
 validateFinancialBatch,FINANCIAL_COLLECTION,assertRepositoryContract
} from './contract.js';
import {readSchemaVersion} from './migrations.js';
import {assertRowLevelSecurityEffective} from './roles.js';

const assertCollection=c=>{if(!isCollection(c))persistenceFail(PERSISTENCE_CODES.INVALID,`Collection name "${c}" is invalid.`);return c;};
const assertId=id=>{if(!isRecordId(id))persistenceFail(PERSISTENCE_CODES.INVALID,`Record identity "${id}" is invalid.`);return id;};
const parseJson=(value,label)=>{try{return JSON.parse(value);}catch{return persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${label} is not valid JSON.`);}};
function toInt(value,label){const n=typeof value==='number'?value:Number(value);if(!Number.isSafeInteger(n))persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${label} did not return an exact integer (${value}).`);return n;}
const isoAt=value=>{if(value instanceof Date)return value.toISOString();const parsed=Date.parse(value);return Number.isNaN(parsed)?String(value):new Date(parsed).toISOString();};
const likeTerm=term=>'%'+term.replace(/([\\%_])/g,'\\$1')+'%';

const userOf=row=>({id:row.user_id,name:row.name,email:row.email,role:row.role,passwordHash:row.password_hash,active:Boolean(row.active),version:Number(row.version)});
const auditOf=row=>({id:toInt(row.audit_id,'Audit identity'),actor:row.actor,action:row.action,collection:row.collection??null,recordId:row.record_id??null,at:isoAt(row.at),details:parseJson(row.details,'Audit detail')});
const auditChecksum=entry=>sha256(canonicalJson({actor:entry.actor,action:entry.action,collection:entry.collection,recordId:entry.recordId,at:entry.at,details:entry.details}));

/**
 * @param {object} options
 * @param {ReturnType<import('./pool.js').createPostgresPool>} options.pool
 * @param {string} options.tenantId
 * @param {object} [options.tenant]  {name, residency} used only when registering a new tenant
 * @param {boolean} [options.ensureTenant] register the tenant row if it is absent
 * @param {boolean} [options.requireRowLevelSecurity] refuse a connection on which
 *        tenant isolation would be present but ineffective (superuser/BYPASSRLS)
 */
export async function createPostgresRepository({pool,tenantId,tenant={},ensureTenant=true,requireRowLevelSecurity=true,now=()=>new Date().toISOString()}={}){
 if(!pool||typeof pool.withTenantSession!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A persistence pool is required.');
 const tenant_id=assertTenantId(tenantId);

 // Fail closed: an unmigrated or differently-versioned database is refused here
 // rather than migrated silently on connect.
 const schemaVersion=await pool.withAdminSession(session=>readSchemaVersion(session));
 // Fail closed again: policies that a superuser bypasses are not isolation.
 const isolation=requireRowLevelSecurity?await pool.withAdminSession(session=>assertRowLevelSecurityEffective(session)):null;

 const active=new AsyncLocalStorage();
 const read=fn=>{const session=active.getStore();return session?fn(session):pool.withTenantSession(tenant_id,fn);};
 const write=fn=>{const session=active.getStore();return session?fn(session):pool.withTransaction(tenant_id,fn);};

 if(ensureTenant){
  const residency=tenant.residency||null;
  await pool.withTransaction(tenant_id,session=>session.query(
   `INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id) DO NOTHING`,
   [tenant_id,tenant.name||'Wimblo workspace',residency?.profile||'us-ca',residency?.databaseRegion||'us-east-1',residency?.storageRegion||'us-east-1']
  ));
 }

 async function projectGift(session,gift){
  const allocations=gift.allocations||[];
  await session.query(
   `INSERT INTO gift_ledger(tenant_id,gift_id,gift_date,amount_cents,status,campaign_id,constituent_id,school_year)
    VALUES($1,$2,$3::date,$4::bigint,$5,$6,$7,$8)
    ON CONFLICT (tenant_id,gift_id) DO UPDATE SET gift_date=excluded.gift_date,amount_cents=excluded.amount_cents,status=excluded.status,campaign_id=excluded.campaign_id,constituent_id=excluded.constituent_id,school_year=excluded.school_year`,
   [tenant_id,gift.id,gift.date,String(gift.amount),gift.status,gift.campaignId??null,gift.constituentId??null,gift.schoolYear??null]
  );
  await session.query('DELETE FROM gift_allocations WHERE tenant_id=$1 AND gift_id=$2',[tenant_id,gift.id]);
  for(const allocation of allocations)
   await session.query('INSERT INTO gift_allocations(tenant_id,gift_id,designation_id,amount_cents) VALUES($1,$2,$3,$4::bigint)',[tenant_id,gift.id,allocation.designationId,String(allocation.amount)]);
  return allocations.length;
 }

 async function writeRecordRow(session,collection,record,{create}){
  assertCollection(collection);
  if(!record||typeof record!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'A record object is required.');
  assertId(record.id);
  if(collection===FINANCIAL_COLLECTION)validateFinancialBatch({gift:record});
  const data=canonicalJson(record),checksum=sha256(data),search=normalizedSearchText(record);
  if(create){
   const existing=await session.query('SELECT 1 FROM records WHERE tenant_id=$1 AND collection=$2 AND record_id=$3',[tenant_id,collection,record.id]);
   if(existing.rowCount)persistenceFail(PERSISTENCE_CODES.CONFLICT,`Record ${collection}/${record.id} already exists.`);
   await session.query('INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum) VALUES($1,$2,$3,$4,$5,$6)',[tenant_id,collection,record.id,data,search,checksum]);
  }else{
   await session.query(
    `INSERT INTO records(tenant_id,collection,record_id,data,search_text,checksum) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id,collection,record_id) DO UPDATE SET data=excluded.data,search_text=excluded.search_text,checksum=excluded.checksum,updated_at=now()`,
    [tenant_id,collection,record.id,data,search,checksum]
   );
  }
  if(collection===FINANCIAL_COLLECTION)await projectGift(session,record);
  return parseJson(data,'Record');
 }

 async function appendAuditRow(session,entry){
  if(!entry||typeof entry.action!=='string'||!entry.action.trim())persistenceFail(PERSISTENCE_CODES.INVALID,'An audit entry requires an action.');
  const at=entry.at?isoAt(entry.at):now();
  const {rows}=await session.query(
   'INSERT INTO audit_entries(tenant_id,actor,action,collection,record_id,at,details) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7) RETURNING audit_id',
   [tenant_id,String(entry.actor||'system'),entry.action,entry.collection??null,entry.recordId??null,at,JSON.stringify(entry.details||{})]
  );
  return {id:toInt(rows[0].audit_id,'Audit identity'),at};
 }

 const giftWhere=({start=null,end=null,status=null,campaignId=null}={},alias='g')=>({
  clause:`AND ($2::date IS NULL OR ${alias}.gift_date>=$2::date) AND ($3::date IS NULL OR ${alias}.gift_date<=$3::date) AND ($4::text IS NULL OR ${alias}.status=$4) AND ($5::text IS NULL OR ${alias}.campaign_id=$5)`,
  values:[start,end,status,campaignId]
 });

 const repository={
  kind:'postgres',
  tenantId:tenant_id,
  pool,
  isolation,
  schemaVersion:()=>schemaVersion,

  describeTenant:()=>read(async session=>{
   const {rows}=await session.query('SELECT tenant_id,name,residency_profile,database_region,storage_region,status,created_at FROM tenants WHERE tenant_id=$1',[tenant_id]);
   if(!rows.length)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Tenant is not registered in this database.');
   const row=rows[0];
   return {tenantId:row.tenant_id,name:row.name,createdAt:isoAt(row.created_at),status:row.status,residency:{profile:row.residency_profile,databaseRegion:row.database_region,storageRegion:row.storage_region},store:'postgres'};
  }),

  listRecords:collection=>read(async session=>{
   const {rows}=await session.query('SELECT data FROM records WHERE tenant_id=$1 AND collection=$2 ORDER BY seq',[tenant_id,assertCollection(collection)]);
   return rows.map(r=>parseJson(r.data,'Record'));
  }),
  findRecord:(collection,id)=>read(async session=>{
   const {rows}=await session.query('SELECT data FROM records WHERE tenant_id=$1 AND collection=$2 AND record_id=$3',[tenant_id,assertCollection(collection),assertId(id)]);
   return rows.length?parseJson(rows[0].data,'Record'):null;
  }),
  getRecord:(collection,id)=>read(async session=>{
   const {rows}=await session.query('SELECT data FROM records WHERE tenant_id=$1 AND collection=$2 AND record_id=$3',[tenant_id,assertCollection(collection),assertId(id)]);
   if(!rows.length)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,`Record ${collection}/${id} was not found.`);
   return parseJson(rows[0].data,'Record');
  }),
  countRecords:collection=>read(async session=>{
   const {rows}=await session.query('SELECT COUNT(*)::text AS n FROM records WHERE tenant_id=$1 AND collection=$2',[tenant_id,assertCollection(collection)]);
   return toInt(rows[0].n,'Record count');
  }),
  createRecord:(collection,record)=>write(session=>writeRecordRow(session,collection,record,{create:true})),
  putRecord:(collection,record)=>write(session=>writeRecordRow(session,collection,record,{create:false})),
  deleteRecord:(collection,id)=>write(async session=>{
   const result=await session.query('DELETE FROM records WHERE tenant_id=$1 AND collection=$2 AND record_id=$3',[tenant_id,assertCollection(collection),assertId(id)]);
   if(!result.rowCount)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,`Record ${collection}/${id} was not found.`);
   return true;
  }),

  writeFinancialBatch(batch){
   const {gift,allocations,audit}=validateFinancialBatch(batch);
   return write(async session=>{
    const existing=await session.query('SELECT 1 FROM records WHERE tenant_id=$1 AND collection=$2 AND record_id=$3',[tenant_id,FINANCIAL_COLLECTION,gift.id]);
    if(existing.rowCount)persistenceFail(PERSISTENCE_CODES.CONFLICT,`Gift ${gift.id} already exists; corrections are explicit revisions, not overwrites.`);
    await writeRecordRow(session,FINANCIAL_COLLECTION,gift,{create:true});
    const entry=audit?await appendAuditRow(session,{...audit,collection:FINANCIAL_COLLECTION,recordId:gift.id,details:{...(audit.details||{}),amount:gift.amount,allocations:allocations.length}}):null;
    return {giftId:gift.id,allocationCount:allocations.length,auditId:entry?.id??null};
   });
  },

  searchRecords:({collection,term,limit=100}={})=>read(async session=>{
   assertCollection(collection);assertSearchLimit(limit);
   const {rows}=await session.query(
    `SELECT data FROM records WHERE tenant_id=$1 AND collection=$2 AND search_text LIKE $3 ESCAPE '\\' ORDER BY seq LIMIT $4`,
    [tenant_id,collection,likeTerm(normalizeSearchTerm(term)),limit]
   );
   return rows.map(r=>parseJson(r.data,'Record'));
  }),

  reportGiftTotals:(filters={})=>read(async session=>{
   const {clause,values}=giftWhere(filters);
   const {rows}=await session.query(
    `SELECT COUNT(*)::text AS gift_count,
            COALESCE(SUM(g.amount_cents) FILTER (WHERE g.status='Posted'),0)::text AS posted_cents,
            COALESCE(SUM(g.amount_cents) FILTER (WHERE g.status='Voided'),0)::text AS voided_cents,
            COUNT(*) FILTER (WHERE g.status='Posted')::text AS posted_gift_count
     FROM gift_ledger g WHERE g.tenant_id=$1 ${clause}`,
    [tenant_id,...values]
   );
   const row=rows[0];
   return {giftCount:toInt(row.gift_count,'Gift count'),postedCents:toInt(row.posted_cents,'Posted cents'),voidedCents:toInt(row.voided_cents,'Voided cents'),postedGiftCount:toInt(row.posted_gift_count,'Posted gift count')};
  }),

  reportDesignationTotals:(filters={})=>read(async session=>{
   const {clause,values}=giftWhere({...filters,status:'Posted'});
   const {rows}=await session.query(
    `SELECT a.designation_id, SUM(a.amount_cents)::text AS posted_cents, COUNT(*)::text AS allocation_count
     FROM gift_allocations a JOIN gift_ledger g ON g.tenant_id=a.tenant_id AND g.gift_id=a.gift_id
     WHERE a.tenant_id=$1 ${clause}
     GROUP BY a.designation_id ORDER BY a.designation_id COLLATE "C"`,
    [tenant_id,...values]
   );
   return rows.map(r=>({designationId:r.designation_id,postedCents:toInt(r.posted_cents,'Designation cents'),allocationCount:toInt(r.allocation_count,'Allocation count')}));
  }),

  appendAudit:entry=>write(session=>appendAuditRow(session,entry)),
  listAudit:({limit=100}={})=>read(async session=>{
   if(!Number.isSafeInteger(limit)||limit<1||limit>10000)persistenceFail(PERSISTENCE_CODES.INVALID,'Audit limit must be between 1 and 10000.');
   const {rows}=await session.query('SELECT * FROM audit_entries WHERE tenant_id=$1 ORDER BY audit_id DESC LIMIT $2',[tenant_id,limit]);
   return rows.map(auditOf);
  }),
  countAudit:()=>read(async session=>{
   const {rows}=await session.query('SELECT COUNT(*)::text AS n FROM audit_entries WHERE tenant_id=$1',[tenant_id]);
   return toInt(rows[0].n,'Audit count');
  }),

  getSettings:()=>read(async session=>{
   const {rows}=await session.query('SELECT data FROM settings WHERE tenant_id=$1',[tenant_id]);
   return rows.length?parseJson(rows[0].data,'Settings'):{};
  }),
  putSettings:value=>write(async session=>{
   if(!value||typeof value!=='object'||Array.isArray(value))persistenceFail(PERSISTENCE_CODES.INVALID,'Settings must be an object.');
   await session.query('INSERT INTO settings(tenant_id,data) VALUES($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET data=excluded.data,updated_at=now()',[tenant_id,canonicalJson(value)]);
   const {rows}=await session.query('SELECT data FROM settings WHERE tenant_id=$1',[tenant_id]);
   return parseJson(rows[0].data,'Settings');
  }),
  listUsers:()=>read(async session=>{
   const {rows}=await session.query('SELECT * FROM users WHERE tenant_id=$1 ORDER BY user_id COLLATE "C"',[tenant_id]);
   return rows.map(userOf);
  }),
  putUser:user=>write(async session=>{
   if(!user||!isRecordId(user.id)||typeof user.email!=='string'||!user.email)persistenceFail(PERSISTENCE_CODES.INVALID,'A user identity and email are required.');
   if(!['admin','staff','viewer'].includes(user.role))persistenceFail(PERSISTENCE_CODES.INVALID,'User role must be admin, staff or viewer.');
   await session.query(
    `INSERT INTO users(tenant_id,user_id,name,email,role,password_hash,active,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id,user_id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,password_hash=excluded.password_hash,active=excluded.active,version=excluded.version`,
    [tenant_id,user.id,String(user.name||''),user.email,user.role,String(user.passwordHash||user.password_hash||''),!(user.active===false||user.active===0),Number.isSafeInteger(user.version)?user.version:1]
   );
   const {rows}=await session.query('SELECT * FROM users WHERE tenant_id=$1 AND user_id=$2',[tenant_id,user.id]);
   return userOf(rows[0]);
  }),

  transaction:fn=>{
   const existing=active.getStore();
   if(existing)return fn();
   return pool.withTransaction(tenant_id,session=>active.run(session,fn));
  },

  snapshotDigest:()=>read(async session=>{
   const {rows}=await session.query('SELECT collection,data,checksum FROM records WHERE tenant_id=$1 ORDER BY collection COLLATE "C", seq',[tenant_id]);
   const collections={};let totalRecords=0;
   for(const row of rows){
    const computed=sha256(row.data);
    if(computed!==row.checksum.trim())persistenceFail(PERSISTENCE_CODES.VERIFICATION,`Stored checksum for ${row.collection} disagrees with its stored document.`);
    (collections[row.collection]??=[]).push(computed);
    totalRecords++;
   }
   // Financial totals are read from the ledger projection, not from the JSON
   // documents. Equality with the SQLite digest therefore also proves the
   // projection agrees with the documents it was derived from.
   const financialRows=await session.query(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status='Posted'),0)::text AS posted,
            COALESCE(SUM(amount_cents) FILTER (WHERE status='Voided'),0)::text AS voided,
            COUNT(*)::text AS gifts FROM gift_ledger WHERE tenant_id=$1`,[tenant_id]);
   const allocationRows=await session.query('SELECT COALESCE(SUM(amount_cents),0)::text AS cents, COUNT(*)::text AS n FROM gift_allocations WHERE tenant_id=$1',[tenant_id]);
   const userRows=await session.query('SELECT * FROM users WHERE tenant_id=$1 ORDER BY user_id COLLATE "C"',[tenant_id]);
   const auditRows=await session.query('SELECT * FROM audit_entries WHERE tenant_id=$1 ORDER BY audit_id',[tenant_id]);
   const settingsRows=await session.query('SELECT data FROM settings WHERE tenant_id=$1',[tenant_id]);
   return {
    tenantId:tenant_id,
    schemaVersion,
    collections:Object.fromEntries(Object.entries(collections).map(([name,list])=>[name,{count:list.length,digest:digestOf(list)}])),
    financial:{
     postedCents:toInt(financialRows.rows[0].posted,'Posted cents'),
     voidedCents:toInt(financialRows.rows[0].voided,'Voided cents'),
     giftCount:toInt(financialRows.rows[0].gifts,'Gift count'),
     allocationCents:toInt(allocationRows.rows[0].cents,'Allocation cents'),
     allocationCount:toInt(allocationRows.rows[0].n,'Allocation count')
    },
    totals:{records:totalRecords,users:userRows.rowCount,audit:auditRows.rowCount},
    users:{count:userRows.rowCount,digest:digestOf(userRows.rows.map(r=>sha256(canonicalJson(userOf(r)))))},
    audit:{count:auditRows.rowCount,digest:digestOf(auditRows.rows.map(r=>auditChecksum(auditOf(r))))},
    settings:{checksum:sha256(settingsRows.rows.length?settingsRows.rows[0].data:canonicalJson({}))}
   };
  }),

  exportTenant:()=>read(async session=>{
   const records=await session.query('SELECT collection,record_id,data FROM records WHERE tenant_id=$1 ORDER BY seq',[tenant_id]);
   const users=await session.query('SELECT * FROM users WHERE tenant_id=$1 ORDER BY user_id COLLATE "C"',[tenant_id]);
   const audit=await session.query('SELECT * FROM audit_entries WHERE tenant_id=$1 ORDER BY audit_id',[tenant_id]);
   const settings=await session.query('SELECT data FROM settings WHERE tenant_id=$1',[tenant_id]);
   return {
    format:'wimblo-persistence-tenant-dump',
    version:1,
    tenantId:tenant_id,
    schemaVersion,
    exportedAt:now(),
    settings:settings.rows.length?parseJson(settings.rows[0].data,'Settings'):{},
    users:users.rows.map(userOf),
    records:records.rows.map(r=>({collection:r.collection,id:r.record_id,record:parseJson(r.data,'Record')})),
    audit:audit.rows.map(auditOf)
   };
  }),

  importTenant:dump=>{
   if(!dump||dump.format!=='wimblo-persistence-tenant-dump')persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit Wimblo tenant dump is required.');
   return repository.transaction(async()=>{
    const session=active.getStore();
    const occupied=await session.query(
     `SELECT (SELECT COUNT(*) FROM records WHERE tenant_id=$1)+(SELECT COUNT(*) FROM users WHERE tenant_id=$1)+(SELECT COUNT(*) FROM audit_entries WHERE tenant_id=$1) AS n`,[tenant_id]);
    if(toInt(occupied.rows[0].n,'Occupancy'))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Restore target is not empty; restores go into a fresh tenant so an existing one is never partially overwritten.');
    if(dump.settings&&Object.keys(dump.settings).length)await repository.putSettings(dump.settings);
    for(const user of dump.users||[])await repository.putUser(user);
    for(const row of dump.records||[])await writeRecordRow(session,row.collection,row.record,{create:true});
    for(const entry of dump.audit||[])await appendAuditRow(session,entry);
    return {records:(dump.records||[]).length,users:(dump.users||[]).length,audit:(dump.audit||[]).length};
   });
  },

  // Independent, server-side recomputation of the per-collection digest. Used by
  // the verification script so equality is not asserted purely by this process.
  serverSideDigest:()=>read(async session=>{
   const {rows}=await session.query(
    `SELECT collection, COUNT(*)::text AS n, md5(string_agg(md5(data), '' ORDER BY md5(data))) AS digest
     FROM records WHERE tenant_id=$1 GROUP BY collection ORDER BY collection COLLATE "C"`,[tenant_id]);
   return rows.map(r=>({collection:r.collection,count:toInt(r.n,'Record count'),md5:r.digest}));
  }),

  close:async()=>{}
 };
 return assertRepositoryContract(repository);
}
