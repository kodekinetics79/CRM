// Volunteer self-service. Two surfaces share one engine:
//  - installPublic(app,ctx): unauthenticated `/api/public/volunteer/*`. No session
//    cookie exists here, so browser CSRF does not apply. Every request proves
//    itself with an explicitly issued, signed, expiring, revocable link token and
//    the module enforces its own origin, rate, replay and body-size limits.
//  - install(app,ctx): staff routes under `/api/volunteer-portal` behind the
//    existing workspace authentication, MFA and role guards.
// A link token grants ONLY that person's own shifts and reservations. It never
// exposes constituent browsing, financial records or another volunteer's details.
// Reminders are handed to an injected provider-neutral outbox callback. Queuing is
// never delivery: nothing in this module contacts an external provider.
import {randomUUID,randomBytes,createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {isPersonConstituent} from '../shared/constituentTypes.js';

const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const iso=time=>new Date(time).toISOString();
const uuid=z.uuid(),version=z.number().int().min(1),reasonText=z.string().trim().min(1).max(500);
const TOKEN=/^wv1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})\.([0-9a-f]{64})$/;
// Replay evidence is retained and cannot be deleted, so it is bounded per link
// instead. One sign-up link can never grow the workspace record, and therefore
// can never consume the workspace row budget the backup archive depends on.
const REQUEST_LEDGER_LIMIT=100;
const DEFAULT_LEAD_MINUTES=[1440,120],MAX_BODY_BYTES=4096,QUEUED_NOTE='Queued to the configured outbox. External delivery is not performed, confirmed or claimed here.';
const DELIVERY_SCOPE='Internal preparation only. Queuing a reminder is not delivery and no external provider is contacted.';
const PUBLIC_SCOPE='This link shows only your own volunteer shifts and reservations. It never opens constituent records, giving history or other volunteers’ details.';
const CLAIM_NOTE='Volunteer self-reported claim. It is not confirmed hours and is never counted in the volunteer time ledger or any hours report.';
const LEDGER_NOTE='No hours were written. Recorded hours remain the sole result of the volunteer clock, used by staff as a separate explicit action.';
const shared=new WeakMap();
const digest=value=>createHash('sha256').update(value).digest('hex');
const sameSecret=(a,b)=>{const left=Buffer.from(a,'hex'),right=Buffer.from(b,'hex');return left.length===right.length&&timingSafeEqual(left,right);};
const shiftStartMs=shift=>Date.parse(shift.date+'T'+shift.startTime+':00.000Z');
const shiftEndMs=shift=>Date.parse(shift.date+'T'+shift.endTime+':00.000Z');

function setup(db){
 db.exec(`CREATE TABLE IF NOT EXISTS volunteer_portal_keys(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS volunteer_portal_access(id TEXT PRIMARY KEY,constituent_id TEXT NOT NULL,nonce_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Revoked')),issued_by TEXT NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,revoke_reason TEXT,last_used_at TEXT,use_count INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS volunteer_portal_access_person ON volunteer_portal_access(constituent_id,status);
 CREATE TRIGGER IF NOT EXISTS volunteer_portal_access_no_delete BEFORE DELETE ON volunteer_portal_access BEGIN SELECT RAISE(ABORT,'Volunteer access history is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_portal_requests(id TEXT PRIMARY KEY,access_id TEXT NOT NULL,request_id TEXT NOT NULL,action TEXT NOT NULL,response TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(access_id,request_id));
 CREATE TRIGGER IF NOT EXISTS volunteer_portal_request_no_update BEFORE UPDATE ON volunteer_portal_requests BEGIN SELECT RAISE(ABORT,'Replay evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_portal_request_no_delete BEFORE DELETE ON volunteer_portal_requests BEGIN SELECT RAISE(ABORT,'Replay evidence is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_reservation_history(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,shift_id TEXT NOT NULL,constituent_id TEXT NOT NULL,action TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,from_version INTEGER,to_version INTEGER NOT NULL,actor TEXT NOT NULL,actor_kind TEXT NOT NULL CHECK(actor_kind IN ('Volunteer','Staff','System')),reason TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(reservation_id,to_version));
 CREATE INDEX IF NOT EXISTS volunteer_reservation_history_shift ON volunteer_reservation_history(shift_id,at);
 CREATE TRIGGER IF NOT EXISTS volunteer_reservation_history_no_update BEFORE UPDATE ON volunteer_reservation_history BEGIN SELECT RAISE(ABORT,'Volunteer roster history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_reservation_history_no_delete BEFORE DELETE ON volunteer_reservation_history BEGIN SELECT RAISE(ABORT,'Volunteer roster history is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_attendance_claims(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,shift_id TEXT NOT NULL,constituent_id TEXT NOT NULL,shift_signature TEXT NOT NULL,reservation_version INTEGER NOT NULL,arrived_at TEXT NOT NULL,departed_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Claimed','Confirmed','Rejected','Suppressed')),decided_by TEXT,decided_at TEXT,decision_reason TEXT,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS volunteer_one_standing_claim ON volunteer_attendance_claims(reservation_id) WHERE status IN ('Claimed','Confirmed');
 CREATE INDEX IF NOT EXISTS volunteer_attendance_claims_person ON volunteer_attendance_claims(constituent_id,status);
 CREATE TRIGGER IF NOT EXISTS volunteer_attendance_claim_no_delete BEFORE DELETE ON volunteer_attendance_claims BEGIN SELECT RAISE(ABORT,'Volunteer attendance claim history is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_attendance_decisions(id TEXT PRIMARY KEY,claim_id TEXT NOT NULL,claim_version INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,actor_kind TEXT NOT NULL CHECK(actor_kind IN ('Volunteer','Staff','System')),at TEXT NOT NULL,UNIQUE(claim_id,claim_version));
 CREATE TRIGGER IF NOT EXISTS volunteer_attendance_decision_no_update BEFORE UPDATE ON volunteer_attendance_decisions BEGIN SELECT RAISE(ABORT,'Attendance claim decisions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_attendance_decision_no_delete BEFORE DELETE ON volunteer_attendance_decisions BEGIN SELECT RAISE(ABORT,'Attendance claim decisions are retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_reminder_config(shift_id TEXT PRIMARY KEY,lead_minutes TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),version INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS volunteer_reminders(id TEXT PRIMARY KEY,shift_id TEXT NOT NULL,reservation_id TEXT NOT NULL,constituent_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('Shift reminder','Waitlist promotion')),lead_minutes INTEGER NOT NULL,send_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Pending','Queued','Suppressed')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(reservation_id,kind,lead_minutes));
 CREATE INDEX IF NOT EXISTS volunteer_reminders_due ON volunteer_reminders(status,next_attempt,send_at);
 CREATE TRIGGER IF NOT EXISTS volunteer_reminder_no_delete BEFORE DELETE ON volunteer_reminders BEGIN SELECT RAISE(ABORT,'Volunteer reminder history is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_reminder_outcomes(id TEXT PRIMARY KEY,reminder_id TEXT NOT NULL,reminder_version INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,retry_at TEXT);
 CREATE TRIGGER IF NOT EXISTS volunteer_reminder_outcome_no_update BEFORE UPDATE ON volunteer_reminder_outcomes BEGIN SELECT RAISE(ABORT,'Reminder outcomes are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_reminder_outcome_no_delete BEFORE DELETE ON volunteer_reminder_outcomes BEGIN SELECT RAISE(ABORT,'Reminder outcomes are retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_reminder_notices(id TEXT PRIMARY KEY,reminder_id TEXT NOT NULL UNIQUE,constituent_id TEXT NOT NULL,shift_id TEXT NOT NULL,reservation_id TEXT NOT NULL,kind TEXT NOT NULL,queued_at TEXT NOT NULL,outbox_reference TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS volunteer_reminder_notice_no_update BEFORE UPDATE ON volunteer_reminder_notices BEGIN SELECT RAISE(ABORT,'Queued reminder evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_reminder_notice_no_delete BEFORE DELETE ON volunteer_reminder_notices BEGIN SELECT RAISE(ABORT,'Queued reminder evidence is retained'); END;
 CREATE TABLE IF NOT EXISTS volunteer_reminder_consent(constituent_id TEXT PRIMARY KEY,granted INTEGER NOT NULL CHECK(granted IN (0,1)),source TEXT NOT NULL CHECK(source IN ('Volunteer','Staff')),basis TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS volunteer_consent_changes(id TEXT PRIMARY KEY,constituent_id TEXT NOT NULL,granted INTEGER NOT NULL,source TEXT NOT NULL,basis TEXT NOT NULL,to_version INTEGER NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(constituent_id,to_version));
 CREATE TRIGGER IF NOT EXISTS volunteer_consent_change_no_update BEFORE UPDATE ON volunteer_consent_changes BEGIN SELECT RAISE(ABORT,'Consent history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS volunteer_consent_change_no_delete BEFORE DELETE ON volunteer_consent_changes BEGIN SELECT RAISE(ABORT,'Consent history is retained'); END;`);
 if(!db.prepare('SELECT 1 FROM volunteer_portal_keys WHERE id=1').get())db.prepare('INSERT INTO volunteer_portal_keys VALUES(1,?,?)').run(randomBytes(32).toString('hex'),new Date().toISOString());
}

// One engine instance per database. installPublic runs before authentication and
// install runs after it; both reuse the same rules so a staff cancellation and a
// volunteer self-cancellation cannot diverge.
function core(ctx){
 const existing=shared.get(ctx.db);if(existing)return existing;
 const {db,list,get,create,put,validate,audit,transaction,isTenantActive=()=>true}=ctx,config=ctx.config||{};
 setup(db);
 const clock=typeof config.clock==='function'?config.clock:Date.now;
 if(config.sendReminder!==undefined&&typeof config.sendReminder!=='function')throw new Error('volunteerPortal.sendReminder must be a synchronous provider-neutral callback.');
 // Default outbox: acceptance of an internal-only preparation. It contacts nothing.
 const outbox=config.sendReminder||(()=>({accepted:true,reference:'internal-only',channel:'Internal only'}));
 const defaultLeads=Array.isArray(config.defaultLeadMinutes)?[...new Set(config.defaultLeadMinutes.filter(n=>Number.isInteger(n)&&n>=0&&n<=20160))].sort((a,b)=>b-a):DEFAULT_LEAD_MINUTES;
 const secret=()=>db.prepare('SELECT secret FROM volunteer_portal_keys WHERE id=1').get().secret;
 const sign=payload=>createHmac('sha256',Buffer.from(secret(),'hex')).update(payload).digest('hex');
 const limits=new Map();
 const rates={ip:120,link:60,...(config.rateLimits&&typeof config.rateLimits==='object'?config.rateLimits:{})};
 const requestLedgerLimit=Number.isInteger(config.requestLedgerLimit)&&config.requestLedgerLimit>=1&&config.requestLedgerLimit<=1000?config.requestLedgerLimit:REQUEST_LEDGER_LIMIT;
 const recordedRequests=accessId=>db.prepare('SELECT COUNT(*) n FROM volunteer_portal_requests WHERE access_id=?').get(accessId).n;
 function rateLimit(key,max,windowMs,time){
  if(limits.size>4096)for(const [k,v] of limits)if(v.until<time)limits.delete(k);
  let bucket=limits.get(key);
  if(!bucket||bucket.until<time){bucket={count:0,until:time+windowMs};limits.set(key,bucket);}
  if(limits.size>8192)fail(429,'Too many requests. Try again shortly.');
  if(++bucket.count>max)fail(429,'Too many requests. Try again shortly.');
 }
 const accessRow=key=>db.prepare('SELECT * FROM volunteer_portal_access WHERE id=?').get(key);
 const person=key=>{let record;try{record=get('constituents',key);}catch(e){if(e.status===404)return null;throw e;}return record.mergedInto||!isPersonConstituent(record)?null:record;};
 const reservations=()=>list('shiftReservations');
 const reserved=(shiftId,exclude=null)=>reservations().filter(r=>r.shiftId===shiftId&&r.status==='Reserved'&&r.id!==exclude).length;
 const waitlist=shiftId=>reservations().filter(r=>r.shiftId===shiftId&&r.status==='Waitlisted').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
 function shiftRecord(key){let shift;try{shift=get('volunteerShifts',key);}catch(e){if(e.status===404)fail(404,'This volunteer shift is not available.');throw e;}return shift;}
 const shiftSummary=(shift,time)=>({id:shift.id,name:shift.name,date:shift.date,startTime:shift.startTime,endTime:shift.endTime,location:shift.location||'',capacity:shift.capacity,status:shift.status,eventId:shift.eventId||null,reservedCount:reserved(shift.id),waitlistCount:waitlist(shift.id).length,placesLeft:Math.max(0,shift.capacity-reserved(shift.id)),version:shift.version,startsAt:iso(shiftStartMs(shift)),past:shiftStartMs(shift)<=time});
 // `tolerate` is used for advisory notes (a skipped promotion) that can legitimately
 // repeat at the same reservation version; a transition is never silently dropped.
 function retainHistory(record,action,fromStatus,fromVersion,actor,actorKind,reason,time,tolerate=false){
  db.prepare('INSERT '+(tolerate?'OR IGNORE ':'')+'INTO volunteer_reservation_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),record.id,record.shiftId,record.constituentId,action,fromStatus,record.status,fromVersion,record.version,actor,actorKind,reason,iso(time));
 }
 const historyFor=key=>db.prepare('SELECT * FROM volunteer_reservation_history WHERE reservation_id=? ORDER BY to_version,id').all(key).map(r=>({id:r.id,action:r.action,fromStatus:r.from_status,toStatus:r.to_status,fromVersion:r.from_version,toVersion:r.to_version,actor:r.actor,actorKind:r.actor_kind,reason:r.reason,at:r.at}));
 // ---------------------------------------------------------------------------
 // Self-reported arrival and departure. A claim is a claim: this module never
 // writes volunteerTime, never touches volunteers.hours and is never counted in
 // any hours report. The hours ledger stays the sole property of the existing
 // volunteer clock endpoint, called by staff as a separate explicit action.
 // ---------------------------------------------------------------------------
 const signatureOf=shift=>shift.date+'|'+shift.startTime+'|'+shift.endTime;
 const claimRow=key=>{const row=db.prepare('SELECT * FROM volunteer_attendance_claims WHERE id=?').get(key);if(!row)fail(404,'Attendance claim not found');return row;};
 const standingClaim=reservationId=>db.prepare("SELECT * FROM volunteer_attendance_claims WHERE reservation_id=? AND status IN ('Claimed','Confirmed')").get(reservationId);
 function claimSource(row){
  let record;try{record=get('shiftReservations',row.reservation_id);}catch(e){if(e.status===404)return {reason:'Reservation unavailable'};throw e;}
  if(record.status!=='Reserved')return {reason:'The place this claim belongs to is no longer reserved'};
  let shift;try{shift=get('volunteerShifts',row.shift_id);}catch(e){if(e.status===404)return {reason:'Shift unavailable'};throw e;}
  if(signatureOf(shift)!==row.shift_signature)return {reason:'The shift date or times changed after this claim was made'};
  return {record,shift};
 }
 const claimDecisions=key=>db.prepare('SELECT * FROM volunteer_attendance_decisions WHERE claim_id=? ORDER BY claim_version,id').all(key).map(r=>({id:r.id,status:r.status,reason:r.reason,actor:r.actor,actorKind:r.actor_kind,at:r.at}));
 function claimView(row){
  const source=claimSource(row);
  return {id:row.id,reservationId:row.reservation_id,shiftId:row.shift_id,constituentId:row.constituent_id,arrivedAt:row.arrived_at,departedAt:row.departed_at,status:row.status,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,
   decidedBy:row.decided_by,decidedAt:row.decided_at,decisionReason:row.decision_reason,
   claimedMinutes:Math.round((Date.parse(row.departed_at)-Date.parse(row.arrived_at))/60000),
   sourceCurrent:!source.reason,sourceProblem:source.reason||null,decisions:claimDecisions(row.id),
   meaning:CLAIM_NOTE};
 }
 function retainDecision(row,status,reason,actor,actorKind,time){db.prepare('INSERT INTO volunteer_attendance_decisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.version+1,status,reason,actor,actorKind,iso(time));}
 function suppressClaim(row,reason,actor,time){
  db.prepare("UPDATE volunteer_attendance_claims SET status='Suppressed',version=version+1,updated_at=?,decided_by=?,decided_at=?,decision_reason=? WHERE id=?").run(iso(time),actor,iso(time),reason,row.id);
  retainDecision(row,'Suppressed',reason,actor,'System',time);
  audit({id:actor},'suppress_volunteer_attendance_claim','volunteerShifts',row.shift_id,{claimId:row.id,constituentId:row.constituent_id,reason,ledger:LEDGER_NOTE});
 }
 function suppressClaimsForReservation(reservationId,reason,actor,time){
  let suppressed=0;
  for(const row of db.prepare("SELECT * FROM volunteer_attendance_claims WHERE reservation_id=? AND status='Claimed' ORDER BY id").all(reservationId)){suppressClaim(row,reason,actor,time);suppressed++;}
  return suppressed;
 }
 function recordClaim(record,arrivedAt,departedAt,actor,time){
  if(record.status!=='Reserved')fail(409,'Only a confirmed place can record when you arrived and left.');
  const shift=shiftRecord(record.shiftId),start=shiftStartMs(shift),end=shiftEndMs(shift);
  const arrived=Date.parse(arrivedAt),departed=Date.parse(departedAt);
  if(start>time)fail(409,'This shift has not started yet.');
  if(!(arrived<departed))fail(400,'The time you left must be after the time you arrived.');
  if(departed>time)fail(400,'You cannot record a time in the future.');
  if(arrived<start-4*3600000||departed>end+8*3600000)fail(400,'Record times that belong to this shift. Ask staff to record anything further outside it.');
  if(standingClaim(record.id))fail(409,'You already recorded when you arrived and left for this shift.');
  const key=randomUUID(),at=iso(time);
  db.prepare('INSERT INTO volunteer_attendance_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,record.id,shift.id,record.constituentId,signatureOf(shift),record.version,iso(arrived),iso(departed),'Claimed',null,null,null,1,at,at);
  const saved=claimRow(key);
  retainDecision({...saved,version:0},'Claimed','Self-reported by the volunteer from their own sign-up link',actor,'Volunteer',time);
  audit({id:actor},'record_volunteer_attendance_claim','volunteerShifts',shift.id,{claimId:key,reservationId:record.id,constituentId:record.constituentId,arrivedAt:iso(arrived),departedAt:iso(departed),ledger:LEDGER_NOTE});
  if(claimSource(saved).reason)fail(409,'The shift or your place changed while this was being saved.');
  return saved;
 }
 // Confirmation records the staff decision only. It writes no hours: the client
 // calls the existing volunteer clock separately and explicitly for that.
 function decideClaim(row,decision,reason,actor,time){
  if(row.status!=='Claimed')fail(409,'This claim is already '+row.status.toLowerCase()+'.');
  const source=claimSource(row);
  if(source.reason){suppressClaim(row,source.reason,actor,time);return {claim:claimView(claimRow(row.id)),outcome:'Suppressed'};}
  db.prepare('UPDATE volunteer_attendance_claims SET status=?,version=version+1,updated_at=?,decided_by=?,decided_at=?,decision_reason=? WHERE id=?').run(decision,iso(time),actor,iso(time),reason,row.id);
  retainDecision(row,decision,reason,actor,'Staff',time);
  audit({id:actor},'decide_volunteer_attendance_claim','volunteerShifts',row.shift_id,{claimId:row.id,constituentId:row.constituent_id,decision,reason,ledger:LEDGER_NOTE});
  return {claim:claimView(claimRow(row.id)),outcome:decision};
 }
 function consent(key){
  const row=db.prepare('SELECT * FROM volunteer_reminder_consent WHERE constituent_id=?').get(key);
  const withdrawnByVolunteer=Boolean(db.prepare("SELECT 1 FROM volunteer_consent_changes WHERE constituent_id=? AND granted=0 AND source='Volunteer'").get(key));
  return {granted:Boolean(row?.granted),source:row?.source||null,basis:row?.basis||'',version:row?.version||0,updatedAt:row?.updated_at||null,withdrawnByVolunteer};
 }
 function setConsent(key,granted,source,basis,actor,time){
  const previous=consent(key);
  if(!granted&&!previous.granted&&previous.version)fail(409,'Reminder consent is already withdrawn.');
  if(granted&&previous.granted)fail(409,'Reminder consent is already recorded.');
  // A volunteer withdrawal is sticky: staff can never re-grant it on their behalf.
  if(granted&&previous.withdrawnByVolunteer&&source!=='Volunteer')fail(409,'This volunteer withdrew reminder consent. Only the volunteer can grant it again from their own sign-up link.');
  const next=previous.version+1;
  db.prepare('INSERT INTO volunteer_reminder_consent VALUES(?,?,?,?,?,?) ON CONFLICT(constituent_id) DO UPDATE SET granted=excluded.granted,source=excluded.source,basis=excluded.basis,version=excluded.version,updated_at=excluded.updated_at').run(key,granted?1:0,source,basis,next,iso(time));
  db.prepare('INSERT INTO volunteer_consent_changes VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),key,granted?1:0,source,basis,next,actor,iso(time));
  audit({id:actor},granted?'grant_volunteer_reminder_consent':'withdraw_volunteer_reminder_consent','constituents',key,{source,basis,version:next,meaning:'Reminder consent only; separate from contact preference and from any login role'});
  return consent(key);
 }
 function reminderConfig(shiftId){
  const row=db.prepare('SELECT * FROM volunteer_reminder_config WHERE shift_id=?').get(shiftId);
  if(!row)return {shiftId,leadMinutes:[...defaultLeads],enabled:true,version:0,updatedAt:null,configured:false};
  return {shiftId,leadMinutes:JSON.parse(row.lead_minutes),enabled:Boolean(row.enabled),version:row.version,updatedAt:row.updated_at,configured:true};
 }
 function scheduleShiftReminders(record,shift,time){
  const settings=reminderConfig(shift.id);if(!settings.enabled)return 0;
  const start=shiftStartMs(shift);let scheduled=0;
  for(const lead of settings.leadMinutes){
   const sendAt=start-lead*60000;if(sendAt<=time)continue;
   if(db.prepare('SELECT 1 FROM volunteer_reminders WHERE reservation_id=? AND kind=? AND lead_minutes=?').get(record.id,'Shift reminder',lead))continue;
   db.prepare('INSERT INTO volunteer_reminders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),shift.id,record.id,record.constituentId,'Shift reminder',lead,iso(sendAt),'Pending',0,iso(sendAt),1,iso(time),iso(time));scheduled++;
  }
  return scheduled;
 }
 function scheduleNotice(record,shift,kind,time){
  if(db.prepare('SELECT 1 FROM volunteer_reminders WHERE reservation_id=? AND kind=? AND lead_minutes=0').get(record.id,kind))return 0;
  db.prepare('INSERT INTO volunteer_reminders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),shift.id,record.id,record.constituentId,kind,0,iso(time),'Pending',0,iso(time),1,iso(time),iso(time));return 1;
 }
 const reminderRow=key=>{const row=db.prepare('SELECT * FROM volunteer_reminders WHERE id=?').get(key);if(!row)fail(404,'Volunteer reminder not found');return row;};
 function outcome(row,status,reason,time,retryAt=null){db.prepare('INSERT INTO volunteer_reminder_outcomes VALUES(?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.version+1,status,reason,iso(time),retryAt);}
 function suppressReminder(row,reason,time){
  db.prepare("UPDATE volunteer_reminders SET status='Suppressed',version=version+1,updated_at=? WHERE id=?").run(iso(time),row.id);
  outcome(row,'Suppressed',reason,time);
  audit({id:'system'},'suppress_volunteer_reminder','volunteerShifts',row.shift_id,{reminderId:row.id,reason,delivery:'Not queued and not delivered'});
 }
 function suppressForReservation(reservationId,reason,time){
  let suppressed=0;
  for(const row of db.prepare("SELECT * FROM volunteer_reminders WHERE reservation_id=? AND status='Pending' ORDER BY id").all(reservationId)){suppressReminder(row,reason,time);suppressed++;}
  return suppressed;
 }
 // Every reason here is rechecked at queue time, not only at scheduling time.
 // Structural facts (a cancelled place, a closed or finished shift, a lost
 // identity) end a reminder as soon as they are observed. Consent and contact
 // preference are judged only when the reminder is actually due, so a volunteer
 // who grants consent after signing up is not silently written off.
 function reminderSource(row,time,due=true){
  let record;try{record=get('shiftReservations',row.reservation_id);}catch(e){if(e.status===404)return {reason:'Reservation unavailable'};throw e;}
  if(record.status!=='Reserved')return {reason:'Reservation is no longer reserved'};
  let shift;try{shift=get('volunteerShifts',row.shift_id);}catch(e){if(e.status===404)return {reason:'Shift unavailable'};throw e;}
  if(shift.status!=='Open')return {reason:'Shift is closed'};
  if(shiftEndMs(shift)<=time)return {reason:'Shift has already finished'};
  const who=person(record.constituentId);
  if(!who)return {reason:'Volunteer identity unavailable'};
  if(!due)return {record,shift,who,deferred:true};
  if(who.preference==='Do not contact')return {reason:'Contact preference blocks this reminder'};
  if(!consent(record.constituentId).granted)return {reason:'Reminder consent is not granted'};
  return {record,shift,who};
 }
 function suppressAll(reason,time){let suppressed=0;transaction(()=>{for(const row of db.prepare("SELECT * FROM volunteer_reminders WHERE status='Pending' ORDER BY id").all()){suppressReminder(row,reason,time);suppressed++;}});return {queued:0,suppressed,failed:0,suspended:true};}
 function runVolunteerReminders(time=clock()){
  if(!isTenantActive())return suppressAll('Workspace is suspended',time);
  let queued=0,suppressed=0,failed=0;
  const due=db.prepare("SELECT id FROM volunteer_reminders WHERE status='Pending' ORDER BY next_attempt,send_at,id LIMIT 100").all();
  for(const candidate of due){
   try{
    const result=transaction(()=>{
     const row=reminderRow(candidate.id);if(row.status!=='Pending')return;
     if(!isTenantActive()){suppressReminder(row,'Workspace is suspended',time);return 'Suppressed';}
     const due=row.send_at<=iso(time)&&row.next_attempt<=iso(time);
     const source=reminderSource(row,time,due);
     if(source.reason){suppressReminder(row,source.reason,time);return 'Suppressed';}
     if(!due)return;
     // Provider-neutral envelope. No contact address, message body or provider
     // identity leaves this module; the outbox owns contact resolution.
     const envelope={kind:row.kind,reminderId:row.id,constituentId:row.constituent_id,shiftId:row.shift_id,reservationId:row.reservation_id,shiftName:source.shift.name,startsAt:iso(shiftStartMs(source.shift)),sendAt:row.send_at,leadMinutes:row.lead_minutes,consent:{granted:true,source:consent(row.constituent_id).source,recordedAt:consent(row.constituent_id).updatedAt},delivery:QUEUED_NOTE};
     const accepted=outbox(envelope);
     if(!accepted||accepted.accepted!==true){suppressReminder(row,'Outbox declined: '+String(accepted&&accepted.reason||'no acceptance recorded').slice(0,200),time);return 'Suppressed';}
     db.prepare('INSERT INTO volunteer_reminder_notices VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.constituent_id,row.shift_id,row.reservation_id,row.kind,iso(time),String(accepted.reference||'internal-only').slice(0,200));
     db.prepare("UPDATE volunteer_reminders SET status='Queued',version=version+1,updated_at=?,attempt_count=attempt_count+1 WHERE id=?").run(iso(time),row.id);
     outcome(row,'Queued',QUEUED_NOTE,time);
     audit({id:'system'},'queue_volunteer_reminder','volunteerShifts',row.shift_id,{reminderId:row.id,constituentId:row.constituent_id,kind:row.kind,delivery:QUEUED_NOTE});
     if(!isTenantActive()||reminderSource(row,time).reason)fail(409,'Reminder source changed before queueing');
     return 'Queued';
    });
    if(result==='Queued')queued++;if(result==='Suppressed')suppressed++;
   }catch(e){
    failed++;
    try{
     const recovery=transaction(()=>{
      const row=reminderRow(candidate.id);if(row.status!=='Pending')return;
      if(!isTenantActive()){suppressReminder(row,'Workspace is suspended',time);return 'Suppressed';}
      if(row.attempt_count>=4){db.prepare('UPDATE volunteer_reminders SET attempt_count=attempt_count+1 WHERE id=?').run(row.id);suppressReminder(row,'Retry limit reached; review the shift and schedule a new reminder',time);return 'Suppressed';}
      const retryAt=iso(time+60000);
      db.prepare('UPDATE volunteer_reminders SET version=version+1,updated_at=?,next_attempt=?,attempt_count=attempt_count+1 WHERE id=?').run(iso(time),retryAt,row.id);
      outcome(row,'Failed','Reminder preparation failed; retry scheduled. Nothing was queued or delivered',time,retryAt);
      audit({id:'system'},'retry_volunteer_reminder','volunteerShifts',row.shift_id,{reminderId:row.id,retryAt,delivery:'Not queued and not delivered'});
      return 'Retried';
     });
     if(recovery==='Suppressed')suppressed++;
    }catch{console.error('Volunteer reminder persistence is unavailable. Nothing was queued; the worker will retry pending reminders.');}
   }
  }
  return {queued,suppressed,failed,suspended:false};
 }
 // Shared by the volunteer self-cancellation and the staff cancellation so one
 // set of capacity, overlap and waitlist rules governs both.
 function cancelReservation(record,actor,actorKind,reason,time){
  const shift=shiftRecord(record.shiftId);
  if(shiftStartMs(shift)<=time)fail(409,'This shift has already started. Ask staff to correct attendance instead of cancelling.');
  if(record.status==='Cancelled')fail(409,'This reservation is already cancelled.');
  const fromStatus=record.status,fromVersion=record.version;
  const next={...record,status:'Cancelled',version:record.version+1,updatedAt:iso(time)};
  validate('shiftReservations',{shiftId:record.shiftId,constituentId:record.constituentId,status:'Cancelled',notes:record.notes||''},record.id,record);
  put('shiftReservations',next);
  retainHistory(next,actorKind==='Volunteer'?'Self-cancelled':'Cancelled',fromStatus,fromVersion,actor,actorKind,reason,time);
  const suppressed=suppressForReservation(record.id,'Reservation cancelled',time);
  const claimsSuppressed=suppressClaimsForReservation(record.id,'The place this claim belongs to was cancelled',actor,time);
  audit({id:actor},'cancel_volunteer_reservation','volunteerShifts',record.shiftId,{reservationId:record.id,constituentId:record.constituentId,fromStatus,actorKind,reason,remindersSuppressed:suppressed,claimsSuppressed,retained:'Reservation, roster and attendance-claim history are retained'});
  const promoted=fromStatus==='Reserved'?promoteWaitlist(shift,actor,time,1):[];
  return {reservation:next,promoted,remindersSuppressed:suppressed,claimsSuppressed};
 }
 // Promotion honours the same capacity and overlap rules as a fresh reservation.
 // A candidate that would overlap another reserved shift is skipped, retained and
 // left on the waitlist rather than silently dropped.
 function promoteWaitlist(shift,actor,time,limit=100){
  const promoted=[];
  if(shift.status!=='Open'||shiftStartMs(shift)<=time)return promoted;
  for(const candidate of waitlist(shift.id)){
   if(promoted.length>=limit)break;
   if(reserved(shift.id)>=shift.capacity)break;
   const fresh=get('shiftReservations',candidate.id);
   if(fresh.status!=='Waitlisted')continue;
   const who=person(fresh.constituentId);
   if(!who){retainHistory(fresh,'Promotion skipped',fresh.status,fresh.version,actor,'System','Volunteer identity is unavailable',time,true);continue;}
   const next={...fresh,status:'Reserved',version:fresh.version+1,updatedAt:iso(time)};
   try{validate('shiftReservations',{shiftId:fresh.shiftId,constituentId:fresh.constituentId,status:'Reserved',notes:fresh.notes||''},fresh.id,fresh);}
   catch(e){retainHistory(fresh,'Promotion skipped',fresh.status,fresh.version,actor,'System',(e.message||'Promotion rule blocked this place').slice(0,500),time,true);continue;}
   put('shiftReservations',next);
   retainHistory(next,'Promoted from waitlist','Waitlisted',fresh.version,actor,'System','A reserved place became available',time);
   scheduleNotice(next,shift,'Waitlist promotion',time);
   scheduleShiftReminders(next,shift,time);
   audit({id:actor},'promote_volunteer_waitlist','volunteerShifts',shift.id,{reservationId:next.id,constituentId:next.constituentId,retained:'Original waitlist place and its history are retained'});
   promoted.push(next);
  }
  return promoted;
 }
 function createReservation(shift,constituentId,requestedStatus,notes,actor,actorKind,time){
  if(shift.status!=='Open')fail(409,'This shift is closed and cannot accept sign-ups.');
  if(shiftStartMs(shift)<=time)fail(409,'This shift has already started and cannot accept sign-ups.');
  const active=reservations().filter(r=>r.shiftId===shift.id&&r.status!=='Cancelled');
  if(active.some(r=>r.constituentId===constituentId))fail(409,'You already hold a place or waitlist place on this shift.');
  if(requestedStatus==='Reserved'&&reserved(shift.id)>=shift.capacity)fail(409,'This shift is full. Join the waitlist instead.');
  const record=create('shiftReservations',{shiftId:shift.id,constituentId,status:requestedStatus,notes:notes||''},{id:actor});
  // Re-count inside the same write lock: a place can never exceed capacity.
  if(reserved(shift.id)>shift.capacity)fail(409,'This shift filled while your request was being saved. Join the waitlist instead.');
  retainHistory(record,requestedStatus==='Reserved'?'Reserved':'Joined waitlist',null,null,actor,actorKind,requestedStatus==='Reserved'?'Volunteer place confirmed':'Waitlist place recorded',time);
  if(requestedStatus==='Reserved')scheduleShiftReminders(record,shift,time);
  audit({id:actor},'create_volunteer_reservation','volunteerShifts',shift.id,{reservationId:record.id,constituentId,status:requestedStatus,actorKind});
  return record;
 }
 function issueAccess(constituentId,days,actor,time){
  const who=person(constituentId);
  if(!who)fail(400,'Volunteer sign-up links require an active individual, alumni, employee or staff constituent.');
  if(db.prepare("SELECT COUNT(*) n FROM volunteer_portal_access WHERE status='Active'").get().n>=500)fail(409,'This workspace has 500 active sign-up links. Revoke an unused link first.');
  const key=randomUUID(),nonce=randomBytes(32).toString('hex'),payload='wv1.'+key+'.'+nonce,expires=time+days*86400000;
  db.prepare('INSERT INTO volunteer_portal_access VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(key,constituentId,digest(nonce),'Active',actor,iso(time),iso(expires),null,null,null,0,1);
  return {row:accessRow(key),token:payload+'.'+sign(payload)};
 }
 function verifyToken(value,time){
  const match=typeof value==='string'&&TOKEN.exec(value);
  if(!match)fail(401,'This sign-up link is not valid. Ask staff for a new link.');
  const [,key,nonce,signature]=match,payload='wv1.'+key+'.'+nonce;
  if(!sameSecret(sign(payload),signature))fail(401,'This sign-up link is not valid. Ask staff for a new link.');
  const row=accessRow(key);
  if(!row||!sameSecret(digest(nonce),row.nonce_hash))fail(401,'This sign-up link is not valid. Ask staff for a new link.');
  if(row.status!=='Active')fail(403,'This sign-up link was revoked. Ask staff for a new link.');
  if(Date.parse(row.expires_at)<=time)fail(403,'This sign-up link has expired. Ask staff for a new link.');
  if(!isTenantActive())fail(403,'This workspace is unavailable. Ask staff to confirm your shift.');
  const who=person(row.constituent_id);
  if(!who)fail(403,'This sign-up link is no longer connected to an active volunteer record. Ask staff for a new link.');
  return {row,who};
 }
 const engine={db,list,get,create,put,validate,audit,transaction,isTenantActive,config,clock,defaultLeads,outbox,limits,rates,rateLimit,requestLedgerLimit,recordedRequests,accessRow,person,reservations,reserved,waitlist,shiftRecord,shiftSummary,retainHistory,historyFor,consent,setConsent,reminderConfig,scheduleShiftReminders,scheduleNotice,reminderRow,suppressForReservation,suppressAll,runVolunteerReminders,cancelReservation,promoteWaitlist,createReservation,issueAccess,verifyToken,sign,digest,
  claimRow,claimView,standingClaim,recordClaim,decideClaim,suppressClaimsForReservation,signatureOf};
 shared.set(db,engine);
 return engine;
}

// ---------------------------------------------------------------------------
// Public, unauthenticated volunteer surface.
// ---------------------------------------------------------------------------
export function installPublic(app,ctx){
 if(!app||!ctx?.db)return null;
 const engine=core(ctx),{db,get,transaction,audit,clock}=engine,config=ctx.config||{};
 const prefix='/api/public/volunteer';
 const allowedOrigins=new Set((Array.isArray(config.allowedOrigins)?config.allowedOrigins:[]).filter(value=>typeof value==='string'));
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 // Strict own-origin policy. This surface never reads a cookie, so there is no
 // ambient authority for a cross-site page to abuse; the checks below refuse the
 // attempt anyway rather than relying on that.
 app.use(prefix,(req,res,next)=>{
  try{
   res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
   const site=req.get('Sec-Fetch-Site');
   if(site&&!['same-origin','same-site','none'].includes(site))fail(403,'Cross-site volunteer requests are denied.');
   const origin=req.get('Origin');
   if(origin){
    let parsed;try{parsed=new URL(origin);}catch{fail(403,'Volunteer request origin is denied.');}
    if(!allowedOrigins.has(origin)&&parsed.host!==req.get('Host'))fail(403,'Volunteer request origin is denied.');
   }
   if(!['GET','POST'].includes(req.method))fail(405,'This volunteer link supports reading and confirming your own shifts only.');
   const declared=Number(req.get('Content-Length')||0);
   if(declared>MAX_BODY_BYTES||(req.body!==undefined&&JSON.stringify(req.body??null).length>MAX_BODY_BYTES))fail(413,'Request too large');
   const time=clock();
   engine.rateLimit('ip:'+req.ip,engine.rates.ip,60000,time);
   next();
  }catch(e){next(e);}
 });
 // Every request proves itself with the issued token. No session, no cookie.
 app.use(prefix,(req,res,next)=>{
  try{
   const time=clock(),header=req.get('X-Volunteer-Token');
   const presented=typeof header==='string'&&header.trim()?header.trim():typeof req.body?.token==='string'?req.body.token:'';
   const {row,who}=engine.verifyToken(presented,time);
   engine.rateLimit('link:'+row.id,engine.rates.link,60000,time);
   db.prepare('UPDATE volunteer_portal_access SET last_used_at=?,use_count=use_count+1 WHERE id=?').run(iso(time),row.id);
   req.volunteer={access:row,person:who,actor:'volunteer-link:'+row.id,time};
   next();
  }catch(e){next(e);}
 });
 // The only data a link may return: this person's own places, the open shift
 // list they may join, and their own reminder state. Nothing else is reachable.
 const scoped=(req,time)=>{
  const key=req.volunteer.person.id,own=engine.reservations().filter(r=>r.constituentId===key);
  const all=engine.list('volunteerShifts'),byId=new Map(all.map(s=>[s.id,s]));
  const openShifts=all.filter(s=>s.status==='Open'&&shiftStartMs(s)>time).sort((a,b)=>(a.date+a.startTime).localeCompare(b.date+b.startTime)).slice(0,100);
  return {
   volunteer:{name:req.volunteer.person.name,expiresAt:req.volunteer.access.expires_at},
   consent:(({granted,source,updatedAt,withdrawnByVolunteer})=>({granted,source,updatedAt,withdrawnByVolunteer}))(engine.consent(key)),
   contactPreference:req.volunteer.person.preference,
   reservations:own.map(r=>{const shift=byId.get(r.shiftId),claim=db.prepare('SELECT * FROM volunteer_attendance_claims WHERE reservation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(r.id);return {id:r.id,version:r.version,status:r.status,notes:r.notes||'',shift:shift?engine.shiftSummary(shift,time):null,history:engine.historyFor(r.id),claim:claim?engine.claimView(claim):null};}).sort((a,b)=>((b.shift?.date||'')+(b.shift?.startTime||'')).localeCompare((a.shift?.date||'')+(a.shift?.startTime||''))),
   shifts:openShifts.map(s=>engine.shiftSummary(s,time)),
   reminders:db.prepare('SELECT * FROM volunteer_reminders WHERE constituent_id=? ORDER BY send_at DESC,id LIMIT 50').all(key).map(r=>({id:r.id,shiftId:r.shift_id,kind:r.kind,sendAt:r.send_at,status:r.status,leadMinutes:r.lead_minutes})),
   link:{confirmationsRecorded:engine.recordedRequests(req.volunteer.access.id),confirmationsLimit:engine.requestLedgerLimit},
   scope:PUBLIC_SCOPE,delivery:DELIVERY_SCOPE,attendance:CLAIM_NOTE,timezone:'UTC'
  };
 };
 // A replayed confirmation returns the original saved answer and changes nothing.
 // The replay answer is given before the ledger ceiling is consulted, so an
 // exhausted link can still be told what it already did; only a genuinely new
 // confirmation is refused, and the refusal is scoped to that one link.
 function once(req,requestId,actionName,work){
  const stored=db.prepare('SELECT response FROM volunteer_portal_requests WHERE access_id=? AND request_id=?').get(req.volunteer.access.id,requestId);
  if(stored)return {...JSON.parse(stored.response),replayed:true};
  return transaction(()=>{
   const again=db.prepare('SELECT response FROM volunteer_portal_requests WHERE access_id=? AND request_id=?').get(req.volunteer.access.id,requestId);
   if(again)return {...JSON.parse(again.response),replayed:true};
   // Retained evidence is bounded rather than trimmed: it refuses here instead of
   // growing, so one link can never reach the workspace backup row budget.
   if(engine.recordedRequests(req.volunteer.access.id)>=engine.requestLedgerLimit)fail(409,'This sign-up link has recorded its limit of '+engine.requestLedgerLimit+' confirmations. Ask staff for a new link; everything you have already confirmed stays exactly as it is.');
   const result=work();
   db.prepare('INSERT INTO volunteer_portal_requests VALUES(?,?,?,?,?,?)').run(randomUUID(),req.volunteer.access.id,requestId,actionName,JSON.stringify(result),iso(req.volunteer.time));
   return result;
  });
 }
 app.get(prefix,action((req,res)=>{z.object({}).strict().parse(req.query);res.json(scoped(req,req.volunteer.time));}));
 app.post(prefix+'/reservations',action((req,res)=>{
  const body=z.object({token:z.string().max(400).optional(),requestId:uuid,shiftId:uuid,join:z.enum(['Reserved','Waitlisted']),notes:z.string().trim().max(500).optional()}).strict().parse(req.body);
  const time=req.volunteer.time;
  const result=once(req,body.requestId,'reservation',()=>{
   const shift=engine.shiftRecord(body.shiftId);
   const record=engine.createReservation(shift,req.volunteer.person.id,body.join,body.notes,req.volunteer.actor,'Volunteer',time);
   return {reservationId:record.id,status:record.status,shiftId:shift.id,confirmedAt:iso(time),delivery:DELIVERY_SCOPE};
  });
  res.status(result.replayed?200:201).json({...result,...scoped(req,time)});
 }));
 app.post(prefix+'/reservations/:id/cancel',action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({token:z.string().max(400).optional(),requestId:uuid,version,reason:z.string().trim().max(500).optional()}).strict().parse(req.body);
  const time=req.volunteer.time;
  const result=once(req,body.requestId,'cancel',()=>{
   let record;try{record=get('shiftReservations',req.params.id);}catch(e){if(e.status===404)fail(404,'This reservation is not available on your sign-up link.');throw e;}
   if(record.constituentId!==req.volunteer.person.id)fail(404,'This reservation is not available on your sign-up link.');
   if(record.version!==body.version)fail(409,'Your place changed. Reload this page and try again.');
   const outcome=engine.cancelReservation(record,req.volunteer.actor,'Volunteer',body.reason?.trim()||'Cancelled by the volunteer from their sign-up link',time);
   return {reservationId:outcome.reservation.id,status:outcome.reservation.status,promotedCount:outcome.promoted.length,remindersSuppressed:outcome.remindersSuppressed,claimsSuppressed:outcome.claimsSuppressed,retained:'Your original place and its history are retained.',delivery:DELIVERY_SCOPE};
  });
  res.json({...result,...scoped(req,time)});
 }));
 app.post(prefix+'/reservations/:id/attendance',action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({token:z.string().max(400).optional(),requestId:uuid,version,arrivedAt:z.iso.datetime(),departedAt:z.iso.datetime()}).strict().parse(req.body);
  const time=req.volunteer.time;
  const result=once(req,body.requestId,'attendance',()=>{
   let record;try{record=get('shiftReservations',req.params.id);}catch(e){if(e.status===404)fail(404,'This reservation is not available on your sign-up link.');throw e;}
   if(record.constituentId!==req.volunteer.person.id)fail(404,'This reservation is not available on your sign-up link.');
   if(record.version!==body.version)fail(409,'Your place changed. Reload this page and try again.');
   const claim=engine.recordClaim(record,body.arrivedAt,body.departedAt,req.volunteer.actor,time);
   return {claimId:claim.id,status:claim.status,arrivedAt:claim.arrived_at,departedAt:claim.departed_at,attendance:CLAIM_NOTE,ledger:LEDGER_NOTE};
  });
  res.status(result.replayed?200:201).json({...result,...scoped(req,time)});
 }));
 app.post(prefix+'/consent',action((req,res)=>{
  const body=z.object({token:z.string().max(400).optional(),requestId:uuid,granted:z.boolean()}).strict().parse(req.body);
  const time=req.volunteer.time;
  const result=once(req,body.requestId,'consent',()=>{
   const state=engine.setConsent(req.volunteer.person.id,body.granted,'Volunteer',body.granted?'Volunteer granted shift reminders from their own sign-up link':'Volunteer withdrew shift reminders from their own sign-up link',req.volunteer.actor,time);
   if(!body.granted)for(const row of db.prepare("SELECT * FROM volunteer_reminders WHERE constituent_id=? AND status='Pending' ORDER BY id").all(req.volunteer.person.id))engine.suppressForReservation(row.reservation_id,'Reminder consent withdrawn',time);
   return {consent:{granted:state.granted,source:state.source,updatedAt:state.updatedAt},delivery:DELIVERY_SCOPE};
  });
  res.json({...result,...scoped(req,time)});
 }));
 app.use(prefix,(req,res)=>res.status(404).json({error:'This volunteer link does not open that page.'}));
 return {close:()=>{}};
}

// ---------------------------------------------------------------------------
// Staff surface.
// ---------------------------------------------------------------------------
export function install(app,ctx){
 if(!app||!ctx?.db)return null;
 const engine=core(ctx),{db,get,list,audit,transaction}=engine;
 const {csrf,write,isTenantActive=()=>true,recheckAccess=()=>true}=ctx,config=ctx.config||{};
 const clock=engine.clock,prefix='/api/volunteer-portal';
 const current=req=>{if(!req?.user||!['admin','staff'].includes(req.user.role))fail(403,'Volunteer sign-up administration requires active staff access');if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');};
 const authorized=(req,res,next)=>{try{current(req);next();}catch(e){next(e);}};
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 app.use(prefix,authorized);
 const accessView=row=>({id:row.id,constituentId:row.constituent_id,status:row.status,issuedBy:row.issued_by,issuedAt:row.issued_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,revokeReason:row.revoke_reason,lastUsedAt:row.last_used_at,useCount:row.use_count,version:row.version,expired:Date.parse(row.expires_at)<=clock(),confirmationsRecorded:engine.recordedRequests(row.id),confirmationsLimit:engine.requestLedgerLimit,confirmationsExhausted:engine.recordedRequests(row.id)>=engine.requestLedgerLimit});
 const lastOutcome=key=>{const r=db.prepare('SELECT * FROM volunteer_reminder_outcomes WHERE reminder_id=? ORDER BY at DESC,rowid DESC LIMIT 1').get(key);return r?{status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at}:null;};
 const reminderView=row=>({id:row.id,shiftId:row.shift_id,reservationId:row.reservation_id,constituentId:row.constituent_id,kind:row.kind,leadMinutes:row.lead_minutes,sendAt:row.send_at,status:row.status,attemptCount:row.attempt_count,nextAttempt:row.status==='Pending'?row.next_attempt:null,version:row.version,lastOutcome:lastOutcome(row.id),queued:Boolean(db.prepare('SELECT 1 FROM volunteer_reminder_notices WHERE reminder_id=?').get(row.id))});
 function overview(req){
  const time=clock(),shifts=list('volunteerShifts').sort((a,b)=>(a.date+a.startTime).localeCompare(b.date+b.startTime)).slice(0,200);
  const all=engine.reservations();
  return {
   generatedAt:iso(time),timezone:'UTC',
   access:db.prepare('SELECT * FROM volunteer_portal_access ORDER BY issued_at DESC,id LIMIT 200').all().map(accessView),
   shifts:shifts.map(shift=>({...engine.shiftSummary(shift,time),reminderConfig:engine.reminderConfig(shift.id),roster:all.filter(r=>r.shiftId===shift.id).map(r=>({id:r.id,version:r.version,status:r.status,constituentId:r.constituentId,notes:r.notes||'',history:engine.historyFor(r.id)}))})),
   reminders:db.prepare('SELECT * FROM volunteer_reminders ORDER BY send_at DESC,id LIMIT 200').all().map(reminderView),
   consent:db.prepare('SELECT * FROM volunteer_reminder_consent ORDER BY updated_at DESC,constituent_id LIMIT 200').all().map(r=>({constituentId:r.constituent_id,granted:Boolean(r.granted),source:r.source,basis:r.basis,updatedAt:r.updated_at,version:r.version,withdrawnByVolunteer:engine.consent(r.constituent_id).withdrawnByVolunteer})),
   cancellations:db.prepare("SELECT * FROM volunteer_reservation_history WHERE action IN ('Self-cancelled','Cancelled','Promoted from waitlist','Promotion skipped') ORDER BY at DESC,id LIMIT 100").all().map(r=>({id:r.id,reservationId:r.reservation_id,shiftId:r.shift_id,constituentId:r.constituent_id,action:r.action,fromStatus:r.from_status,toStatus:r.to_status,actorKind:r.actor_kind,reason:r.reason,at:r.at})),
   claims:db.prepare('SELECT * FROM volunteer_attendance_claims ORDER BY created_at DESC,rowid DESC LIMIT 200').all().map(engine.claimView),
   pendingClaimCount:db.prepare("SELECT COUNT(*) n FROM volunteer_attendance_claims WHERE status='Claimed'").get().n,
   attendance:CLAIM_NOTE,ledger:LEDGER_NOTE,
   defaults:{leadMinutes:engine.defaultLeads,linkPath:'/volunteer'},
   outbox:{configured:typeof config.sendReminder==='function',mode:typeof config.sendReminder==='function'?'Injected outbox':'Internal only'},
   delivery:DELIVERY_SCOPE,scope:'Volunteer self-service administration only. No revenue, receipt or external message is created here.'
  };
 }
 app.get(prefix,action((req,res)=>{z.object({}).strict().parse(req.query);res.json(overview(req));}));
 app.post(prefix+'/access',csrf,write,action((req,res)=>{
  const body=z.object({constituentId:uuid,days:z.number().int().min(1).max(180).default(30),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock();
   if(db.prepare("SELECT 1 FROM volunteer_portal_access WHERE constituent_id=? AND status='Active' AND expires_at>?").get(body.constituentId,iso(time)))fail(409,'This volunteer already has an active sign-up link. Revoke it before issuing another.');
   const {row,token}=engine.issueAccess(body.constituentId,body.days,req.user.id,time);
   audit(req.user,'issue_volunteer_link','constituents',body.constituentId,{accessId:row.id,expiresAt:row.expires_at,reason:body.reason,delivery:'Link issued in this workspace only; nothing was sent'});
   current(req);
   return {access:accessView(engine.accessRow(row.id)),token,linkPath:'/volunteer?t='+encodeURIComponent(token),notice:'Copy this link now. It is shown once and is never stored or sent by this workspace.'};
  });
  res.status(201).json(result);
 }));
 app.post(prefix+'/access/:id/revoke',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock(),row=engine.accessRow(req.params.id);
   if(!row)fail(404,'Sign-up link not found');
   if(row.status!=='Active')fail(409,'This sign-up link is already revoked.');
   if(row.version!==body.version)fail(409,'Sign-up link changed. Reload its current version.');
   db.prepare("UPDATE volunteer_portal_access SET status='Revoked',revoked_at=?,revoke_reason=?,version=version+1 WHERE id=?").run(iso(time),body.reason,row.id);
   audit(req.user,'revoke_volunteer_link','constituents',row.constituent_id,{accessId:row.id,reason:body.reason});
   current(req);
   return {access:accessView(engine.accessRow(row.id))};
  });
  res.json(result);
 }));
 app.post(prefix+'/shifts/:id/reminder-config',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({leadMinutes:z.array(z.number().int().min(0).max(20160)).max(5),enabled:z.boolean(),reason:reasonText}).strict().parse(req.body);
  if(new Set(body.leadMinutes).size!==body.leadMinutes.length)fail(400,'Choose each reminder lead time once.');
  const result=transaction(()=>{
   current(req);const time=clock(),shift=engine.shiftRecord(req.params.id),leads=[...body.leadMinutes].sort((a,b)=>b-a);
   const previous=engine.reminderConfig(shift.id);
   db.prepare('INSERT INTO volunteer_reminder_config VALUES(?,?,?,?,?,?) ON CONFLICT(shift_id) DO UPDATE SET lead_minutes=excluded.lead_minutes,enabled=excluded.enabled,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(shift.id,JSON.stringify(leads),body.enabled?1:0,previous.version+1,iso(time),req.user.id);
   let scheduled=0,suppressed=0;
   for(const record of engine.reservations().filter(r=>r.shiftId===shift.id&&r.status==='Reserved'))scheduled+=engine.scheduleShiftReminders(record,shift,time);
   if(!body.enabled)for(const record of engine.reservations().filter(r=>r.shiftId===shift.id))suppressed+=engine.suppressForReservation(record.id,'Shift reminders were turned off',time);
   audit(req.user,'configure_volunteer_reminders','volunteerShifts',shift.id,{leadMinutes:leads,enabled:body.enabled,reason:body.reason,scheduled,suppressed,delivery:DELIVERY_SCOPE});
   current(req);
   return {reminderConfig:engine.reminderConfig(shift.id),scheduled,suppressed,delivery:DELIVERY_SCOPE};
  });
  res.json(result);
 }));
 app.post(prefix+'/reservations/:id/cancel',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock();
   let record;try{record=get('shiftReservations',req.params.id);}catch(e){if(e.status===404)fail(404,'Reservation not found');throw e;}
   if(record.version!==body.version)fail(409,'Reservation changed. Reload its current version.');
   const outcome=engine.cancelReservation(record,req.user.id,'Staff',body.reason,time);
   current(req);
   return {reservation:{id:outcome.reservation.id,status:outcome.reservation.status,version:outcome.reservation.version},promoted:outcome.promoted.map(r=>({id:r.id,constituentId:r.constituentId,status:r.status})),remindersSuppressed:outcome.remindersSuppressed,claimsSuppressed:outcome.claimsSuppressed,retained:'Reservation, roster and attendance-claim history are retained'};
  });
  res.json(result);
 }));
 app.post(prefix+'/shifts/:id/promote',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock(),shift=engine.shiftRecord(req.params.id);
   const promoted=engine.promoteWaitlist(shift,req.user.id,time);
   audit(req.user,'reconcile_volunteer_waitlist','volunteerShifts',shift.id,{promoted:promoted.length,reason:body.reason});
   current(req);
   return {promoted:promoted.map(r=>({id:r.id,constituentId:r.constituentId,status:r.status})),shift:engine.shiftSummary(engine.shiftRecord(shift.id),time)};
  });
  res.json(result);
 }));
 app.post(prefix+'/consent',csrf,write,action((req,res)=>{
  const body=z.object({constituentId:uuid,granted:z.boolean(),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock();
   if(!engine.person(body.constituentId))fail(400,'Reminder consent requires an active person constituent.');
   const state=engine.setConsent(body.constituentId,body.granted,'Staff',body.reason,req.user.id,time);
   if(!body.granted)for(const record of engine.reservations().filter(r=>r.constituentId===body.constituentId))engine.suppressForReservation(record.id,'Reminder consent withdrawn',time);
   current(req);
   return {consent:{constituentId:body.constituentId,granted:state.granted,source:state.source,updatedAt:state.updatedAt,withdrawnByVolunteer:state.withdrawnByVolunteer},delivery:DELIVERY_SCOPE};
  });
  res.json(result);
 }));
 // Confirming or rejecting records the staff decision and nothing else. The hours
 // ledger is written only by the existing volunteer clock, as a separate action.
 for(const decision of ['confirm','reject'])app.post(prefix+'/claims/:id/'+decision,csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   current(req);const time=clock(),row=engine.claimRow(req.params.id);
   if(row.version!==body.version)fail(409,'This claim changed. Reload its current version before continuing');
   const outcome=engine.decideClaim(row,decision==='confirm'?'Confirmed':'Rejected',body.reason,req.user.id,time);
   current(req);
   return {...outcome,ledger:{written:false,note:LEDGER_NOTE},attendance:CLAIM_NOTE,retained:'The claim and every decision on it are retained'};
  });
  res.json(result);
 }));
 app.get(prefix+'/claims/:id',action((req,res)=>{
  uuid.parse(req.params.id);z.object({}).strict().parse(req.query);
  res.json({claim:engine.claimView(engine.claimRow(req.params.id)),attendance:CLAIM_NOTE,ledger:LEDGER_NOTE});
 }));
 app.get(prefix+'/reminders/:id',action((req,res)=>{
  uuid.parse(req.params.id);z.object({}).strict().parse(req.query);
  const row=engine.reminderRow(req.params.id);
  res.json({reminder:reminderView(row),outcomes:db.prepare('SELECT * FROM volunteer_reminder_outcomes WHERE reminder_id=? ORDER BY at DESC,rowid DESC LIMIT 100').all(row.id).map(r=>({id:r.id,status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at})),delivery:DELIVERY_SCOPE});
 }));
 const worker=config.worker===false?null:setInterval(()=>{try{engine.runVolunteerReminders();}catch{console.error('Volunteer reminder worker could not complete its current cycle.');}},60000);
 worker?.unref();
 const referencesConstituent=key=>Boolean(db.prepare('SELECT 1 FROM volunteer_portal_access WHERE constituent_id=? UNION ALL SELECT 1 FROM volunteer_reminders WHERE constituent_id=? UNION ALL SELECT 1 FROM volunteer_reservation_history WHERE constituent_id=? UNION ALL SELECT 1 FROM volunteer_reminder_consent WHERE constituent_id=? UNION ALL SELECT 1 FROM volunteer_attendance_claims WHERE constituent_id=? LIMIT 1').get(key,key,key,key,key));
 return {
  runVolunteerReminders:engine.runVolunteerReminders,
  suppressPendingForTenant:(time=clock())=>engine.suppressAll('Workspace is suspended',time),
  hasConstituentReferences:referencesConstituent,
  validateDeletion:(collection,record)=>{
   if(!record)return;
   if(collection==='constituents'&&referencesConstituent(record.id))fail(409,'Retained volunteer sign-up, reminder or consent history protects this constituent from deletion');
   if(collection==='volunteerShifts'&&db.prepare('SELECT 1 FROM volunteer_reservation_history WHERE shift_id=? UNION ALL SELECT 1 FROM volunteer_reminders WHERE shift_id=? UNION ALL SELECT 1 FROM volunteer_attendance_claims WHERE shift_id=? LIMIT 1').get(record.id,record.id,record.id))fail(409,'Retained volunteer roster, reminder and attendance-claim history protects this shift from deletion');
  },
  validateMutation:(collection,previous,next)=>{
   if(collection!=='volunteerShifts'||!previous||!next)return;
   if(db.prepare("SELECT 1 FROM volunteer_reminders WHERE shift_id=? AND status='Pending'").get(previous.id)&&(previous.date!==next.date||previous.startTime!==next.startTime||previous.endTime!==next.endTime))fail(409,'Pending volunteer reminders are scheduled against this shift time. Turn its reminders off, then create a new shift');
  },
  close:()=>{if(worker)clearInterval(worker);shared.delete(db);}
 };
}
