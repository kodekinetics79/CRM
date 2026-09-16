// Provider-neutral messaging core: explicit consent and sticky suppression
// ledgers, reviewed recipient snapshots re-checked at execution, idempotent
// bounded execution and campaign attribution that never creates or duplicates
// revenue. Only a TEST_ONLY transport ships: it records what would be sent and
// performs no network I/O. Production transports stay refused without explicit
// configuration AND recorded authorization, and NODE_ENV=production enables
// none of them. Preparing, reviewing or finalizing never claims delivery.
import {randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getConstituentTypes} from '../shared/constituentTypes.js';
import {mfaAccountBinding} from './mfa.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const iso=time=>new Date(time).toISOString();
const id=z.uuid(),version=z.number().int().positive(),reason=z.string().trim().min(1).max(2000),nativeKey=z.string().min(1).max(100);
const CHANNELS=['Email','SMS'],CLASSIFICATIONS=['Marketing','Transactional','Acknowledgment'],PURPOSES=['Marketing','Transactional'];
const EVENT_TYPES=['Delivered','Bounced','Complaint','Unsubscribed','Opted out','Subscribed'];
const SUPPRESSION_SCOPE=Object.freeze({Unsubscribed:'Marketing','Opted out':'Marketing',Complaint:'All',Bounced:'All',Manual:'All'});
const handoff='Handed to the TEST_ONLY transport and recorded locally. No provider transmission, delivery, open, click or human readership is claimed.';
const notSent='Not sent';
const scopeStatement='TEST_ONLY provider-neutral messaging. Consent and suppression are explicit local ledgers; contact preference is not marketing consent; a provider observation never grants consent or clears a retained suppression; preparing or reviewing never claims delivery; attribution never creates or duplicates revenue.';
const limits=Object.freeze({campaigns:5000,recipients:500,page:100,history:100,attempts:5,retrySeconds:60,webhookBytes:262144,smsBody:480,events:200000,attributions:200000,queue:20000,queueBatch:100});
// Operational reminders requested by other services. Every one is Transactional:
// it never requires marketing consent and is never a marketing send. An unknown
// purpose is programmer error and throws; a policy denial is a returned refusal.
export const QUEUE_PURPOSES=Object.freeze(['volunteer-shift-reminder','volunteer-shift-cancellation','volunteer-shift-promotion','event-reminder','task-reminder']);
const QUEUE_LABELS=Object.freeze({'volunteer-shift-reminder':'Your upcoming volunteer shift','volunteer-shift-cancellation':'A change to your volunteer shift','volunteer-shift-promotion':'A volunteer shift place is now yours','event-reminder':'Your upcoming event','task-reminder':'A reminder about your assigned work'});
const queueEnvelopeSchema=z.object({purpose:z.enum(QUEUE_PURPOSES),constituentId:z.string().min(1).max(100),constituentVersion:z.number().int().positive(),channel:z.enum(CHANNELS),reference:z.string().trim().min(1).max(200),summary:z.string().trim().min(1).max(500)}).strict();
const purposeFor=classification=>classification==='Marketing'?'Marketing':'Transactional';
const normalizeEmail=value=>typeof value==='string'&&z.email().safeParse(value.trim()).success?value.trim().toLowerCase():null;
const normalizeNumber=value=>{if(typeof value!=='string')return null;const compact=value.replace(/[\s()\-.]/g,'');return /^\+[1-9]\d{6,14}$/.test(compact)?compact:null;};
const addressOf=(profile,channel)=>channel==='Email'?normalizeEmail(profile.email):normalizeNumber(profile.phone);

// The only shipped transport. It records an exact structured message and never
// opens a socket, so a recorded send is evidence of local handoff, not delivery.
export function createTestOnlyMessagingTransport(){
 const sent=[];
 const messageSchema=z.object({channel:z.enum(CHANNELS),to:z.string().min(1).max(320),from:z.string().min(1).max(320),subject:z.string().max(500),body:z.string().min(1).max(16000),campaignId:id.optional(),recipientId:id.optional(),queueId:id.optional(),purpose:z.enum(QUEUE_PURPOSES).optional(),classification:z.enum(CLASSIFICATIONS),idempotencyKey:z.string().min(1).max(200)}).strict()
  .refine(m=>Boolean(m.campaignId&&m.recipientId)!==Boolean(m.queueId),'A message belongs either to a reviewed campaign recipient or to one operational queue row')
  .refine(m=>!m.queueId||m.classification==='Transactional','An operational queue message is always Transactional');
 return {mode:'TEST_ONLY',name:'Recorded TEST_ONLY transport',sent,
  async send(message){const p=messageSchema.parse(message);sent.push({...p,sequence:sent.length});return {providerMessageId:'test_'+createHash('sha256').update(p.idempotencyKey).digest('hex').slice(0,24),mode:'TEST_ONLY',transmitted:false,statement:handoff};}};
}

export function validateMessagingConfig(config,{production=false}={}){
 if(!config)return null;
 const {clock,...rest}=config;
 if(!Object.keys(rest).length)return null;
 if(production)throw new Error('Messaging transports are unavailable in production until an authorized live provider, residency review and consent evidence are integrated');
 const p=z.object({mode:z.literal('TEST_ONLY'),channels:z.array(z.enum(CHANNELS)).min(1).max(2).refine(v=>new Set(v).size===v.length,'Choose each channel once'),fromAddress:z.email(),fromNumber:z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),webhookSecret:z.string().min(32).max(200),authorization:z.object({approved:z.literal(true),reference:z.string().trim().min(1).max(250),reviewedAt:z.iso.datetime()}).strict(),rateLimitPerMinute:z.number().int().min(1).max(1000).default(60),maxRecipients:z.number().int().min(1).max(limits.recipients).default(100),transport:z.any()}).strict().parse(rest);
 if(!p.transport||typeof p.transport.send!=='function'||p.transport.mode!=='TEST_ONLY')throw new Error('TEST_ONLY messaging requires an explicitly injected transport that records instead of sending');
 if(p.channels.includes('SMS')&&!p.fromNumber)throw new Error('Optional SMS requires an explicitly configured originating number');
 return p;
}

export function install(app,{db,get,audit,csrf,transaction,tenantId=null,production=false,config=null,isTenantActive=()=>true,recheckAccess=()=>false,ownerAllowed=()=>false,services={}}={}){
 const c=validateMessagingConfig(config,{production});
 const clock=typeof config?.clock==='function'?config.clock:Date.now;
 const scope=tenantId||'default';
 if(c&&!z.uuid().safeParse(tenantId).success)throw new Error('Messaging transports require an explicit test workspace UUID');
 const correspondence=services?.correspondence||null;
 const transport=c?c.transport:null;
 const policy=c?hash({mode:c.mode,channels:[...c.channels].sort(),from:c.fromAddress,number:c.fromNumber||null,authorization:c.authorization,secret:hash(c.webhookSecret)}):'disabled';
 db.exec(`CREATE TABLE IF NOT EXISTS messaging_consent_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,constituent_id TEXT NOT NULL,constituent_version INTEGER NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('Email','SMS')),address TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('Marketing','Transactional')),state TEXT NOT NULL CHECK(state IN ('Granted','Withdrawn')),source_kind TEXT NOT NULL CHECK(source_kind IN ('Staff recorded','Provider observation')),basis TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,CHECK(source_kind<>'Provider observation' OR state='Withdrawn'));
 CREATE INDEX IF NOT EXISTS messaging_consent_current ON messaging_consent_events(tenant_id,constituent_id,channel,address,purpose);
 CREATE INDEX IF NOT EXISTS messaging_consent_address ON messaging_consent_events(tenant_id,channel,address,purpose);
 CREATE TABLE IF NOT EXISTS messaging_suppressions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('Email','SMS')),address TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('Unsubscribed','Opted out','Complaint','Bounced','Manual')),scope TEXT NOT NULL CHECK(scope IN ('Marketing','All')),source_kind TEXT NOT NULL,source_id TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(tenant_id,channel,address,reason));
 CREATE TABLE IF NOT EXISTS messaging_campaigns(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification IN ('Marketing','Transactional','Acknowledgment')),channel TEXT NOT NULL CHECK(channel IN ('Email','SMS')),source_kind TEXT NOT NULL CHECK(source_kind IN ('Template','Correspondence')),template_id TEXT,template_version INTEGER,template_digest TEXT,preparation_id TEXT,preparation_digest TEXT,campaign_record_id TEXT,campaign_record_version INTEGER,status TEXT NOT NULL CHECK(status IN ('Draft','Reviewed','Executing','Executed','ReviewRequired','Cancelled')),version INTEGER NOT NULL,snapshot_digest TEXT,recipient_count INTEGER NOT NULL DEFAULT 0,owner_id TEXT NOT NULL REFERENCES users(id),owner_version INTEGER NOT NULL,owner_binding TEXT NOT NULL,config_digest TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messaging_recipients(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL REFERENCES messaging_campaigns(id),constituent_id TEXT NOT NULL,constituent_version INTEGER NOT NULL,constituent_digest TEXT NOT NULL,channel TEXT NOT NULL,address TEXT NOT NULL,consent_event_id TEXT NOT NULL REFERENCES messaging_consent_events(id),content_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Reviewed','Sending','Sent','Failed','Refused','Unknown')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt TEXT NOT NULL,write_attempted INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(campaign_id,constituent_id),UNIQUE(campaign_id,address));
 CREATE TABLE IF NOT EXISTS messaging_deliveries(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL REFERENCES messaging_campaigns(id),recipient_id TEXT NOT NULL UNIQUE REFERENCES messaging_recipients(id),execution_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,transport_mode TEXT NOT NULL CHECK(transport_mode='TEST_ONLY'),provider_message_id TEXT NOT NULL,content_digest TEXT NOT NULL,recorded_at TEXT NOT NULL,statement TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS messaging_delivery_window ON messaging_deliveries(tenant_id,recorded_at);
 CREATE TABLE IF NOT EXISTS messaging_executions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL REFERENCES messaging_campaigns(id),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,actor TEXT NOT NULL,result_json TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(tenant_id,idempotency_key));
 CREATE TABLE IF NOT EXISTS messaging_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,raw_digest TEXT NOT NULL,type TEXT NOT NULL,channel TEXT NOT NULL,address TEXT NOT NULL,delivery_id TEXT,campaign_id TEXT,provider_message_id TEXT,signature_timestamp INTEGER NOT NULL,source_fired_at TEXT,received_at TEXT NOT NULL,suppression_reason TEXT,UNIQUE(tenant_id,raw_digest));
 CREATE TABLE IF NOT EXISTS messaging_attributions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL REFERENCES messaging_campaigns(id),recipient_id TEXT NOT NULL REFERENCES messaging_recipients(id),constituent_id TEXT NOT NULL,gift_id TEXT NOT NULL,gift_version INTEGER NOT NULL,gift_digest TEXT NOT NULL,amount_cents INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(tenant_id,gift_id));
 CREATE TABLE IF NOT EXISTS messaging_queue(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,purpose TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification='Transactional'),constituent_id TEXT NOT NULL,constituent_version INTEGER NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('Email','SMS')),reference TEXT NOT NULL,summary TEXT NOT NULL,consent_basis TEXT NOT NULL,consent_event_id TEXT,requested_by TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Queued','Sent','Refused','Failed','Unknown')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt TEXT NOT NULL,write_attempted INTEGER NOT NULL DEFAULT 0,sent_constituent_version INTEGER,last_error TEXT,queued_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(tenant_id,reference));
 CREATE INDEX IF NOT EXISTS messaging_queue_due ON messaging_queue(tenant_id,status,next_attempt,id);
 CREATE TABLE IF NOT EXISTS messaging_queue_deliveries(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,queue_id TEXT NOT NULL UNIQUE REFERENCES messaging_queue(id),execution_id TEXT NOT NULL,purpose TEXT NOT NULL,channel TEXT NOT NULL,transport_mode TEXT NOT NULL CHECK(transport_mode='TEST_ONLY'),provider_message_id TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification='Transactional'),recorded_at TEXT NOT NULL,statement TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS messaging_queue_delivery_window ON messaging_queue_deliveries(tenant_id,recorded_at);
 CREATE TRIGGER IF NOT EXISTS messaging_queue_no_delete BEFORE DELETE ON messaging_queue BEGIN SELECT RAISE(ABORT,'Operational reminder history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_queue_original_immutable BEFORE UPDATE ON messaging_queue WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.purpose IS NOT OLD.purpose OR NEW.classification IS NOT OLD.classification OR NEW.constituent_id IS NOT OLD.constituent_id OR NEW.constituent_version IS NOT OLD.constituent_version OR NEW.channel IS NOT OLD.channel OR NEW.reference IS NOT OLD.reference OR NEW.summary IS NOT OLD.summary OR NEW.consent_basis IS NOT OLD.consent_basis OR NEW.requested_by IS NOT OLD.requested_by OR NEW.queued_at IS NOT OLD.queued_at BEGIN SELECT RAISE(ABORT,'A queued operational reminder is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_queue_attempt_retained BEFORE UPDATE OF write_attempted ON messaging_queue WHEN OLD.write_attempted=1 AND NEW.write_attempted IS NOT 1 BEGIN SELECT RAISE(ABORT,'An attempted transport handoff cannot be cleared'); END;
 CREATE TABLE IF NOT EXISTS messaging_outcomes(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL,campaign_version INTEGER NOT NULL,recipient_id TEXT,status TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,retry_at TEXT);
 CREATE TRIGGER IF NOT EXISTS messaging_campaign_no_delete BEFORE DELETE ON messaging_campaigns BEGIN SELECT RAISE(ABORT,'Messaging campaign history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_campaign_definition_immutable BEFORE UPDATE ON messaging_campaigns WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.name IS NOT OLD.name OR NEW.classification IS NOT OLD.classification OR NEW.channel IS NOT OLD.channel OR NEW.source_kind IS NOT OLD.source_kind OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR NEW.template_digest IS NOT OLD.template_digest OR NEW.preparation_id IS NOT OLD.preparation_id OR NEW.preparation_digest IS NOT OLD.preparation_digest OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_version IS NOT OLD.owner_version OR NEW.owner_binding IS NOT OLD.owner_binding OR NEW.config_digest IS NOT OLD.config_digest OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'Reviewed messaging definitions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_campaign_closed_immutable BEFORE UPDATE ON messaging_campaigns WHEN OLD.status IN ('Executed','Cancelled') BEGIN SELECT RAISE(ABORT,'Closed messaging campaigns cannot resume or change'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_recipient_no_delete BEFORE DELETE ON messaging_recipients BEGIN SELECT RAISE(ABORT,'Reviewed recipient snapshots are retained'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_recipient_snapshot_immutable BEFORE UPDATE ON messaging_recipients WHEN NEW.id IS NOT OLD.id OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.constituent_id IS NOT OLD.constituent_id OR NEW.constituent_version IS NOT OLD.constituent_version OR NEW.constituent_digest IS NOT OLD.constituent_digest OR NEW.address IS NOT OLD.address OR NEW.channel IS NOT OLD.channel OR NEW.consent_event_id IS NOT OLD.consent_event_id OR NEW.content_digest IS NOT OLD.content_digest OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'Reviewed recipient snapshots are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS messaging_recipient_attempt_retained BEFORE UPDATE OF write_attempted ON messaging_recipients WHEN OLD.write_attempted=1 AND NEW.write_attempted IS NOT 1 BEGIN SELECT RAISE(ABORT,'An attempted transport handoff cannot be cleared'); END;
 ${['consent_events','suppressions','deliveries','executions','events','attributions','outcomes','queue_deliveries'].map(name=>`CREATE TRIGGER IF NOT EXISTS messaging_${name}_no_update BEFORE UPDATE ON messaging_${name} BEGIN SELECT RAISE(ABORT,'Messaging evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS messaging_${name}_no_delete BEFORE DELETE ON messaging_${name} BEGIN SELECT RAISE(ABORT,'Messaging evidence is retained'); END;`).join('\n')}`);
 const tx=fn=>db.isTransaction?fn():transaction(fn),at=()=>iso(clock());
 const ready=()=>{if(!c)fail(503,'No messaging transport is configured. Nothing can be sent from this workspace');};
 function current(req,level='write'){const roles=level==='admin'?['admin']:['admin','staff'];if(!req?.user||!roles.includes(req.user.role))fail(403,level==='admin'?'Executing a reviewed campaign requires administrator access':'Messaging requires current staff or administrator access');if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');}
 const account=key=>db.prepare('SELECT * FROM users WHERE id=?').get(key);
 const profile=key=>{const p=get('constituents',key);getConstituentTypes(p);return p;};
 function find(key){const row=db.prepare('SELECT * FROM messaging_campaigns WHERE id=?').get(key);if(!row||row.tenant_id!==scope)fail(404,'Messaging campaign not found');return row;}
 const recipientRow=key=>{const row=db.prepare('SELECT * FROM messaging_recipients WHERE id=?').get(key);if(!row||row.tenant_id!==scope)fail(404,'Reviewed recipient not found');return row;};
 const recipientsOf=key=>db.prepare('SELECT * FROM messaging_recipients WHERE campaign_id=? ORDER BY constituent_id').all(key);
 const latestConsent=(constituentId,channel,address,purpose)=>db.prepare('SELECT * FROM messaging_consent_events WHERE tenant_id=? AND constituent_id=? AND channel=? AND address=? AND purpose=? ORDER BY rowid DESC LIMIT 1').get(scope,constituentId,channel,address,purpose)||null;
 const suppressionsFor=(channel,address)=>db.prepare('SELECT * FROM messaging_suppressions WHERE tenant_id=? AND channel=? AND address=? ORDER BY at,id').all(scope,channel,address);
 const blockingSuppressions=(channel,address,classification)=>suppressionsFor(channel,address).filter(row=>row.scope==='All'||classification==='Marketing');
 function outcome(row,recipientId,status,why,user,time=clock(),retryAt=null){db.prepare('INSERT INTO messaging_outcomes VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,row.version,recipientId,status,why,user?.id||'system',iso(time),retryAt);}
 function retainSuppression(channel,address,why,sourceKind,sourceId){if(!why)return null;const existing=db.prepare('SELECT * FROM messaging_suppressions WHERE tenant_id=? AND channel=? AND address=? AND reason=?').get(scope,channel,address,why);if(existing)return existing;const row={id:randomUUID(),tenant_id:scope,channel,address,reason:why,scope:SUPPRESSION_SCOPE[why],source_kind:sourceKind,source_id:sourceId,at:at()};db.prepare('INSERT INTO messaging_suppressions VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row));if(hash(db.prepare('SELECT * FROM messaging_suppressions WHERE id=?').get(row.id))!==hash(row))fail(409,'Saved suppression failed reconciliation');return row;}
 // Provider observations may only withdraw. The table CHECK refuses a granting
 // provider row, so no callback, import or reconciliation can manufacture consent.
 function retainConsent(p,sourceKind,actor){const row={id:randomUUID(),tenant_id:scope,constituent_id:p.constituentId,constituent_version:p.constituentVersion,channel:p.channel,address:p.address,purpose:p.purpose,state:p.state,source_kind:sourceKind,basis:p.basis,actor:actor||'system',at:at()};db.prepare('INSERT INTO messaging_consent_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));if(hash(db.prepare('SELECT * FROM messaging_consent_events WHERE id=?').get(row.id))!==hash(row))fail(409,'Saved consent event failed reconciliation');return row;}

 function eligibility(p,channel,classification){
  if(p.mergedInto)return {reason:'Merged identity; select the surviving constituent'};
  if(p.preference==='Do not contact')return {reason:'Do not contact is recorded on this constituent'};
  const address=addressOf(p,channel);if(!address)return {reason:'No valid '+channel+' address is recorded'};
  const purpose=purposeFor(classification),consent=latestConsent(p.id,channel,address,purpose);
  if(!consent||consent.state!=='Granted')return {reason:'No current '+purpose.toLowerCase()+' consent is recorded for this '+channel+' address',address};
  const blocked=blockingSuppressions(channel,address,classification);
  if(blocked.length)return {reason:'Retained suppression: '+blocked.map(r=>r.reason).join(', '),address};
  return {address,consent};
 }
 // Wording is produced by the existing reviewed correspondence services only;
 // messaging never invents recipient text, merge fields or a second template store.
 function contentFor(row,constituentId){
  if(row.source_kind==='Correspondence'){const reviewed=correspondence.getReviewedMessage(row.preparation_id,row.preparation_digest);if(!reviewed.sourceCurrent)fail(409,'The finalized acknowledgment source changed. Review new wording before sending');const item=reviewed.items.find(x=>x.recipientId===constituentId);if(!item)fail(409,'This recipient is not part of the finalized acknowledgment');return {subject:item.subject,body:item.body};}
  const snapshot=correspondence.prepareWorkflowMessage({templateId:row.template_id,templateVersion:row.template_version,channel:row.channel==='Email'?'Email draft':'Print',constituentId}),item=snapshot.items[0];
  if(row.channel==='SMS'&&item.body.length>limits.smsBody)fail(400,'Reviewed SMS text exceeds '+limits.smsBody+' characters; shorten the template before review');
  return {subject:item.subject,body:item.body};
 }
 const contentDigest=(row,constituentId)=>hash({...contentFor(row,constituentId),classification:row.classification,channel:row.channel});
 function linkedCampaignRecord(row){if(!row.campaign_record_id)return null;try{return get('campaigns',row.campaign_record_id);}catch(e){if(e.status===404)return undefined;throw e;}}
 function staleReason(row,r){
  if(row.config_digest!==policy)return 'Transport configuration or recorded authorization changed';
  let p;try{p=profile(r.constituent_id);}catch(e){if(e.status===404)return 'Recipient record is unavailable';throw e;}
  if(p.version!==r.constituent_version||hash(p)!==r.constituent_digest)return 'Recipient record changed after review';
  const state=eligibility(p,r.channel,row.classification);if(state.reason)return state.reason;
  if(state.address!==r.address)return 'Recipient address changed after review';
  if(state.consent.id!==r.consent_event_id)return 'Recorded consent changed after review';
  const linked=linkedCampaignRecord(row);if(linked===undefined)return 'Linked campaign record is unavailable';
  if(linked&&linked.version!==row.campaign_record_version)return 'Linked campaign record changed after review';
  let digest;try{digest=contentDigest(row,r.constituent_id);}catch(e){if(e.status)return 'Reviewed wording is unavailable or changed';throw e;}
  if(digest!==r.content_digest)return 'Reviewed wording changed after review';
  return null;
 }
 function authority(req,row){
  if(row.config_digest!==policy)fail(409,'Transport configuration or recorded authorization changed since review');
  const owner=account(row.owner_id);
  if(!owner?.active||!['admin','staff'].includes(owner.role)||!ownerAllowed(owner))fail(409,'The reviewing account is no longer authorized. Review this campaign again');
  if(owner.version!==row.owner_version||mfaAccountBinding(owner)!==row.owner_binding)fail(409,'The reviewing account changed after review. Review this campaign again');
 }
 // Reviewed campaigns and operational reminders share one honest per-minute
 // budget, so a reminder burst can never exceed the configured transport rate.
 const rateBudget=time=>{const since=iso(time-60000),used=db.prepare('SELECT COUNT(*) n FROM messaging_deliveries WHERE tenant_id=? AND recorded_at>?').get(scope,since).n+db.prepare('SELECT COUNT(*) n FROM messaging_queue_deliveries WHERE tenant_id=? AND recorded_at>?').get(scope,since).n;return (c?.rateLimitPerMinute??0)-used;};

 const recipientView=r=>({id:r.id,constituentId:r.constituent_id,constituentVersion:r.constituent_version,channel:r.channel,addressMasked:mask(r.address),status:r.status,attemptCount:r.attempt_count,writeAttempted:Boolean(r.write_attempted),lastError:r.last_error||null,contentDigest:r.content_digest,updatedAt:r.updated_at});
 const mask=address=>address.includes('@')?address.replace(/^(.)[^@]*@(.).*$/,'$1***@$2***'):address.slice(0,2)+'***'+address.slice(-2);
 function view(row,{detail=false}={}){
  const base={id:row.id,name:row.name,classification:row.classification,channel:row.channel,sourceKind:row.source_kind,templateId:row.template_id,templateVersion:row.template_version,preparationId:row.preparation_id,campaignRecordId:row.campaign_record_id,campaignRecordVersion:row.campaign_record_version,status:row.status,version:row.version,recipientCount:row.recipient_count,snapshotDigest:row.snapshot_digest,ownerId:row.owner_id,configCurrent:row.config_digest===policy,createdAt:row.created_at,updatedAt:row.updated_at,delivery:row.status==='Executed'||row.status==='Executing'?handoff:notSent};
  if(!detail)return base;
  const rows=recipientsOf(row.id),stale=rows.filter(r=>r.status==='Reviewed').map(r=>({recipientId:r.id,reason:staleReason(row,r)})).filter(x=>x.reason);
  return {...base,recipients:rows.map(recipientView),sentCount:rows.filter(r=>r.status==='Sent').length,pendingCount:rows.filter(r=>r.status==='Reviewed').length,failedCount:rows.filter(r=>['Failed','Refused','Unknown'].includes(r.status)).length,staleRecipients:stale,sourceCurrent:rows.length>0&&stale.length===0};
 }
 const outcomesOf=key=>db.prepare('SELECT * FROM messaging_outcomes WHERE campaign_id=? ORDER BY at DESC,rowid DESC LIMIT ?').all(key,limits.history).map(r=>({id:r.id,campaignVersion:r.campaign_version,recipientId:r.recipient_id,status:r.status,reason:r.reason,actor:r.actor,at:r.at,retryAt:r.retry_at}));
 const deliveriesOf=key=>db.prepare('SELECT * FROM messaging_deliveries WHERE campaign_id=? ORDER BY recorded_at,id LIMIT ?').all(key,limits.recipients).map(r=>({id:r.id,recipientId:r.recipient_id,providerMessageId:r.provider_message_id,transportMode:r.transport_mode,recordedAt:r.recorded_at,statement:r.statement}));

 function createCampaign(req,body){
  const p=z.object({name:z.string().trim().min(1).max(250),classification:z.enum(CLASSIFICATIONS),channel:z.enum(CHANNELS),templateId:id.optional(),templateVersion:version.optional(),preparationId:id.optional(),preparationDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),campaignRecordId:nativeKey.optional(),reason,confirmed:z.literal(true)}).strict().parse(body);
  const template=Boolean(p.templateId),reviewed=Boolean(p.preparationId);
  if(template===reviewed)fail(400,'Choose exactly one reviewed source: a Messaging template or a finalized acknowledgment preparation');
  if(template&&!p.templateVersion)fail(400,'Select the exact Messaging template version');
  if(reviewed&&(!p.preparationDigest||p.classification!=='Acknowledgment'||p.channel!=='Email'))fail(400,'A finalized acknowledgment source requires its digest, the Acknowledgment classification and the Email channel');
  return tx(()=>{
   current(req);if(!correspondence?.prepareWorkflowMessage||!correspondence?.getReviewedMessage)fail(503,'Reviewed correspondence services are unavailable');
   if(db.prepare('SELECT COUNT(*) n FROM messaging_campaigns WHERE tenant_id=?').get(scope).n>=limits.campaigns)fail(409,'This workspace has reached its retained messaging campaign capacity');
   const owner=account(req.user.id);if(!ownerAllowed(owner))fail(403,'Current account security policy does not permit reviewing messages');
   if(c&&!c.channels.includes(p.channel))fail(409,'The '+p.channel+' channel is not configured for this workspace');
   let templateDigest=null,linked=null;
   if(template)templateDigest=correspondence.getWorkflowTemplate(p.templateId,p.templateVersion).definitionDigest;
   else {const source=correspondence.getReviewedMessage(p.preparationId,p.preparationDigest);if(source.kind!=='Acknowledgment')fail(400,'Select a finalized gift acknowledgment, not another prepared document');if(!source.sourceCurrent)fail(409,'The finalized acknowledgment source changed. Review new wording first');}
   if(p.campaignRecordId){linked=get('campaigns',p.campaignRecordId);if(linked.status==='Completed')fail(409,'Select an active or planned campaign record for attribution');}
   const key=randomUUID(),time=at();
   db.prepare('INSERT INTO messaging_campaigns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,scope,p.name,p.classification,p.channel,template?'Template':'Correspondence',p.templateId||null,p.templateVersion||null,templateDigest,p.preparationId||null,p.preparationDigest||null,p.campaignRecordId||null,linked?.version??null,'Draft',1,null,0,owner.id,owner.version,mfaAccountBinding(owner),policy,time,time);
   const saved=find(key);outcome(saved,null,'Draft','Campaign created; no recipient is reviewed and nothing is sent',req.user);
   audit(req.user,'create_messaging_campaign',null,key,{classification:p.classification,channel:p.channel,sourceKind:saved.source_kind,campaignRecordId:p.campaignRecordId||null,delivery:notSent});
   current(req);return view(saved);
  });
 }

 function reviewCampaign(req,key,body){
  id.parse(key);
  const p=z.object({version,constituentIds:z.array(nativeKey).min(1).max(limits.recipients).refine(v=>new Set(v).size===v.length,'Select each recipient once'),reason,confirmed:z.literal(true)}).strict().parse(body);
  return tx(()=>{
   current(req);const row=find(key);
   if(row.status!=='Draft')fail(409,'Only a draft campaign can be reviewed. Create a new campaign to change a reviewed recipient set');
   if(row.version!==p.version)fail(409,'Campaign changed. Reload its current version');
   authority(req,row);
   const max=c?.maxRecipients??limits.recipients;if(p.constituentIds.length>max)fail(409,'This workspace reviews at most '+max+' recipients per campaign');
   const selected=[...p.constituentIds].sort(),frozen=[];
   for(const constituentId of selected){
    const person=profile(constituentId),state=eligibility(person,row.channel,row.classification);
    if(state.reason)fail(409,'Recipient '+constituentId+' is not eligible: '+state.reason+'. Nothing was reviewed');
    const digest=contentDigest(row,constituentId),time=at(),recipientId=randomUUID();
    db.prepare('INSERT INTO messaging_recipients VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(recipientId,scope,row.id,person.id,person.version,hash(person),row.channel,state.address,state.consent.id,digest,'Reviewed',0,time,0,null,time,time);
    frozen.push({constituentId:person.id,constituentVersion:person.version,constituentDigest:hash(person),address:state.address,consentEventId:state.consent.id,contentDigest:digest});
   }
   const snapshot=hash({campaignId:row.id,classification:row.classification,channel:row.channel,recipients:frozen});
   db.prepare("UPDATE messaging_campaigns SET status='Reviewed',version=version+1,snapshot_digest=?,recipient_count=?,updated_at=? WHERE id=?").run(snapshot,frozen.length,at(),row.id);
   const saved=find(row.id);outcome(saved,null,'Reviewed','Recipient set, consent state and source versions frozen; nothing is sent',req.user);
   audit(req.user,'review_messaging_campaign',null,row.id,{version:saved.version,recipientCount:frozen.length,snapshotDigest:snapshot,classification:row.classification,channel:row.channel,delivery:notSent});
   current(req);authority(req,saved);
   const check=recipientsOf(row.id).map(r=>({constituentId:r.constituent_id,constituentVersion:r.constituent_version,constituentDigest:r.constituent_digest,address:r.address,consentEventId:r.consent_event_id,contentDigest:r.content_digest}));
   if(hash({campaignId:row.id,classification:row.classification,channel:row.channel,recipients:check})!==snapshot)fail(409,'The reviewed recipient snapshot failed reconciliation before it was saved');
   return view(saved,{detail:true});
  });
 }

 function markReviewRequired(row,why,user){if(['Executed','Cancelled'].includes(row.status))return row;db.prepare("UPDATE messaging_campaigns SET status='ReviewRequired',version=version+1,updated_at=? WHERE id=?").run(at(),row.id);const saved=find(row.id);outcome(saved,null,'ReviewRequired',why,user);audit(user,'review_required_messaging_campaign',null,row.id,{version:saved.version,reason:why,delivery:notSent});return saved;}

 async function executeCampaign(req,key,body){
  ready();id.parse(key);
  const p=z.object({version,snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:id,reason,confirmed:z.literal(true)}).strict().parse(body);
  const requestDigest=hash({campaignId:key,...p});
  const pin=tx(()=>{
   current(req,'admin');const row=find(key);
   const replay=db.prepare('SELECT * FROM messaging_executions WHERE tenant_id=? AND idempotency_key=?').get(scope,p.idempotencyKey);
   if(replay){if(replay.request_digest!==requestDigest)fail(409,'This execution key was already used for a different reviewed request');return {replay:JSON.parse(replay.result_json)};}
   if(!['Reviewed','Executing'].includes(row.status))fail(409,'Only a reviewed campaign can execute. Review the current recipients again');
   if(row.version!==p.version)fail(409,'Campaign changed. Reload its current version');
   if(row.snapshot_digest!==p.snapshotDigest)fail(409,'The reviewed recipient snapshot changed. Review the campaign again');
   authority(req,row);
   if(!c.channels.includes(row.channel))fail(409,'The '+row.channel+' channel is not configured for this workspace; nothing was sent');
   const pending=recipientsOf(row.id).filter(r=>r.status==='Reviewed');
   if(!pending.length)fail(409,'No reviewed recipient remains for this campaign');
   // A refusal rolls its own transaction back, so the campaign is moved to
   // ReviewRequired in a separate retained write after this one is discarded.
   const stale=pending.map(r=>({r,why:staleReason(row,r)})).filter(x=>x.why);
   if(stale.length)return {stale:stale[0].why};
   const budget=rateBudget(clock());
   if(budget<=0)fail(429,'The messaging rate limit for this minute is reached. Nothing was sent; retry after the current minute');
   db.prepare("UPDATE messaging_campaigns SET status='Executing',version=version+1,updated_at=? WHERE id=?").run(at(),row.id);
   const saved=find(row.id);outcome(saved,null,'Executing','Reviewed execution started against the configured TEST_ONLY transport',req.user);
   return {campaign:saved,pending:pending.slice(0,budget),rateLimited:pending.length>budget};
  });
  if(pin.replay)return {...pin.replay,replayed:true,scope:scopeStatement};
  if(pin.stale){try{tx(()=>markReviewRequired(find(key),'Reviewed recipients, consent, suppression, wording or authorization changed before execution: '+pin.stale,req.user));}catch{}fail(409,'Reviewed recipients, consent, suppression, wording or authorization changed before execution: '+pin.stale+'. Nothing was sent; review the campaign again');}
  let sent=0,failed=0,unknown=0;
  const executionId=randomUUID();
  for(const candidate of pin.pending){
   let reserved=null;
   try{reserved=tx(()=>{
    current(req,'admin');const row=find(key);if(row.status!=='Executing')fail(409,'Campaign changed during execution');
    const r=recipientRow(candidate.id);if(r.status!=='Reviewed')return null;
    if(db.prepare('SELECT 1 FROM messaging_deliveries WHERE recipient_id=?').get(r.id))return null;
    const why=staleReason(row,r);if(why)fail(409,'Recipient changed before handoff: '+why);
    const content=contentFor(row,r.constituent_id);
    db.prepare("UPDATE messaging_recipients SET status='Sending',attempt_count=attempt_count+1,write_attempted=1,updated_at=? WHERE id=?").run(at(),r.id);
    return {row,r:recipientRow(r.id),content};
   });}catch(e){failed++;try{tx(()=>{const row=find(key),r=recipientRow(candidate.id);if(r.status!=='Reviewed')return;db.prepare("UPDATE messaging_recipients SET status='Refused',last_error=?,updated_at=? WHERE id=?").run(String(e.message).slice(0,500),at(),r.id);outcome(row,r.id,'Refused','Recipient refused before any transport handoff: '+e.message,req.user);});}catch{}continue;}
   if(!reserved)continue;
   let result=null;
   try{result=await transport.send({channel:reserved.r.channel,to:reserved.r.address,from:reserved.r.channel==='Email'?c.fromAddress:c.fromNumber,subject:reserved.content.subject,body:reserved.content.body,campaignId:reserved.row.id,recipientId:reserved.r.id,classification:reserved.row.classification,idempotencyKey:p.idempotencyKey+':'+reserved.r.id});}
   catch(e){failed++;try{tx(()=>{const row=find(key),r=recipientRow(reserved.r.id);const terminal=r.attempt_count>=limits.attempts;const retryAt=iso(clock()+limits.retrySeconds*1000);db.prepare('UPDATE messaging_recipients SET status=?,next_attempt=?,last_error=?,updated_at=? WHERE id=?').run(terminal?'Failed':'Reviewed',retryAt,String(e.message).slice(0,500),at(),r.id);outcome(row,r.id,terminal?'Failed':'Retry',terminal?'Transport handoff failed '+r.attempt_count+' times; no further automatic attempt':'Transport handoff failed; a bounded retry is scheduled',req.user,clock(),terminal?null:retryAt);audit(req.user,'messaging_handoff_failed',null,row.id,{recipientId:r.id,attemptCount:r.attempt_count,terminal,delivery:notSent});});}catch{}continue;}
   try{tx(()=>{
    const row=find(key),r=recipientRow(reserved.r.id);if(r.status!=='Sending')fail(503,'Recipient reservation changed during handoff');
    db.prepare('INSERT INTO messaging_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,r.id,executionId,p.idempotencyKey,'TEST_ONLY',String(result.providerMessageId),r.content_digest,at(),handoff);
    db.prepare("UPDATE messaging_recipients SET status='Sent',last_error=NULL,updated_at=? WHERE id=?").run(at(),r.id);
    outcome(row,r.id,'Sent',handoff,req.user);
    audit(req.user,'send_messaging_recipient',null,row.id,{recipientId:r.id,constituentId:r.constituent_id,channel:r.channel,classification:row.classification,transportMode:'TEST_ONLY',providerTransmitted:false,delivery:handoff});
   });sent++;}
   catch(e){unknown++;try{tx(()=>{const row=find(key),r=recipientRow(reserved.r.id);if(r.status!=='Sending')return;db.prepare("UPDATE messaging_recipients SET status='Unknown',last_error=?,updated_at=? WHERE id=?").run(String(e.message).slice(0,500),at(),r.id);outcome(row,r.id,'Unknown','The transport handoff began but local evidence could not be retained; no automatic repeat is attempted',req.user);});}catch{}}
  }
  return tx(()=>{
   current(req,'admin');const row=find(key),rows=recipientsOf(row.id),remaining=rows.filter(r=>r.status==='Reviewed').length;
   const status=remaining?'Executing':'Executed';
   if(row.status==='Executing')db.prepare('UPDATE messaging_campaigns SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,at(),row.id);
   const saved=find(row.id),result={campaign:view(saved,{detail:true}),sent,failed,unknown,pending:remaining,rateLimited:Boolean(pin.rateLimited),executionId,delivery:handoff};
   db.prepare('INSERT INTO messaging_executions VALUES(?,?,?,?,?,?,?,?)').run(executionId,scope,row.id,p.idempotencyKey,requestDigest,req.user.id,JSON.stringify(result),at());
   outcome(saved,null,status,'Execution finished: '+sent+' handed to the TEST_ONLY transport, '+failed+' failed, '+unknown+' unconfirmed, '+remaining+' still reviewed',req.user);
   audit(req.user,'execute_messaging_campaign',null,row.id,{executionId,idempotencyKey:p.idempotencyKey,sent,failed,unknown,pending:remaining,transportMode:'TEST_ONLY',providerTransmitted:false,delivery:handoff});
   current(req,'admin');return {...result,scope:scopeStatement};
  });
 }

 function cancelCampaign(req,key,body){
  id.parse(key);const p=z.object({version,reason,confirmed:z.literal(true)}).strict().parse(body);
  return tx(()=>{
   current(req);const row=find(key);
   if(['Executed','Cancelled'].includes(row.status))fail(409,'This campaign is closed. Create a new reviewed campaign');
   if(row.version!==p.version)fail(409,'Campaign changed. Reload its current version');
   if(row.owner_id!==req.user.id&&req.user.role!=='admin')fail(403,'Only the reviewing account or an administrator can cancel this campaign');
   for(const r of recipientsOf(row.id))if(r.status==='Reviewed')db.prepare("UPDATE messaging_recipients SET status='Refused',last_error='Campaign cancelled before handoff',updated_at=? WHERE id=?").run(at(),r.id);
   db.prepare("UPDATE messaging_campaigns SET status='Cancelled',version=version+1,updated_at=? WHERE id=?").run(at(),row.id);
   const saved=find(row.id);outcome(saved,null,'Cancelled',p.reason,req.user);
   audit(req.user,'cancel_messaging_campaign',null,row.id,{version:saved.version,reason:p.reason,delivery:notSent});
   current(req);return view(saved,{detail:true});
  });
 }

 // Attribution links an already-posted gift to one campaign for A7.6 reporting.
 // It never creates, edits, re-posts or re-counts a gift: one gift may carry at
 // most one messaging attribution and the amount is copied only as evidence.
 function attributeGift(req,key,body){
  id.parse(key);
  const p=z.object({version,recipientId:id,giftId:nativeKey,giftVersion:version,reason,confirmed:z.literal(true)}).strict().parse(body);
  return tx(()=>{
   current(req);const row=find(key);
   if(!['Executing','Executed'].includes(row.status))fail(409,'Only an executed campaign can carry gift attribution');
   if(row.version!==p.version)fail(409,'Campaign changed. Reload its current version');
   const r=recipientRow(p.recipientId);if(r.campaign_id!==row.id)fail(404,'Reviewed recipient not found');
   if(r.status!=='Sent')fail(409,'Only a recipient with retained transport handoff evidence can carry attribution');
   if(db.prepare('SELECT COUNT(*) n FROM messaging_attributions WHERE tenant_id=?').get(scope).n>=limits.attributions)fail(409,'Retained attribution capacity reached');
   const gift=get('gifts',p.giftId);
   if(gift.version!==p.giftVersion)fail(409,'Gift changed. Reload its current version');
   if(gift.status!=='Posted')fail(409,'Only a posted gift can carry campaign attribution');
   if(gift.type==='Fee payment')fail(409,'Fee payments are not campaign revenue');
   if(!Number.isSafeInteger(gift.amount)||gift.amount<=0)fail(400,'Gift value must be positive safe integer cents');
   if(gift.constituentId!==r.constituent_id)fail(409,'The gift donor is not the reviewed recipient');
   if(row.campaign_record_id&&gift.campaignId&&gift.campaignId!==row.campaign_record_id)fail(409,'The gift is recorded against a different campaign record');
   if(db.prepare('SELECT 1 FROM messaging_attributions WHERE tenant_id=? AND gift_id=?').get(scope,p.giftId))fail(409,'This gift already carries a messaging attribution; revenue is never counted twice');
   const record={id:randomUUID(),tenant_id:scope,campaign_id:row.id,recipient_id:r.id,constituent_id:r.constituent_id,gift_id:gift.id,gift_version:gift.version,gift_digest:hash(gift),amount_cents:gift.amount,actor:req.user.id,reason:p.reason,at:at()};
   db.prepare('INSERT INTO messaging_attributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(record));
   outcome(row,r.id,'Attributed','An existing posted gift was linked to this campaign; no revenue was created or duplicated',req.user);
   audit(req.user,'attribute_messaging_gift','gifts',gift.id,{campaignId:row.id,recipientId:r.id,giftVersion:gift.version,amountCents:gift.amount,revenueCreated:false,giftModified:false,delivery:notSent});
   current(req);
   if(hash(db.prepare('SELECT * FROM messaging_attributions WHERE id=?').get(record.id))!==hash(record)||hash(get('gifts',gift.id))!==record.gift_digest)fail(409,'Attribution or its gift source failed reconciliation');
   return attributionView(record);
  });
 }
 function attributionView(record){
  let sourceCurrent=false,currentAmount=null,status=null;
  try{const gift=get('gifts',record.gift_id);sourceCurrent=gift.version===record.gift_version&&hash(gift)===record.gift_digest&&gift.status==='Posted';currentAmount=Number.isSafeInteger(gift.amount)?gift.amount:null;status=gift.status;}catch(e){if(e.status!==404)throw e;}
  return {id:record.id,campaignId:record.campaign_id,recipientId:record.recipient_id,constituentId:record.constituent_id,giftId:record.gift_id,giftVersion:record.gift_version,attributedCents:record.amount_cents,currentGiftCents:currentAmount,currentGiftStatus:status,sourceCurrent,reason:record.reason,at:record.at,statement:'Attribution links existing posted revenue to one campaign. It never creates, edits or duplicates a gift.'};
 }
 const attributionsOf=key=>db.prepare('SELECT * FROM messaging_attributions WHERE tenant_id=? AND campaign_id=? ORDER BY at,id LIMIT ?').all(scope,key,limits.page).map(attributionView);

 // Synchronous durable queueing for other services' operational reminders. It
 // joins the caller's write transaction, performs no network I/O, calls no
 // transport and never sleeps. A policy denial is a returned refusal, never a
 // throw, so a volunteer's own action is never failed by messaging policy.
 // Transactional always: marketing consent is never required and a marketing
 // unsubscribe never blocks it, while an All-scope suppression always does.
 function queueTransactional(envelope){
  const p=queueEnvelopeSchema.parse(envelope);
  if(!db.isTransaction)fail(503,'Transactional queueing must join the requesting service write transaction');
  if(p.channel==='SMS'&&p.summary.length>limits.smsBody)return {accepted:false,reason:'The operational summary exceeds the '+limits.smsBody+'-character SMS bound'};
  if(!isTenantActive())return {accepted:false,reason:'Workspace is suspended'};
  const existing=db.prepare('SELECT * FROM messaging_queue WHERE tenant_id=? AND reference=?').get(scope,p.reference);
  if(existing){
   if(existing.purpose!==p.purpose||existing.constituent_id!==p.constituentId||existing.channel!==p.channel||existing.summary!==p.summary)return {accepted:false,reason:'That reference is already queued for a different operational reminder'};
   return {accepted:true,reference:p.reference,queueId:existing.id,classification:'Transactional',replayed:true,delivery:notSent};
  }
  if(db.prepare('SELECT COUNT(*) n FROM messaging_queue WHERE tenant_id=?').get(scope).n>=limits.queue)return {accepted:false,reason:'Retained operational reminder capacity is reached'};
  let person;try{person=profile(p.constituentId);}catch(e){if(e.status===404)return {accepted:false,reason:'Constituent record is unavailable'};throw e;}
  if(person.version!==p.constituentVersion)return {accepted:false,reason:'Constituent changed since it was read; queue again from the current record'};
  if(person.mergedInto)return {accepted:false,reason:'Merged identity; queue against the surviving constituent'};
  if(person.preference==='Do not contact')return {accepted:false,reason:'Do not contact is recorded on this constituent'};
  const address=addressOf(person,p.channel);
  if(!address)return {accepted:false,reason:'No valid '+p.channel+' address is recorded'};
  // Scope is the whole point: a complaint, bounce or manual denial refuses an
  // operational reminder; a marketing unsubscribe must not strand a volunteer.
  const blocking=suppressionsFor(p.channel,address).filter(row=>row.scope==='All');
  if(blocking.length)return {accepted:false,reason:'Retained suppression: '+blocking.map(row=>row.reason).join(', ')};
  const grant=latestConsent(person.id,p.channel,address,'Transactional');
  const key=randomUUID(),time=at();
  db.prepare('INSERT INTO messaging_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,scope,p.purpose,'Transactional',person.id,person.version,p.channel,p.reference,p.summary,grant?.state==='Granted'?'Recorded transactional consent':'Operational relationship recorded by the requesting service',grant?.state==='Granted'?grant.id:null,'system','Queued',0,time,0,null,null,time,time);
  audit(null,'queue_transactional_message','constituents',person.id,{purpose:p.purpose,channel:p.channel,reference:p.reference,classification:'Transactional',marketing:false,transportConfigured:Boolean(c),delivery:notSent});
  return {accepted:true,reference:p.reference,queueId:key,classification:'Transactional',delivery:notSent};
 }
 const queueRow=key=>{const row=db.prepare('SELECT * FROM messaging_queue WHERE id=?').get(key);if(!row||row.tenant_id!==scope)fail(404,'Operational reminder not found');return row;};
 const queueView=row=>({id:row.id,purpose:row.purpose,classification:row.classification,constituentId:row.constituent_id,channel:row.channel,reference:row.reference,summary:row.summary,consentBasis:row.consent_basis,status:row.status,attemptCount:row.attempt_count,writeAttempted:Boolean(row.write_attempted),lastError:row.last_error||null,queuedAt:row.queued_at,updatedAt:row.updated_at,delivery:row.status==='Sent'?handoff:notSent});
 function queueRefuse(row,why,user){db.prepare("UPDATE messaging_queue SET status='Refused',last_error=?,updated_at=? WHERE id=?").run(String(why).slice(0,500),at(),row.id);audit(user,'refuse_transactional_message','constituents',row.constituent_id,{queueId:row.id,purpose:row.purpose,reason:why,classification:'Transactional',delivery:notSent});}
 function queuePolicy(row){
  if(!c.channels.includes(row.channel))return 'The '+row.channel+' channel is not configured for this workspace';
  let person;try{person=profile(row.constituent_id);}catch(e){if(e.status===404)return 'Constituent record is unavailable';throw e;}
  if(person.mergedInto)return 'Merged identity; the surviving constituent must be queued instead';
  if(person.preference==='Do not contact')return 'Do not contact is recorded on this constituent';
  // The address is deliberately resolved now, not frozen at queue time.
  const address=addressOf(person,row.channel);
  if(!address)return 'No valid '+row.channel+' address is recorded';
  const blocking=suppressionsFor(row.channel,address).filter(x=>x.scope==='All');
  if(blocking.length)return 'Retained suppression: '+blocking.map(x=>x.reason).join(', ');
  return {person,address};
 }
 async function executeQueue(req,body){
  ready();
  const p=z.object({reason,confirmed:z.literal(true)}).strict().parse(body);
  const executionId=randomUUID();
  const pin=tx(()=>{
   current(req,'admin');
   const budget=rateBudget(clock());
   if(budget<=0)fail(429,'The messaging rate limit for this minute is reached. Nothing was sent');
   const due=db.prepare("SELECT id FROM messaging_queue WHERE tenant_id=? AND status='Queued' AND next_attempt<=? ORDER BY queued_at,id LIMIT ?").all(scope,iso(clock()),Math.min(budget,limits.queueBatch));
   const pending=db.prepare("SELECT COUNT(*) n FROM messaging_queue WHERE tenant_id=? AND status='Queued'").get(scope).n;
   return {due,rateLimited:pending>due.length};
  });
  let sent=0,refused=0,failed=0,unknown=0;
  for(const candidate of pin.due){
   let reserved=null;
   try{reserved=tx(()=>{
    current(req,'admin');const row=queueRow(candidate.id);if(row.status!=='Queued')return null;
    if(db.prepare('SELECT 1 FROM messaging_queue_deliveries WHERE queue_id=?').get(row.id))return null;
    const policy=queuePolicy(row);
    if(typeof policy==='string'){queueRefuse(row,policy,req.user);return {refused:true};}
    db.prepare("UPDATE messaging_queue SET status='Queued',attempt_count=attempt_count+1,write_attempted=1,updated_at=? WHERE id=?").run(at(),row.id);
    return {row:queueRow(row.id),...policy};
   });}catch{failed++;continue;}
   if(!reserved)continue;
   if(reserved.refused){refused++;continue;}
   let result=null;
   const subject=reserved.row.channel==='Email'?QUEUE_LABELS[reserved.row.purpose]||'An operational notice':'';
   const body=reserved.row.channel==='Email'?reserved.row.summary+'\n\nReference: '+reserved.row.reference+'\n\nThis is an operational notice about your own scheduled activity. It is not a fundraising message.':reserved.row.summary;
   try{result=await transport.send({channel:reserved.row.channel,to:reserved.address,from:reserved.row.channel==='Email'?c.fromAddress:c.fromNumber,subject,body,queueId:reserved.row.id,purpose:reserved.row.purpose,classification:'Transactional',idempotencyKey:'queue:'+reserved.row.id});}
   catch(e){failed++;try{tx(()=>{const row=queueRow(reserved.row.id);const terminal=row.attempt_count>=limits.attempts;const retryAt=iso(clock()+limits.retrySeconds*1000);db.prepare('UPDATE messaging_queue SET status=?,next_attempt=?,last_error=?,updated_at=? WHERE id=?').run(terminal?'Failed':'Queued',retryAt,String(e.message).slice(0,500),at(),row.id);audit(req.user,'messaging_handoff_failed','constituents',row.constituent_id,{queueId:row.id,purpose:row.purpose,attemptCount:row.attempt_count,terminal,classification:'Transactional',delivery:notSent});});}catch{}continue;}
   try{tx(()=>{
    const row=queueRow(reserved.row.id);if(row.status!=='Queued')fail(503,'Operational reminder changed during handoff');
    db.prepare('INSERT INTO messaging_queue_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,executionId,row.purpose,row.channel,'TEST_ONLY',String(result.providerMessageId),'Transactional',at(),handoff);
    db.prepare("UPDATE messaging_queue SET status='Sent',sent_constituent_version=?,last_error=NULL,updated_at=? WHERE id=?").run(reserved.person.version,at(),row.id);
    audit(req.user,'send_transactional_message','constituents',row.constituent_id,{queueId:row.id,purpose:row.purpose,channel:row.channel,classification:'Transactional',marketing:false,transportMode:'TEST_ONLY',providerTransmitted:false,queuedConstituentVersion:row.constituent_version,sentConstituentVersion:reserved.person.version,delivery:handoff});
   });sent++;}
   catch(e){unknown++;try{tx(()=>{const row=queueRow(reserved.row.id);if(row.status!=='Queued')return;db.prepare("UPDATE messaging_queue SET status='Unknown',last_error=?,updated_at=? WHERE id=?").run(String(e.message).slice(0,500),at(),row.id);});}catch{}}
  }
  return tx(()=>{current(req,'admin');return {sent,refused,failed,unknown,pending:db.prepare("SELECT COUNT(*) n FROM messaging_queue WHERE tenant_id=? AND status='Queued'").get(scope).n,rateLimited:Boolean(pin.rateLimited),executionId,classification:'Transactional',delivery:handoff,scope:scopeStatement};});
 }

 // Signed provider callback intake. The same verification serves the raw
 // public webhook; nothing here grants consent or clears a retained suppression.
 function receiveEvent(raw,header){
  ready();
  if(!isTenantActive())fail(503,'Workspace unavailable; the provider must retry');
  if(!Buffer.isBuffer(raw)||!raw.length||raw.length>limits.webhookBytes)fail(400,'A bounded raw callback body is required');
  if(typeof header!=='string'||header.length>256||!/^t=[0-9]{1,12},v1=[a-f0-9]{64}$/.test(header))fail(400,'Invalid messaging callback signature header');
  const [t,v]=header.split(','),timestamp=Number(t.slice(2));
  if(!Number.isSafeInteger(timestamp)||Math.abs(clock()/1000-timestamp)>300)fail(400,'Stale messaging callback signature');
  const wanted=createHmac('sha256',c.webhookSecret).update(String(timestamp)+'.').update(raw).digest(),actual=Buffer.from(v.slice(3),'hex');
  if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))fail(400,'Invalid messaging callback signature');
  let parsed;try{parsed=JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid messaging callback payload');}
  const p=z.object({tenantId:z.string().min(1).max(100),type:z.enum(EVENT_TYPES),channel:z.enum(CHANNELS),address:z.string().min(3).max(320),providerMessageId:z.string().min(1).max(200).optional(),firedAt:z.iso.datetime().optional()}).strict().parse(parsed);
  if(p.tenantId!==scope)fail(404,'Callback workspace does not match this workspace');
  const address=p.channel==='Email'?normalizeEmail(p.address):normalizeNumber(p.address);
  if(!address)fail(400,'Callback address is not a valid '+p.channel+' address');
  const rawDigest=createHash('sha256').update(raw).digest('hex');
  return tx(()=>{
   if(!isTenantActive())fail(503,'Workspace unavailable; the provider must retry');
   const replay=db.prepare('SELECT * FROM messaging_events WHERE tenant_id=? AND raw_digest=?').get(scope,rawDigest);
   if(replay)return {received:true,replayed:true,eventId:replay.id,suppressionReason:replay.suppression_reason,scope:scopeStatement};
   if(db.prepare('SELECT COUNT(*) n FROM messaging_events WHERE tenant_id=?').get(scope).n>=limits.events)fail(503,'Retained callback capacity reached; reconciliation is required');
   const deliveryRow=p.providerMessageId?db.prepare('SELECT * FROM messaging_deliveries WHERE tenant_id=? AND provider_message_id=?').get(scope,p.providerMessageId):null;
   const why={Bounced:'Bounced',Complaint:'Complaint',Unsubscribed:'Unsubscribed','Opted out':'Opted out'}[p.type]||null;
   const event={id:randomUUID(),tenant_id:scope,raw_digest:rawDigest,type:p.type,channel:p.channel,address,delivery_id:deliveryRow?.id||null,campaign_id:deliveryRow?.campaign_id||null,provider_message_id:p.providerMessageId||null,signature_timestamp:timestamp,source_fired_at:p.firedAt||null,received_at:at(),suppression_reason:why};
   db.prepare('INSERT INTO messaging_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(event));
   const suppression=retainSuppression(p.channel,address,why,'Provider callback',event.id);
   // A provider observation only withdraws. 'Subscribed' and 'Delivered' change
   // nothing: the consent table CHECK refuses any granting provider row.
   if(why){const withdrawn=p.type==='Complaint'?PURPOSES:['Marketing'];for(const purpose of withdrawn){const existing=db.prepare('SELECT * FROM messaging_consent_events WHERE tenant_id=? AND channel=? AND address=? AND purpose=? ORDER BY rowid DESC LIMIT 1').get(scope,p.channel,address,purpose);if(existing&&existing.state==='Granted')retainConsent({constituentId:existing.constituent_id,constituentVersion:existing.constituent_version,channel:p.channel,address,purpose,state:'Withdrawn',basis:'Provider callback: '+p.type},'Provider observation','system');}}
   audit(null,'observe_messaging_event',null,event.id,{type:p.type,channel:p.channel,campaignId:event.campaign_id,suppressionReason:why,consentGranted:false,humanReadershipClaimed:false});
   if(hash(db.prepare('SELECT * FROM messaging_events WHERE id=?').get(event.id))!==hash(event))fail(409,'Saved callback event failed reconciliation');
   if(suppression&&hash(db.prepare('SELECT * FROM messaging_suppressions WHERE id=?').get(suppression.id))!==hash(suppression))fail(409,'Saved suppression failed reconciliation');
   return {received:true,replayed:false,eventId:event.id,suppressionReason:why,scope:scopeStatement};
  });
 }

 function report(req){
  current(req,'admin');
  return tx(()=>{
   const campaigns=db.prepare('SELECT * FROM messaging_campaigns WHERE tenant_id=? ORDER BY created_at,id LIMIT ?').all(scope,limits.campaigns).map(row=>{
    const rows=recipientsOf(row.id),attributions=attributionsOf(row.id),live=attributions.filter(a=>a.sourceCurrent);
    return {id:row.id,name:row.name,classification:row.classification,channel:row.channel,status:row.status,revision:row.version,recipientCount:rows.length,handedToTransport:rows.filter(r=>r.status==='Sent').length,failedCount:rows.filter(r=>['Failed','Refused'].includes(r.status)).length,unconfirmedCount:rows.filter(r=>r.status==='Unknown').length,
     eventCounts:Object.fromEntries(EVENT_TYPES.map(type=>[type,db.prepare('SELECT COUNT(*) n FROM messaging_events WHERE tenant_id=? AND campaign_id=? AND type=?').get(scope,row.id,type).n])),
     attributedGiftCount:live.length,attributedCents:live.reduce((total,a)=>total+a.attributedCents,0),staleAttributionCount:attributions.length-live.length,campaignRecordId:row.campaign_record_id,mode:'TEST_ONLY'};
   });
   const queueCount=state=>db.prepare('SELECT COUNT(*) n FROM messaging_queue WHERE tenant_id=? AND status=?').get(scope,state).n;
   const transactionalQueue={queued:queueCount('Queued'),handedToTransport:queueCount('Sent'),refused:queueCount('Refused'),failed:queueCount('Failed'),unconfirmed:queueCount('Unknown'),
    byPurpose:Object.fromEntries(QUEUE_PURPOSES.map(purpose=>[purpose,db.prepare('SELECT COUNT(*) n FROM messaging_queue WHERE tenant_id=? AND purpose=?').get(scope,purpose).n])),
    classification:'Transactional',mode:c?'TEST_ONLY':'Disabled',
    statement:'Operational reminders requested by other services. They never require marketing consent, a marketing unsubscribe never blocks one, they are never included in any campaign or marketing count, and a queued row is never a delivery.'};
   return {campaigns,transactionalQueue,consentEventCount:db.prepare('SELECT COUNT(*) n FROM messaging_consent_events WHERE tenant_id=?').get(scope).n,suppressionCount:db.prepare('SELECT COUNT(*) n FROM messaging_suppressions WHERE tenant_id=?').get(scope).n,
    suppressionReasons:Object.fromEntries(Object.keys(SUPPRESSION_SCOPE).map(key=>[key,db.prepare('SELECT COUNT(*) n FROM messaging_suppressions WHERE tenant_id=? AND reason=?').get(scope,key).n])),
    revenueStatement:'Attributed values are a subset of already-posted gift revenue. Messaging never creates, re-posts or duplicates income.',deliveryStatement:handoff,mode:c?'TEST_ONLY':'Disabled',scope:scopeStatement};
  });
 }

 const status=()=>({enabled:Boolean(c),mode:c?'TEST_ONLY':'Disabled',channels:c?c.channels:[],fromAddress:c?c.fromAddress:null,authorizationReference:c?c.authorization.reference:null,productionReady:false,rateLimitPerMinute:c?.rateLimitPerMinute??null,maxRecipients:c?.maxRecipients??null,queuePurposes:QUEUE_PURPOSES,queueingEnabled:true,limits,scope:scopeStatement,delivery:notSent});

 const route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
 app.use('/api/messaging',(req,res,next)=>{try{current(req);next();}catch(e){next(e);}});
 app.get('/api/messaging/status',route((req,res)=>{z.object({}).strict().parse(req.query);res.json(status());}));
 app.get('/api/messaging/consent',route((req,res)=>{const q=z.object({constituentId:nativeKey}).strict().parse(req.query);res.json(tx(()=>({constituentId:q.constituentId,events:db.prepare('SELECT * FROM messaging_consent_events WHERE tenant_id=? AND constituent_id=? ORDER BY rowid DESC LIMIT ?').all(scope,q.constituentId,limits.history).map(r=>({id:r.id,channel:r.channel,address:r.address,purpose:r.purpose,state:r.state,sourceKind:r.source_kind,basis:r.basis,actor:r.actor,at:r.at})),statement:'Contact preference is not marketing consent. Only an explicitly recorded grant permits a message of that purpose.',limit:limits.history})));}));
 app.post('/api/messaging/consent',csrf,route((req,res)=>{
  const p=z.object({constituentId:nativeKey,constituentVersion:version,channel:z.enum(CHANNELS),purpose:z.enum(PURPOSES),state:z.enum(['Granted','Withdrawn']),basis:z.string().trim().min(1).max(500),confirmed:z.literal(true)}).strict().parse(req.body);
  res.status(201).json(tx(()=>{
   current(req);const person=profile(p.constituentId);
   if(person.version!==p.constituentVersion)fail(409,'Constituent changed. Reload its current version');
   if(person.mergedInto)fail(409,'Merged identities cannot record consent; use the surviving constituent');
   const address=addressOf(person,p.channel);if(!address)fail(400,'This constituent has no valid '+p.channel+' address');
   if(p.state==='Granted'&&person.preference==='Do not contact')fail(409,'Do not contact is recorded on this constituent; consent cannot be granted');
   const event=retainConsent({constituentId:person.id,constituentVersion:person.version,channel:p.channel,address,purpose:p.purpose,state:p.state,basis:p.basis},'Staff recorded',req.user.id);
   audit(req.user,'record_messaging_consent','constituents',person.id,{channel:p.channel,purpose:p.purpose,state:p.state,eventId:event.id,delivery:notSent});
   current(req);
   return {consent:{id:event.id,constituentId:person.id,channel:p.channel,purpose:p.purpose,state:p.state,at:event.at},statement:'Recorded consent is evidence only; a retained suppression still refuses a send.'};
  }));
 }));
 app.get('/api/messaging/suppressions',route((req,res)=>{z.object({}).strict().parse(req.query);res.json(tx(()=>({suppressions:db.prepare('SELECT * FROM messaging_suppressions WHERE tenant_id=? ORDER BY at DESC,id DESC LIMIT ?').all(scope,limits.page).map(r=>({id:r.id,channel:r.channel,addressMasked:mask(r.address),reason:r.reason,scope:r.scope,sourceKind:r.source_kind,at:r.at})),limit:limits.page,statement:'Suppression is sticky. It is never cleared by a provider-observed subscription, a new consent record or any route in this application.'})));}));
 app.post('/api/messaging/suppressions',csrf,route((req,res)=>{
  const p=z.object({constituentId:nativeKey,channel:z.enum(CHANNELS),reason:z.literal('Manual'),basis:z.string().trim().min(1).max(500),confirmed:z.literal(true)}).strict().parse(req.body);
  res.status(201).json(tx(()=>{
   current(req);const person=profile(p.constituentId),address=addressOf(person,p.channel);
   if(!address)fail(400,'This constituent has no valid '+p.channel+' address');
   const row=retainSuppression(p.channel,address,'Manual','Staff recorded',person.id);
   audit(req.user,'record_messaging_suppression','constituents',person.id,{channel:p.channel,reason:'Manual',scope:row.scope,basis:p.basis,delivery:notSent});
   current(req);return {suppression:{id:row.id,channel:row.channel,reason:row.reason,scope:row.scope,at:row.at},statement:'Retained suppression is permanent in this application; no route clears it.'};
  }));
 }));
 app.get('/api/messaging/campaigns',route((req,res)=>{z.object({}).strict().parse(req.query);res.json(tx(()=>({campaigns:db.prepare('SELECT * FROM messaging_campaigns WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(scope,limits.page).map(row=>view(row)),limit:limits.page,limits,delivery:notSent,scope:scopeStatement})));}));
 app.get('/api/messaging/campaigns/:id',route((req,res)=>{id.parse(req.params.id);z.object({}).strict().parse(req.query);res.json(tx(()=>{const row=find(req.params.id);return {campaign:view(row,{detail:true}),outcomes:outcomesOf(row.id),outcomeCount:db.prepare('SELECT COUNT(*) n FROM messaging_outcomes WHERE campaign_id=?').get(row.id).n,outcomeLimit:limits.history,deliveries:deliveriesOf(row.id),attributions:attributionsOf(row.id),scope:scopeStatement};}));}));
 app.post('/api/messaging/campaigns',csrf,route((req,res)=>res.status(201).json({campaign:createCampaign(req,req.body),delivery:notSent,scope:scopeStatement})));
 app.post('/api/messaging/campaigns/:id/review',csrf,route((req,res)=>res.json({campaign:reviewCampaign(req,req.params.id,req.body),delivery:notSent,scope:scopeStatement})));
 app.post('/api/messaging/campaigns/:id/execute',csrf,route(async(req,res)=>res.json(await executeCampaign(req,req.params.id,req.body))));
 app.post('/api/messaging/campaigns/:id/cancel',csrf,route((req,res)=>res.json({campaign:cancelCampaign(req,req.params.id,req.body),delivery:notSent})));
 app.post('/api/messaging/campaigns/:id/attributions',csrf,route((req,res)=>res.status(201).json({attribution:attributeGift(req,req.params.id,req.body),revenueCreated:false})));
 app.post('/api/messaging/events/intake',csrf,route((req,res)=>{
  const p=z.object({signature:z.string().min(1).max(256),payload:z.string().min(1).max(limits.webhookBytes)}).strict().parse(req.body);
  current(req,'admin');res.status(201).json(receiveEvent(Buffer.from(p.payload,'utf8'),p.signature));
 }));
 app.get('/api/messaging/queue',route((req,res)=>{z.object({}).strict().parse(req.query);res.json(tx(()=>({queue:db.prepare('SELECT * FROM messaging_queue WHERE tenant_id=? ORDER BY queued_at DESC,id DESC LIMIT ?').all(scope,limits.page).map(queueView),limit:limits.page,classification:'Transactional',
  statement:'Operational reminders requested by other services. A queued row is a durable internal request, never a sent or delivered message, and it never requires or consumes marketing consent.',delivery:notSent})));}));
 app.post('/api/messaging/queue/execute',csrf,route(async(req,res)=>res.json(await executeQueue(req,req.body))));
 app.get('/api/messaging/report',route((req,res)=>{z.object({}).strict().parse(req.query);res.json(report(req));}));

 const hasHistory=key=>Boolean(db.prepare('SELECT 1 FROM messaging_consent_events WHERE tenant_id=? AND constituent_id=? LIMIT 1').get(scope,key)||db.prepare('SELECT 1 FROM messaging_recipients WHERE tenant_id=? AND constituent_id=? LIMIT 1').get(scope,key)||db.prepare('SELECT 1 FROM messaging_queue WHERE tenant_id=? AND constituent_id=? LIMIT 1').get(scope,key));
 return {
  status,receiveEvent,report,queueTransactional,queuePurposes:QUEUE_PURPOSES,runTransactionalQueue:executeQueue,
  hasConstituentReferences:hasHistory,
  validateMutation:(collection,previous,next)=>{if(collection==='constituents'&&hasHistory(previous.id)&&(!next||next.mergedInto))fail(409,'Retained messaging consent or reviewed recipient history protects this identity. Record a withdrawal or suppression instead of merging or deleting it');},
  validateDeletion:(collection,record)=>{if(collection==='constituents'&&hasHistory(record.id))fail(409,'Retained messaging consent or reviewed recipient history protects this constituent from deletion. Record a consent withdrawal instead');}
 };
}
export function installPublic(){return null;}
