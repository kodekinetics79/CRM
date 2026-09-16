// Security operations, health/readiness and data-lifecycle seam.
//
// Three concerns live here, all installed through the single extension seam:
//
// 1. Structured operational logging. Every request that reaches this Express
//    application is recorded as a fixed-shape, allowlisted record: method,
//    normalized route (identifiers replaced), status class, duration, role and
//    a stable pseudonymous actor digest. Request bodies, query strings, client
//    addresses, message bodies, constituent personal data and monetary values
//    are never logged. The detail bag is allowlisted, not denylisted, so an
//    unknown field is dropped rather than leaked.
// 2. Counters, readiness and alert hooks. Counters are durable so a restart
//    does not silently reset an alerting signal. Readiness distinguishes
//    "process up" from "dependencies usable" and fails closed. Alert hooks are
//    completely inert unless a deployment owner supplies a transport: this
//    module never opens a socket, never resolves a host and never retries.
// 3. Retention classes, legal hold and deletion request states. A legal hold
//    BLOCKS deletion and identity consolidation. Recording a disposition never
//    destroys financial or audit history: it writes a retained tombstone with
//    the record digest so a later restore can suppress a disposed record
//    without erasing the evidence that the disposition happened.
//
// Nothing here is an operated control. Implemented code does not establish
// SOC 2, ISO 27001, PCI, FERPA or LearnPlatform approval, an adopted retention
// schedule, a monitored alerting service or verified data residency.
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';

const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const digest=value=>createHash('sha256').update(value).digest('hex');
const HANDLE=Symbol.for('wimblo.observability.instrumented'),LOGGED=Symbol.for('wimblo.observability.logged');
const LOG_LIMIT=500,ROUTE_LIMIT=140,TEXT_LIMIT=120,DEPENDENCY_TIMEOUT=2000;

// A fixed counter catalogue. An unknown name is refused so an attacker-supplied
// value can never grow the metric key space.
export const OBSERVABILITY_COUNTERS=Object.freeze(['requests_total','requests_ok_total','requests_client_error_total','requests_unauthenticated_total','requests_forbidden_total','requests_conflict_total','requests_rate_limited_total','requests_server_error_total','requests_public_total','requests_webhook_total','readiness_checks_total','readiness_failures_total','retention_class_assigned_total','legal_hold_placed_total','legal_hold_released_total','legal_hold_blocked_deletion_total','legal_hold_blocked_merge_total','deletion_requested_total','deletion_blocked_total','deletion_refused_total','deletion_approved_total','deletion_recorded_total','alerts_dispatched_total','alerts_sink_failed_total','log_fields_dropped_total']);

// Q&A56 sets a ten-year minimum. Addendum 2 section 1(a)(iv) requires US/Canada
// storage. Financial and audit history is never destruction-permitted: the
// invariant is retained history, and a disposition is recorded, not performed.
export const RETENTION_CLASSES=Object.freeze([
 Object.freeze({id:'financial-history',label:'Financial and gift history',minimumYears:10,destructionPermitted:false,basis:'Q&A56 ten-year minimum; retained-financial-history invariant',collections:Object.freeze(['gifts','pledges','campaigns','designations','grants'])}),
 Object.freeze({id:'constituent-record',label:'Constituent and contact record',minimumYears:10,destructionPermitted:true,basis:'Q&A56 ten-year minimum, then district-directed disposition under the executed DPA',collections:Object.freeze(['constituents','communications','volunteers','events','tasks','volunteerShifts'])}),
 Object.freeze({id:'audit-and-security',label:'Audit and security evidence',minimumYears:10,destructionPermitted:false,basis:'C7d accountability; audit is append-only in the database',collections:Object.freeze([])}),
 Object.freeze({id:'operational-evidence',label:'Operational and recovery evidence',minimumYears:10,destructionPermitted:false,basis:'C7e recovery evidence and incident reconstruction',collections:Object.freeze([])})
]);
export const RETENTION_RESIDENCY=Object.freeze({declared:'United States or Canada',source:'Addendum 2 section 1(a)(iv)',supersedes:'Q&A56 "North America or Europe"',enforcedInCode:false,note:'Approved storage regions are constrained for private object storage only. Database, log, backup, telemetry and subprocessor residency remain deployment-owner evidence, not a code guarantee.'});
const CLASS_BY_ID=new Map(RETENTION_CLASSES.map(c=>[c.id,c]));

const NOTICE='Implemented local controls only. No operated monitoring service, adopted retention schedule, executed legal agreement, certification or buyer acceptance is established by this code.';

// ---------------------------------------------------------------------------
// Redaction. These helpers are exported so tests and reviewers can exercise them
// without an HTTP round trip.
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_NUMBER=/\d{3,}/g;
// Control, zero-width and bidirectional-override characters are removed through
// a code-point predicate rather than a source-level escape sequence, so no raw
// control byte can ever enter this file.
const stripControl=value=>String(value).replace(/./gsu,ch=>{const code=ch.codePointAt(0);return code<32||code===127||code>=0x200b&&code<=0x200f||code>=0x202a&&code<=0x202e||code>=0x2066&&code<=0x2069?'':ch;});
// Allowlisted detail keys. Anything else is dropped, counted and never written.
const DETAIL_KEYS=new Set(['outcome','kind','state','check','dependency','collection','classId','holdId','requestId','count','durationMs','status','destructionPermitted','required','blocked','replayed','surface','decision','tombstoneId','assignmentId','minimumYears','activeHolds','rule','threshold','value']);

export function safeText(value){
 if(value===null||value===undefined)return null;
 if(typeof value==='boolean')return value;
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 return stripControl(value).replace(EMAIL,'[redacted-email]').replace(LONG_NUMBER,'[redacted-number]').slice(0,TEXT_LIMIT);
}

export function redactDetail(detail){
 const out={};let dropped=0;
 if(detail&&typeof detail==='object'&&!Array.isArray(detail))for(const [key,value] of Object.entries(detail)){
  if(!DETAIL_KEYS.has(key)||value&&typeof value==='object'){dropped++;continue;}
  const safe=safeText(value);if(safe===null&&value!==null){dropped++;continue;}
  out[key]=safe;
 }else if(detail!==undefined&&detail!==null)dropped++;
 return {detail:out,dropped};
}

// A path segment that identifies a record never reaches the log. Anything that
// looks like an identifier, a long token or a number becomes ':id'.
const IDENTIFIER=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d+)$/i;
export function normalizeRoute(url){
 const path=String(url??'').split('?')[0].split('#')[0];
 const parts=path.split('/').slice(0,12).map(part=>!part?part:IDENTIFIER.test(part)||part.length>24||EMAIL.test(part)?':id':stripControl(part).replace(/[^A-Za-z0-9._-]/g,'').slice(0,40));
 const joined=parts.join('/')||'/';
 return joined.slice(0,ROUTE_LIMIT)||'/';
}

const statusClass=status=>!Number.isInteger(status)?'unknown':status<200?'1xx':status<300?'2xx':status<400?'3xx':status<500?'4xx':'5xx';

// ---------------------------------------------------------------------------
export function install(app,ctx){
 if(!app||!ctx?.db)return null;
 const {db,get,audit,csrf,transaction,collections=[],tenantId=null,production=false,isTenantActive=()=>true,recheckAccess=()=>true,mfaStatus=null,config=null}=ctx;
 const clock=typeof config?.clock==='function'?config.clock:Date.now;
 const at=()=>new Date(clock()).toISOString();
 const scope=typeof tenantId==='string'&&tenantId?tenantId:'workspace';
 const actorSalt='wimblo-observability-actor:'+scope;
 const logSink=typeof config?.logSink==='function'?config.logSink:null;
 const alertSink=typeof config?.alerts?.sink==='function'?config.alerts.sink:null;
 const alertRules=Array.isArray(config?.alerts?.rules)?config.alerts.rules.filter(r=>r&&OBSERVABILITY_COUNTERS.includes(r.counter)&&Number.isSafeInteger(r.threshold)&&r.threshold>0).slice(0,32):[];
 const dependencies=(Array.isArray(config?.dependencies)?config.dependencies:[]).filter(d=>d&&typeof d.name==='string'&&d.name.length<=40&&typeof d.check==='function').slice(0,16);
 const worker=config?.worker!==false;

 db.exec(`CREATE TABLE IF NOT EXISTS observability_counters(tenant_id TEXT NOT NULL,name TEXT NOT NULL,count INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,name));
 CREATE TABLE IF NOT EXISTS observability_heartbeat(tenant_id TEXT PRIMARY KEY,at TEXT NOT NULL,writes INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS retention_assignments(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,collection TEXT NOT NULL,record_id TEXT NOT NULL,class_id TEXT NOT NULL,version INTEGER NOT NULL,assigned_by TEXT NOT NULL,assigned_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(tenant_id,collection,record_id));
 CREATE TABLE IF NOT EXISTS retention_assignment_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,assignment_id TEXT NOT NULL REFERENCES retention_assignments(id),class_id TEXT NOT NULL,assignment_version INTEGER NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS legal_holds(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,collection TEXT NOT NULL,record_id TEXT,matter TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Released')),version INTEGER NOT NULL,placed_by TEXT NOT NULL,placed_at TEXT NOT NULL,released_by TEXT,released_at TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS legal_hold_one_active ON legal_holds(tenant_id,collection,COALESCE(record_id,'*')) WHERE status='Active';
 CREATE INDEX IF NOT EXISTS legal_hold_active_lookup ON legal_holds(tenant_id,status,collection);
 CREATE TABLE IF NOT EXISTS legal_hold_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,hold_id TEXT NOT NULL REFERENCES legal_holds(id),action TEXT NOT NULL,reason TEXT NOT NULL,hold_version INTEGER NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS deletion_requests(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,collection TEXT NOT NULL,record_id TEXT NOT NULL,class_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('Requested','Blocked','Refused','Approved','Recorded')),version INTEGER NOT NULL,requested_by TEXT NOT NULL,requested_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS deletion_request_one_open ON deletion_requests(tenant_id,collection,record_id) WHERE state IN ('Requested','Blocked','Approved');
 CREATE TABLE IF NOT EXISTS deletion_request_events(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL REFERENCES deletion_requests(id),action TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,request_version INTEGER NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS deletion_tombstones(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE REFERENCES deletion_requests(id),collection TEXT NOT NULL,record_id TEXT NOT NULL,class_id TEXT NOT NULL,record_digest TEXT NOT NULL,record_version INTEGER NOT NULL,disposition TEXT NOT NULL,evidence_retained INTEGER NOT NULL CHECK(evidence_retained=1),history_destroyed INTEGER NOT NULL CHECK(history_destroyed=0),recorded_by TEXT NOT NULL,recorded_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS retention_assignment_event_no_update BEFORE UPDATE ON retention_assignment_events BEGIN SELECT RAISE(ABORT,'Retention assignment history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS retention_assignment_event_no_delete BEFORE DELETE ON retention_assignment_events BEGIN SELECT RAISE(ABORT,'Retention assignment history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS retention_assignment_no_delete BEFORE DELETE ON retention_assignments BEGIN SELECT RAISE(ABORT,'Retention assignments are retained'); END;
 CREATE TRIGGER IF NOT EXISTS legal_hold_event_no_update BEFORE UPDATE ON legal_hold_events BEGIN SELECT RAISE(ABORT,'Legal hold history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS legal_hold_event_no_delete BEFORE DELETE ON legal_hold_events BEGIN SELECT RAISE(ABORT,'Legal hold history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS legal_hold_no_delete BEFORE DELETE ON legal_holds BEGIN SELECT RAISE(ABORT,'Legal holds are retained'); END;
 CREATE TRIGGER IF NOT EXISTS deletion_request_event_no_update BEFORE UPDATE ON deletion_request_events BEGIN SELECT RAISE(ABORT,'Deletion request history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS deletion_request_event_no_delete BEFORE DELETE ON deletion_request_events BEGIN SELECT RAISE(ABORT,'Deletion request history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS deletion_request_no_delete BEFORE DELETE ON deletion_requests BEGIN SELECT RAISE(ABORT,'Deletion requests are retained'); END;
 CREATE TRIGGER IF NOT EXISTS deletion_tombstone_no_update BEFORE UPDATE ON deletion_tombstones BEGIN SELECT RAISE(ABORT,'Disposition evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS deletion_tombstone_no_delete BEFORE DELETE ON deletion_tombstones BEGIN SELECT RAISE(ABORT,'Disposition evidence is retained'); END;`);

 // -------------------------------------------------------------------------
 // Counters. Held in memory, flushed durably so a restart keeps the signal.
 const pending=new Map();
 function bump(name,by=1){if(!OBSERVABILITY_COUNTERS.includes(name)||!Number.isSafeInteger(by)||by<1)return;pending.set(name,(pending.get(name)||0)+by);}
 function flush(){
  if(!pending.size)return 0;const entries=[...pending];pending.clear();let written=0;
  try{const time=at();for(const [name,by] of entries){db.prepare('INSERT INTO observability_counters VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET count=count+excluded.count,updated_at=excluded.updated_at').run(scope,name,by,time);written++;}}
  catch{for(const [name,by] of entries)pending.set(name,(pending.get(name)||0)+by);}
  return written;
 }
 function counters(){
  flush();const stored=new Map(db.prepare('SELECT name,count FROM observability_counters WHERE tenant_id=?').all(scope).map(r=>[r.name,Number(r.count)]));
  return Object.fromEntries(OBSERVABILITY_COUNTERS.map(name=>[name,(stored.get(name)||0)+(pending.get(name)||0)]));
 }

 // -------------------------------------------------------------------------
 // Structured log. Fixed shape, allowlisted, bounded, and never persisted to the
 // business database: an unauthenticated caller must not be able to grow a
 // retained table. A deployment owner supplies the durable sink.
 const logs=[];
 const actorDigest=value=>typeof value==='string'&&value?digest(actorSalt+':'+value).slice(0,16):null;
 function emit(record){
  const line=Object.freeze({...record});
  logs.push(line);if(logs.length>LOG_LIMIT)logs.splice(0,logs.length-LOG_LIMIT);
  if(logSink)try{logSink(line);}catch{}
  return line;
 }
 function observe(kind,detail={},extra={}){
  const {detail:safe,dropped}=redactDetail(detail);
  if(dropped)bump('log_fields_dropped_total',dropped);
  return emit({at:at(),kind:String(kind).slice(0,40),tenant:actorDigest(scope),...extra,...safe,droppedFields:dropped});
 }
 function recordRequest(started,{method,route,surface},req,res){
  let status=null;try{status=res?.statusCode??null;}catch{}
  const cls=statusClass(status);
  bump('requests_total');
  if(cls==='2xx'||cls==='3xx')bump('requests_ok_total');
  if(cls==='4xx')bump('requests_client_error_total');
  if(status===401)bump('requests_unauthenticated_total');
  if(status===403)bump('requests_forbidden_total');
  if(status===409)bump('requests_conflict_total');
  if(status===429)bump('requests_rate_limited_total');
  if(cls==='5xx')bump('requests_server_error_total');
  if(surface==='public')bump('requests_public_total');
  if(surface==='webhook')bump('requests_webhook_total');
  let role='anonymous',actor=null;
  try{if(req?.user&&typeof req.user.role==='string'){role=req.user.role;actor=actorDigest(req.user.id);}}catch{}
  let durationMs=null;try{if(typeof started==='bigint')durationMs=Number((process.hrtime.bigint()-started)/1000000n);}catch{}
  return emit({at:at(),kind:'request',tenant:actorDigest(scope),method,route,surface,status,statusClass:cls,durationMs,role,actor,droppedFields:0});
 }
 // Wrapping app.handle is the only seam-safe way to see every request: the
 // extension seam installs after the application's own routes, so an ordinary
 // middleware would never run for a request an earlier route already answered.
 let instrumented=false;
 try{
  const original=app.handle;
  if(typeof original==='function'&&!app[HANDLE]){
   const wrapped=function(req,res,next){
    try{
     if(res&&!res[LOGGED]){
      Object.defineProperty(res,LOGGED,{value:true,writable:false,configurable:true,enumerable:false});
      let started=null;try{started=process.hrtime.bigint();}catch{}
      const method=String(req?.method||'').slice(0,10).toUpperCase();
      const raw=req?.originalUrl||req?.url||'';
      const route=normalizeRoute(raw);
      const surface=route.startsWith('/api/public')?'public':route.includes('/webhook')?'webhook':route.startsWith('/api')?'api':'app';
      let done=false;const finish=()=>{if(done)return;done=true;try{recordRequest(started,{method,route,surface},req,res);}catch{}};
      res.once('finish',finish);res.once('close',finish);
     }
    }catch{}
    return original.call(this,req,res,next);
   };
   Object.defineProperty(app,'handle',{value:wrapped,writable:true,configurable:true,enumerable:false});
   Object.defineProperty(app,HANDLE,{value:true,writable:true,configurable:true,enumerable:false});
   instrumented=true;
  }
 }catch{instrumented=false;}

 // -------------------------------------------------------------------------
 // Alert hooks. Inert unless a transport is supplied. No network, no retry.
 const fired=new Set();
 function runAlertChecks(){
  if(!alertSink||!alertRules.length)return {configured:false,dispatched:0,evaluated:0,notice:'No alert transport is configured. Alert hooks are inert.'};
  const values=counters();let dispatched=0;
  for(const rule of alertRules){
   const value=values[rule.counter]||0;const key=rule.counter+':'+rule.threshold;
   if(value<rule.threshold||fired.has(key))continue;
   fired.add(key);
   try{alertSink({counter:rule.counter,threshold:rule.threshold,value,at:at(),tenant:actorDigest(scope),notice:NOTICE});dispatched++;bump('alerts_dispatched_total');}
   catch{bump('alerts_sink_failed_total');}
   observe('alert',{rule:rule.counter,threshold:rule.threshold,value});
  }
  flush();
  return {configured:true,dispatched,evaluated:alertRules.length};
 }

 // -------------------------------------------------------------------------
 // Readiness. "Process up" is not "dependencies usable"; a failing required
 // dependency fails closed with 503 and never surfaces its error text.
 const startedAt=clock();
 const withTimeout=promise=>new Promise(resolve=>{let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;resolve(false);}},DEPENDENCY_TIMEOUT);timer.unref?.();Promise.resolve(promise).then(value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value===true||value?.ok===true);}},()=>{if(!settled){settled=true;clearTimeout(timer);resolve(false);}});});
 async function readiness(req=null){
  const checks=[];
  let databaseReadable=false,databaseWritable=false;
  try{db.prepare('SELECT count(*) n FROM observability_counters WHERE tenant_id=?').get(scope);databaseReadable=true;}catch{databaseReadable=false;}
  try{db.prepare('INSERT INTO observability_heartbeat VALUES(?,?,1) ON CONFLICT(tenant_id) DO UPDATE SET at=excluded.at,writes=writes+1').run(scope,at());databaseWritable=Boolean(db.prepare('SELECT 1 FROM observability_heartbeat WHERE tenant_id=?').get(scope));}catch{databaseWritable=false;}
  checks.push({name:'database.read',required:true,ok:databaseReadable,detail:databaseReadable?'Workspace database answered a bounded read':'Workspace database did not answer a bounded read'});
  checks.push({name:'database.write',required:true,ok:databaseWritable,detail:databaseWritable?'Workspace database accepted and read back a heartbeat write':'Workspace database did not accept a heartbeat write'});
  let tenantOk=false;try{tenantOk=isTenantActive()!==false;}catch{tenantOk=false;}
  checks.push({name:'workspace.active',required:true,ok:tenantOk,detail:tenantOk?'Workspace is active':'Workspace is suspended or its status is unavailable'});
  let factorOk=true;
  if(typeof mfaStatus==='function'&&req?.user){try{factorOk=mfaStatus(req.user)?.available===true;}catch{factorOk=false;}}
  checks.push({name:'authenticator.key',required:Boolean(production),ok:factorOk,detail:factorOk?'Second-factor material is readable':'Second-factor material is unavailable; enrolled sign-in fails closed'});
  for(const dependency of dependencies){
   const required=dependency.required!==false;let ok=false;
   try{ok=await withTimeout(dependency.check());}catch{ok=false;}
   checks.push({name:safeText(dependency.name),required,ok,detail:ok?'Dependency answered its configured readiness probe':'Dependency did not answer its configured readiness probe'});
  }
  const ready=checks.every(check=>!check.required||check.ok);
  bump('readiness_checks_total');if(!ready)bump('readiness_failures_total');
  for(const check of checks)if(!check.ok)observe('readiness',{check:check.name,required:check.required,outcome:'unavailable'});
  flush();
  return {
   ready,status:ready?'ready':'notReady',
   process:{up:true,uptimeSeconds:Math.max(0,Math.round((clock()-startedAt)/1000)),instrumented},
   checks,dependenciesConfigured:dependencies.length,
   meaning:'A process that answers this endpoint is up. Readiness is false whenever a required dependency cannot be used, so an orchestrator removes this instance instead of serving requests that would fail.',
   notice:NOTICE
  };
 }

 // -------------------------------------------------------------------------
 // Retention, legal hold and deletion state.
 const activeHoldCount=()=>db.prepare("SELECT COUNT(*) n FROM legal_holds WHERE tenant_id=? AND status='Active'").get(scope).n;
 let holdsActive=0;try{holdsActive=activeHoldCount();}catch{holdsActive=0;}
 const refreshHolds=()=>{try{holdsActive=activeHoldCount();}catch{}};
 function coveringHold(collection,recordId){
  if(!holdsActive)return null;
  return db.prepare("SELECT * FROM legal_holds WHERE tenant_id=? AND status='Active' AND collection=? AND (record_id IS NULL OR record_id=?) ORDER BY record_id IS NULL,placed_at LIMIT 1").get(scope,collection,recordId??'')||null;
 }
 const classFor=(collection,recordId)=>{
  const row=db.prepare('SELECT * FROM retention_assignments WHERE tenant_id=? AND collection=? AND record_id=?').get(scope,collection,recordId);
  if(row)return CLASS_BY_ID.get(row.class_id)||null;
  return RETENTION_CLASSES.find(c=>c.collections.includes(collection))||null;
 };
 const holdView=row=>({id:row.id,collection:row.collection,recordId:row.record_id,matter:row.matter,status:row.status,version:row.version,placedAt:row.placed_at,releasedAt:row.released_at,scopeKind:row.record_id?'Record':'Collection'});
 const requestView=row=>({id:row.id,collection:row.collection,recordId:row.record_id,classId:row.class_id,state:row.state,version:row.version,requestedAt:row.requested_at,updatedAt:row.updated_at,blockedByHold:Boolean(coveringHold(row.collection,row.record_id))});
 const tombstoneView=row=>({id:row.id,requestId:row.request_id,collection:row.collection,recordId:row.record_id,classId:row.class_id,recordDigest:row.record_digest,recordVersion:row.record_version,disposition:row.disposition,evidenceRetained:Boolean(row.evidence_retained),historyDestroyed:Boolean(row.history_destroyed),recordedAt:row.recorded_at});

 const current=req=>{
  if(!req?.user||req.user.role!=='admin')fail(403,'Security operations and data-lifecycle controls require an administrator');
  if(!isTenantActive())fail(403,'Workspace is suspended');
  if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');
 };
 const authorized=(req,res,next)=>{try{current(req);res.set('Cache-Control','no-store');next();}catch(e){next(e);}};
 const route=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 const asyncRoute=fn=>(req,res,next)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
 const collectionName=z.string().min(1).max(60).refine(value=>collections.includes(value),'Choose a current workspace collection');
 const recordKey=z.string().min(1).max(100);
 const reasonText=z.string().trim().min(1).max(500);
 const versionNumber=z.number().int().min(1);

 for(const prefix of ['/api/observability','/api/retention'])app.use(prefix,authorized);

 app.get('/api/observability/readiness',asyncRoute(async(req,res)=>{
  z.object({}).strict().parse(req.query);
  const result=await readiness(req);
  res.status(result.ready?200:503).json(result);
 }));
 app.get('/api/observability/status',route((req,res)=>{
  z.object({}).strict().parse(req.query);
  res.json({
   counters:counters(),
   logging:{instrumented,retainedLines:logs.length,retainedLimit:LOG_LIMIT,durableSinkConfigured:Boolean(logSink),redaction:'Allowlisted fields only. Request bodies, query strings, client addresses, message bodies, personal data and monetary values are never written.'},
   alerts:{configured:Boolean(alertSink),ruleCount:alertRules.length,rules:alertRules.map(r=>({counter:r.counter,threshold:r.threshold})),transport:'Deployment-owner supplied callback only; this module opens no network connection.'},
   retention:{classes:RETENTION_CLASSES,residency:RETENTION_RESIDENCY,activeHolds:holdsActive,openDeletionRequests:db.prepare("SELECT COUNT(*) n FROM deletion_requests WHERE tenant_id=? AND state IN ('Requested','Blocked','Approved')").get(scope).n,tombstones:db.prepare('SELECT COUNT(*) n FROM deletion_tombstones WHERE tenant_id=?').get(scope).n},
   notice:NOTICE
  });
 }));
 app.get('/api/observability/logs',route((req,res)=>{
  const q=z.object({limit:z.coerce.number().int().min(1).max(200).default(100)}).strict().parse(req.query);
  res.json({lines:logs.slice(-q.limit),retainedLimit:LOG_LIMIT,durableSinkConfigured:Boolean(logSink),notice:'Process-local operational lines only. They are bounded, redacted and lost on restart; durable off-host retention is a deployment-owner control.'});
 }));
 app.post('/api/observability/alerts/test',csrf,route((req,res)=>{
  z.object({}).strict().parse(req.body??{});
  if(!alertSink)fail(503,'No alert transport is configured. Alert hooks stay inert until a deployment owner supplies one');
  let delivered=false;
  try{alertSink({counter:'alerts_dispatched_total',threshold:0,value:0,at:at(),tenant:actorDigest(scope),test:true,notice:NOTICE});delivered=true;bump('alerts_dispatched_total');}
  catch{bump('alerts_sink_failed_total');}
  flush();observe('alert',{kind:'test',outcome:delivered?'delivered':'failed'});
  res.json({configured:true,delivered,notice:'Handing a record to the configured callback is not evidence that a person received or acted on an alert.'});
 }));

 app.get('/api/retention',route((req,res)=>{
  z.object({}).strict().parse(req.query);
  res.json({
   classes:RETENTION_CLASSES,residency:RETENTION_RESIDENCY,
   assignments:db.prepare('SELECT * FROM retention_assignments WHERE tenant_id=? ORDER BY updated_at DESC,id LIMIT 100').all(scope).map(r=>({id:r.id,collection:r.collection,recordId:r.record_id,classId:r.class_id,version:r.version,assignedAt:r.assigned_at,updatedAt:r.updated_at})),
   holds:db.prepare('SELECT * FROM legal_holds WHERE tenant_id=? ORDER BY status,placed_at DESC,id LIMIT 100').all(scope).map(holdView),
   deletionRequests:db.prepare('SELECT * FROM deletion_requests WHERE tenant_id=? ORDER BY updated_at DESC,id LIMIT 100').all(scope).map(requestView),
   tombstones:db.prepare('SELECT * FROM deletion_tombstones WHERE tenant_id=? ORDER BY recorded_at DESC,id LIMIT 100').all(scope).map(tombstoneView),
   limits:{visible:100},
   invariants:['A legal hold blocks deletion and identity consolidation until it is explicitly released.','Recording a disposition never destroys financial or audit history; it writes a retained tombstone.','Every retention class carries at least the Q&A56 ten-year minimum.'],
   notice:NOTICE
  });
 }));

 app.post('/api/retention/assignments',csrf,route((req,res)=>{
  const p=z.object({collection:collectionName,recordId:recordKey,classId:z.enum(RETENTION_CLASSES.map(c=>c.id))}).strict().parse(req.body);
  const definition=CLASS_BY_ID.get(p.classId);
  if(definition.collections.length&&!definition.collections.includes(p.collection))fail(400,'This retention class does not cover that collection');
  const result=transaction(()=>{
   current(req);
   get(p.collection,p.recordId);
   const time=at(),existing=db.prepare('SELECT * FROM retention_assignments WHERE tenant_id=? AND collection=? AND record_id=?').get(scope,p.collection,p.recordId);
   const id=existing?.id||randomUUID(),version=existing?existing.version+1:1;
   if(existing)db.prepare('UPDATE retention_assignments SET class_id=?,version=?,updated_at=? WHERE id=?').run(p.classId,version,time,id);
   else db.prepare('INSERT INTO retention_assignments VALUES(?,?,?,?,?,?,?,?,?)').run(id,scope,p.collection,p.recordId,p.classId,version,req.user.id,time,time);
   db.prepare('INSERT INTO retention_assignment_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),scope,id,p.classId,version,req.user.id,time);
   audit(req.user,'assign_retention_class',p.collection,p.recordId,{assignmentId:id,classId:p.classId,minimumYears:definition.minimumYears,destructionPermitted:definition.destructionPermitted,residency:RETENTION_RESIDENCY.declared});
   current(req);
   return {id,collection:p.collection,recordId:p.recordId,classId:p.classId,version,updatedAt:time};
  });
  bump('retention_class_assigned_total');flush();
  observe('retention',{kind:'assign',collection:p.collection,classId:p.classId,assignmentId:result.id});
  res.status(201).json({assignment:result,class:definition,residency:RETENTION_RESIDENCY});
 }));

 app.post('/api/retention/holds',csrf,route((req,res)=>{
  const p=z.object({collection:collectionName,recordId:recordKey.nullable().default(null),matter:z.string().trim().min(1).max(200),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   if(p.recordId)get(p.collection,p.recordId);
   if(db.prepare("SELECT 1 FROM legal_holds WHERE tenant_id=? AND status='Active' AND collection=? AND COALESCE(record_id,'*')=?").get(scope,p.collection,p.recordId??'*'))fail(409,'An active legal hold already covers that scope. Release it before placing another');
   const id=randomUUID(),time=at();
   db.prepare('INSERT INTO legal_holds VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scope,p.collection,p.recordId,p.matter,'Active',1,req.user.id,time,null,null);
   db.prepare('INSERT INTO legal_hold_events VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),scope,id,'Placed',p.reason,1,req.user.id,time);
   audit(req.user,'place_legal_hold',p.collection,p.recordId,{holdId:id,matter:p.matter,reason:p.reason,blocks:'Deletion and identity consolidation'});
   current(req);
   const saved=db.prepare('SELECT * FROM legal_holds WHERE id=?').get(id);
   if(!saved||saved.status!=='Active')fail(409,'Legal hold readback failed');
   return holdView(saved);
  });
  refreshHolds();bump('legal_hold_placed_total');flush();
  observe('retention',{kind:'hold-placed',collection:p.collection,holdId:result.id,activeHolds:holdsActive});
  res.status(201).json({hold:result,effect:'Deletion and identity consolidation of the covered records are refused until this hold is released.',notice:NOTICE});
 }));

 app.post('/api/retention/holds/:id/release',csrf,route((req,res)=>{
  z.uuid().parse(req.params.id);
  const p=z.object({version:versionNumber,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   const row=db.prepare('SELECT * FROM legal_holds WHERE id=? AND tenant_id=?').get(req.params.id,scope);
   if(!row)fail(404,'Legal hold not found');
   if(row.status!=='Active')fail(409,'This legal hold is already released');
   if(row.version!==p.version)fail(409,'Legal hold changed. Reload its current version');
   const time=at(),version=row.version+1;
   db.prepare("UPDATE legal_holds SET status='Released',version=?,released_by=?,released_at=? WHERE id=?").run(version,req.user.id,time,row.id);
   db.prepare('INSERT INTO legal_hold_events VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,'Released',p.reason,version,req.user.id,time);
   audit(req.user,'release_legal_hold',row.collection,row.record_id,{holdId:row.id,reason:p.reason,retained:'Hold history is retained'});
   current(req);
   return holdView(db.prepare('SELECT * FROM legal_holds WHERE id=?').get(row.id));
  });
  refreshHolds();bump('legal_hold_released_total');flush();
  observe('retention',{kind:'hold-released',holdId:result.id,activeHolds:holdsActive});
  res.json({hold:result,notice:'Released holds and their reasons are retained.'});
 }));

 app.post('/api/retention/deletion-requests',csrf,route((req,res)=>{
  const p=z.object({collection:collectionName,recordId:recordKey,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   get(p.collection,p.recordId);
   const definition=classFor(p.collection,p.recordId);
   if(!definition)fail(400,'Assign a retention class to this record before requesting its disposition');
   if(db.prepare("SELECT 1 FROM deletion_requests WHERE tenant_id=? AND collection=? AND record_id=? AND state IN ('Requested','Blocked','Approved')").get(scope,p.collection,p.recordId))fail(409,'An open disposition request already exists for this record');
   const hold=coveringHold(p.collection,p.recordId),state=hold?'Blocked':'Requested',id=randomUUID(),time=at();
   db.prepare('INSERT INTO deletion_requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,scope,p.collection,p.recordId,definition.id,state,1,req.user.id,time,time);
   db.prepare('INSERT INTO deletion_request_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,id,'Requested',state,p.reason,1,req.user.id,time);
   audit(req.user,'request_record_disposition',p.collection,p.recordId,{deletionRequestId:id,state,classId:definition.id,holdId:hold?.id||null,reason:p.reason});
   current(req);
   return {row:db.prepare('SELECT * FROM deletion_requests WHERE id=?').get(id),hold,definition};
  });
  bump('deletion_requested_total');if(result.hold)bump('deletion_blocked_total');flush();
  observe('retention',{kind:'deletion-requested',collection:p.collection,requestId:result.row.id,state:result.row.state,blocked:Boolean(result.hold)});
  res.status(201).json({request:requestView(result.row),class:result.definition,blockedByHold:result.hold?{id:result.hold.id,matter:result.hold.matter}:null,notice:result.hold?'An active legal hold blocks this disposition. Release the hold explicitly before it can be approved.':NOTICE});
 }));

 app.post('/api/retention/deletion-requests/:id/decide',csrf,route((req,res)=>{
  z.uuid().parse(req.params.id);
  const p=z.object({version:versionNumber,decision:z.enum(['Approve','Refuse']),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   const row=db.prepare('SELECT * FROM deletion_requests WHERE id=? AND tenant_id=?').get(req.params.id,scope);
   if(!row)fail(404,'Disposition request not found');
   if(!['Requested','Blocked'].includes(row.state))fail(409,'This disposition request is already decided');
   if(row.version!==p.version)fail(409,'Disposition request changed. Reload its current version');
   const definition=CLASS_BY_ID.get(row.class_id);
   if(!definition)fail(409,'This request references a retention class that is no longer defined');
   let state='Refused';
   if(p.decision==='Approve'){
    // Authority, hold and retention minimum are rechecked at execution time.
    const hold=coveringHold(row.collection,row.record_id);
    if(hold)fail(409,'An active legal hold blocks this disposition. Release the hold explicitly first');
    if(!definition.destructionPermitted)fail(409,'This retention class never permits destruction. Financial and audit history is retained');
    const record=get(row.collection,row.record_id),created=Date.parse(record.createdAt||'');
    if(!Number.isSafeInteger(created))fail(409,'This record has no recorded creation date; its retention minimum cannot be evaluated');
    const elapsedYears=(clock()-created)/(365.2425*86400000);
    if(elapsedYears<definition.minimumYears)fail(409,`The ${definition.minimumYears}-year minimum retention for this class has not elapsed`);
    state='Approved';
   }
   const time=at(),version=row.version+1;
   db.prepare('UPDATE deletion_requests SET state=?,version=?,updated_at=? WHERE id=?').run(state,version,time,row.id);
   db.prepare('INSERT INTO deletion_request_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,p.decision,state,p.reason,version,req.user.id,time);
   audit(req.user,'decide_record_disposition',row.collection,row.record_id,{deletionRequestId:row.id,decision:p.decision,state,classId:definition.id,reason:p.reason});
   current(req);
   return db.prepare('SELECT * FROM deletion_requests WHERE id=?').get(row.id);
  });
  bump(result.state==='Approved'?'deletion_approved_total':'deletion_refused_total');flush();
  observe('retention',{kind:'deletion-decided',requestId:result.id,state:result.state,decision:p.decision});
  res.json({request:requestView(result),notice:result.state==='Approved'?'Approval authorizes a recorded disposition. It does not destroy retained financial or audit history.':NOTICE});
 }));

 app.post('/api/retention/deletion-requests/:id/record-disposition',csrf,route((req,res)=>{
  z.uuid().parse(req.params.id);
  const p=z.object({version:versionNumber,reason:reasonText,disposition:z.enum(['Transferred to the district','Disposed under district instruction','Suppressed pending disposal']).default('Disposed under district instruction')}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);
   const row=db.prepare('SELECT * FROM deletion_requests WHERE id=? AND tenant_id=?').get(req.params.id,scope);
   if(!row)fail(404,'Disposition request not found');
   if(row.state!=='Approved')fail(409,'Only an approved disposition request can be recorded');
   if(row.version!==p.version)fail(409,'Disposition request changed. Reload its current version');
   // The hold is rechecked here, not only at approval: an intervening hold wins.
   const hold=coveringHold(row.collection,row.record_id);
   if(hold)fail(409,'An active legal hold blocks this disposition. Release the hold explicitly first');
   const record=get(row.collection,row.record_id),time=at(),version=row.version+1,tombstoneId=randomUUID();
   db.prepare('UPDATE deletion_requests SET state=?,version=?,updated_at=? WHERE id=?').run('Recorded',version,time,row.id);
   db.prepare('INSERT INTO deletion_request_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),scope,row.id,'Recorded','Recorded',p.reason,version,req.user.id,time);
   // The retained tombstone is written last on purpose: if it cannot be written,
   // the whole disposition rolls back rather than leaving a recorded state with
   // no evidence of what was disposed.
   db.prepare('INSERT INTO deletion_tombstones VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?)').run(tombstoneId,scope,row.id,row.collection,row.record_id,row.class_id,digest(JSON.stringify(record)),Number.isSafeInteger(record.version)?record.version:1,p.disposition,req.user.id,time);
   audit(req.user,'record_record_disposition',row.collection,row.record_id,{deletionRequestId:row.id,tombstoneId,disposition:p.disposition,reason:p.reason,historyDestroyed:false,evidenceRetained:true});
   current(req);
   const saved=db.prepare('SELECT * FROM deletion_tombstones WHERE id=?').get(tombstoneId);
   if(!saved||saved.history_destroyed!==0||saved.evidence_retained!==1)fail(409,'Disposition evidence readback failed');
   return {request:db.prepare('SELECT * FROM deletion_requests WHERE id=?').get(row.id),tombstone:saved};
  });
  bump('deletion_recorded_total');flush();
  observe('retention',{kind:'deletion-recorded',requestId:result.request.id,tombstoneId:result.tombstone.id});
  res.json({request:requestView(result.request),tombstone:tombstoneView(result.tombstone),historyDestroyed:false,evidenceRetained:true,notice:'This records an institutional disposition decision and keeps its evidence. It does not erase retained financial history, audit rows, receipts or recovery archives; physical disposal across backups and subprocessors remains an operated procedure.'});
 }));

 app.use('/api/observability',(req,res)=>res.status(404).json({error:'Endpoint not found'}));
 app.use('/api/retention',(req,res)=>res.status(404).json({error:'Endpoint not found'}));

 const timer=worker?setInterval(()=>{try{flush();runAlertChecks();}catch{}},5000):null;timer?.unref?.();

 return {
  observe,counters,flush,readiness,runAlertChecks,recentLogs:(limit=LOG_LIMIT)=>logs.slice(-limit),
  activeHolds:()=>holdsActive,coveringHold,instrumented,
  validateDeletion(collection,record){
   if(!record?.id)return;
   const hold=coveringHold(collection,record.id);
   if(!hold)return;
   // Never flush here: this guard runs inside the caller's transaction, which is
   // about to roll back. The in-memory delta survives and is flushed afterwards.
   bump('legal_hold_blocked_deletion_total');
   observe('retention',{kind:'deletion-blocked',collection,holdId:hold.id,outcome:'refused'});
   fail(409,'An active legal hold retains this record. Release the hold through the retention controls before any disposition');
  },
  validateMutation(collection,previous,next){
   if(!previous?.id||!next?.mergedInto||previous.mergedInto)return;
   const hold=coveringHold(collection,previous.id);
   if(!hold)return;
   bump('legal_hold_blocked_merge_total');
   observe('retention',{kind:'merge-blocked',collection,holdId:hold.id,outcome:'refused'});
   fail(409,'An active legal hold retains this identity. Release the hold before consolidating it');
  },
  hasConstituentReferences(id){return Boolean(typeof id==='string'&&id&&coveringHold('constituents',id));},
  close(){try{if(timer)clearInterval(timer);}catch{}try{flush();}catch{}}
 };
}

export function installPublic(){return null;}
