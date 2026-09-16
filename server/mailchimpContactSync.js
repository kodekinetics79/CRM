import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeMailchimpMember } from './mailchimp.js';
import { mfaAccountBinding } from './mfa.js';

// Existing-member PATCH only. Never PUT/create, subscribe, send, or change email.
// https://mailchimp.com/developer/marketing/api/list-members/update-list-member/
// https://mailchimp.com/developer/marketing/docs/merge-fields/
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const version = z.number().int().positive(), id = z.uuid(), reason = z.string().trim().min(1).max(500);
const prepareSchema = z.object({ requestId: id, constituentId: z.string().min(1).max(100), constituentVersion: version, bindingId: id, bindingVersion: version, reason, confirmed: z.literal(true) }).strict();
const actionSchema = z.object({ version, reason, confirmed: z.literal(true) }).strict();
const closeSchema = actionSchema.extend({ runnerStoppedConfirmed:z.literal(true) });
const scope = 'Explicit approved existing-member contact fields or unsubscribe only. No new member, resubscription, consent certification, campaign sending, native preference/receipt/financial changes or automatic retry of an ambiguous PATCH.';
const limits = Object.freeze({ intents: 20000, page: 100, history: 100, responseBytes: 2097152, textBytes: 255 });
const policySchema = z.object({ approved: z.literal(true), reference: z.string().trim().min(1).max(250), version,
  purpose: z.literal('Existing contact synchronization'), existingMemberUpdates: z.literal(true),
  mergeFields: z.array(z.object({ tag: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/).refine(k => !['EMAIL','STATUS'].includes(k)), field: z.enum(['name','phone','type']), type: z.literal('text') }).strict()).min(1).max(3)
}).strict().refine(p => new Set(p.mergeFields.map(f=>f.tag)).size === p.mergeFields.length && new Set(p.mergeFields.map(f=>f.field)).size === p.mergeFields.length, 'Use distinct approved fields and tags');
export function validateMailchimpContactSyncConfig(config, { production = false } = {}) {
  if (!config) return null;
  if (production) throw Error('Contact sync production integration is unavailable until approved live binding, inbound policy and residency are integrated');
  const p = z.object({ mode: z.enum(['TEST_ONLY','OWNER_APPROVED']), access: z.literal('EXISTING_MEMBER_UPDATE'), serverPrefix: z.string().regex(/^us[1-9][0-9]{0,3}$/), listId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), apiKey: z.string(), ownerPolicy: policySchema, adapter: z.any().optional() }).strict().parse(config);
  if (!new RegExp('^[a-f0-9]{32}-'+p.serverPrefix+'$').test(p.apiKey) || (p.mode === 'TEST_ONLY' && !p.adapter)) throw Error('Contact sync requires explicit server-only credentials and an injected TEST_ONLY adapter');
  if (p.adapter && (typeof p.adapter.getMember !== 'function' || typeof p.adapter.updateMember !== 'function')) throw Error('Invalid existing-member contact adapter');
  return p;
}
export function createMailchimpContactAdapter(config, { fetchImpl = globalThis.fetch } = {}) {
  const c = validateMailchimpContactSyncConfig(config);
  if (!c || c.mode !== 'OWNER_APPROVED') throw Error('Real contact adapter requires recorded OWNER_APPROVED policy');
  async function request(memberId, method, payload) {
    if (!/^[a-f0-9]{32}$/.test(memberId)) fail(400,'Invalid canonical member identity');
    if (method === 'PATCH') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400,'Unsupported contact mutation');
      const keys = Object.keys(payload);
      if (keys.length !== 1 || payload.merge_fields !== undefined && (!payload.merge_fields || typeof payload.merge_fields !== 'object' || Array.isArray(payload.merge_fields) || !Object.keys(payload.merge_fields).length)) fail(400,'Choose exactly one supported contact mutation');
      if (keys.some(k=>!['merge_fields','status'].includes(k)) || payload.status !== undefined && payload.status !== 'unsubscribed') fail(400,'Unsupported contact mutation');
      if (payload.merge_fields && Object.entries(payload.merge_fields).some(([tag,value])=>!c.ownerPolicy.mergeFields.some(f=>f.tag===tag) || typeof value !== 'string' || Buffer.byteLength(value)>255)) fail(400,'Unsupported approved merge field');
    }
    let response;
    try { response = await fetchImpl('https://'+c.serverPrefix+'.api.mailchimp.com/3.0/lists/'+c.listId+'/members/'+memberId, { method,
      headers: { Authorization: 'Basic '+Buffer.from('wimblo:'+c.apiKey).toString('base64'), Accept:'application/json', ...(payload?{'Content-Type':'application/json'}:{}) },
      ...(payload?{body:JSON.stringify(payload)}:{}), redirect:'error', signal:AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); fail(502,'Provider contact request was rejected'); }
      let size=0;const chunks=[];
      for await (const chunk of response.body) { size+=chunk.length;if(size>limits.responseBytes)fail(502,'Provider contact response exceeded the supported bound');chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { fail(502,'Provider contact request did not produce verified bounded evidence'); }
  }
  return { getMember: memberId=>request(memberId,'GET'), updateMember:(memberId,payload)=>request(memberId,'PATCH',payload) };
}
export function createMailchimpContactSyncService({ db, get, audit, transaction, tenantId, config = null, production = false, marketingResponses, clock = Date.now, isTenantActive = ()=>true, recheckAccess = ()=>false }) {
  const c = validateMailchimpContactSyncConfig(config,{production});
  if(c && (!id.safeParse(tenantId).success || typeof marketingResponses?.detail !== 'function')) throw Error('Contact sync requires explicit workspace and verified existing member bindings');
  const adapter = c ? c.adapter || createMailchimpContactAdapter(c) : null;
  const policy = c ? hash({ mode:c.mode,server:c.serverPrefix,list:c.listId,keyHash:hash(c.apiKey),ownerPolicy:c.ownerPolicy }) : 'disabled';
  db.exec(`CREATE TABLE IF NOT EXISTS mailchimp_contact_sync_intents(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,request_json TEXT NOT NULL,request_digest TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('Ready','Executing','Unknown','Reconciled','ReviewRequired')),constituent_id TEXT NOT NULL,binding_id TEXT NOT NULL,binding_version INTEGER NOT NULL,binding_digest TEXT NOT NULL,source_json TEXT NOT NULL,source_digest TEXT NOT NULL,member_id TEXT NOT NULL,list_id TEXT NOT NULL,policy_digest TEXT NOT NULL,recovery_marker TEXT NOT NULL,actor_id TEXT NOT NULL,actor_binding TEXT NOT NULL,actor_factor TEXT NOT NULL,operation TEXT NOT NULL,payload_json TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT,write_attempted INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error_code TEXT,UNIQUE(tenant_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS mailchimp_contact_sync_active_member ON mailchimp_contact_sync_intents(tenant_id,list_id,member_id) WHERE status IN ('Ready','Executing','Unknown');
    CREATE TABLE IF NOT EXISTS mailchimp_contact_sync_history(id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES mailchimp_contact_sync_intents(id),intent_version INTEGER NOT NULL,status TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(intent_id,intent_version));
    CREATE TABLE IF NOT EXISTS mailchimp_contact_sync_suppressions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,list_id TEXT NOT NULL,member_id TEXT NOT NULL,reason TEXT NOT NULL,intent_id TEXT NOT NULL REFERENCES mailchimp_contact_sync_intents(id),at TEXT NOT NULL,UNIQUE(tenant_id,list_id,member_id,reason));
    CREATE TABLE IF NOT EXISTS mailchimp_contact_sync_dispositions(id TEXT PRIMARY KEY,intent_id TEXT NOT NULL UNIQUE REFERENCES mailchimp_contact_sync_intents(id),intent_version INTEGER NOT NULL,intent_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status='ClosedWithoutWrite'),reason TEXT NOT NULL,actor_id TEXT NOT NULL,actor_binding TEXT NOT NULL,runner_stopped_confirmed INTEGER NOT NULL CHECK(runner_stopped_confirmed=1),at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_attempt_retained BEFORE UPDATE OF write_attempted ON mailchimp_contact_sync_intents WHEN OLD.write_attempted=1 AND NEW.write_attempted IS NOT 1 BEGIN SELECT RAISE(ABORT,'Attempted provider mutation cannot be cleared'); END;
    CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_closed_immutable BEFORE UPDATE ON mailchimp_contact_sync_intents WHEN EXISTS(SELECT 1 FROM mailchimp_contact_sync_dispositions WHERE intent_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Closed contact review custody is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_intent_no_delete BEFORE DELETE ON mailchimp_contact_sync_intents BEGIN SELECT RAISE(ABORT,'Contact synchronization custody is retained'); END;
    CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_original_immutable BEFORE UPDATE ON mailchimp_contact_sync_intents WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.request_id IS NOT OLD.request_id OR NEW.request_json IS NOT OLD.request_json OR NEW.request_digest IS NOT OLD.request_digest OR NEW.constituent_id IS NOT OLD.constituent_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_version IS NOT OLD.binding_version OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.source_json IS NOT OLD.source_json OR NEW.source_digest IS NOT OLD.source_digest OR NEW.member_id IS NOT OLD.member_id OR NEW.list_id IS NOT OLD.list_id OR NEW.policy_digest IS NOT OLD.policy_digest OR NEW.recovery_marker IS NOT OLD.recovery_marker OR NEW.actor_id IS NOT OLD.actor_id OR NEW.actor_binding IS NOT OLD.actor_binding OR NEW.actor_factor IS NOT OLD.actor_factor OR NEW.operation IS NOT OLD.operation OR NEW.payload_json IS NOT OLD.payload_json OR NEW.before_json IS NOT OLD.before_json OR NEW.created_at IS NOT OLD.created_at OR (OLD.status='Reconciled' AND NEW.status!=OLD.status) BEGIN SELECT RAISE(ABORT,'Original contact review authority is immutable'); END;
    ${['history','suppressions','dispositions'].map(table=>`CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_${table}_no_update BEFORE UPDATE ON mailchimp_contact_sync_${table} BEGIN SELECT RAISE(ABORT,'Contact evidence is immutable'); END;CREATE TRIGGER IF NOT EXISTS mailchimp_contact_sync_${table}_no_delete BEFORE DELETE ON mailchimp_contact_sync_${table} BEGIN SELECT RAISE(ABORT,'Contact evidence is retained'); END;`).join('')}`);
  const tx = fn=>db.isTransaction?fn():transaction(fn), at = ()=>new Date(clock()).toISOString();
  const marker = ()=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='automation_recovery_markers'").get() ? db.prepare('SELECT id FROM automation_recovery_markers ORDER BY rowid DESC LIMIT 1').get()?.id || 'none' : 'none';
  const factor = actor=>{const row=db.prepare('SELECT enabled,encrypted_secret FROM mfa_settings WHERE user_id=?').get(actor);return hash(row||null);};
  function current(req) { if(req?.user?.role!=='admin')fail(403,'Administrator required');if(!isTenantActive())fail(503,'Workspace unavailable');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again'); }
  const ready = ()=>{if(!c)fail(503,'Outbound contact synchronization is disabled');};
  function find(key) { const r=db.prepare('SELECT * FROM mailchimp_contact_sync_intents WHERE id=? AND tenant_id=?').get(key,tenantId);if(!r)fail(404,'Contact sync intent not found');if(hash(JSON.parse(r.request_json))!==r.request_digest || hash(JSON.parse(r.source_json))!==r.source_digest)fail(503,'Original contact review custody is unavailable');return r; }
  function disposition(r) {
    const d=db.prepare('SELECT * FROM mailchimp_contact_sync_dispositions WHERE intent_id=?').get(r.id);if(!d)return null;
    if(d.status!=='ClosedWithoutWrite'||d.intent_version!==r.version||d.intent_hash!==hash(r)||r.status!=='ReviewRequired'||r.write_attempted!==0||d.runner_stopped_confirmed!==1)fail(503,'Retained no-write disposition custody is unavailable');return d;
  }
  const dispositionView=d=>d?{id:d.id,status:d.status,version:d.intent_version,reason:d.reason,actorId:d.actor_id,runnerStoppedConfirmed:true,at:d.at}:null;
  function assertNoPending(memberId) {
    const rows=db.prepare("SELECT * FROM mailchimp_contact_sync_intents WHERE tenant_id=? AND list_id=? AND member_id=? AND status IN ('Ready','Executing','Unknown','ReviewRequired')").all(tenantId,c.listId,memberId);
    for(const r of rows){const closed=disposition(r);if(r.status!=='ReviewRequired'||r.write_attempted!==0||!closed)fail(409,'An active or uncertain contact intent already exists; reconcile attempted updates or explicitly close a stopped no-write review');}
  }
  function identity(p) {
    const binding=marketingResponses.detail({role:'admin'},p.bindingId).binding;
    const native=get('constituents',p.constituentId);
    if(binding.status!=='Current'||!binding.sourceCurrent||binding.version!==p.bindingVersion||binding.constituentId!==p.constituentId||binding.constituentVersion!==p.constituentVersion||binding.listId!==c.listId||native.version!==p.constituentVersion||native.mergedInto||!z.email().safeParse(native.email).success)fail(409,'Choose a current verified primary-email member binding and native source');
    const memberId=createHash('md5').update(native.email.toLowerCase()).digest('hex');if(memberId!==binding.memberId)fail(409,'Canonical provider identity changed');
    return { native,binding,memberId };
  }
  function authority(req,r) {
    current(req);const actor=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if(actor?.id!==r.actor_id||mfaAccountBinding(actor)!==r.actor_binding||factor(actor.id)!==r.actor_factor||policy!==r.policy_digest||marker()!==r.recovery_marker)fail(409,'Original reviewed actor, policy or recovery authority changed');
    const p=JSON.parse(r.request_json),facts=identity(p);if(hash(facts.native)!==r.source_digest||bindingHash(facts.binding)!==r.binding_digest)fail(409,'Original contact source or verified binding changed');return facts;
  }
  const bindingHash = binding=>{const {marketingEligible,eligibilityReason,suppressed,suppressionReasons,...authorityFields}=binding;return hash(authorityFields);};
  const tableExists = name=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  function suppressed(memberId) {
    const own=db.prepare('SELECT reason FROM mailchimp_contact_sync_suppressions WHERE tenant_id=? AND list_id=? AND member_id=?').all(tenantId,c.listId,memberId);
    const inbound=tableExists('marketing_suppressions')?db.prepare('SELECT reason FROM marketing_suppressions WHERE tenant_id=? AND list_id=? AND member_id=?').all(tenantId,c.listId,memberId):[];
    return [...new Set([...own,...inbound].map(r=>r.reason))].sort();
  }
  function normalize(raw,r) {
    const native=JSON.parse(r.source_json),base=normalizeMailchimpMember(raw,r.list_id,r.member_id,native.email.toLowerCase());
    const merge={};for(const f of c.ownerPolicy.mergeFields){const value=raw.merge_fields?.[f.tag];if(typeof value!=='string'||Buffer.byteLength(value)>255)fail(502,'Approved text merge-field metadata was not verified');merge[f.tag]=value;}
    return {...base,mergeFields:merge};
  }
  function proposal(native,member,memberId) {
    const denied=native.preference==='Do not contact'||suppressed(memberId).length>0;
    if(member.providerStatus!=='subscribed')return {operation:'NoChange',payload:{}};
    if(denied)return {operation:'Unsubscribe',payload:{status:'unsubscribed'}};
    const merge_fields={};for(const f of c.ownerPolicy.mergeFields){const value=native[f.field];if(typeof value!=='string'||Buffer.byteLength(value)>255)fail(409,'Approved native text exceeds the provider byte bound; prepare an approved source mapping without truncation');merge_fields[f.tag]=value;}
    return {operation:'UpdateFields',payload:{merge_fields}};
  }
  function history(row,action,why,user) {const h={id:randomUUID(),intent_id:row.id,intent_version:row.version,status:row.status,action,reason:why,actor_id:user?.id||'system',at:at()};db.prepare('INSERT INTO mailchimp_contact_sync_history VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(h));return h;}
  function exact(row,h) {const saved=find(row.id);if(hash(saved)!==hash(row)||hash(db.prepare('SELECT * FROM mailchimp_contact_sync_history WHERE id=?').get(h.id))!==hash(h))fail(409,'Saved contact synchronization failed full reconciliation');}
  function change(row,status,action,why,user,fields={}) {
    const n={...row,...fields,version:row.version+1,status,updated_at:at()};db.prepare('UPDATE mailchimp_contact_sync_intents SET version=?,status=?,after_json=?,write_attempted=?,updated_at=?,last_error_code=? WHERE id=?').run(n.version,n.status,n.after_json,n.write_attempted,n.updated_at,n.last_error_code,n.id);
    const h=history(n,action,why,user);audit(user,'mailchimp_contact_sync_'+action,'constituents',n.constituent_id,{intentId:n.id,version:n.version,status:n.status,operation:n.operation});exact(n,h);return n;
  }
  function retainSuppression(r,member) {
    const why={unsubscribed:'Unsubscribed',cleaned:'Cleaned'}[member.providerStatus];if(!why)return;
    const old=db.prepare('SELECT id FROM mailchimp_contact_sync_suppressions WHERE tenant_id=? AND list_id=? AND member_id=? AND reason=?').get(tenantId,r.list_id,r.member_id,why);if(old)return;
    const row={id:randomUUID(),tenant_id:tenantId,list_id:r.list_id,member_id:r.member_id,reason:why,intent_id:r.id,at:at()};db.prepare('INSERT INTO mailchimp_contact_sync_suppressions VALUES(?,?,?,?,?,?,?)').run(...Object.values(row));if(hash(db.prepare('SELECT * FROM mailchimp_contact_sync_suppressions WHERE id=?').get(row.id))!==hash(row))fail(409,'Saved contact suppression failed reconciliation');
  }
  function view(r,req) {
    let sourceCurrent=false;try{authority(req,r);sourceCurrent=true;}catch{}
    const closed=disposition(r);
    return {id:r.id,requestId:r.request_id,version:r.version,status:closed?'ClosedWithoutWrite':r.status,disposition:dispositionView(closed),constituentId:r.constituent_id,bindingId:r.binding_id,bindingVersion:r.binding_version,listId:r.list_id,memberId:r.member_id,operation:r.operation,
      changes:sourceCurrent&&!closed?JSON.parse(r.payload_json):null,closeAllowed:!closed&&r.write_attempted===0&&['Ready','Unknown','ReviewRequired'].includes(r.status),sourceCurrent,writeAttempted:Boolean(r.write_attempted),providerStatus:r.after_json?JSON.parse(r.after_json).providerStatus:JSON.parse(r.before_json).providerStatus,
      suppressed:!!c&&suppressed(r.member_id).length>0,createdAt:r.created_at,updatedAt:r.updated_at,lastErrorCode:r.last_error_code,mode:c?.mode||'Disabled',scope};
  }
  async function prepare(req,body) {
    ready();const p=prepareSchema.parse(body),pin=tx(()=>{
      current(req);const old=db.prepare('SELECT id FROM mailchimp_contact_sync_intents WHERE tenant_id=? AND request_id=?').get(tenantId,p.requestId);
      if(old){const r=find(old.id);if(r.request_digest!==hash(p))fail(409,'Reviewed request identity changed');authority(req,r);return {replay:r};}
      const facts=identity(p),actor=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if(db.prepare('SELECT count(*) n FROM mailchimp_contact_sync_intents').get().n>=limits.intents)fail(409,'Contact review history capacity reached');
      assertNoPending(facts.memberId);
      return {...facts,actorId:actor.id,actorBinding:mfaAccountBinding(actor),actorFactor:factor(actor.id),marker:marker()};
    });if(pin.replay)return {intent:view(pin.replay,req),replayed:true,scope};
    const skeleton={source_json:JSON.stringify(pin.native),list_id:c.listId,member_id:pin.memberId};let before;
    try{before=normalize(await adapter.getMember(pin.memberId),skeleton);}catch{fail(502,'Existing provider member identity/approved fields could not be verified');}
    return tx(()=>{current(req);const facts=identity(p),actor=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if(hash(facts.native)!==hash(pin.native)||bindingHash(facts.binding)!==bindingHash(pin.binding)||actor.id!==pin.actorId||mfaAccountBinding(actor)!==pin.actorBinding||factor(actor.id)!==pin.actorFactor||marker()!==pin.marker)fail(409,'Source or account changed during contact review');
      const raced=db.prepare('SELECT id FROM mailchimp_contact_sync_intents WHERE tenant_id=? AND request_id=?').get(tenantId,p.requestId);if(raced){const r=find(raced.id);if(r.request_digest!==hash(p))fail(409,'Reviewed request identity changed');authority(req,r);return {intent:view(r,req),replayed:true,scope};}
      if(db.prepare('SELECT count(*) n FROM mailchimp_contact_sync_intents').get().n>=limits.intents)fail(409,'Contact review history capacity reached');
      assertNoPending(pin.memberId);
      const proposed=proposal(facts.native,before,pin.memberId),timestamp=at(),r={id:randomUUID(),tenant_id:tenantId,request_id:p.requestId,request_json:JSON.stringify(p),request_digest:hash(p),version:1,status:'Ready',constituent_id:p.constituentId,binding_id:p.bindingId,binding_version:p.bindingVersion,binding_digest:bindingHash(facts.binding),source_json:JSON.stringify(facts.native),source_digest:hash(facts.native),member_id:pin.memberId,list_id:c.listId,policy_digest:policy,recovery_marker:pin.marker,actor_id:pin.actorId,actor_binding:pin.actorBinding,actor_factor:pin.actorFactor,operation:proposed.operation,payload_json:JSON.stringify(proposed.payload),before_json:JSON.stringify(before),after_json:null,write_attempted:0,created_at:timestamp,updated_at:timestamp,last_error_code:null};
      db.prepare('INSERT INTO mailchimp_contact_sync_intents VALUES('+Object.keys(r).map(()=>'?').join(',')+')').run(...Object.values(r));retainSuppression(r,before);const h=history(r,'prepare',p.reason,req.user);audit(req.user,'mailchimp_contact_sync_prepare','constituents',r.constituent_id,{intentId:r.id,operation:r.operation});exact(r,h);authority(req,r);return {intent:view(r,req),replayed:false,scope};
    });
  }
  function matches(r,member) {
    if(r.operation==='Unsubscribe')return ['unsubscribed','cleaned'].includes(member.providerStatus);
    if(r.operation==='NoChange')return member.providerStatus===JSON.parse(r.before_json).providerStatus;
    return member.providerStatus==='subscribed' && !suppressed(r.member_id).length && Object.entries(JSON.parse(r.payload_json).merge_fields).every(([tag,value])=>member.mergeFields[tag]===value);
  }
  function markUnknown(key,code) {return tx(()=>{const r=find(key);if(r.status==='Executing')return change(r,'Unknown','unknown','Provider write/readback authority is uncertain; no automatic PATCH retry',null,{last_error_code:code});return r;});}
  async function execute(req,key,body) {
    ready();id.parse(key);const p=actionSchema.parse(body),reserved=tx(()=>{const r=find(key);authority(req,r);if(r.version!==p.version||r.status!=='Ready')fail(409,'Intent changed, completed or uncertain; review or reconcile instead of retrying PATCH');return change(r,'Executing','reserve',p.reason,req.user);});
    try {
      const before=normalize(await adapter.getMember(reserved.member_id),reserved);
      tx(()=>{const r=find(key);authority(req,r);if(r.version!==reserved.version||r.status!=='Executing'||hash(before)!==hash(JSON.parse(r.before_json)))fail(409,'Provider or native reviewed source changed before PATCH');const proposed=proposal(JSON.parse(r.source_json),before,r.member_id);if(hash(proposed.payload)!==hash(JSON.parse(r.payload_json)))fail(409,'Retained suppression changed before PATCH');});
      if(reserved.operation!=='NoChange'){
        tx(()=>{const r=find(key);authority(req,r);if(r.version!==reserved.version||r.status!=='Executing'||r.write_attempted!==0)fail(409,'Write reservation changed');const n={...r,write_attempted:1};db.prepare('UPDATE mailchimp_contact_sync_intents SET write_attempted=1 WHERE id=?').run(key);if(hash(find(key))!==hash(n))fail(409,'Write reservation failed reconciliation');authority(req,n);if(hash(proposal(JSON.parse(n.source_json),before,n.member_id).payload)!==hash(JSON.parse(n.payload_json)))fail(409,'Retained suppression changed at final write reservation');});
        // Once invocation begins, even a timeout/rejected local persistence cannot
        // prove the remote write did not happen. Never invoke PATCH automatically again.
        await adapter.updateMember(reserved.member_id,JSON.parse(reserved.payload_json));
      }
      const after=normalize(await adapter.getMember(reserved.member_id),reserved);
      return tx(()=>{let r=find(key);authority(req,r);if(r.status!=='Executing'||r.version!==reserved.version)fail(409,'Contact intent changed during provider request');retainSuppression(r,after);
        const status=matches(r,after)?'Reconciled':'ReviewRequired';r=change(r,status,status==='Reconciled'?'reconcile':'review',p.reason,req.user,{after_json:JSON.stringify(after),last_error_code:status==='Reconciled'?null:'READBACK_MISMATCH'});authority(req,r);return {intent:view(r,req),scope};});
    } catch(e) {try{markUnknown(key,e.status===409?'SOURCE_CHANGED':'PROVIDER_UNCERTAIN');}catch{}fail(e.status===401?401:e.status===403?403:e.status===503?503:409,'Contact update did not produce verified completion. Reconcile current provider evidence; no PATCH was retried');}
  }
  async function reconcile(req,key,body) {
    ready();id.parse(key);const p=actionSchema.parse(body),pin=tx(()=>{const r=find(key);authority(req,r);if(disposition(r))fail(409,'Closed no-write review cannot be reconciled or rearmed');if(r.version!==p.version||!['Unknown','Executing','ReviewRequired'].includes(r.status))fail(409,'Choose a current uncertain contact intent');return r;});
    let after;try{after=normalize(await adapter.getMember(pin.member_id),pin);}catch{fail(502,'Contact readback identity/fields could not be verified; no provider write was attempted');}
    return tx(()=>{let r=find(key);authority(req,r);if(r.version!==pin.version||r.status!==pin.status)fail(409,'Contact intent changed during reconciliation');retainSuppression(r,after);
      const good=matches(r,after);r=change(r,good?'Reconciled':'ReviewRequired',good?'reconcile':'review',p.reason,req.user,{after_json:JSON.stringify(after),last_error_code:good?null:'READBACK_MISMATCH'});authority(req,r);return {intent:view(r,req),scope};});
  }
  function closeWithoutWrite(req,key,body) {
    id.parse(key);const p=closeSchema.parse(body);return tx(()=>{
      current(req);const r=find(key);if(disposition(r)||r.version!==p.version||r.write_attempted!==0||!['Ready','Unknown','ReviewRequired'].includes(r.status))fail(409,'Only a stopped, current no-write review can close; an attempted or Executing provider operation remains protected');
      const actor=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id),actorBinding=mfaAccountBinding(actor),actorFactor=factor(actor.id);
      const n=change(r,'ReviewRequired','close_without_write',p.reason,req.user,{last_error_code:'CLOSED_WITHOUT_WRITE'});
      // Closure is governance, not renewed authority to synchronize stale PII.
      // Its full-row fingerprint retains the native status without rebuilding CHECKs.
      const d={id:randomUUID(),intent_id:n.id,intent_version:n.version,intent_hash:hash(n),status:'ClosedWithoutWrite',reason:p.reason,actor_id:actor.id,actor_binding:actorBinding,runner_stopped_confirmed:1,at:at()};
      db.prepare('INSERT INTO mailchimp_contact_sync_dispositions VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(d));
      audit(req.user,'mailchimp_contact_sync_disposition','constituents',n.constituent_id,{intentId:n.id,version:n.version,status:d.status,writeAttempted:false,runnerStoppedConfirmed:true});
      current(req);const now=db.prepare('SELECT * FROM users WHERE id=?').get(actor.id);if(mfaAccountBinding(now)!==actorBinding||factor(actor.id)!==actorFactor||hash(find(n.id))!==hash(n)||hash(db.prepare('SELECT * FROM mailchimp_contact_sync_dispositions WHERE id=?').get(d.id))!==hash(d))fail(409,'No-write closure source or administrator changed during persistence');
      disposition(n);return {intent:view(n,req),scope};
    });
  }
  function detail(req,key){current(req);id.parse(key);return tx(()=>{const r=find(key);return {intent:view(r,req),history:db.prepare('SELECT id,intent_version AS version,status,action,reason,actor_id AS actorId,at FROM mailchimp_contact_sync_history WHERE intent_id=? ORDER BY rowid DESC LIMIT 100').all(key),scope};});}
  function list(req,q={}) {
    current(req);const p=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:id.optional(),constituentId:z.string().min(1).max(100).optional()}).strict().parse(q);
    return tx(()=>{const cursor=p.after?find(p.after):null;if(cursor&&p.constituentId&&cursor.constituent_id!==p.constituentId)fail(400,'History cursor is outside the selected constituent');
      const rows=db.prepare('SELECT id FROM mailchimp_contact_sync_intents WHERE tenant_id=?'+(p.constituentId?' AND constituent_id=?':'')+(cursor?' AND (created_at,id)<(?,?)':'')+' ORDER BY created_at DESC,id DESC LIMIT ?').all(tenantId,...(p.constituentId?[p.constituentId]:[]),...(cursor?[cursor.created_at,cursor.id]:[]),p.limit+1),page=rows.slice(0,p.limit);
      return {intents:page.map(x=>{const {changes,...safe}=view(find(x.id),req);return safe;}),nextCursor:rows.length>p.limit?page.at(-1).id:null,limit:p.limit,constituentId:p.constituentId||null,scope};
    });
  }
  return {prepare,execute,reconcile,closeWithoutWrite,detail,list,current,status:()=>({enabled:!!c,mode:c?.mode||'Disabled',access:'EXISTING_MEMBER_UPDATE',productionReady:false,scope,limits}),
    hasProtectedConstituentHistory:key=>Boolean(db.prepare('SELECT 1 FROM mailchimp_contact_sync_intents WHERE constituent_id=? LIMIT 1').get(key))};
}
export function installMailchimpContactSyncRoutes(app,service,{csrf,admin}) {
  const prefix='/api/mailchimp-contact-sync',route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  app.use(prefix,admin,(req,res,next)=>{try{service.current(req);next();}catch(e){next(e);}});
  app.get(prefix+'/status',route((req,res)=>res.json(service.status())));
  app.get(prefix+'/intents',route((req,res)=>res.json(service.list(req,req.query))));
  app.get(prefix+'/intents/:id',route((req,res)=>res.json(service.detail(req,req.params.id))));
  app.post(prefix+'/intents',csrf,route(async(req,res)=>res.status(201).json(await service.prepare(req,req.body))));
  app.post(prefix+'/intents/:id/close-without-write',csrf,route((req,res)=>res.json(service.closeWithoutWrite(req,req.params.id,req.body))));
  for(const action of ['execute','reconcile'])app.post(prefix+'/intents/:id/'+action,csrf,route(async(req,res)=>res.json(await service[action](req,req.params.id,req.body))));
}
