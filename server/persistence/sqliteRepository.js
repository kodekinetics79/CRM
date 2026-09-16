// The SQLite side of the persistence boundary.
//
// This implementation reads and writes the workspace schema the application
// already uses today — records / users / settings / audit — and NOTHING else.
// It creates no extra tables in a live workspace, changes no application file
// and is not installed into server/app.js. It exists so that the boundary's
// behaviour can be pinned against the store the product actually runs on, and
// so a workspace can be read faithfully during a conversion.
//
// Deliberate limitation, stated rather than hidden: search and reporting here
// are full scans of a collection. SQLite has no index for the JSON document
// shape the application stores. That is one of the reasons the PostgreSQL store
// exists, and the conformance suite proves the two return the same answers, not
// that they take the same time.

import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {
 PERSISTENCE_CODES,persistenceFail,assertTenantId,canonicalJson,recordChecksum,digestOf,sha256,
 isCollection,isRecordId,matchesSearch,assertSearchLimit,validateFinancialBatch,FINANCIAL_COLLECTION,assertRepositoryContract
} from './contract.js';
import {SCHEMA_VERSION} from './migrations.js';

const WORKSPACE_DDL=`CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,collection TEXT,record_id TEXT,at TEXT NOT NULL,details TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;`;

export const WORKSPACE_TABLES=Object.freeze(['records','users','settings','audit']);

const isoAt=value=>{const parsed=Date.parse(value);return Number.isNaN(parsed)?String(value):new Date(parsed).toISOString();};
const parseJson=(value,label)=>{try{return JSON.parse(value);}catch{return persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${label} is not valid JSON.`);}};
const assertCollection=c=>{if(!isCollection(c))persistenceFail(PERSISTENCE_CODES.INVALID,`Collection name "${c}" is invalid.`);return c;};
const assertId=id=>{if(!isRecordId(id))persistenceFail(PERSISTENCE_CODES.INVALID,`Record identity "${id}" is invalid.`);return id;};

const userOf=row=>({id:row.id,name:row.name,email:row.email,role:row.role,passwordHash:row.password_hash,active:Boolean(row.active),version:row.version??1});
const auditOf=row=>({id:Number(row.id),actor:row.actor,action:row.action,collection:row.collection??null,recordId:row.record_id??null,at:isoAt(row.at),details:parseJson(row.details,'Audit detail')});
const auditChecksum=entry=>sha256(canonicalJson({actor:entry.actor,action:entry.action,collection:entry.collection,recordId:entry.recordId,at:entry.at,details:entry.details}));

/**
 * @param {object} options
 * @param {string} options.tenantId               tenant this workspace belongs to
 * @param {import('node:sqlite').DatabaseSync} [options.db]  an already-open workspace
 * @param {string} [options.dbPath]               path to open (':memory:' for tests)
 * @param {boolean} [options.manageSchema]        create the workspace tables when absent
 * @param {boolean} [options.readOnly]            open the workspace read-only (conversions)
 * @param {object} [options.tenant]               descriptive tenant metadata
 */
export function createSqliteRepository({tenantId,db=null,dbPath=null,manageSchema=null,readOnly=false,tenant={},now=()=>new Date().toISOString()}={}){
 const tenant_id=assertTenantId(tenantId);
 if(!db&&!dbPath)persistenceFail(PERSISTENCE_CODES.INVALID,'A SQLite workspace connection or path is required.');
 let owned=false,connection=db;
 if(!connection){
  if(dbPath!==':memory:')mkdirSync(dirname(dbPath),{recursive:true});
  connection=readOnly?new DatabaseSync(dbPath,{readOnly:true}):new DatabaseSync(dbPath);
  owned=true;
 }
 // Never alter a workspace that was handed in, and never alter a read-only one.
 const willManage=manageSchema===null?owned&&!readOnly:manageSchema===true;
 if(willManage&&readOnly)persistenceFail(PERSISTENCE_CODES.INVALID,'A read-only workspace cannot be schema-managed.');
 if(willManage){connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');connection.exec(WORKSPACE_DDL);}
 const present=new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
 for(const table of WORKSPACE_TABLES)if(!present.has(table))persistenceFail(PERSISTENCE_CODES.MIGRATION,`This SQLite file is not a Wimblo workspace: table "${table}" is missing. No schema is created implicitly.`);

 let depth=0;
 const prepared=new Map();
 const statement=sql=>{let s=prepared.get(sql);if(!s){s=connection.prepare(sql);prepared.set(sql,s);}return s;};

 const rowOf=(collection,id)=>statement('SELECT data FROM records WHERE collection=? AND id=?').get(assertCollection(collection),assertId(id));
 const recordsOf=collection=>statement('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(assertCollection(collection)).map(r=>parseJson(r.data,'Record'));

 function transaction(fn){
  if(depth>0)return fn();
  connection.exec('BEGIN IMMEDIATE');
  depth++;
  let result;
  try{result=fn();}
  catch(e){depth--;connection.exec('ROLLBACK');throw e;}
  if(result&&typeof result.then==='function'){
   return result.then(
    value=>{depth--;connection.exec('COMMIT');return value;},
    error=>{depth--;connection.exec('ROLLBACK');throw error;}
   );
  }
  depth--;connection.exec('COMMIT');return result;
 }

 function appendAudit(entry){
  if(!entry||typeof entry.action!=='string'||!entry.action.trim())persistenceFail(PERSISTENCE_CODES.INVALID,'An audit entry requires an action.');
  const at=entry.at?isoAt(entry.at):now();
  const result=statement('INSERT INTO audit(actor,action,collection,record_id,at,details) VALUES(?,?,?,?,?,?)')
   .run(String(entry.actor||'system'),entry.action,entry.collection??null,entry.recordId??null,at,JSON.stringify(entry.details||{}));
  return {id:Number(result.lastInsertRowid),at};
 }

 function writeRecord(collection,record,{create}){
  assertCollection(collection);
  if(!record||typeof record!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'A record object is required.');
  assertId(record.id);
  // Any write of a financial document is validated the same way on both stores,
  // so a gift can never reach either store with fractional or unbalanced cents.
  if(collection===FINANCIAL_COLLECTION)validateFinancialBatch({gift:record});
  const data=canonicalJson(record);
  if(create){
   if(rowOf(collection,record.id))persistenceFail(PERSISTENCE_CODES.CONFLICT,`Record ${collection}/${record.id} already exists.`);
   statement('INSERT INTO records(collection,id,data) VALUES(?,?,?)').run(collection,record.id,data);
  }else{
   statement('INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data').run(collection,record.id,data);
  }
  return parseJson(data,'Record');
 }

 const giftRows=()=>recordsOf(FINANCIAL_COLLECTION);
 function giftFilter({start=null,end=null,status=null,campaignId=null}={}){
  return giftRows().filter(g=>(!start||g.date>=start)&&(!end||g.date<=end)&&(!status||g.status===status)&&(!campaignId||g.campaignId===campaignId));
 }

 const repository={
  kind:'sqlite',
  tenantId:tenant_id,
  connection,
  schemaVersion:()=>SCHEMA_VERSION,
  describeTenant:()=>({tenantId:tenant_id,name:tenant.name||'Wimblo workspace',createdAt:tenant.createdAt||null,residency:tenant.residency||null,store:'sqlite'}),

  listRecords:collection=>recordsOf(collection),
  findRecord:(collection,id)=>{const row=rowOf(collection,id);return row?parseJson(row.data,'Record'):null;},
  getRecord:(collection,id)=>{const row=rowOf(collection,id);if(!row)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,`Record ${collection}/${id} was not found.`);return parseJson(row.data,'Record');},
  countRecords:collection=>Number(statement('SELECT COUNT(*) AS n FROM records WHERE collection=?').get(assertCollection(collection)).n),
  createRecord:(collection,record)=>writeRecord(collection,record,{create:true}),
  putRecord:(collection,record)=>writeRecord(collection,record,{create:false}),
  deleteRecord:(collection,id)=>{
   assertCollection(collection);assertId(id);
   const result=statement('DELETE FROM records WHERE collection=? AND id=?').run(collection,id);
   if(!result.changes)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,`Record ${collection}/${id} was not found.`);
   return true;
  },

  writeFinancialBatch(batch){
   const {gift,allocations,audit}=validateFinancialBatch(batch);
   return transaction(()=>{
    if(rowOf(FINANCIAL_COLLECTION,gift.id))persistenceFail(PERSISTENCE_CODES.CONFLICT,`Gift ${gift.id} already exists; corrections are explicit revisions, not overwrites.`);
    writeRecord(FINANCIAL_COLLECTION,gift,{create:true});
    const entry=audit?appendAudit({...audit,collection:FINANCIAL_COLLECTION,recordId:gift.id,details:{...(audit.details||{}),amount:gift.amount,allocations:allocations.length}}):null;
    return {giftId:gift.id,allocationCount:allocations.length,auditId:entry?.id??null};
   });
  },

  searchRecords({collection,term,limit=100}={}){
   assertCollection(collection);
   assertSearchLimit(limit);
   const matched=[];
   for(const record of recordsOf(collection)){if(matchesSearch(record,term))matched.push(record);if(matched.length>=limit)break;}
   return matched;
  },

  reportGiftTotals(filters={}){
   const matched=giftFilter(filters);
   let postedCents=0,voidedCents=0,postedGiftCount=0;
   for(const gift of matched){
    if(gift.status==='Posted'){postedCents+=gift.amount;postedGiftCount++;}
    else if(gift.status==='Voided')voidedCents+=gift.amount;
   }
   return {giftCount:matched.length,postedCents,voidedCents,postedGiftCount};
  },

  reportDesignationTotals(filters={}){
   const totals=new Map();
   for(const gift of giftFilter({...filters,status:'Posted'}))for(const allocation of gift.allocations||[]){
    const current=totals.get(allocation.designationId)||{designationId:allocation.designationId,postedCents:0,allocationCount:0};
    current.postedCents+=allocation.amount;current.allocationCount++;
    totals.set(allocation.designationId,current);
   }
   return [...totals.values()].sort((a,b)=>a.designationId<b.designationId?-1:a.designationId>b.designationId?1:0);
  },

  appendAudit,
  listAudit({limit=100}={}){
   if(!Number.isSafeInteger(limit)||limit<1||limit>10000)persistenceFail(PERSISTENCE_CODES.INVALID,'Audit limit must be between 1 and 10000.');
   return statement('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(auditOf);
  },
  countAudit:()=>Number(statement('SELECT COUNT(*) AS n FROM audit').get().n),

  getSettings(){const row=statement('SELECT data FROM settings WHERE id=1').get();return row?parseJson(row.data,'Settings'):{};},
  putSettings(value){
   if(!value||typeof value!=='object'||Array.isArray(value))persistenceFail(PERSISTENCE_CODES.INVALID,'Settings must be an object.');
   statement('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(canonicalJson(value));
   return repository.getSettings();
  },
  listUsers:()=>statement('SELECT * FROM users ORDER BY id').all().map(userOf),
  putUser(user){
   if(!user||!isRecordId(user.id)||typeof user.email!=='string'||!user.email)persistenceFail(PERSISTENCE_CODES.INVALID,'A user identity and email are required.');
   if(!['admin','staff','viewer'].includes(user.role))persistenceFail(PERSISTENCE_CODES.INVALID,'User role must be admin, staff or viewer.');
   try{
    statement('INSERT INTO users(id,name,email,role,password_hash,active,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,password_hash=excluded.password_hash,active=excluded.active,version=excluded.version')
     .run(user.id,String(user.name||''),user.email,user.role,String(user.passwordHash||user.password_hash||''),user.active===false||user.active===0?0:1,Number.isSafeInteger(user.version)?user.version:1);
   }catch(e){persistenceFail(/UNIQUE/i.test(e.message)?PERSISTENCE_CODES.CONFLICT:PERSISTENCE_CODES.INVALID,`User could not be written: ${e.message}`);}
   return userOf(statement('SELECT * FROM users WHERE id=?').get(user.id));
  },

  transaction,

  snapshotDigest(){
   const collections={};let totalRecords=0;
   for(const {collection} of statement('SELECT DISTINCT collection FROM records ORDER BY collection').all()){
    const rows=statement('SELECT data FROM records WHERE collection=?').all(collection).map(r=>recordChecksum(parseJson(r.data,'Record')));
    collections[collection]={count:rows.length,digest:digestOf(rows)};
    totalRecords+=rows.length;
   }
   let postedCents=0,voidedCents=0,allocationCents=0,allocationCount=0;const gifts=giftRows();
   for(const gift of gifts){
    if(gift.status==='Posted')postedCents+=gift.amount;else if(gift.status==='Voided')voidedCents+=gift.amount;
    for(const allocation of gift.allocations||[]){allocationCents+=allocation.amount;allocationCount++;}
   }
   const users=repository.listUsers();
   const audit=statement('SELECT * FROM audit ORDER BY id').all().map(row=>auditChecksum(auditOf(row)));
   return {
    tenantId:tenant_id,
    schemaVersion:SCHEMA_VERSION,
    collections,
    financial:{postedCents,voidedCents,giftCount:gifts.length,allocationCents,allocationCount},
    totals:{records:totalRecords,users:users.length,audit:audit.length},
    users:{count:users.length,digest:digestOf(users.map(u=>sha256(canonicalJson(u))))},
    audit:{count:audit.length,digest:digestOf(audit)},
    settings:{checksum:sha256(canonicalJson(repository.getSettings()))}
   };
  },

  exportTenant(){
   return {
    format:'wimblo-persistence-tenant-dump',
    version:1,
    tenantId:tenant_id,
    schemaVersion:SCHEMA_VERSION,
    exportedAt:now(),
    settings:repository.getSettings(),
    users:repository.listUsers(),
    records:statement('SELECT collection,id,data FROM records ORDER BY rowid').all().map(r=>({collection:r.collection,id:r.id,record:parseJson(r.data,'Record')})),
    audit:statement('SELECT * FROM audit ORDER BY id').all().map(auditOf)
   };
  },

  importTenant(dump){
   if(!dump||dump.format!=='wimblo-persistence-tenant-dump')persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit Wimblo tenant dump is required.');
   return transaction(()=>{
    const occupied=Number(statement('SELECT COUNT(*) AS n FROM records').get().n)+Number(statement('SELECT COUNT(*) AS n FROM users').get().n)+repository.countAudit();
    if(occupied)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Restore target is not empty; restores go into a fresh workspace so an existing one is never partially overwritten.');
    if(dump.settings&&Object.keys(dump.settings).length)repository.putSettings(dump.settings);
    for(const user of dump.users||[])repository.putUser(user);
    for(const row of dump.records||[])writeRecord(row.collection,row.record,{create:true});
    for(const entry of dump.audit||[])appendAudit(entry);
    return {records:(dump.records||[]).length,users:(dump.users||[]).length,audit:(dump.audit||[]).length};
   });
  },

  close(){prepared.clear();if(owned)connection.close();}
 };
 return assertRepositoryContract(repository);
}
