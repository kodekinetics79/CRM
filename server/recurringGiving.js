// Provider-neutral recurring giving intentions.
//
// A PLEDGE is a commitment. A RECURRING PAYMENT is a collection instruction.
// Neither is income. Income exists only when an explicit, reviewed settlement
// posts exactly one native gift for exactly one scheduled collection.
//
// There is no provider client in this file and no network call anywhere in it.
// Collection is performed by an injected TEST_ONLY adapter supplied through
// createApp({extensions:{recurringGiving:{...}}}). Without that explicit
// configuration the collection instruction path stays disabled, manual entry
// and import remain the primary and fully intact way to record giving, and no
// approved live provider relationship is implied.
import {randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {changedGiftFinancialFields} from './financialCorrections.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const key=z.string().min(1).max(100),version=z.number().int().positive(),reason=z.string().trim().min(1).max(2000);
const FREQUENCIES=['Monthly','Quarterly','Annual'],MONTHS={Monthly:1,Quarterly:3,Annual:12};
const METHODS=['Check','Cash','Credit card','ACH','Payroll'];
const scope='TEST ONLY: provider-neutral recurring intentions with an injected simulated collection adapter. A simulated collection is not bank settlement, not provider acceptance, not a tax receipt and not donor consent. Manual entry and import remain the primary path.';
const limits={page:100,history:100,intentions:1000,collections:2000,maxAttempts:4,retryMinutes:[60,360,1440],catchUp:24,horizonDays:3660};

const isoDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
// Calendar advance with end-of-month clamping so the 31st never silently skips a month.
export function advance(date,frequency,periods=1){
 const [y,m,d]=date.split('-').map(Number),total=(m-1)+MONTHS[frequency]*periods,year=y+Math.floor(total/12),month=(total%12+12)%12;
 const last=new Date(Date.UTC(year,month+1,0)).getUTCDate();
 return `${String(year).padStart(4,'0')}-${String(month+1).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;
}

export function install(app,ctx){
 if(!ctx)return null;
 const {db,get,create,audit,csrf,admin,transaction,tenantId,production,isTenantActive=()=>true,recheckAccess=()=>false,config=null}=ctx;
 const clock=config?.clock||Date.now;
 if(config){
  if(production||config.mode!=='TEST_ONLY')throw new Error('Recurring giving TEST_ONLY cannot enable in production');
  if(!z.uuid().safeParse(tenantId).success)throw new Error('Recurring giving requires an explicit test workspace tenant');
  if(!config.adapter||typeof config.adapter.collect!=='function')throw new Error('Recurring giving requires an injected TEST_ONLY collection adapter');
  if(typeof config.adjustmentSecret!=='string'||config.adjustmentSecret.length<16)throw new Error('Recurring giving requires a test adjustment signing secret');
  if(config.donorTokenSecret!=null&&(typeof config.donorTokenSecret!=='string'||config.donorTokenSecret.length<16))throw new Error('Recurring giving donor token secret must be an explicit strong secret');
 }
 const adapter=config?.adapter||null;
 db.exec(`CREATE TABLE IF NOT EXISTS recurring_intentions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('Pledge','RecurringPayment')),status TEXT NOT NULL CHECK(status IN ('Active','Paused','Cancelled','Completed','ReviewRequired')),source_json TEXT NOT NULL,source_digest TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),frequency TEXT NOT NULL CHECK(frequency IN ('Monthly','Quarterly','Annual')),start_date TEXT NOT NULL,occurrences INTEGER,next_due TEXT,dunning TEXT NOT NULL CHECK(dunning IN ('None','Retrying','Exhausted')),request_id TEXT NOT NULL,recovery_marker TEXT NOT NULL,token_hash TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error_code TEXT,UNIQUE(tenant_id,request_id));
 CREATE TABLE IF NOT EXISTS recurring_collections(id TEXT PRIMARY KEY,intention_id TEXT NOT NULL REFERENCES recurring_intentions(id),tenant_id TEXT NOT NULL,sequence INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('Scheduled','AttemptFailed','Unknown','Collected','GiftRecorded','ReviewRequired','Cancelled')),scheduled_for TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt TEXT,idempotency_key TEXT NOT NULL UNIQUE,provider_ref TEXT UNIQUE,method TEXT,evidence_json TEXT,evidence_digest TEXT,gift_id TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error_code TEXT,UNIQUE(intention_id,sequence));
 CREATE TABLE IF NOT EXISTS recurring_gift_links(collection_id TEXT PRIMARY KEY REFERENCES recurring_collections(id),intention_id TEXT NOT NULL REFERENCES recurring_intentions(id),gift_id TEXT NOT NULL UNIQUE,provider_ref TEXT NOT NULL UNIQUE,amount_cents INTEGER NOT NULL,gift_json TEXT NOT NULL,gift_digest TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS recurring_history(id TEXT PRIMARY KEY,intention_id TEXT NOT NULL REFERENCES recurring_intentions(id),collection_id TEXT,entity_version INTEGER NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL,error_code TEXT);
 CREATE TABLE IF NOT EXISTS recurring_adjustments(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL REFERENCES recurring_collections(id),type TEXT NOT NULL,body_digest TEXT NOT NULL,amount_cents INTEGER NOT NULL,data_json TEXT NOT NULL,at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS recurring_collection_due ON recurring_collections(status,scheduled_for);
 CREATE TRIGGER IF NOT EXISTS recurring_intention_no_delete BEFORE DELETE ON recurring_intentions BEGIN SELECT RAISE(ABORT,'Recurring giving history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS recurring_collection_no_delete BEFORE DELETE ON recurring_collections BEGIN SELECT RAISE(ABORT,'Recurring collection history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS recurring_intention_source_immutable BEFORE UPDATE ON recurring_intentions WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.kind IS NOT OLD.kind OR NEW.source_json IS NOT OLD.source_json OR NEW.source_digest IS NOT OLD.source_digest OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.frequency IS NOT OLD.frequency OR NEW.start_date IS NOT OLD.start_date OR NEW.occurrences IS NOT OLD.occurrences OR NEW.request_id IS NOT OLD.request_id OR NEW.recovery_marker IS NOT OLD.recovery_marker OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'Original recurring authority is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS recurring_intention_cancelled BEFORE UPDATE ON recurring_intentions WHEN OLD.status='Cancelled' AND NEW.status!='Cancelled' BEGIN SELECT RAISE(ABORT,'A cancelled recurring intention cannot resume'); END;
 CREATE TRIGGER IF NOT EXISTS recurring_collection_immutable BEFORE UPDATE ON recurring_collections WHEN NEW.id IS NOT OLD.id OR NEW.intention_id IS NOT OLD.intention_id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.sequence IS NOT OLD.sequence OR NEW.scheduled_for IS NOT OLD.scheduled_for OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS NOT OLD.provider_ref) OR (OLD.gift_id IS NOT NULL AND NEW.gift_id IS NOT OLD.gift_id) OR (OLD.evidence_json IS NOT NULL AND (NEW.evidence_json IS NOT OLD.evidence_json OR NEW.evidence_digest IS NOT OLD.evidence_digest OR NEW.method IS NOT OLD.method)) BEGIN SELECT RAISE(ABORT,'Recorded recurring collection facts are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS recurring_collection_settled BEFORE UPDATE ON recurring_collections WHEN OLD.status='GiftRecorded' AND NEW.status NOT IN ('GiftRecorded','ReviewRequired') BEGIN SELECT RAISE(ABORT,'A settled recurring collection cannot reopen'); END;
 ${['gift_links','history','adjustments'].map(n=>`CREATE TRIGGER IF NOT EXISTS recurring_${n}_no_update BEFORE UPDATE ON recurring_${n} BEGIN SELECT RAISE(ABORT,'Recurring giving evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS recurring_${n}_no_delete BEFORE DELETE ON recurring_${n} BEGIN SELECT RAISE(ABORT,'Recurring giving evidence is retained'); END;`).join('\n')}`);

 const tx=fn=>db.isTransaction?fn():transaction(fn),time=()=>new Date(clock()).toISOString(),day=()=>time().slice(0,10);
 const marker=()=>db.prepare("SELECT 1 FROM sqlite_schema WHERE name='automation_recovery_markers' AND type='table'").get()?db.prepare('SELECT id FROM automation_recovery_markers ORDER BY rowid DESC LIMIT 1').get()?.id||'none':'none';
 function ready(){if(!config)fail(503,'Simulated recurring collection is not configured; record these gifts by manual entry or import');}
 function reader(req){if(!['admin','staff'].includes(req?.user?.role||''))fail(403,'Recurring giving requires administrator or staff access');if(!isTenantActive())fail(503,'Workspace unavailable; retry after authorized recovery');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');}
 function current(req){if(req?.user?.role!=='admin')fail(403,'Administrator required');if(!isTenantActive())fail(503,'Workspace unavailable; retry after authorized recovery');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');}
 function find(id){const r=db.prepare('SELECT * FROM recurring_intentions WHERE id=?').get(id);if(!r||r.tenant_id!==tenantId)fail(404,'Recurring intention not found');if(digest(JSON.parse(r.source_json))!==r.source_digest)fail(503,'Recurring intention authority is unavailable');return r;}
 function findCollection(id){const c=db.prepare('SELECT * FROM recurring_collections WHERE id=?').get(id);if(!c||c.tenant_id!==tenantId)fail(404,'Recurring collection not found');find(c.intention_id);return c;}
 function sourceCurrent(r){try{const s=JSON.parse(r.source_json),live={donor:get('constituents',s.donor.id),campaign:get('campaigns',s.campaign.id),designation:get('designations',s.designation.id)};return marker()===r.recovery_marker&&Object.keys(live).every(k=>digest(live[k])===digest(s[k]))&&!live.donor.mergedInto&&live.campaign.status==='Active';}catch{return false;}}
 function authority(r){if(!sourceCurrent(r))fail(409,'Original donor, campaign, designation or recovery authority changed; explicit financial review is required');}
 function history(intentionId,collectionId,entityVersion,action,status,user,why,errorCode=null){db.prepare('INSERT INTO recurring_history VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),intentionId,collectionId,entityVersion,action,status,user?.id||'system',time(),why,errorCode);}
 function updateIntention(r,status,fields={},user=null,why='',action='StateChanged'){const next={...r,...fields,status,version:r.version+1,updated_at:time()};db.prepare('UPDATE recurring_intentions SET version=?,status=?,next_due=?,dunning=?,token_hash=?,updated_at=?,last_error_code=? WHERE id=?').run(next.version,next.status,next.next_due,next.dunning,next.token_hash,next.updated_at,next.last_error_code,next.id);history(next.id,null,next.version,action,next.status,user,why,next.last_error_code);return next;}
 function updateCollection(c,status,fields={},user=null,why='',action='StateChanged'){const next={...c,...fields,status,version:c.version+1,updated_at:time()};db.prepare('UPDATE recurring_collections SET version=?,status=?,attempt_count=?,next_attempt=?,provider_ref=?,method=?,evidence_json=?,evidence_digest=?,gift_id=?,updated_at=?,last_error_code=? WHERE id=?').run(next.version,next.status,next.attempt_count,next.next_attempt,next.provider_ref,next.method,next.evidence_json,next.evidence_digest,next.gift_id,next.updated_at,next.last_error_code,next.id);history(next.intention_id,next.id,next.version,action,next.status,user,why,next.last_error_code);return next;}
 function exactIntention(r){if(digest(find(r.id))!==digest(r))fail(409,'Saved recurring intention failed exact reconciliation');}
 function exactCollection(c){if(digest(findCollection(c.id))!==digest(c))fail(409,'Saved recurring collection failed exact reconciliation');}

 // One posted gift per collection, reconciled field by field against the retained link.
 function currentGift(c){if(!c.gift_id)return null;const link=db.prepare('SELECT * FROM recurring_gift_links WHERE collection_id=?').get(c.id);if(!link||link.gift_id!==c.gift_id||link.provider_ref!==c.provider_ref)fail(503,'Recurring gift custody is unavailable');const old=JSON.parse(link.gift_json),gift=get('gifts',c.gift_id),r=find(c.intention_id),s=JSON.parse(r.source_json);if(digest(old)!==link.gift_digest||old.id!==link.gift_id||old.amount!==c.amount_cents||link.amount_cents!==c.amount_cents||old.constituentId!==s.donor.id||old.externalRef!=='RECURRING-TEST-'+c.id||changedGiftFinancialFields(old,gift).length||gift.id!==c.gift_id||!['Posted','Voided'].includes(gift.status))fail(503,'Recurring gift financial source failed reconciliation');return gift;}
 function collectionBody(c){const gift=currentGift(c);return {id:c.id,intentionId:c.intention_id,sequence:c.sequence,version:c.version,status:c.status,scheduledFor:c.scheduled_for,amountCents:c.amount_cents,currency:'usd',attemptCount:c.attempt_count,maxAttempts:limits.maxAttempts,nextAttempt:c.next_attempt||null,providerRef:c.provider_ref||null,method:c.method||null,giftId:c.gift_id||null,giftStatus:gift?.status||null,giftVersion:gift?.version||null,recordedCashCents:gift?.status==='Posted'?gift.amount:0,lastErrorCode:c.last_error_code||null,createdAt:c.created_at,updatedAt:c.updated_at};}
 function body(r){const s=JSON.parse(r.source_json),rows=db.prepare('SELECT * FROM recurring_collections WHERE intention_id=? ORDER BY sequence').all(r.id).map(collectionBody);
  return {id:r.id,requestId:r.request_id,version:r.version,mode:config?'TEST_ONLY':'ManualOnly',kind:r.kind,commitmentOnly:r.kind==='Pledge',status:r.status,donorId:s.donor.id,donorName:s.donor.name,campaignId:s.campaign.id,campaignName:s.campaign.name,designationId:s.designation.id,designationName:s.designation.name,sourceVersions:{donor:s.donor.version,campaign:s.campaign.version,designation:s.designation.version},sourceCurrent:sourceCurrent(r),amountCents:r.amount_cents,currency:'usd',frequency:r.frequency,startDate:r.start_date,occurrences:r.occurrences,nextDue:r.next_due,dunning:r.dunning,donorTokenIssued:Boolean(r.token_hash),collections:rows,scheduledCount:rows.length,recordedCashCents:rows.reduce((n,x)=>n+x.recordedCashCents,0),committedCents:r.occurrences?r.amount_cents*r.occurrences:null,createdAt:r.created_at,updatedAt:r.updated_at,lastErrorCode:r.last_error_code||null};}

 // Materialize due occurrences. Scheduling creates no income and calls no provider.
 function ensureCollections(r,user=null){if(r.status!=='Active')return r;let live=r,made=0;const today=day();
  while(made<limits.catchUp&&live.next_due&&live.next_due<=today){
   const sequence=db.prepare('SELECT COUNT(*) n FROM recurring_collections WHERE intention_id=?').get(live.id).n+1;
   if(live.occurrences&&sequence>live.occurrences)break;
   if(db.prepare('SELECT COUNT(*) n FROM recurring_collections WHERE tenant_id=?').get(tenantId).n>=limits.collections)fail(409,'This test workspace has the maximum retained recurring collections');
   const id=randomUUID(),at=time();
   db.prepare('INSERT INTO recurring_collections(id,intention_id,tenant_id,sequence,version,status,scheduled_for,amount_cents,attempt_count,next_attempt,idempotency_key,provider_ref,method,evidence_json,evidence_digest,gift_id,created_at,updated_at,last_error_code) VALUES(?,?,?,?,1,?,?,?,0,?,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL)').run(id,live.id,tenantId,sequence,'Scheduled',live.next_due,live.amount_cents,live.next_due,'wimblo-recurring-'+tenantId+'-'+id,at,at);
   history(live.id,id,1,'Scheduled','Scheduled',user,'Scheduled occurrence '+sequence+' for '+live.next_due);
   const following=advance(live.next_due,live.frequency);
   const done=live.occurrences&&sequence>=live.occurrences;
   live=updateIntention(live,done?'Completed':'Active',{next_due:done?null:following},user,done?'All committed occurrences are scheduled':'Advanced schedule to '+following,'Scheduled');
   made++;
   if(done)break;
  }
  return live;
 }

 function signAdjustment(payload){return createHmac('sha256',config.adjustmentSecret).update(canonical(payload)).digest('hex');}
 function verifyAdjustment(payload,signature){const expected=Buffer.from(signAdjustment(payload),'utf8'),supplied=Buffer.from(String(signature||''),'utf8');if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))fail(400,'Invalid simulated adjustment signature');}

 function reviewCollection(c,code,why,user=null){if(c.status==='ReviewRequired')return c;const n=updateCollection(c,'ReviewRequired',{last_error_code:code,next_attempt:null},user,why,'ReviewRequired');audit(user,'review_recurring_collection',null,c.id,{collectionId:c.id,intentionId:c.intention_id,errorCode:code});exactCollection(n);return n;}

 function createIntention(req,p){
  return tx(()=>{current(req);
   const existing=db.prepare('SELECT * FROM recurring_intentions WHERE tenant_id=? AND request_id=?').get(tenantId,p.requestId);
   if(existing){const old=find(existing.id),s=JSON.parse(old.source_json);if(old.kind!==p.kind||old.amount_cents!==p.amountCents||old.frequency!==p.frequency||old.start_date!==p.startDate||(old.occurrences??null)!==(p.occurrences??null)||s.donor.id!==p.donorId||s.campaign.id!==p.campaignId||s.designation.id!==p.designationId)fail(409,'Reviewed request identity changed; reuse only the exact original request');return {intention:body(ensureCollections(old,req.user)),replayed:true,scope};}
   if(db.prepare('SELECT COUNT(*) n FROM recurring_intentions WHERE tenant_id=?').get(tenantId).n>=limits.intentions)fail(409,'This test workspace has the maximum retained recurring intentions');
   const donor=get('constituents',p.donorId),campaign=get('campaigns',p.campaignId),designation=get('designations',p.designationId);
   if(donor.mergedInto||campaign.status!=='Active'||donor.version!==p.donorVersion||campaign.version!==p.campaignVersion||designation.version!==p.designationVersion)fail(409,'Choose a current surviving donor, an active campaign and current designation versions');
   if(p.startDate<day())fail(400,'Choose a start date from today onward');
   if(Date.parse(p.startDate+'T00:00:00Z')>clock()+limits.horizonDays*86400000)fail(400,'Choose a start date inside the supported ten-year horizon');
   if(p.kind==='RecurringPayment'&&!config)fail(503,'Simulated recurring collection is not configured; record a pledge commitment and enter its gifts manually');
   const id=randomUUID(),source={donor,campaign,designation},at=time();
   db.prepare('INSERT INTO recurring_intentions(id,tenant_id,version,kind,status,source_json,source_digest,amount_cents,frequency,start_date,occurrences,next_due,dunning,request_id,recovery_marker,token_hash,created_at,updated_at,last_error_code) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)').run(id,tenantId,p.kind,'Active',JSON.stringify(source),digest(source),p.amountCents,p.frequency,p.startDate,p.occurrences??null,p.startDate,'None',p.requestId,marker(),at,at);
   history(id,null,1,'Created','Active',req.user,p.reason);
   audit(req.user,'create_recurring_intention',null,id,{intentionId:id,kind:p.kind,amountCents:p.amountCents,frequency:p.frequency,occurrences:p.occurrences??null,income:'None recorded'});
   const live=ensureCollections(find(id),req.user);current(req);authority(live);exactIntention(live);
   return {intention:body(live),replayed:false,scope};
  });
 }

 function lifecycle(req,id,action,p){
  return tx(()=>{current(req);const r=find(id);if(r.version!==p.version)fail(409,'Recurring intention changed. Reload its current version');
   if(action==='pause'){if(r.status!=='Active')fail(409,'Only an active recurring intention can pause');const n=updateIntention(r,'Paused',{},req.user,p.reason,'Paused');audit(req.user,'pause_recurring_intention',null,id,{intentionId:id,reason:p.reason});exactIntention(n);return {intention:body(n),scope};}
   if(action==='resume'){if(!['Paused','ReviewRequired'].includes(r.status))fail(409,'Only a paused or reviewed recurring intention can resume');authority(r);const today=day();let due=r.next_due||r.start_date;while(due<today)due=advance(due,r.frequency);const n=ensureCollections(updateIntention(r,'Active',{next_due:due,dunning:'None',last_error_code:null},req.user,p.reason,'Resumed'),req.user);audit(req.user,'resume_recurring_intention',null,id,{intentionId:id,reason:p.reason,nextDue:n.next_due});exactIntention(n);return {intention:body(n),scope};}
   if(r.status==='Cancelled')fail(409,'This recurring intention is already cancelled');
   const n=updateIntention(r,'Cancelled',{next_due:null,dunning:'None'},req.user,p.reason,'Cancelled');
   for(const c of db.prepare("SELECT * FROM recurring_collections WHERE intention_id=? AND status IN ('Scheduled','AttemptFailed')").all(id))updateCollection(c,'Cancelled',{next_attempt:null},req.user,'Intention cancelled: '+p.reason,'Cancelled');
   audit(req.user,'cancel_recurring_intention',null,id,{intentionId:id,reason:p.reason,income:'Existing posted gifts are retained and unchanged'});
   exactIntention(n);return {intention:body(n),scope};
  });
 }

 // Simulated collection. Records evidence only; it never posts a gift.
 async function collect(req,collectionId,p){
  ready();
  const pinned=tx(()=>{current(req);const c=findCollection(collectionId),r=find(c.intention_id);
   if(r.kind==='Pledge')fail(409,'A pledge is a commitment, not a collection instruction. Record its gift by reviewed manual entry');
   if(c.version!==p.version)fail(409,'Recurring collection changed. Reload its current version');
   if(!['Scheduled','AttemptFailed','Unknown'].includes(c.status))fail(409,'This collection is not available for a simulated attempt');
   if(r.status!=='Active')fail(409,'Only an active recurring intention collects');
   if(c.next_attempt&&c.next_attempt>time())fail(409,'This collection is waiting for its scheduled retry');
   if(c.attempt_count>=limits.maxAttempts)fail(409,'Bounded retry attempts are exhausted; explicit financial review is required');
   authority(r);return {c,r};
  });
  let outcome;
  try{outcome=await adapter.collect({intentionId:pinned.r.id,collectionId:pinned.c.id,amountCents:pinned.c.amount_cents,currency:'usd',scheduledFor:pinned.c.scheduled_for,attempt:pinned.c.attempt_count+1,idempotencyKey:pinned.c.idempotency_key,mode:'TEST_ONLY'});}
  catch{return tx(()=>{const c=findCollection(collectionId);if(c.version!==pinned.c.version)fail(409,'Collection changed during the simulated attempt');const n=updateCollection(c,'Unknown',{attempt_count:c.attempt_count+1,next_attempt:null,last_error_code:'COLLECTION_OUTCOME_UNKNOWN'},null,'Simulated collection outcome is unknown; the original idempotency key is retained','Unknown');audit(null,'collect_recurring',null,c.id,{collectionId:c.id,status:n.status,errorCode:n.last_error_code});exactCollection(n);fail(502,'Collection outcome unknown. Refresh, then retry the original request explicitly');});}
  return tx(()=>{current(req);const c=findCollection(collectionId),r=find(c.intention_id);
   if(c.version!==pinned.c.version||r.version!==pinned.r.version)fail(409,'Recurring authority changed during the simulated attempt');
   if(!sourceCurrent(r)){reviewCollection(c,'SOURCE_CHANGED','Original source changed during the simulated attempt');fail(409,'Original source changed; explicit financial review is required');}
   const attempt=c.attempt_count+1;
   if(outcome?.outcome==='succeeded'){
    if(!/^rc_test_[A-Za-z0-9_-]+$/.test(outcome.providerRef||''))fail(502,'Simulated collection reference is not a test reference');
    if(outcome.mode!=='TEST_ONLY'||outcome.currency!=='usd'||!Number.isSafeInteger(outcome.amountCents)||outcome.amountCents!==c.amount_cents)fail(502,'Simulated collection facts do not match the exact scheduled amount');
    if(!['Credit card','ACH'].includes(outcome.method))fail(502,'Unsupported simulated collection method');
    if(db.prepare('SELECT 1 FROM recurring_collections WHERE provider_ref=? AND id<>?').get(outcome.providerRef,c.id))fail(409,'This simulated collection reference is already retained');
    const evidence={providerRef:outcome.providerRef,amountCents:c.amount_cents,currency:'usd',method:outcome.method,collectedAt:outcome.collectedAt&&isoDate(String(outcome.collectedAt).slice(0,10))?String(outcome.collectedAt):time(),idempotencyKey:c.idempotency_key,mode:'TEST_ONLY'};
    const n=updateCollection(c,'Collected',{attempt_count:attempt,next_attempt:null,provider_ref:evidence.providerRef,method:evidence.method,evidence_json:JSON.stringify(evidence),evidence_digest:digest(evidence),last_error_code:null},req.user,p.reason,'Collected');
    if(r.dunning!=='None')updateIntention(find(r.id),'Active',{dunning:'None',last_error_code:null},req.user,'Simulated collection succeeded after recovery','DunningCleared');
    audit(req.user,'collect_recurring',null,c.id,{collectionId:c.id,intentionId:r.id,status:n.status,amountCents:c.amount_cents,currency:'usd',mode:'TEST_ONLY',income:'None recorded; explicit settlement is separate'});
    current(req);authority(find(r.id));exactCollection(n);return {collection:collectionBody(n),intention:body(find(r.id)),scope};
   }
   const code=typeof outcome?.failureCode==='string'&&outcome.failureCode.length<=60?outcome.failureCode:'COLLECTION_FAILED';
   if(attempt>=limits.maxAttempts){const n=updateCollection(c,'ReviewRequired',{attempt_count:attempt,next_attempt:null,last_error_code:code},req.user,p.reason,'RetriesExhausted');const paused=updateIntention(find(r.id),'ReviewRequired',{dunning:'Exhausted',next_due:null,last_error_code:code},req.user,'Bounded recovery attempts are exhausted','DunningExhausted');audit(req.user,'fail_recurring_collection',null,c.id,{collectionId:c.id,intentionId:r.id,attempt,errorCode:code,dunning:'Exhausted'});exactCollection(n);exactIntention(paused);return {collection:collectionBody(n),intention:body(paused),scope};}
   const wait=limits.retryMinutes[Math.min(attempt-1,limits.retryMinutes.length-1)],next=new Date(clock()+wait*60000).toISOString();
   const n=updateCollection(c,'AttemptFailed',{attempt_count:attempt,next_attempt:next,last_error_code:code},req.user,p.reason,'AttemptFailed');
   const dunned=r.dunning==='Retrying'?find(r.id):updateIntention(find(r.id),r.status,{dunning:'Retrying',last_error_code:code},req.user,'Bounded recovery scheduled','DunningRetrying');
   audit(req.user,'fail_recurring_collection',null,c.id,{collectionId:c.id,intentionId:r.id,attempt,errorCode:code,retryAt:next,dunning:'Retrying'});
   exactCollection(n);return {collection:collectionBody(n),intention:body(dunned),scope};
  });
 }

 // The one place income is created. Idempotent: exactly one posted gift per collection.
 function settle(req,collectionId,p){
  return tx(()=>{current(req);const c=findCollection(collectionId),r=find(c.intention_id),s=JSON.parse(r.source_json);
   if(c.gift_id){const gift=currentGift(c);return {collection:collectionBody(findCollection(collectionId)),giftId:c.gift_id,giftVersion:gift.version,alreadySettled:true,scope};}
   if(c.version!==p.version)fail(409,'Recurring collection changed. Reload its current version');
   if(r.status==='Cancelled')fail(409,'A cancelled recurring intention cannot post new income');
   authority(r);
   if(s.donor.version!==p.donorVersion||s.campaign.version!==p.campaignVersion||s.designation.version!==p.designationVersion)fail(409,'Original native source versions changed');
   let method,date;
   if(r.kind==='Pledge'){
    if(c.status!=='Scheduled')fail(409,'Only a scheduled pledge installment can be recorded');
    if(!p.method||!METHODS.includes(p.method))fail(400,'Choose the reviewed manual payment method actually received');
    if(!p.receivedDate||!isoDate(p.receivedDate)||p.receivedDate>day())fail(400,'Record the actual received date, which cannot be in the future');
    method=p.method;date=p.receivedDate;
   }else{
    if(c.status!=='Collected')fail(409,'Only a successfully collected instruction can settle');
    const evidence=JSON.parse(c.evidence_json||'null');
    if(!evidence||digest(evidence)!==c.evidence_digest||evidence.mode!=='TEST_ONLY'||evidence.amountCents!==c.amount_cents||evidence.currency!=='usd'||evidence.providerRef!==c.provider_ref||evidence.method!==c.method)fail(503,'Simulated collection evidence is unavailable');
    method=evidence.method;date=evidence.collectedAt.slice(0,10);
   }
   const providerRef=c.provider_ref||'manual-'+c.id;
   if(db.prepare('SELECT 1 FROM recurring_gift_links WHERE collection_id=? OR provider_ref=?').get(c.id,providerRef))fail(409,'This recurring collection already reconciles to a posted gift');
   const gift=create('gifts',{constituentId:s.donor.id,amount:c.amount_cents,type:'Cash',method,date,campaignId:s.campaign.id,allocations:[{designationId:s.designation.id,amount:c.amount_cents}],giftKind:r.kind==='Pledge'?'Pledge fulfillment':'Recurring',externalRef:'RECURRING-TEST-'+c.id,notes:'TEST ONLY reviewed recurring settlement; not bank settlement, acknowledgment or tax receipt'},req.user);
   if(gift.amount!==c.amount_cents||gift.allocations.reduce((n,a)=>n+a.amount,0)!==c.amount_cents)fail(500,'Recurring settlement failed exact integer-cent reconciliation');
   db.prepare('INSERT INTO recurring_gift_links VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,r.id,gift.id,providerRef,c.amount_cents,JSON.stringify(gift),digest(gift),req.user.id,time());
   const n=updateCollection(c,'GiftRecorded',{gift_id:gift.id,provider_ref:providerRef,method,next_attempt:null,last_error_code:null},req.user,p.reason,'GiftRecorded');
   audit(req.user,'record_recurring_gift','gifts',gift.id,{collectionId:c.id,intentionId:r.id,amountCents:c.amount_cents,currency:'usd',kind:r.kind,mode:config?'TEST_ONLY':'ManualOnly'});
   current(req);authority(find(r.id));exactCollection(n);
   if(digest(get('gifts',gift.id))!==digest(gift))fail(409,'Saved recurring gift failed full reconciliation');
   const link=db.prepare('SELECT * FROM recurring_gift_links WHERE collection_id=?').get(c.id);
   if(!link||link.gift_id!==gift.id||link.gift_digest!==digest(gift)||link.amount_cents!==c.amount_cents)fail(409,'Recurring gift custody failed reconciliation');
   if(db.prepare('SELECT COUNT(*) n FROM recurring_gift_links WHERE collection_id=?').get(c.id).n!==1)fail(409,'Recurring settlement must reconcile to exactly one posted gift');
   return {collection:collectionBody(n),giftId:gift.id,giftVersion:gift.version,alreadySettled:false,scope};
  });
 }

 // Signed simulated refund / dispute / provider cancellation. Never voids a gift by itself.
 function adjust(req,p){
  ready();
  return tx(()=>{current(req);verifyAdjustment(p.adjustment,p.signature);
   const a=p.adjustment,c=findCollection(a.collectionId),r=find(c.intention_id);
   if(a.mode!=='TEST_ONLY'||a.currency!=='usd'||!Number.isSafeInteger(a.amountCents)||a.amountCents<0||a.amountCents>c.amount_cents)fail(400,'Unsupported simulated adjustment facts');
   if(a.providerRef!==c.provider_ref)fail(409,'Simulated adjustment does not match the retained collection reference');
   const bodyDigest=digest(a),old=db.prepare('SELECT * FROM recurring_adjustments WHERE id=?').get(a.id);
   if(old){if(old.body_digest!==bodyDigest)fail(409,'Simulated adjustment identity changed');return {received:true,replayed:true,collection:collectionBody(c),scope};}
   db.prepare('INSERT INTO recurring_adjustments VALUES(?,?,?,?,?,?,?)').run(a.id,c.id,a.type,bodyDigest,a.amountCents,JSON.stringify(a),time());
   const code={refund:'PROVIDER_REFUND_REVIEW_REQUIRED',dispute:'PROVIDER_DISPUTE_REVIEW_REQUIRED',cancellation:'PROVIDER_CANCELLATION_REVIEW_REQUIRED'}[a.type];
   const n=reviewCollection(c,code,'Signed simulated '+a.type+' requires financial review; no native gift is voided automatically',req.user);
   let intention=find(r.id);
   if(a.type==='cancellation'&&intention.status==='Active')intention=updateIntention(intention,'ReviewRequired',{next_due:null,last_error_code:code},req.user,'Signed simulated provider cancellation requires review','ProviderCancellation');
   audit(req.user,'adjust_recurring_collection',null,c.id,{collectionId:c.id,intentionId:r.id,adjustmentId:a.id,type:a.type,amountCents:a.amountCents,income:'Unchanged; a native void is a separate reasoned action'});
   exactCollection(n);
   return {received:true,replayed:false,collection:collectionBody(n),intention:body(intention),scope};
  });
 }

 function listIntentions(req,q){return tx(()=>{reader(req);const all=db.prepare('SELECT id FROM recurring_intentions WHERE tenant_id=? ORDER BY created_at DESC,id DESC').all(tenantId).map(x=>find(x.id));const cursor=q.after?all.find(x=>x.id===q.after):null;if(q.after&&!cursor)fail(400,'Recurring cursor unavailable');const rows=cursor?all.filter(x=>x.created_at<cursor.created_at||(x.created_at===cursor.created_at&&x.id<cursor.id)):all,page=rows.slice(0,q.limit);return {intentions:page.map(body),nextCursor:rows.length>q.limit?page.at(-1).id:null,limit:q.limit,limits,scope};});}
 function detail(req,id){return tx(()=>{reader(req);const r=find(id);return {intention:body(r),history:db.prepare('SELECT id,intention_id AS intentionId,collection_id AS collectionId,entity_version AS version,action,status,actor,at,reason,error_code AS errorCode FROM recurring_history WHERE intention_id=? ORDER BY at DESC,rowid DESC LIMIT ?').all(id,limits.history),historyCount:db.prepare('SELECT COUNT(*) n FROM recurring_history WHERE intention_id=?').get(id).n,historyLimit:limits.history,scope};});}
 const status=()=>({enabled:Boolean(config),ready:Boolean(config),mode:config?'TEST_ONLY':'Disabled',reasonCode:config?null:'TEST_ADAPTER_NOT_CONFIGURED',manualEntryPrimary:true,limits,frequencies:FREQUENCIES,methods:METHODS,scope});

 // Bounded due processing. It schedules occurrences only; it never collects or posts income.
 function runDueSchedules(){if(!isTenantActive())return {scheduled:0,suspended:true};let scheduled=0;
  for(const row of db.prepare("SELECT id FROM recurring_intentions WHERE tenant_id=? AND status='Active' AND next_due IS NOT NULL AND next_due<=? ORDER BY next_due,id LIMIT 100").all(tenantId,day()))
   try{tx(()=>{const r=find(row.id);if(r.status!=='Active'||!sourceCurrent(r))return;const before=db.prepare('SELECT COUNT(*) n FROM recurring_collections WHERE intention_id=?').get(r.id).n;ensureCollections(r);scheduled+=db.prepare('SELECT COUNT(*) n FROM recurring_collections WHERE intention_id=?').get(r.id).n-before;});}catch{}
  return {scheduled,suspended:false};
 }

 // Strictly bounded donor self-service support for the public surface.
 // It never exposes other donors, never alters consent and never changes money.
 function bindDonorToken(intentionId,tokenHash){return tx(()=>{const r=find(intentionId);if(r.token_hash===tokenHash)return body(r);if(r.token_hash)fail(409,'A donor self-service token is already issued for this intention');const n=updateIntention(r,r.status,{token_hash:tokenHash},null,'Donor self-service token issued','TokenIssued');return body(n);});}
 function donorView(tokenHash){return tx(()=>{const row=db.prepare('SELECT id FROM recurring_intentions WHERE tenant_id=? AND token_hash=?').get(tenantId,tokenHash);if(!row)fail(404,'This link is not available');const r=find(row.id),full=body(r);
  return {id:full.id,status:full.status,kind:full.kind,commitmentOnly:full.commitmentOnly,amountCents:full.amountCents,currency:'usd',frequency:full.frequency,startDate:full.startDate,nextDue:full.nextDue,occurrences:full.occurrences,version:full.version,scheduledCount:full.scheduledCount,designationName:full.designationName,scope};});}
 function donorCancel(tokenHash,p){return tx(()=>{const row=db.prepare('SELECT id FROM recurring_intentions WHERE tenant_id=? AND token_hash=?').get(tenantId,tokenHash);if(!row)fail(404,'This link is not available');const r=find(row.id);if(r.version!==p.version)fail(409,'This recurring intention changed. Reload it before cancelling');if(r.status==='Cancelled')fail(409,'This recurring intention is already cancelled');
  const n=updateIntention(r,'Cancelled',{next_due:null,dunning:'None'},null,'Donor self-service cancellation: '+p.reason,'DonorCancelled');
  for(const c of db.prepare("SELECT * FROM recurring_collections WHERE intention_id=? AND status IN ('Scheduled','AttemptFailed')").all(r.id))updateCollection(c,'Cancelled',{next_attempt:null},null,'Donor cancelled the recurring intention','Cancelled');
  audit(null,'donor_cancel_recurring_intention',null,r.id,{intentionId:r.id,channel:'Public donor self-service',consent:'Unchanged',income:'Existing posted gifts are retained and unchanged'});
  exactIntention(n);const v=donorView(tokenHash);return {intention:v,cancelled:true,scope};});}

 const referencedConstituent=id=>db.prepare('SELECT source_json FROM recurring_intentions').all().some(r=>JSON.parse(r.source_json).donor.id===id);
 function validateMutation(collection,old,next){
  if(collection==='gifts'&&db.prepare('SELECT 1 FROM recurring_gift_links WHERE gift_id=?').get(old.id)&&(!next||changedGiftFinancialFields(old,next).length))fail(409,'Recurring-linked gift facts cannot be rewritten; a reasoned native void is not a provider refund');
  if(collection==='constituents'&&referencedConstituent(old.id)&&(!next||next.mergedInto||next.type!==old.type))fail(409,'Retained recurring giving donor custody prevents identity replacement');
  if(['campaigns','designations'].includes(collection)&&!next&&db.prepare('SELECT source_json FROM recurring_intentions').all().some(r=>JSON.parse(r.source_json)[collection==='campaigns'?'campaign':'designation'].id===old.id))fail(409,'Retained recurring giving source custody prevents deletion');
 }

 const route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
 app.use('/api/recurring-giving',(req,res,next)=>{try{reader(req);next();}catch(e){next(e);}});
 app.get('/api/recurring-giving/status',route((req,res)=>res.json(status())));
 app.get('/api/recurring-giving/intentions',route((req,res)=>res.json(listIntentions(req,z.object({limit:z.coerce.number().int().min(1).max(limits.page).default(limits.page),after:z.uuid().optional()}).strict().parse(req.query)))));
 app.get('/api/recurring-giving/intentions/:id',route((req,res)=>res.json(detail(req,req.params.id))));
 app.post('/api/recurring-giving/intentions',csrf,admin,route((req,res)=>{const p=z.object({requestId:z.uuid(),kind:z.enum(['Pledge','RecurringPayment']),donorId:key,donorVersion:version,campaignId:key,campaignVersion:version,designationId:key,designationVersion:version,amountCents:z.number().int().min(100).max(1e8),currency:z.literal('usd'),frequency:z.enum(FREQUENCIES),startDate:z.string().refine(isoDate,'Use a valid calendar date'),occurrences:z.number().int().min(1).max(120).nullable().default(null),reason,reviewConfirmed:z.literal(true)}).strict().parse(req.body);res.status(201).json(createIntention(req,p));}));
 for(const action of ['pause','resume','cancel'])app.post('/api/recurring-giving/intentions/:id/'+action,csrf,admin,route((req,res)=>res.json(lifecycle(req,req.params.id,action,z.object({version,reason}).strict().parse(req.body)))));
 app.post('/api/recurring-giving/collections/:id/collect',csrf,admin,route(async(req,res)=>{const p=z.object({version,reason,testModeConfirmed:z.literal(true)}).strict().parse(req.body);res.json(await collect(req,req.params.id,p));}));
 app.post('/api/recurring-giving/collections/:id/record-gift',csrf,admin,route((req,res)=>{const p=z.object({version,donorVersion:version,campaignVersion:version,designationVersion:version,reason,reviewConfirmed:z.literal(true),method:z.enum(METHODS).optional(),receivedDate:z.string().refine(isoDate,'Use a valid calendar date').optional()}).strict().parse(req.body);const result=settle(req,req.params.id,p);
  // 201 only when this call created the gift; an idempotent replay is 200, so a
  // concurrent duplicate can never be mistaken for a second recorded contribution.
  res.status(result.alreadySettled?200:201).json(result);}));
 // Mints the one bounded donor self-service link. The token is returned once and
 // only its hash is retained, so it cannot be recovered from the workspace later.
 app.post('/api/recurring-giving/intentions/:id/donor-link',csrf,admin,route((req,res)=>{
  const p=z.object({version,reason,expiresInDays:z.number().int().min(1).max(365).default(30)}).strict().parse(req.body);
  if(!config?.donorTokenSecret)fail(503,'Donor self-service links are not configured for this workspace');
  const result=tx(()=>{current(req);const r=find(req.params.id);if(r.version!==p.version)fail(409,'Recurring intention changed. Reload its current version');if(r.status==='Cancelled')fail(409,'A cancelled recurring intention cannot issue a donor link');if(r.token_hash)fail(409,'A donor self-service link is already issued for this intention');
   const payload={t:tenantId,i:r.id,n:randomUUID(),e:clock()+p.expiresInDays*86400000},encoded='v1.'+Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
   const token=encoded+'.'+createHmac('sha256',config.donorTokenSecret).update(encoded).digest('hex');
   const intention=bindDonorToken(r.id,createHash('sha256').update(token).digest('hex'));
   audit(req.user,'issue_recurring_donor_link',null,r.id,{intentionId:r.id,reason:p.reason,expiresAt:new Date(payload.e).toISOString(),scopeOfLink:'View and cancel this one intention only'});
   return {intention,token,expiresAt:new Date(payload.e).toISOString()};
  });
  res.status(201).json({...result,delivery:'Not sent. Share this link with the donor through a reviewed channel; issuing it delivers nothing.',scope});
 }));
 app.post('/api/recurring-giving/adjustments',csrf,admin,route((req,res)=>{const p=z.object({adjustment:z.object({id:z.string().min(1).max(100),collectionId:z.uuid(),providerRef:z.string().min(1).max(200),type:z.enum(['refund','dispute','cancellation']),amountCents:z.number().int().min(0).max(1e8),currency:z.literal('usd'),mode:z.literal('TEST_ONLY')}).strict(),signature:z.string().min(1).max(200)}).strict().parse(req.body);res.json(adjust(req,p));}));

 return {status,runDueSchedules,collect,settle,bindDonorToken,donorView,donorCancel,validateMutation,validateDeletion:validateMutation,hasConstituentReferences:referencedConstituent,
  reportSources(user){if(user?.role!=='admin'||!isTenantActive())fail(403,'Current administrator read access required');return tx(()=>({recurringIntentions:db.prepare('SELECT id FROM recurring_intentions WHERE tenant_id=? ORDER BY created_at,id LIMIT 10001').all(tenantId).map(x=>{const r=find(x.id),v=body(r);return {id:r.id,revision:r.version,kind:r.kind,status:r.status,donorId:v.donorId,campaignId:v.campaignId,designationId:v.designationId,amountCents:v.amountCents,currency:'usd',frequency:r.frequency,recordedCashCents:v.recordedCashCents,committedCents:v.committedCents,sourceCurrent:v.sourceCurrent,mode:v.mode,createdAt:r.created_at,updatedAt:r.updated_at};})}));}};
}
