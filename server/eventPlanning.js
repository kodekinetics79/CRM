// Event planning and task follow-up.
//  - Event checklists, workflow assignments, templates, planning budgets and a
//    vendor list (buyer Q&A51/52: helpful, not a bidding or payment terminal).
//    Unresolved responsibility is always identifiable and never inferred silently.
//  - Task recurrence and escalation built beside the existing one-shot reminder
//    engine in server/taskReminders.js. That module is not modified, imported or
//    depended on: these tables, routes and workers are independent.
// Nothing here creates, posts or alters revenue. Planning amounts are estimates in
// exact integer cents and are never gifts, pledges, receipts or recorded expense.
// Escalations are handed to an injected provider-neutral outbox callback; preparing
// one is never delivery and no external provider is contacted.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const iso=time=>new Date(time).toISOString();
const uuid=z.uuid(),version=z.number().int().min(1),reasonText=z.string().trim().min(1).max(500);
const title=z.string().trim().min(1).max(250),detail=z.string().trim().max(2000).default(''),shortText=z.string().trim().max(250).default('');
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,'Use a valid calendar date');
const cents=z.number().int().min(0).max(1e12);
const ITEM_STATUS=['Open','In progress','Blocked','Done'],VENDOR_STATUS=['Considering','Confirmed','Declined'],BUDGET_KINDS=['Expense estimate','Income estimate'];
const PREPARED_NOTE='Prepared for the configured outbox. External delivery is not performed, confirmed or claimed here.';
const PLANNING_SCOPE='Planning estimates and vendor notes only. No gift, pledge, receipt, purchase order, payment or recorded expense is created here.';
// Templates are source constants, applied explicitly and then owned by the event.
const TEMPLATES={
 'fundraising-dinner':{name:'Fundraising dinner',items:[['Confirm venue contract and insurance',-45],['Confirm catering headcount and dietary needs',-21],['Confirm audio, staging and accessibility needs',-14],['Confirm table hosts and seating plan',-10],['Brief volunteers on arrival and check-in',-3],['Reconcile attendance and thank participants',3]]},
 'volunteer-day':{name:'Community volunteer day',items:[['Confirm site supervisor and safety briefing',-21],['Publish volunteer shifts and capacity',-14],['Confirm tools, supplies and water',-7],['Confirm arrival instructions and parking',-2],['Record volunteer hours and thank volunteers',2]]},
 'school-celebration':{name:'School celebration',items:[['Confirm school calendar slot and approval',-30],['Confirm student participation permissions',-14],['Confirm photography and media consent handling',-10],['Confirm setup and clean-up responsibilities',-2],['Record outcomes for the next school year',5]]}
};

export function install(app,ctx){
 if(!app||!ctx?.db)return null;
 const {db,list,get,create,audit,csrf,write,transaction,versionCheck,isTenantActive=()=>true,recheckAccess=()=>true,ownerAllowed=()=>true}=ctx,config=ctx.config||{};
 const clock=typeof config.clock==='function'?config.clock:Date.now;
 if(config.sendReminder!==undefined&&typeof config.sendReminder!=='function')throw new Error('eventPlanning.sendReminder must be a synchronous provider-neutral callback.');
 const outbox=config.sendReminder||(()=>({accepted:true,reference:'internal-only',channel:'Internal only'}));
 db.exec(`CREATE TABLE IF NOT EXISTS event_plan_checklists(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,name TEXT NOT NULL,template_key TEXT,status TEXT NOT NULL CHECK(status IN ('Active','Archived')),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS event_plan_checklists_event ON event_plan_checklists(event_id);
 CREATE TRIGGER IF NOT EXISTS event_plan_checklist_no_delete BEFORE DELETE ON event_plan_checklists BEGIN SELECT RAISE(ABORT,'Event planning history is retained'); END;
 CREATE TABLE IF NOT EXISTS event_plan_items(id TEXT PRIMARY KEY,checklist_id TEXT NOT NULL REFERENCES event_plan_checklists(id),event_id TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,due_date TEXT NOT NULL,assignee_id TEXT,assignee_version INTEGER,status TEXT NOT NULL CHECK(status IN ('Open','In progress','Blocked','Done')),sequence INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS event_plan_items_checklist ON event_plan_items(checklist_id,sequence);
 CREATE TRIGGER IF NOT EXISTS event_plan_item_no_delete BEFORE DELETE ON event_plan_items BEGIN SELECT RAISE(ABORT,'Event responsibility history is retained'); END;
 CREATE TABLE IF NOT EXISTS event_plan_item_history(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,action TEXT NOT NULL,from_version INTEGER,to_version INTEGER NOT NULL,before_json TEXT,after_json TEXT NOT NULL,reason TEXT NOT NULL,actor_json TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(item_id,to_version));
 CREATE TRIGGER IF NOT EXISTS event_plan_item_history_no_update BEFORE UPDATE ON event_plan_item_history BEGIN SELECT RAISE(ABORT,'Event responsibility history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS event_plan_item_history_no_delete BEFORE DELETE ON event_plan_item_history BEGIN SELECT RAISE(ABORT,'Event responsibility history is retained'); END;
 CREATE TABLE IF NOT EXISTS event_plan_budget_lines(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('Expense estimate','Income estimate')),category TEXT NOT NULL,description TEXT NOT NULL,planned_cents INTEGER NOT NULL CHECK(planned_cents>=0),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS event_plan_budget_event ON event_plan_budget_lines(event_id);
 CREATE TABLE IF NOT EXISTS event_plan_vendors(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,name TEXT NOT NULL,service TEXT NOT NULL,contact_name TEXT NOT NULL,contact_email TEXT NOT NULL,phone TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Considering','Confirmed','Declined')),notes TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS event_plan_vendors_event ON event_plan_vendors(event_id);
 CREATE TABLE IF NOT EXISTS task_recurrences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,cadence TEXT NOT NULL CHECK(cadence IN ('Daily','Weekly','Monthly')),interval_count INTEGER NOT NULL,remaining INTEGER NOT NULL,owner_id TEXT NOT NULL,owner_version INTEGER NOT NULL,task_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('Active','Completed','Cancelled','Suppressed')),current_task_id TEXT NOT NULL,next_due TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS task_one_active_recurrence ON task_recurrences(current_task_id) WHERE status='Active';
 CREATE TRIGGER IF NOT EXISTS task_recurrence_no_delete BEFORE DELETE ON task_recurrences BEGIN SELECT RAISE(ABORT,'Recurrence history is retained'); END;
 CREATE TABLE IF NOT EXISTS task_recurrence_occurrences(id TEXT PRIMARY KEY,recurrence_id TEXT NOT NULL,sequence INTEGER NOT NULL,task_id TEXT NOT NULL,due_date TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(recurrence_id,sequence));
 CREATE TRIGGER IF NOT EXISTS task_recurrence_occurrence_no_update BEFORE UPDATE ON task_recurrence_occurrences BEGIN SELECT RAISE(ABORT,'Recurrence occurrences are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS task_recurrence_occurrence_no_delete BEFORE DELETE ON task_recurrence_occurrences BEGIN SELECT RAISE(ABORT,'Recurrence occurrences are retained'); END;
 CREATE TABLE IF NOT EXISTS task_escalations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,task_version INTEGER NOT NULL,owner_id TEXT NOT NULL,after_minutes INTEGER NOT NULL,escalate_to_id TEXT NOT NULL,escalate_to_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('Armed','Escalated','Resolved','Cancelled','Suppressed')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS task_one_armed_escalation ON task_escalations(task_id) WHERE status='Armed';
 CREATE TRIGGER IF NOT EXISTS task_escalation_no_delete BEFORE DELETE ON task_escalations BEGIN SELECT RAISE(ABORT,'Escalation history is retained'); END;
 CREATE TABLE IF NOT EXISTS task_escalation_outcomes(id TEXT PRIMARY KEY,escalation_id TEXT NOT NULL,escalation_version INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,retry_at TEXT);
 CREATE TRIGGER IF NOT EXISTS task_escalation_outcome_no_update BEFORE UPDATE ON task_escalation_outcomes BEGIN SELECT RAISE(ABORT,'Escalation outcomes are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS task_escalation_outcome_no_delete BEFORE DELETE ON task_escalation_outcomes BEGIN SELECT RAISE(ABORT,'Escalation outcomes are retained'); END;
 CREATE TABLE IF NOT EXISTS task_escalation_notices(id TEXT PRIMARY KEY,escalation_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,escalate_to_id TEXT NOT NULL,prepared_at TEXT NOT NULL,outbox_reference TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS task_escalation_notice_no_update BEFORE UPDATE ON task_escalation_notices BEGIN SELECT RAISE(ABORT,'Prepared escalation evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS task_escalation_notice_no_delete BEFORE DELETE ON task_escalation_notices BEGIN SELECT RAISE(ABORT,'Prepared escalation evidence is retained'); END;`);
 const account=key=>db.prepare('SELECT * FROM users WHERE id=?').get(key);
 const staffAccount=key=>{const u=account(key);if(!u)fail(400,'Choose a current workspace account.');if(!u.active||!['admin','staff'].includes(u.role))fail(400,'Choose an active administrator or staff account; viewers and event helpers cannot own planning work.');return u;};
 const live=req=>{if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');};
 const reader=req=>{if(!req?.user||!['admin','staff','viewer'].includes(req.user.role))fail(403,'Event planning requires workspace access');live(req);};
 const writer=req=>{if(!req?.user||!['admin','staff'].includes(req.user.role))fail(403,'Event planning changes require administrator or staff access');live(req);};
 const follower=req=>{if(!req?.user||!['admin','staff'].includes(req.user.role))fail(403,'Task follow-up requires administrator or staff access');live(req);};
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 const prefix='/api/event-planning';
 app.use(prefix,(req,res,next)=>{try{reader(req);next();}catch(e){next(e);}});
 for(const path of ['/api/task-recurrence','/api/task-escalations'])app.use(path,(req,res,next)=>{try{follower(req);next();}catch(e){next(e);}});
 const row=(table,key,label)=>{const r=db.prepare('SELECT * FROM '+table+' WHERE id=?').get(key);if(!r)fail(404,label);return r;};
 function event(key,expected){let e;try{e=get('events',key);}catch(err){if(err.status===404)fail(404,'Event not found');throw err;}if(expected!==undefined&&e.version!==expected)fail(409,'Event changed. Reload its current version before continuing');return e;}
 const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00.000Z')+days*86400000).toISOString().slice(0,10);
 function addMonths(date,months){const [y,m,d]=date.split('-').map(Number),target=new Date(Date.UTC(y,m-1+months,1)),last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();return new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth(),Math.min(d,last))).toISOString().slice(0,10);}
 const nextDue=(date,cadence,interval)=>cadence==='Daily'?addDays(date,interval):cadence==='Weekly'?addDays(date,7*interval):addMonths(date,interval);
 const dueMoment=date=>Date.parse(date+'T23:59:59.999Z');
 // ---------------------------------------------------------------------------
 // Event checklists, assignments and unresolved responsibility.
 // ---------------------------------------------------------------------------
 const assigneeView=key=>{if(!key)return null;const u=account(key);return {id:key,name:u?.name||'Unavailable account',role:u?.role||null,version:u?.version||null,active:Boolean(u?.active)};};
 function itemView(r,time){
  const assignee=assigneeView(r.assignee_id),stale=Boolean(assignee&&(!assignee.active||!['admin','staff'].includes(assignee.role)||assignee.version!==r.assignee_version));
  const overdue=r.status!=='Done'&&dueMoment(r.due_date)<time;
  return {id:r.id,checklistId:r.checklist_id,eventId:r.event_id,title:r.title,detail:r.detail,dueDate:r.due_date,status:r.status,sequence:r.sequence,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,assignee,assigneeVersion:r.assignee_version,assignmentCurrent:!stale,overdue,
   unresolved:r.status!=='Done'&&(!assignee||stale||overdue),
   unresolvedReasons:r.status==='Done'?[]:[...(assignee?[]:['No one is responsible yet']),...(stale?['The assigned account changed or is no longer active staff']:[]),...(overdue?['The agreed date has passed']:[])]};
 }
 const itemsFor=(where,args,time)=>db.prepare('SELECT * FROM event_plan_items'+(where?' WHERE '+where:'')+' ORDER BY sequence,created_at,id LIMIT 2000').all(...args).map(r=>itemView(r,time));
 function retainItem(req,itemId,actionName,before,after,reason){db.prepare('INSERT INTO event_plan_item_history VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),itemId,actionName,before?.version??null,after.version,before?JSON.stringify(before):null,JSON.stringify(after),reason,JSON.stringify({id:req.user.id,name:req.user.name,role:req.user.role}),iso(clock()));}
 const itemHistory=key=>db.prepare('SELECT * FROM event_plan_item_history WHERE item_id=? ORDER BY to_version,id LIMIT 200').all(key).map(r=>({id:r.id,action:r.action,fromVersion:r.from_version,toVersion:r.to_version,reason:r.reason,actor:JSON.parse(r.actor_json),at:r.at}));
 const checklistView=r=>({id:r.id,eventId:r.event_id,name:r.name,templateKey:r.template_key,status:r.status,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at});
 const budgetView=r=>({id:r.id,eventId:r.event_id,kind:r.kind,category:r.category,description:r.description,plannedCents:r.planned_cents,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,meaning:PLANNING_SCOPE});
 const vendorView=r=>({id:r.id,eventId:r.event_id,name:r.name,service:r.service,contactName:r.contact_name,contactEmail:r.contact_email,phone:r.phone,status:r.status,notes:r.notes,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at});
 app.get(prefix,action((req,res)=>{
  const q=z.object({eventId:uuid.optional()}).strict().parse(req.query),time=clock();
  if(q.eventId)event(q.eventId);
  const filter=q.eventId?' WHERE event_id=?':'',args=q.eventId?[q.eventId]:[];
  const items=itemsFor(q.eventId?'event_id=?':'',args,time);
  const planned=db.prepare('SELECT kind,COALESCE(SUM(planned_cents),0) total FROM event_plan_budget_lines'+filter+' GROUP BY kind').all(...args);
  res.json({
   generatedAt:iso(time),timezone:'UTC',
   events:list('events').map(e=>({id:e.id,name:e.name,date:e.date,location:e.location||'',capacity:e.capacity,version:e.version})),
   templates:Object.entries(TEMPLATES).map(([key,t])=>({key,name:t.name,itemCount:t.items.length})),
   checklists:db.prepare('SELECT * FROM event_plan_checklists'+filter+' ORDER BY created_at,id LIMIT 500').all(...args).map(checklistView),
   items,
   unresolved:items.filter(i=>i.unresolved),
   budgetLines:db.prepare('SELECT * FROM event_plan_budget_lines'+filter+' ORDER BY kind,category,id LIMIT 500').all(...args).map(budgetView),
   budgetTotals:{expenseEstimate:planned.find(p=>p.kind==='Expense estimate')?.total||0,incomeEstimate:planned.find(p=>p.kind==='Income estimate')?.total||0,currency:'USD',meaning:PLANNING_SCOPE},
   vendors:db.prepare('SELECT * FROM event_plan_vendors'+filter+' ORDER BY name,id LIMIT 500').all(...args).map(vendorView),
   assignableUsers:db.prepare("SELECT id,name,role,version FROM users WHERE active=1 AND role IN ('admin','staff') ORDER BY name,id LIMIT 200").all(),
   canWrite:['admin','staff'].includes(req.user.role),scope:PLANNING_SCOPE
  });
 }));
 app.get(prefix+'/unresolved',action((req,res)=>{
  const q=z.object({eventId:uuid.optional()}).strict().parse(req.query),time=clock();
  if(q.eventId)event(q.eventId);
  const items=itemsFor(q.eventId?'event_id=?':'',q.eventId?[q.eventId]:[],time).filter(i=>i.unresolved);
  res.json({generatedAt:iso(time),unresolved:items,counts:{unassigned:items.filter(i=>!i.assignee).length,changedAuthority:items.filter(i=>i.assignee&&!i.assignmentCurrent).length,overdue:items.filter(i=>i.overdue).length},scope:'Every open responsibility with no owner, a changed owner account or a passed date.'});
 }));
 app.get(prefix+'/items/:id',action((req,res)=>{uuid.parse(req.params.id);z.object({}).strict().parse(req.query);const r=row('event_plan_items',req.params.id,'Checklist item not found');res.json({item:itemView(r,clock()),history:itemHistory(r.id)});}));
 app.post(prefix+'/checklists',csrf,write,action((req,res)=>{
  const body=z.object({eventId:uuid,eventVersion:version,name:title,templateKey:z.enum(Object.keys(TEMPLATES)).nullable().optional()}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),e=event(body.eventId,body.eventVersion);
   if(db.prepare('SELECT COUNT(*) n FROM event_plan_checklists WHERE event_id=?').get(e.id).n>=20)fail(409,'This event already has 20 checklists. Archive one before adding another.');
   const key=randomUUID(),at=iso(time);
   db.prepare('INSERT INTO event_plan_checklists VALUES(?,?,?,?,?,?,?,?)').run(key,e.id,body.name,body.templateKey||null,'Active',1,at,at);
   let created=0;
   if(body.templateKey)for(const [itemTitle,offset] of TEMPLATES[body.templateKey].items){
    const itemKey=randomUUID();
    db.prepare('INSERT INTO event_plan_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(itemKey,key,e.id,itemTitle,'',addDays(e.date,offset),null,null,'Open',++created,1,at,at);
    retainItem(req,itemKey,'Created from template',null,db.prepare('SELECT * FROM event_plan_items WHERE id=?').get(itemKey),'Applied template '+TEMPLATES[body.templateKey].name);
   }
   audit(req.user,'create_event_checklist','events',e.id,{checklistId:key,templateKey:body.templateKey||null,itemsCreated:created});
   writer(req);
   return {checklist:checklistView(row('event_plan_checklists',key,'Checklist not found')),items:itemsFor('checklist_id=?',[key],time)};
  });
  res.status(201).json(result);
 }));
 app.post(prefix+'/checklists/:id/items',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,title,detail,dueDate:day,assigneeId:uuid.nullable().optional(),assigneeVersion:version.nullable().optional()}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),checklist=row('event_plan_checklists',req.params.id,'Checklist not found');
   if(checklist.version!==body.version)fail(409,'Checklist changed. Reload its current version before continuing');
   if(checklist.status!=='Active')fail(409,'Archived checklists cannot receive new responsibilities.');
   if(db.prepare('SELECT COUNT(*) n FROM event_plan_items WHERE checklist_id=?').get(checklist.id).n>=200)fail(409,'This checklist already has 200 responsibilities.');
   let assignee=null;
   if(body.assigneeId){assignee=staffAccount(body.assigneeId);if(body.assigneeVersion==null||assignee.version!==body.assigneeVersion)fail(409,'The chosen account changed. Reload current accounts before assigning');}
   else if(body.assigneeVersion!=null)fail(400,'Provide an account with its current version, or neither.');
   const key=randomUUID(),at=iso(time),sequence=(db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM event_plan_items WHERE checklist_id=?').get(checklist.id).n)+1;
   db.prepare('INSERT INTO event_plan_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,checklist.id,checklist.event_id,body.title,body.detail,body.dueDate,assignee?.id||null,assignee?.version||null,'Open',sequence,1,at,at);
   db.prepare('UPDATE event_plan_checklists SET version=version+1,updated_at=? WHERE id=?').run(at,checklist.id);
   retainItem(req,key,'Created',null,row('event_plan_items',key,'Checklist item not found'),assignee?'Assigned to '+assignee.name:'Created without an owner; it is listed as unresolved');
   audit(req.user,'create_event_checklist_item','events',checklist.event_id,{checklistId:checklist.id,itemId:key,assigneeId:assignee?.id||null,dueDate:body.dueDate});
   writer(req);
   return {item:itemView(row('event_plan_items',key,'Checklist item not found'),time),checklist:checklistView(row('event_plan_checklists',checklist.id,'Checklist not found'))};
  });
  res.status(201).json(result);
 }));
 app.post(prefix+'/items/:id/assign',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,assigneeId:uuid.nullable(),assigneeVersion:version.nullable(),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),before=row('event_plan_items',req.params.id,'Checklist item not found');
   if(before.version!==body.version)fail(409,'This responsibility changed. Reload its current version before continuing');
   if(before.status==='Done')fail(409,'Completed responsibilities keep their recorded owner. Reopen it first if the record is wrong.');
   let assignee=null;
   if(body.assigneeId){assignee=staffAccount(body.assigneeId);if(body.assigneeVersion==null||assignee.version!==body.assigneeVersion)fail(409,'The chosen account changed. Reload current accounts before assigning');}
   else if(body.assigneeVersion!=null)fail(400,'Clearing an owner cannot carry an account version.');
   db.prepare('UPDATE event_plan_items SET assignee_id=?,assignee_version=?,version=version+1,updated_at=? WHERE id=?').run(assignee?.id||null,assignee?.version||null,iso(time),before.id);
   const after=row('event_plan_items',before.id,'Checklist item not found');
   retainItem(req,before.id,assignee?'Assigned':'Owner cleared',before,after,body.reason);
   audit(req.user,'assign_event_checklist_item','events',before.event_id,{itemId:before.id,fromAssigneeId:before.assignee_id,assigneeId:assignee?.id||null,reason:body.reason});
   writer(req);
   return {item:itemView(after,time)};
  });
  res.json(result);
 }));
 app.post(prefix+'/items/:id/status',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,status:z.enum(ITEM_STATUS),reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),before=row('event_plan_items',req.params.id,'Checklist item not found');
   if(before.version!==body.version)fail(409,'This responsibility changed. Reload its current version before continuing');
   if(before.status===body.status)fail(409,'This responsibility is already recorded as '+body.status+'.');
   if(body.status==='Done'&&!before.assignee_id)fail(409,'Record who completed this responsibility before marking it done.');
   db.prepare('UPDATE event_plan_items SET status=?,version=version+1,updated_at=? WHERE id=?').run(body.status,iso(time),before.id);
   const after=row('event_plan_items',before.id,'Checklist item not found');
   retainItem(req,before.id,'Status '+body.status,before,after,body.reason);
   audit(req.user,'update_event_checklist_item_status','events',before.event_id,{itemId:before.id,fromStatus:before.status,status:body.status,reason:body.reason});
   writer(req);
   return {item:itemView(after,time)};
  });
  res.json(result);
 }));
 app.patch(prefix+'/items/:id',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,title,detail,dueDate:day,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),before=row('event_plan_items',req.params.id,'Checklist item not found');
   if(before.version!==body.version)fail(409,'This responsibility changed. Reload its current version before continuing');
   if(before.status==='Done')fail(409,'Completed responsibilities are retained as recorded.');
   db.prepare('UPDATE event_plan_items SET title=?,detail=?,due_date=?,version=version+1,updated_at=? WHERE id=?').run(body.title,body.detail,body.dueDate,iso(time),before.id);
   const after=row('event_plan_items',before.id,'Checklist item not found');
   retainItem(req,before.id,'Updated',before,after,body.reason);
   audit(req.user,'update_event_checklist_item','events',before.event_id,{itemId:before.id,reason:body.reason});
   writer(req);
   return {item:itemView(after,time)};
  });
  res.json(result);
 }));
 app.post(prefix+'/budget-lines',csrf,write,action((req,res)=>{
  const body=z.object({eventId:uuid,eventVersion:version,kind:z.enum(BUDGET_KINDS),category:title,description:detail,plannedCents:cents}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),e=event(body.eventId,body.eventVersion),at=iso(time),key=randomUUID();
   if(db.prepare('SELECT COUNT(*) n FROM event_plan_budget_lines WHERE event_id=?').get(e.id).n>=200)fail(409,'This event already has 200 planning lines.');
   db.prepare('INSERT INTO event_plan_budget_lines VALUES(?,?,?,?,?,?,?,?,?)').run(key,e.id,body.kind,body.category,body.description,body.plannedCents,1,at,at);
   audit(req.user,'create_event_budget_line','events',e.id,{budgetLineId:key,kind:body.kind,plannedCents:body.plannedCents,meaning:PLANNING_SCOPE});
   writer(req);
   return {budgetLine:budgetView(row('event_plan_budget_lines',key,'Planning line not found'))};
  });
  res.status(201).json(result);
 }));
 app.patch(prefix+'/budget-lines/:id',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,kind:z.enum(BUDGET_KINDS),category:title,description:detail,plannedCents:cents}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const before=row('event_plan_budget_lines',req.params.id,'Planning line not found');
   if(before.version!==body.version)fail(409,'This planning line changed. Reload its current version before continuing');
   db.prepare('UPDATE event_plan_budget_lines SET kind=?,category=?,description=?,planned_cents=?,version=version+1,updated_at=? WHERE id=?').run(body.kind,body.category,body.description,body.plannedCents,iso(clock()),before.id);
   audit(req.user,'update_event_budget_line','events',before.event_id,{budgetLineId:before.id,plannedCents:body.plannedCents,meaning:PLANNING_SCOPE});
   writer(req);
   return {budgetLine:budgetView(row('event_plan_budget_lines',before.id,'Planning line not found'))};
  });
  res.json(result);
 }));
 app.post(prefix+'/vendors',csrf,write,action((req,res)=>{
  const body=z.object({eventId:uuid,eventVersion:version,name:title,service:shortText,contactName:shortText,contactEmail:z.union([z.literal(''),z.email().max(254)]).default(''),phone:shortText,status:z.enum(VENDOR_STATUS),notes:detail}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const time=clock(),e=event(body.eventId,body.eventVersion),at=iso(time),key=randomUUID();
   if(db.prepare('SELECT COUNT(*) n FROM event_plan_vendors WHERE event_id=?').get(e.id).n>=200)fail(409,'This event already lists 200 vendors.');
   db.prepare('INSERT INTO event_plan_vendors VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(key,e.id,body.name,body.service,body.contactName,body.contactEmail,body.phone,body.status,body.notes,1,at,at);
   audit(req.user,'create_event_vendor','events',e.id,{vendorId:key,status:body.status,meaning:'Planning contact list only; no constituent identity, agreement or payment is created'});
   writer(req);
   return {vendor:vendorView(row('event_plan_vendors',key,'Vendor not found'))};
  });
  res.status(201).json(result);
 }));
 app.patch(prefix+'/vendors/:id',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,name:title,service:shortText,contactName:shortText,contactEmail:z.union([z.literal(''),z.email().max(254)]).default(''),phone:shortText,status:z.enum(VENDOR_STATUS),notes:detail}).strict().parse(req.body);
  const result=transaction(()=>{
   writer(req);const before=row('event_plan_vendors',req.params.id,'Vendor not found');
   if(before.version!==body.version)fail(409,'This vendor changed. Reload its current version before continuing');
   db.prepare('UPDATE event_plan_vendors SET name=?,service=?,contact_name=?,contact_email=?,phone=?,status=?,notes=?,version=version+1,updated_at=? WHERE id=?').run(body.name,body.service,body.contactName,body.contactEmail,body.phone,body.status,body.notes,iso(clock()),before.id);
   audit(req.user,'update_event_vendor','events',before.event_id,{vendorId:before.id,status:body.status});
   writer(req);
   return {vendor:vendorView(row('event_plan_vendors',before.id,'Vendor not found'))};
  });
  res.json(result);
 }));
 // ---------------------------------------------------------------------------
 // Task recurrence and escalation.
 // ---------------------------------------------------------------------------
 const recurrenceView=r=>({id:r.id,taskId:r.task_id,currentTaskId:r.current_task_id,cadence:r.cadence,intervalCount:r.interval_count,remaining:r.remaining,ownerId:r.owner_id,ownerVersion:r.owner_version,status:r.status,nextDue:r.next_due,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,occurrences:db.prepare('SELECT * FROM task_recurrence_occurrences WHERE recurrence_id=? ORDER BY sequence').all(r.id).map(o=>({sequence:o.sequence,taskId:o.task_id,dueDate:o.due_date,createdAt:o.created_at}))});
 const escalationOutcome=key=>{const r=db.prepare('SELECT * FROM task_escalation_outcomes WHERE escalation_id=? ORDER BY at DESC,rowid DESC LIMIT 1').get(key);return r?{status:r.status,reason:r.reason,at:r.at,retryAt:r.retry_at}:null;};
 const escalationView=r=>({id:r.id,taskId:r.task_id,taskVersion:r.task_version,ownerId:r.owner_id,afterMinutes:r.after_minutes,escalateToId:r.escalate_to_id,escalateToVersion:r.escalate_to_version,status:r.status,attemptCount:r.attempt_count,nextAttempt:r.status==='Armed'?r.next_attempt:null,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,lastOutcome:escalationOutcome(r.id),prepared:Boolean(db.prepare('SELECT 1 FROM task_escalation_notices WHERE escalation_id=?').get(r.id)),delivery:PREPARED_NOTE});
 app.get('/api/task-recurrence',action((req,res)=>{z.object({}).strict().parse(req.query);res.json({recurrences:db.prepare('SELECT * FROM task_recurrences ORDER BY created_at DESC,id LIMIT 200').all().map(recurrenceView),limit:200,timezone:'UTC'});}));
 app.get('/api/task-escalations',action((req,res)=>{z.object({}).strict().parse(req.query);res.json({escalations:db.prepare('SELECT * FROM task_escalations ORDER BY created_at DESC,id LIMIT 200').all().map(escalationView),limit:200,timezone:'UTC',delivery:PREPARED_NOTE});}));
 app.post('/api/task-recurrence',csrf,write,action((req,res)=>{
  const body=z.object({taskId:uuid,taskVersion:version,ownerVersion:version,cadence:z.enum(['Daily','Weekly','Monthly']),intervalCount:z.number().int().min(1).max(12),occurrences:z.number().int().min(1).max(60)}).strict().parse(req.body);
  const result=transaction(()=>{
   follower(req);const time=clock(),task=get('tasks',body.taskId);
   if(task.version!==body.taskVersion)fail(409,'Task changed. Reload its current version before continuing');
   if(task.status==='Completed')fail(409,'Completed tasks cannot start a new recurrence.');
   if(!task.ownerId)fail(409,'Assign a current staff owner before adding recurrence.');
   const owner=staffAccount(task.ownerId);
   if(owner.version!==body.ownerVersion)fail(409,'Task owner account changed. Reload current accounts before continuing');
   if(!ownerAllowed(owner))fail(409,'The task owner cannot currently receive scheduled work.');
   if(db.prepare("SELECT 1 FROM task_recurrences WHERE current_task_id=? AND status='Active'").get(task.id))fail(409,'This task already repeats. Cancel its recurrence before adding another.');
   if(db.prepare("SELECT COUNT(*) n FROM task_recurrences WHERE status='Active'").get().n>=100)fail(409,'This workspace has 100 active recurrences. Cancel an unused recurrence first.');
   const key=randomUUID(),at=iso(time),due=nextDue(task.dueDate,body.cadence,body.intervalCount);
   db.prepare('INSERT INTO task_recurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,task.id,body.cadence,body.intervalCount,body.occurrences,owner.id,owner.version,task.version,'Active',task.id,due,1,at,at);
   db.prepare('INSERT INTO task_recurrence_occurrences VALUES(?,?,?,?,?,?)').run(randomUUID(),key,0,task.id,task.dueDate,at);
   audit(req.user,'create_task_recurrence','tasks',task.id,{recurrenceId:key,cadence:body.cadence,intervalCount:body.intervalCount,occurrences:body.occurrences,nextDue:due,meaning:'A follow-up task is created only after the current one is completed; nothing is sent'});
   follower(req);
   return {recurrence:recurrenceView(row('task_recurrences',key,'Recurrence not found'))};
  });
  res.status(201).json(result);
 }));
 app.post('/api/task-recurrence/:id/cancel',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   follower(req);const before=row('task_recurrences',req.params.id,'Recurrence not found');
   if(before.status!=='Active')fail(409,'This recurrence is already closed.');
   if(before.version!==body.version)fail(409,'Recurrence changed. Reload its current version before continuing');
   db.prepare("UPDATE task_recurrences SET status='Cancelled',version=version+1,updated_at=? WHERE id=?").run(iso(clock()),before.id);
   audit(req.user,'cancel_task_recurrence','tasks',before.task_id,{recurrenceId:before.id,reason:body.reason});
   follower(req);
   return {recurrence:recurrenceView(row('task_recurrences',before.id,'Recurrence not found'))};
  });
  res.json(result);
 }));
 app.post('/api/task-escalations',csrf,write,action((req,res)=>{
  const body=z.object({taskId:uuid,taskVersion:version,afterMinutes:z.number().int().min(0).max(43200),escalateToId:uuid,escalateToVersion:version}).strict().parse(req.body);
  const result=transaction(()=>{
   follower(req);const time=clock(),task=get('tasks',body.taskId);
   if(task.version!==body.taskVersion)fail(409,'Task changed. Reload its current version before continuing');
   if(task.status==='Completed')fail(409,'Completed tasks do not need escalation.');
   if(!task.ownerId)fail(409,'Assign a current staff owner before arming escalation.');
   const target=staffAccount(body.escalateToId);
   if(target.version!==body.escalateToVersion)fail(409,'The escalation account changed. Reload current accounts before continuing');
   if(target.id===task.ownerId)fail(400,'Escalate to a different account than the current owner.');
   if(!ownerAllowed(target))fail(409,'The escalation account cannot currently receive escalations.');
   if(db.prepare("SELECT 1 FROM task_escalations WHERE task_id=? AND status='Armed'").get(task.id))fail(409,'This task already has an armed escalation. Cancel it before arming another.');
   if(db.prepare("SELECT COUNT(*) n FROM task_escalations WHERE status='Armed'").get().n>=100)fail(409,'This workspace has 100 armed escalations. Cancel an unused escalation first.');
   const key=randomUUID(),at=iso(time);
   db.prepare('INSERT INTO task_escalations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,task.id,task.version,task.ownerId,body.afterMinutes,target.id,target.version,'Armed',0,iso(dueMoment(task.dueDate)+body.afterMinutes*60000),1,at,at);
   audit(req.user,'arm_task_escalation','tasks',task.id,{escalationId:key,afterMinutes:body.afterMinutes,escalateToId:target.id,delivery:'Nothing prepared or delivered yet'});
   follower(req);
   return {escalation:escalationView(row('task_escalations',key,'Escalation not found'))};
  });
  res.status(201).json(result);
 }));
 app.post('/api/task-escalations/:id/cancel',csrf,write,action((req,res)=>{
  uuid.parse(req.params.id);
  const body=z.object({version,reason:reasonText}).strict().parse(req.body);
  const result=transaction(()=>{
   follower(req);const time=clock(),before=row('task_escalations',req.params.id,'Escalation not found');
   if(before.status!=='Armed')fail(409,'This escalation is already closed.');
   if(before.version!==body.version)fail(409,'Escalation changed. Reload its current version before continuing');
   db.prepare("UPDATE task_escalations SET status='Cancelled',version=version+1,updated_at=? WHERE id=?").run(iso(time),before.id);
   db.prepare('INSERT INTO task_escalation_outcomes VALUES(?,?,?,?,?,?,?)').run(randomUUID(),before.id,before.version+1,'Cancelled',body.reason,iso(time),null);
   audit(req.user,'cancel_task_escalation','tasks',before.task_id,{escalationId:before.id,reason:body.reason});
   follower(req);
   return {escalation:escalationView(row('task_escalations',before.id,'Escalation not found'))};
  });
  res.json(result);
 }));
 function closeRecurrence(r,status,reason,time){
  db.prepare('UPDATE task_recurrences SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,iso(time),r.id);
  audit({id:'system'},'close_task_recurrence','tasks',r.task_id,{recurrenceId:r.id,status,reason});
 }
 function escalationOutcomeRow(r,status,reason,time,retryAt=null){db.prepare('INSERT INTO task_escalation_outcomes VALUES(?,?,?,?,?,?,?)').run(randomUUID(),r.id,r.version+1,status,reason,iso(time),retryAt);}
 function closeEscalation(r,status,reason,time){
  db.prepare('UPDATE task_escalations SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,iso(time),r.id);
  escalationOutcomeRow(r,status,reason,time);
  audit({id:'system'},'close_task_escalation','tasks',r.task_id,{escalationId:r.id,status,reason,delivery:'Not prepared and not delivered'});
 }
 // Worker. Every authority and version fact is rechecked here, at execution time.
 function runTaskFollowUp(time=clock()){
  const result={created:0,recurrencesClosed:0,escalated:0,escalationsClosed:0,failed:0,suspended:false};
  if(!isTenantActive()){
   transaction(()=>{
    for(const r of db.prepare("SELECT * FROM task_recurrences WHERE status='Active' ORDER BY id").all()){closeRecurrence(r,'Suppressed','Workspace is suspended',time);result.recurrencesClosed++;}
    for(const r of db.prepare("SELECT * FROM task_escalations WHERE status='Armed' ORDER BY id").all()){closeEscalation(r,'Suppressed','Workspace is suspended',time);result.escalationsClosed++;}
   });
   result.suspended=true;return result;
  }
  for(const candidate of db.prepare("SELECT id FROM task_recurrences WHERE status='Active' ORDER BY next_due,id LIMIT 100").all()){
   try{
    transaction(()=>{
     const r=row('task_recurrences',candidate.id,'Recurrence not found');
     if(r.status!=='Active')return;
     let task;try{task=get('tasks',r.current_task_id);}catch(e){if(e.status===404){closeRecurrence(r,'Suppressed','Source task unavailable',time);result.recurrencesClosed++;return;}throw e;}
     const owner=account(r.owner_id);
     if(!owner?.active||!['admin','staff'].includes(owner.role)||owner.version!==r.owner_version||!ownerAllowed(owner)){closeRecurrence(r,'Suppressed','Owner account changed or is unavailable',time);result.recurrencesClosed++;return;}
     if(task.ownerId!==r.owner_id){closeRecurrence(r,'Suppressed','Task was reassigned',time);result.recurrencesClosed++;return;}
     if(task.status!=='Completed')return;
     if(r.remaining<=0){closeRecurrence(r,'Completed','All scheduled occurrences were created',time);result.recurrencesClosed++;return;}
     const sequence=db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM task_recurrence_occurrences WHERE recurrence_id=?').get(r.id).n+1;
     const due=nextDue(task.dueDate,r.cadence,r.interval_count);
     const created=create('tasks',{title:task.title,dueDate:due,owner:owner.name,ownerId:owner.id,status:'Open',priority:task.priority,constituentId:task.constituentId??null,eventId:task.eventId??null,notes:task.notes||''},{id:'system',name:'Task recurrence',role:owner.role});
     db.prepare('INSERT INTO task_recurrence_occurrences VALUES(?,?,?,?,?,?)').run(randomUUID(),r.id,sequence,created.id,due,iso(time));
     const remaining=r.remaining-1;
     db.prepare('UPDATE task_recurrences SET remaining=?,current_task_id=?,next_due=?,task_version=?,version=version+1,updated_at=?,status=? WHERE id=?').run(remaining,created.id,nextDue(due,r.cadence,r.interval_count),created.version,iso(time),remaining>0?'Active':'Completed',r.id);
     audit({id:'system'},'create_recurring_task','tasks',created.id,{recurrenceId:r.id,sequence,fromTaskId:task.id,dueDate:due,remaining,meaning:'A follow-up task record only; nothing was sent or delivered'});
     result.created++;if(remaining<=0)result.recurrencesClosed++;
    });
   }catch(e){result.failed++;console.error('Task recurrence could not create its next occurrence: '+(e.message||'unknown error'));}
  }
  for(const candidate of db.prepare("SELECT id FROM task_escalations WHERE status='Armed' ORDER BY next_attempt,id LIMIT 100").all()){
   try{
    transaction(()=>{
     const r=row('task_escalations',candidate.id,'Escalation not found');
     if(r.status!=='Armed')return;
     let task;try{task=get('tasks',r.task_id);}catch(e){if(e.status===404){closeEscalation(r,'Suppressed','Source task unavailable',time);result.escalationsClosed++;return;}throw e;}
     if(task.status==='Completed'){closeEscalation(r,'Resolved','The task was completed before escalation',time);result.escalationsClosed++;return;}
     if(task.ownerId!==r.owner_id){closeEscalation(r,'Suppressed','The task was reassigned; escalate again if it is still needed',time);result.escalationsClosed++;return;}
     const target=account(r.escalate_to_id);
     if(!target?.active||!['admin','staff'].includes(target.role)||target.version!==r.escalate_to_version||!ownerAllowed(target)){closeEscalation(r,'Suppressed','Escalation account changed or is unavailable',time);result.escalationsClosed++;return;}
     if(dueMoment(task.dueDate)+r.after_minutes*60000>time||r.next_attempt>iso(time))return;
     const envelope={kind:'task-escalation',escalationId:r.id,taskId:task.id,ownerId:r.owner_id,escalateToId:target.id,dueDate:task.dueDate,afterMinutes:r.after_minutes,preparedAt:iso(time),delivery:PREPARED_NOTE};
     const accepted=outbox(envelope);
     if(!accepted||accepted.accepted!==true){closeEscalation(r,'Suppressed','Outbox declined: '+String(accepted&&accepted.reason||'no acceptance recorded').slice(0,200),time);result.escalationsClosed++;return;}
     db.prepare('INSERT INTO task_escalation_notices VALUES(?,?,?,?,?,?)').run(randomUUID(),r.id,task.id,target.id,iso(time),String(accepted.reference||'internal-only').slice(0,200));
     db.prepare("UPDATE task_escalations SET status='Escalated',version=version+1,updated_at=?,attempt_count=attempt_count+1 WHERE id=?").run(iso(time),r.id);
     escalationOutcomeRow(r,'Escalated',PREPARED_NOTE,time);
     audit({id:'system'},'escalate_task','tasks',task.id,{escalationId:r.id,escalateToId:target.id,delivery:PREPARED_NOTE});
     result.escalated++;
    });
   }catch(e){
    result.failed++;
    try{
     transaction(()=>{
      const r=row('task_escalations',candidate.id,'Escalation not found');
      if(r.status!=='Armed')return;
      if(r.attempt_count>=4){db.prepare('UPDATE task_escalations SET attempt_count=attempt_count+1 WHERE id=?').run(r.id);closeEscalation(r,'Suppressed','Retry limit reached; review the task and arm a new escalation',time);result.escalationsClosed++;return;}
      const retryAt=iso(time+60000);
      db.prepare('UPDATE task_escalations SET version=version+1,updated_at=?,next_attempt=?,attempt_count=attempt_count+1 WHERE id=?').run(iso(time),retryAt,r.id);
      escalationOutcomeRow(r,'Failed','Escalation preparation failed; retry scheduled. Nothing was prepared or delivered',time,retryAt);
     });
    }catch{console.error('Task escalation persistence is unavailable. Nothing was prepared; the worker will retry armed escalations.');}
   }
  }
  return result;
 }
 const worker=config.worker===false?null:setInterval(()=>{try{runTaskFollowUp();}catch{console.error('Task follow-up worker could not complete its current cycle.');}},60000);
 worker?.unref();
 return {
  runTaskFollowUp,templates:TEMPLATES,
  validateDeletion:(collection,record)=>{
   if(!record)return;
   if(collection==='events'&&db.prepare('SELECT 1 FROM event_plan_checklists WHERE event_id=? UNION ALL SELECT 1 FROM event_plan_budget_lines WHERE event_id=? UNION ALL SELECT 1 FROM event_plan_vendors WHERE event_id=? LIMIT 1').get(record.id,record.id,record.id))fail(409,'Retained event planning history protects this event from deletion');
   if(collection==='tasks'&&db.prepare('SELECT 1 FROM task_recurrences WHERE task_id=? UNION ALL SELECT 1 FROM task_recurrences WHERE current_task_id=? UNION ALL SELECT 1 FROM task_recurrence_occurrences WHERE task_id=? UNION ALL SELECT 1 FROM task_escalations WHERE task_id=? LIMIT 1').get(record.id,record.id,record.id,record.id))fail(409,'Retained recurrence or escalation history protects this task from deletion. Complete the task instead');
  },
  close:()=>{if(worker)clearInterval(worker);}
 };
}
