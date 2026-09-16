// Wimblo persistence boundary — explicit repository contract.
//
// This module defines the ONLY surface the application is permitted to use when
// it is eventually moved off the embedded SQLite store. It is deliberately
// narrow: records, tenants, financial writes, search and reporting queries,
// audit append, settings and users. Everything else stays in the feature
// modules.
//
// Two implementations must behave identically:
//   - server/persistence/sqliteRepository.js   (the store the app runs on today)
//   - server/persistence/postgresRepository.js (the candidate production store)
//
// "Identically" is not an assertion: runRepositoryConformance() below is a
// single executable suite that is run against both implementations. The SQLite
// run happens in tests/persistence-contract.test.js on every `npm test`; the
// PostgreSQL run happens in scripts/postgres-verify.mjs against a real server.
//
// Nothing in this module is wired into the running application. Phase 4 is
// readiness, not a completed migration.

import {createHash} from 'node:crypto';

export const PERSISTENCE_CODES=Object.freeze({
 NOT_FOUND:'PERSISTENCE_NOT_FOUND',
 CONFLICT:'PERSISTENCE_CONFLICT',
 INVALID:'PERSISTENCE_INVALID',
 UNAVAILABLE:'PERSISTENCE_UNAVAILABLE',
 TIMEOUT:'PERSISTENCE_TIMEOUT',
 AMBIGUOUS:'PERSISTENCE_AMBIGUOUS_COMMIT',
 ISOLATION:'PERSISTENCE_TENANT_ISOLATION',
 MIGRATION:'PERSISTENCE_MIGRATION',
 VERIFICATION:'PERSISTENCE_VERIFICATION'
});

const STATUS={[PERSISTENCE_CODES.NOT_FOUND]:404,[PERSISTENCE_CODES.CONFLICT]:409,[PERSISTENCE_CODES.INVALID]:400,[PERSISTENCE_CODES.UNAVAILABLE]:503,[PERSISTENCE_CODES.TIMEOUT]:503,[PERSISTENCE_CODES.AMBIGUOUS]:503,[PERSISTENCE_CODES.ISOLATION]:403,[PERSISTENCE_CODES.MIGRATION]:500,[PERSISTENCE_CODES.VERIFICATION]:500};

export class PersistenceError extends Error{
 constructor(code,message,detail={}){super(message);this.name='PersistenceError';this.code=code;this.status=STATUS[code]||500;this.detail=detail;}
}
export const persistenceFail=(code,message,detail={})=>{throw new PersistenceError(code,message,detail);};

// Canonical JSON: sorted object keys, no incidental whitespace. Identical text
// on both stores is what makes checksum equality a real comparison rather than
// a restatement of one store's own formatting.
export const canonicalJson=v=>Array.isArray(v)?'['+v.map(canonicalJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(v[k])).join(',')+'}':JSON.stringify(v===undefined?null:v);
export const sha256=value=>createHash('sha256').update(typeof value==='string'?Buffer.from(value,'utf8'):value).digest('hex');
export const recordChecksum=record=>sha256(canonicalJson(record));

// An unordered set of row checksums folded into one digest. Sorting first means
// the digest does not depend on physical row order, which SQLite and PostgreSQL
// do not share.
export function digestOf(checksums){const sorted=[...checksums].sort();const h=createHash('sha256');for(const c of sorted)h.update(Buffer.from(c,'hex'));return h.digest('hex');}

export const isIntegerCents=v=>Number.isSafeInteger(v);
export function assertIntegerCents(value,label){if(!Number.isSafeInteger(value))persistenceFail(PERSISTENCE_CODES.INVALID,`${label} must be exact integer cents.`);return value;}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertTenantId(value){if(typeof value!=='string'||!UUID.test(value))persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit tenant UUID is required.');return value.toLowerCase();}
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const isRecordId=v=>typeof v==='string'&&ID.test(v);
const COLLECTION=/^[a-z][A-Za-z0-9]{0,63}$/;
export const isCollection=v=>typeof v==='string'&&COLLECTION.test(v);
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export const FINANCIAL_COLLECTION='gifts';
export const GIFT_STATUSES=Object.freeze(['Posted','Voided']);

// Deterministic search projection shared by both stores, so an indexed
// PostgreSQL search and an unindexed SQLite scan return the same rows.
export function searchText(record,depth=0){
 if(depth>6||record===null||record===undefined)return '';
 if(typeof record==='string')return record;
 if(typeof record==='number'||typeof record==='boolean')return String(record);
 if(Array.isArray(record))return record.map(v=>searchText(v,depth+1)).filter(Boolean).join(' ');
 if(typeof record==='object')return Object.keys(record).sort().map(k=>searchText(record[k],depth+1)).filter(Boolean).join(' ');
 return '';
}
export const normalizedSearchText=record=>searchText(record).replace(/\s+/g,' ').trim().toLowerCase();
export function normalizeSearchTerm(query){const q=String(query??'').trim().toLowerCase();if(!q)persistenceFail(PERSISTENCE_CODES.INVALID,'Search requires a non-empty term.');if(q.length>200)persistenceFail(PERSISTENCE_CODES.INVALID,'Search term exceeds 200 characters.');return q;}
export function assertSearchLimit(limit){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)persistenceFail(PERSISTENCE_CODES.INVALID,'Search limit must be between 1 and 1000.');return limit;}
export const matchesSearch=(record,query)=>normalizedSearchText(record).includes(normalizeSearchTerm(query));

// Shared financial validation. Both stores reject the same batches for the same
// reasons, before any row is written.
export function validateFinancialBatch(batch){
 if(!batch||typeof batch!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'A financial batch is required.');
 const gift=batch.gift;
 if(!gift||typeof gift!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'A financial batch requires its gift record.');
 if(!isRecordId(gift.id))persistenceFail(PERSISTENCE_CODES.INVALID,'Gift identity is invalid.');
 if(!GIFT_STATUSES.includes(gift.status))persistenceFail(PERSISTENCE_CODES.INVALID,'Gift status must be Posted or Voided.');
 if(typeof gift.date!=='string'||!DATE.test(gift.date)||Number.isNaN(Date.parse(gift.date)))persistenceFail(PERSISTENCE_CODES.INVALID,'Gift date must be an ISO calendar date.');
 assertIntegerCents(gift.amount,'Gift amount');
 if(gift.amount<0)persistenceFail(PERSISTENCE_CODES.INVALID,'Gift amount cannot be negative.');
 const allocations=gift.allocations;
 if(!Array.isArray(allocations)||!allocations.length)persistenceFail(PERSISTENCE_CODES.INVALID,'A gift requires at least one allocation.');
 if(allocations.length>200)persistenceFail(PERSISTENCE_CODES.INVALID,'A gift exceeds the 200-allocation boundary limit.');
 const seen=new Set();let total=0;
 for(const allocation of allocations){
  if(!allocation||!isRecordId(allocation.designationId))persistenceFail(PERSISTENCE_CODES.INVALID,'Allocation designation is invalid.');
  if(seen.has(allocation.designationId))persistenceFail(PERSISTENCE_CODES.INVALID,'Duplicate designation allocation.');
  seen.add(allocation.designationId);
  assertIntegerCents(allocation.amount,'Allocation amount');
  if(allocation.amount<=0)persistenceFail(PERSISTENCE_CODES.INVALID,'Allocation amounts must be positive integer cents.');
  total+=allocation.amount;
 }
 if(total!==gift.amount)persistenceFail(PERSISTENCE_CODES.INVALID,'Allocations must sum to the gift amount in exact cents.');
 if(batch.audit!==undefined&&(!batch.audit||typeof batch.audit!=='object'||typeof batch.audit.action!=='string'||!batch.audit.action))persistenceFail(PERSISTENCE_CODES.INVALID,'A financial audit entry requires an action.');
 return {gift,allocations,audit:batch.audit||null};
}

// ---------------------------------------------------------------------------
// The boundary itself.
// ---------------------------------------------------------------------------
export const REPOSITORY_CONTRACT=Object.freeze({
 // identity
 kind:'string: "sqlite" | "postgres"',
 tenantId:'string: the single tenant every call is scoped to',
 schemaVersion:'() => number — the recorded, applied forward-only schema version',
 // records
 listRecords:'(collection) => record[] in stable insertion order',
 getRecord:'(collection,id) => record; NOT_FOUND when absent',
 findRecord:'(collection,id) => record|null',
 countRecords:'(collection) => number',
 createRecord:'(collection,record) => record; CONFLICT on existing id',
 putRecord:'(collection,record) => record; upsert of the whole document',
 deleteRecord:'(collection,id) => true; NOT_FOUND when absent',
 // tenants
 describeTenant:'() => {tenantId,name,createdAt,residency}',
 // financial writes
 writeFinancialBatch:'(batch) => {giftId,allocationCount,auditId}; all-or-nothing',
 // search + reporting access paths
 searchRecords:'({collection,term,limit}) => record[]',
 reportGiftTotals:'({start,end,status,campaignId}) => exact integer-cent totals',
 reportDesignationTotals:'({start,end}) => per-designation exact integer-cent totals',
 // audit
 appendAudit:'(entry) => {id}',
 listAudit:'({limit}) => entry[] — append only, never updated or deleted',
 countAudit:'() => number',
 // settings and users
 getSettings:'() => object',
 putSettings:'(object) => object',
 listUsers:'() => user[]',
 putUser:'(user) => user',
 // transactions and verification
 transaction:'(fn) => result; rollback leaves nothing behind',
 snapshotDigest:'() => {tenantId,schemaVersion,collections,financial,totals} for equality proofs',
 exportTenant:'() => a portable, ordered dump of every row this boundary owns',
 importTenant:'(dump) => row counts — refuses to write into a non-empty tenant',
 close:'() => void'
});
export const REPOSITORY_METHODS=Object.freeze(Object.entries(REPOSITORY_CONTRACT).filter(([,d])=>d.startsWith('(')).map(([name])=>name));

export function assertRepositoryContract(repository){
 if(!repository||typeof repository!=='object')persistenceFail(PERSISTENCE_CODES.INVALID,'A repository instance is required.');
 if(!['sqlite','postgres'].includes(repository.kind))persistenceFail(PERSISTENCE_CODES.INVALID,'A repository must declare its store kind.');
 assertTenantId(repository.tenantId);
 const missing=REPOSITORY_METHODS.filter(name=>typeof repository[name]!=='function');
 if(missing.length)persistenceFail(PERSISTENCE_CODES.INVALID,`Repository does not implement the persistence boundary: ${missing.join(', ')}`);
 return repository;
}

// ---------------------------------------------------------------------------
// Executable conformance suite. Run against every implementation.
// ---------------------------------------------------------------------------
const eq=(actual,expected,message)=>{if(canonicalJson(actual)!==canonicalJson(expected))persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${message}: expected ${canonicalJson(expected)}, received ${canonicalJson(actual)}`);};
async function rejects(fn,code,message){
 let error=null;
 try{await fn();}catch(e){error=e;}
 if(!error)persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${message}: no error was raised`);
 if(error.code!==code)persistenceFail(PERSISTENCE_CODES.VERIFICATION,`${message}: expected ${code}, received ${error.code||error.message}`);
}

const donor=(id,name)=>({id,name,email:`${id}@synthetic.invalid`,type:'Individual',version:1});
const gift=(id,amount,allocations,extra={})=>({id,constituentId:'c-1',date:'2026-03-04',amount,status:'Posted',campaignId:'camp-1',schoolYear:'2025–2026',allocations,version:1,...extra});

// Every check is a named async step so a failure names itself in evidence.
export const CONFORMANCE_CHECKS=Object.freeze([
 ['empty collection lists as an empty array',async r=>{eq(await r.listRecords('constituents'),[],'empty list');eq(await r.countRecords('constituents'),0,'empty count');}],
 ['created records read back byte-identically',async r=>{const record=donor('c-1','Ada Fonseca');eq(await r.createRecord('constituents',record),record,'create echo');eq(await r.getRecord('constituents','c-1'),record,'read back');}],
 ['duplicate identity is a conflict, not an overwrite',async r=>{await rejects(()=>r.createRecord('constituents',donor('c-1','Impostor')),PERSISTENCE_CODES.CONFLICT,'duplicate create');eq((await r.getRecord('constituents','c-1')).name,'Ada Fonseca','original retained');}],
 ['absent identity is not found',async r=>{await rejects(()=>r.getRecord('constituents','missing'),PERSISTENCE_CODES.NOT_FOUND,'absent get');eq(await r.findRecord('constituents','missing'),null,'findRecord null');}],
 ['put upserts the whole document',async r=>{const updated={...donor('c-1','Ada Fonseca'),name:'Ada F. Fonseca',version:2};eq(await r.putRecord('constituents',updated),updated,'put echo');eq(await r.getRecord('constituents','c-1'),updated,'put read back');eq(await r.countRecords('constituents'),1,'put does not duplicate');}],
 ['list order is stable insertion order',async r=>{await r.createRecord('constituents',donor('c-2','Bo Lindgren'));await r.createRecord('constituents',donor('c-3','Cy Okafor'));eq((await r.listRecords('constituents')).map(x=>x.id),['c-1','c-2','c-3'],'insertion order');}],
 ['delete removes exactly one row and refuses the absent',async r=>{await r.createRecord('constituents',donor('c-4','Dee Vargas'));eq(await r.deleteRecord('constituents','c-4'),true,'delete');eq(await r.countRecords('constituents'),3,'count after delete');await rejects(()=>r.deleteRecord('constituents','c-4'),PERSISTENCE_CODES.NOT_FOUND,'delete absent');}],
 ['a failed transaction leaves nothing behind',async r=>{
  const before=await r.countRecords('constituents');
  await rejects(async()=>r.transaction(async()=>{await r.createRecord('constituents',donor('c-9','Rolled Back'));await r.createRecord('constituents',donor('c-10','Rolled Back Too'));persistenceFail(PERSISTENCE_CODES.INVALID,'synthetic mid-transaction failure');}),PERSISTENCE_CODES.INVALID,'transaction failure');
  eq(await r.countRecords('constituents'),before,'rollback restored the count');
  eq(await r.findRecord('constituents','c-9'),null,'first row rolled back');
  eq(await r.findRecord('constituents','c-10'),null,'second row rolled back');
 }],
 ['a valid financial batch writes gift, allocations and audit together',async r=>{
  const auditBefore=await r.countAudit();
  const result=await r.writeFinancialBatch({gift:gift('g-1',25000,[{designationId:'d-1',amount:15000},{designationId:'d-2',amount:10000}]),audit:{actor:'synthetic',action:'create_gift'}});
  eq(result.giftId,'g-1','gift id');eq(result.allocationCount,2,'allocation count');
  eq((await r.getRecord('gifts','g-1')).amount,25000,'exact cents retained');
  eq(await r.countAudit(),auditBefore+1,'audit appended once');
 }],
 ['a failed multi-row financial write leaves nothing behind',async r=>{
  const before={gifts:await r.countRecords('gifts'),audit:await r.countAudit()};
  await rejects(()=>r.writeFinancialBatch({gift:gift('g-bad',25000,[{designationId:'d-1',amount:15000},{designationId:'d-2',amount:9999}]),audit:{actor:'synthetic',action:'create_gift'}}),PERSISTENCE_CODES.INVALID,'unbalanced allocations');
  await rejects(()=>r.writeFinancialBatch({gift:gift('g-bad',25000,[{designationId:'d-1',amount:12500},{designationId:'d-1',amount:12500}]),audit:{actor:'synthetic',action:'create_gift'}}),PERSISTENCE_CODES.INVALID,'duplicate designation');
  await rejects(()=>r.writeFinancialBatch({gift:gift('g-bad',250.5,[{designationId:'d-1',amount:250.5}]),audit:{actor:'synthetic',action:'create_gift'}}),PERSISTENCE_CODES.INVALID,'fractional cents');
  await rejects(()=>r.writeFinancialBatch({gift:gift('g-1',25000,[{designationId:'d-1',amount:25000}]),audit:{actor:'synthetic',action:'create_gift'}}),PERSISTENCE_CODES.CONFLICT,'duplicate gift identity');
  eq(await r.countRecords('gifts'),before.gifts,'no gift row survived a refused write');
  eq(await r.countAudit(),before.audit,'no audit row survived a refused write');
  eq(await r.findRecord('gifts','g-bad'),null,'refused gift absent');
 }],
 ['reporting totals are exact integer cents and exclude voided revenue',async r=>{
  await r.writeFinancialBatch({gift:gift('g-2',7500,[{designationId:'d-1',amount:7500}],{date:'2026-05-19'}),audit:{actor:'synthetic',action:'create_gift'}});
  await r.writeFinancialBatch({gift:gift('g-3',999,[{designationId:'d-2',amount:999}],{date:'2025-11-02',status:'Voided'}),audit:{actor:'synthetic',action:'void_gift'}});
  eq(await r.reportGiftTotals({}),{giftCount:3,postedCents:32500,voidedCents:999,postedGiftCount:2},'all-time totals');
  eq(await r.reportGiftTotals({start:'2026-01-01',end:'2026-12-31'}),{giftCount:2,postedCents:32500,voidedCents:0,postedGiftCount:2},'date-window totals');
  eq(await r.reportGiftTotals({start:'2026-04-01',end:'2026-06-30'}),{giftCount:1,postedCents:7500,voidedCents:0,postedGiftCount:1},'narrow window');
  eq(await r.reportGiftTotals({campaignId:'camp-absent'}),{giftCount:0,postedCents:0,voidedCents:0,postedGiftCount:0},'unknown campaign');
  eq(await r.reportDesignationTotals({}),[{designationId:'d-1',postedCents:22500,allocationCount:2},{designationId:'d-2',postedCents:10000,allocationCount:1}],'designation totals');
 }],
 ['search returns the same rows on every store',async r=>{
  eq((await r.searchRecords({collection:'constituents',term:'lindgren'})).map(x=>x.id),['c-2'],'name match');
  eq((await r.searchRecords({collection:'constituents',term:'SYNTHETIC.INVALID'})).map(x=>x.id),['c-1','c-2','c-3'],'case-insensitive substring across fields');
  eq((await r.searchRecords({collection:'constituents',term:'no-such-donor'})),[],'no match');
  eq((await r.searchRecords({collection:'constituents',term:'synthetic',limit:2})).length,2,'limit honoured');
  await rejects(()=>r.searchRecords({collection:'constituents',term:'  '}),PERSISTENCE_CODES.INVALID,'empty term');
 }],
 ['audit is append-only and ordered',async r=>{
  const before=await r.countAudit();
  const appended=await r.appendAudit({actor:'synthetic',action:'export',collection:'gifts',recordId:'g-1',details:{scope:'conformance'}});
  if(!appended?.id)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'appendAudit did not return an identity');
  eq(await r.countAudit(),before+1,'audit count grew by one');
  const entries=await r.listAudit({limit:1});
  eq(entries.length,1,'limit honoured');eq(entries[0].action,'export','most recent first');
  if(typeof r.updateAudit==='function'||typeof r.deleteAudit==='function')persistenceFail(PERSISTENCE_CODES.VERIFICATION,'the boundary must not expose audit mutation');
 }],
 ['settings and users round-trip',async r=>{
  eq(await r.putSettings({organizationName:'Wimblo',fiscalStartMonth:7}),{organizationName:'Wimblo',fiscalStartMonth:7},'settings write');
  eq(await r.getSettings(),{organizationName:'Wimblo',fiscalStartMonth:7},'settings read');
  await r.putUser({id:'u-1',name:'Alex Morgan',email:'alex@synthetic.invalid',role:'admin',passwordHash:'synthetic-hash',active:1,version:1});
  eq((await r.listUsers()).map(u=>u.email),['alex@synthetic.invalid'],'user list');
 }],
 ['the tenant snapshot digest is stable and covers the financial totals',async r=>{
  const first=await r.snapshotDigest(),second=await r.snapshotDigest();
  eq(first,second,'digest is stable across reads');
  eq(first.tenantId,r.tenantId,'digest names its tenant');
  eq(first.financial,{postedCents:32500,voidedCents:999,giftCount:3,allocationCents:33499,allocationCount:4},'financial totals in the digest');
  if(!Number.isInteger(first.schemaVersion)||first.schemaVersion<1)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'digest must carry the applied schema version');
  const collections=Object.fromEntries(Object.entries(first.collections).map(([k,v])=>[k,v.count]));
  eq(collections,{constituents:3,gifts:3},'digest collection counts');
 }],
 ['export and import reproduce an identical tenant',async(r,context)=>{
  if(!context?.createEmptyRepository)return;
  const dump=await r.exportTenant();
  const target=await context.createEmptyRepository();
  try{
   await target.importTenant(dump);
   const source=await r.snapshotDigest(),restored=await target.snapshotDigest();
   eq({...restored,tenantId:source.tenantId},{...source,tenantId:source.tenantId},'restored digest equals the source digest');
   await rejects(()=>target.importTenant(dump),PERSISTENCE_CODES.CONFLICT,'import into a non-empty tenant');
  }finally{await target.close();}
 }]
]);

export async function runRepositoryConformance({createRepository,createEmptyRepository=null,label='repository'}={}){
 if(typeof createRepository!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'Conformance needs a repository factory.');
 const repository=assertRepositoryContract(await createRepository());
 const checks=[];
 try{
  for(const [name,check] of CONFORMANCE_CHECKS){
   try{await check(repository,{createEmptyRepository});checks.push({name,passed:true});}
   catch(e){checks.push({name,passed:false,error:e.message});throw new PersistenceError(PERSISTENCE_CODES.VERIFICATION,`[${label}] ${name} — ${e.message}`,{checks});}
  }
 }finally{await repository.close();}
 return {label,kind:repository.kind,checks,passed:checks.length,failed:0};
}
