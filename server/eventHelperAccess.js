import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const id=z.uuid(),version=z.number().int().min(1),now=()=>new Date().toISOString();
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const eventView=e=>({id:e.id,name:e.name,date:e.date,location:e.location,version:e.version});
const ticketView=r=>({id:r.id,attendeeName:r.attendee_name,version:r.version,checkedIn:Boolean(r.checked_in_at),checkedInAt:r.checked_in_at||null});

// This router precedes the general business modules. Its DTOs never use financial
// ticket views; all remaining helper routes are denied by the enclosing app.
export function installEventHelperAccessRoutes(app,{db,get,list,audit,csrf,admin,transaction,recheckAccess,isTenantActive,checkInTicket}){
 db.exec(`CREATE TABLE IF NOT EXISTS event_helper_assignments(user_id TEXT NOT NULL REFERENCES users(id),event_id TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
 CREATE INDEX IF NOT EXISTS event_helper_assignments_event ON event_helper_assignments(event_id);
 CREATE TABLE IF NOT EXISTS event_helper_access_changes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,actor_json TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(user_id,to_version));
 CREATE TRIGGER IF NOT EXISTS event_helper_assignment_no_delete BEFORE DELETE ON event_helper_assignments BEGIN SELECT RAISE(ABORT,'Helper assignment history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS event_helper_access_no_update BEFORE UPDATE ON event_helper_access_changes BEGIN SELECT RAISE(ABORT,'Helper access history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS event_helper_access_no_delete BEFORE DELETE ON event_helper_access_changes BEGIN SELECT RAISE(ABORT,'Helper access history is retained'); END;`);
 const activeEvents=userId=>db.prepare('SELECT event_id FROM event_helper_assignments WHERE user_id=? AND active=1 ORDER BY event_id').all(userId).map(r=>r.event_id);
 const live=req=>{if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');};
 const role=req=>{live(req);if(!['admin','staff','event-helper'].includes(req.user.role))fail(403,'Event check-in access required');};
 function authorizedEvent(req,key){role(req);if(req.user.role==='event-helper'&&!db.prepare('SELECT 1 FROM event_helper_assignments WHERE user_id=? AND event_id=? AND active=1').get(req.user.id,key))fail(404,'Event check-in record not found');try{return get('events',key);}catch(e){if(e.status===404)fail(404,'Event check-in record not found');throw e;}}
 const account=key=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(key);if(!u)fail(404,'Account not found');if(!u.active||u.role!=='event-helper')fail(409,'Event assignments require an active event-helper account');return u;};
 const accessView=u=>({userId:u.id,version:u.version,eventIds:activeEvents(u.id)});
 function retain(req,userId,fromVersion,toVersion,before,after,reason){db.prepare('INSERT INTO event_helper_access_changes VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),userId,fromVersion,toVersion,JSON.stringify(before),JSON.stringify(after),reason,JSON.stringify({id:req.user.id,name:req.user.name,role:req.user.role}),now());}
 function replaceAssignments(userId,keys){const at=now();db.prepare('UPDATE event_helper_assignments SET active=0,version=version+1,updated_at=? WHERE user_id=? AND active=1').run(at,userId);for(const key of keys)db.prepare('INSERT INTO event_helper_assignments VALUES(?,?,1,1,?) ON CONFLICT(user_id,event_id) DO UPDATE SET active=1,version=event_helper_assignments.version+1,updated_at=excluded.updated_at').run(userId,key,at);}
 // Run within the existing account-change transaction; an old helper grant must
 // never reappear after a later role change or reactivation.
 function retireAccountAssignments(req,previous,nextVersion){const before=activeEvents(previous.id);if(!before.length)return;replaceAssignments(previous.id,[]);retain(req,previous.id,previous.version,nextVersion,before,[],'Account role or active status changed');audit(req.user,'revoke_event_helper_access','users',previous.id,{fromVersion:previous.version,toVersion:nextVersion,eventIds:before,reason:'Account role or active status changed'});}
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 const helperAction=fn=>action((req,res)=>{try{fn(req,res);}catch(e){if(req.user.role==='event-helper'&&!(e instanceof z.ZodError)){
   if(e.status===404)fail(404,'Event check-in record not found');
   if(e.status===409)fail(409,'Check-in changed or is unavailable. Refresh the event roster; ask staff if it is not ready');
   if(!e.status||e.status>=500)fail(e.status||500,'Check-in is unavailable. Ask staff to assist');
  }throw e;}});
 const prefix='/api/event-checkin';
 // Express otherwise treats HEAD as GET automatically. The helper business
 // contract deliberately admits only the listed GET/POST methods.
 app.use(prefix,(req,res,next)=>req.user.role==='event-helper'&&!['GET','POST'].includes(req.method)?res.status(403).json({error:'This account can check in tickets for assigned events only'}):next());
 app.get(prefix+'/events',helperAction((req,res)=>{role(req);z.object({}).strict().parse(req.query);let events;if(req.user.role==='event-helper')events=activeEvents(req.user.id).map(key=>authorizedEvent(req,key));else{events=list('events');if(events.length>100)fail(409,'Use staff Event operations to browse more than 100 events');}res.json({events:events.map(eventView),scope:'Assigned event ticket check-in only'});}));
 app.get(prefix+'/events/:eventId',helperAction((req,res)=>{const key=id.parse(req.params.eventId),q=z.object({limit:z.coerce.number().int().min(1).max(100).optional(),after:id.optional()}).strict().parse(req.query),e=authorizedEvent(req,key),limit=q.limit||100;
  const rows=db.prepare(`SELECT t.id,t.version,t.checked_in_at,json_extract(c.data,'$.name') AS attendee_name FROM event_tickets t JOIN records c ON c.collection='constituents' AND c.id=t.constituent_id
   WHERE t.event_id=? AND t.status='Issued' AND t.id>? AND json_extract(c.data,'$.mergedInto') IS NULL
   AND EXISTS(SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.constituentId')=t.constituent_id AND COALESCE(json_extract(r.value,'$.checkedIn'),0)=(t.checked_in_at IS NOT NULL))
   ORDER BY t.id LIMIT ?`).all(e.id,q.after||'',JSON.stringify(e.registrations||[]),limit+1);
  const page=rows.slice(0,limit);res.json({event:eventView(e),tickets:page.map(ticketView),nextCursor:rows.length>limit?page.at(-1).id:null});
 }));
 app.post(prefix+'/events/:eventId/tickets/:ticketId/checkin',csrf,helperAction((req,res)=>{const eventId=id.parse(req.params.eventId),ticketId=id.parse(req.params.ticketId),p=z.object({version,eventVersion:version}).strict().parse(req.body);
  const result=transaction(()=>{authorizedEvent(req,eventId);const match=db.prepare('SELECT event_id FROM event_tickets WHERE id=?').get(ticketId);if(!match||match.event_id!==eventId)fail(404,'Event check-in record not found');const changed=checkInTicket(req,{ticketId,eventId,...p});const c=get('constituents',changed.ticket.constituent_id);return {event:{id:eventId,version:changed.eventVersion},ticket:ticketView({...changed.ticket,attendee_name:c.name})};});res.json(result);
 }));
 app.get('/api/users/:id/event-access',admin,action((req,res)=>{live(req);id.parse(req.params.id);z.object({}).strict().parse(req.query);res.json(accessView(account(req.params.id)));}));
 app.patch('/api/users/:id/event-access',csrf,admin,action((req,res)=>{id.parse(req.params.id);const p=z.object({version,eventIds:z.array(id).max(100).refine(keys=>new Set(keys).size===keys.length,'Choose each event once'),reason:z.string().trim().min(1).max(500)}).strict().parse(req.body);
  const result=transaction(()=>{live(req);const u=account(req.params.id);if(u.version!==p.version)fail(409,'Account changed. Reload its current version before continuing');for(const key of p.eventIds)get('events',key);const before=activeEvents(u.id),after=[...p.eventIds].sort();replaceAssignments(u.id,after);db.prepare('UPDATE users SET version=version+1 WHERE id=?').run(u.id);const sessionsRevoked=db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id).changes;db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(u.id);retain(req,u.id,u.version,u.version+1,before,after,p.reason);audit(req.user,'replace_event_helper_access','users',u.id,{fromVersion:u.version,toVersion:u.version+1,before,after,reason:p.reason,sessionsRevoked});return {...accessView({...u,version:u.version+1}),sessionsRevoked};});res.json(result);
 }));
 return {retireAccountAssignments,validateDeletion:(collection,record)=>{if(collection==='events'&&db.prepare('SELECT 1 FROM event_helper_assignments WHERE event_id=?').get(record.id))fail(409,'Retained helper event assignment history protects this event from deletion');}};
}
