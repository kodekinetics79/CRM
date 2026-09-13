import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';

const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
const key=z.string().min(1).max(100);
const mergeShape={targetId:key,sourceId:key,targetVersion:z.number().int().min(1),sourceVersion:z.number().int().min(1),reason:z.string().trim().min(1).max(2000),parentId:key.nullable().optional()};
const mergeSchema=z.object(mergeShape).strict();
const householdShape={name:z.string().trim().min(1).max(250),address:z.string().trim().max(2000),memberIds:z.array(key).max(250).refine(ids=>new Set(ids).size===ids.length,'Each household member must be unique')};
const personTypes=new Set(['Individual','Alumni','Employee','Staff']);
const fields={
 constituents:['name','email','phone','type','household','parentId','contacts','segments','preference','notes'],
 gifts:['constituentId','amount','type','method','date','campaignId','allocations','externalRef','notes','tribute','softCreditId','pledge','pledgeId','grantId','giftKind'],
 grants:['name','funderId','amount','awardedAmount','awardDate','stage','deadline','reportDue','notes'],
 volunteers:['constituentId','skills','shift','eventId','hours','capacity','notes'],
 tasks:['title','dueDate','owner','status','priority','constituentId','eventId','notes'],
 pledges:['name','constituentId','amount','startDate','installments','frequency','designationId','campaignId','status','notes'],
 communications:['constituentId','subject','channel','status','date','body','notes'],
 events:['name','date','location','capacity','ticketPrice','sponsorGoal','notes']
};
const editable=(collection,r)=>Object.fromEntries((fields[collection]||[]).filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]]));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function installIdentityRoutes(app,{db,list,get,put,validate,audit,csrf,admin,transaction,collections,hasProtectedConstituentHistory=()=>false}) {
 db.exec(`CREATE TABLE IF NOT EXISTS identity_aliases(source_id TEXT PRIMARY KEY,target_id TEXT NOT NULL,source_snapshot TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS identity_alias_no_update BEFORE UPDATE ON identity_aliases BEGIN SELECT RAISE(ABORT,'Identity merge history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS identity_alias_no_delete BEFORE DELETE ON identity_aliases BEGIN SELECT RAISE(ABORT,'Identity merge history is retained'); END;
 CREATE TABLE IF NOT EXISTS households(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,address TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS household_members(household_id TEXT NOT NULL REFERENCES households(id),constituent_id TEXT NOT NULL UNIQUE,PRIMARY KEY(household_id,constituent_id));`);
 const alias=id=>db.prepare('SELECT * FROM identity_aliases WHERE source_id=?').get(id);
 const membership=id=>db.prepare('SELECT household_id FROM household_members WHERE constituent_id=?').get(id)?.household_id;
 const householdView=r=>({id:r.id,name:r.name,address:r.address,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,memberIds:db.prepare('SELECT constituent_id FROM household_members WHERE household_id=? ORDER BY constituent_id').all(r.id).map(x=>x.constituent_id)});
 const households=()=>db.prepare('SELECT * FROM households ORDER BY name,id').all().map(householdView);
 function findHousehold(id){const r=db.prepare('SELECT * FROM households WHERE id=?').get(id);if(!r)fail(404,'Household not found');return r;}
 function active(id){const r=get('constituents',id);if(alias(id)||r.mergedInto)fail(409,'Merged identities cannot be selected; use the surviving constituent');return r;}
 function version(r,v){if(r.version!==v)fail(409,'Record changed. Reload before continuing.');}
 function checkMembers(p,ownId=null){
  if(db.prepare('SELECT id FROM households WHERE name=? AND id<>?').get(p.name,ownId||''))fail(409,'A household with this name already exists');
  if(list('constituents').some(c=>c.household?.trim().toLocaleLowerCase()===p.name.toLocaleLowerCase()&&!p.memberIds.includes(c.id)&&!c.mergedInto&&membership(c.id)!==ownId))fail(409,'This name is already used by other legacy household members; include or reconcile them first');
  for(const id of p.memberIds){const c=active(id);if(!personTypes.has(c.type))fail(400,'Only individuals, alumni, employees and staff can belong to a household');const owner=membership(id);if(owner&&owner!==ownId)fail(409,'A person can belong to only one managed household');if(c.household?.trim()&&owner!==ownId&&c.household.trim().toLocaleLowerCase()!==p.name.toLocaleLowerCase())fail(409,'Reconcile this person’s existing household before assigning another');}
 }
 function saveHousehold(p,user,old=null){
  checkMembers(p,old?.id);const at=new Date().toISOString(),id=old?.id||randomUUID(),previous=old?householdView(old):null;
  const next={id,name:p.name,address:p.address,version:(old?.version||0)+1,created_at:old?.created_at||at,updated_at:at};
  db.prepare('INSERT INTO households VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,version=excluded.version,updated_at=excluded.updated_at').run(id,next.name,next.address,next.version,next.created_at,next.updated_at);
  const before=previous?.memberIds||[];db.prepare('DELETE FROM household_members WHERE household_id=?').run(id);
  for(const memberId of new Set([...before,...p.memberIds])){const c=active(memberId),household=p.memberIds.includes(memberId)?p.name:'';if(c.household!==household){put('constituents',{...c,household,version:c.version+1,updatedAt:at});audit(user,'sync_household','constituents',memberId,{householdId:id,previousHousehold:c.household,household});}if(p.memberIds.includes(memberId))db.prepare('INSERT INTO household_members VALUES(?,?)').run(id,memberId);}
  audit(user,old?'update_household':'create_household',null,id,{previous,household:householdView(next)});return householdView(next);
 }
 app.get('/api/households',(req,res)=>res.json({households:households()}));
 app.post('/api/households',csrf,admin,(req,res)=>{const p=z.object(householdShape).strict().parse(req.body);res.status(201).json({household:transaction(()=>saveHousehold(p,req.user))});});
 app.patch('/api/households/:id',csrf,admin,(req,res)=>{const p=z.object({...householdShape,version:z.number().int().min(1)}).strict().parse(req.body);res.json({household:transaction(()=>{const old=findHousehold(req.params.id);version(old,p.version);return saveHousehold(p,req.user,old);})});});
 app.delete('/api/households/:id',csrf,admin,(req,res)=>{findHousehold(req.params.id);fail(403,'Households are retained; remove memberships through a versioned household update');});
 app.get('/api/identity/aliases',admin,(req,res)=>res.json({aliases:db.prepare('SELECT source_id AS sourceId,target_id AS targetId,reason,actor,at FROM identity_aliases ORDER BY at').all()}));
 function plan(p){
  if(hasProtectedConstituentHistory(p.sourceId))fail(409,'This source identity has retained protected fundraising history; historical consolidation requires a reviewed alias workflow');
  if(p.targetId===p.sourceId)fail(400,'Choose two different constituents');const target=active(p.targetId),source=active(p.sourceId);version(target,p.targetVersion);version(source,p.sourceVersion);
  const all=Object.fromEntries(collections.map(c=>[c,list(c)])),blockers=[],changes=[];
  const block=(collection,recordId,reason)=>blockers.push({collection,recordId,reason});
  if(db.prepare('SELECT 1 FROM identity_aliases WHERE target_id=?').get(source.id))block('constituents',source.id,'This surviving identity already has retained aliases; a history-aware alias workflow is required before merging it into another');
  if(target.type!==source.type)block('constituents',source.id,'Different constituent types require reconciliation before merging');
  let parentId=Object.hasOwn(p,'parentId')?p.parentId:target.parentId;
  if(!Object.hasOwn(p,'parentId')&&source.parentId&&source.parentId!==target.parentId)block('constituents',source.id,'Choose an explicit parentId to resolve different organization parents');
  if(parentId===source.id)parentId=target.id;
  if(parentId===target.id)block('constituents',target.id,'The merge would create an organization hierarchy cycle');
  if(parentId){active(parentId);let next=parentId;const seen=new Set([target.id,source.id]);while(next){if(seen.has(next)){block('constituents',target.id,'The selected parent would create an organization hierarchy cycle');break;}seen.add(next);next=get('constituents',next).parentId;}}
  const targetHousehold=membership(target.id),sourceHousehold=membership(source.id);
  if(targetHousehold&&sourceHousehold&&targetHousehold!==sourceHousehold)block('households',sourceHousehold,'Resolve different managed household memberships before merging');
  if(target.household?.trim()&&source.household?.trim()&&target.household.trim().toLocaleLowerCase()!==source.household.trim().toLocaleLowerCase())block('constituents',source.id,'Resolve different household labels before merging');
  const contacts=[...(target.contacts||[])];const contactKeys=new Set(contacts.map(c=>JSON.stringify([c.name,c.email,c.role]).toLocaleLowerCase()));
  for(const c of source.contacts||[]){const k=JSON.stringify([c.name,c.email,c.role]).toLocaleLowerCase();if(!contactKeys.has(k)){contacts.push(c);contactKeys.add(k);}}
  const segments=[...new Set([target.segments,source.segments].flatMap(s=>(s||'').split(',').map(v=>v.trim()).filter(Boolean)))].join(',');
  if(contacts.length>50||segments.length>300)block('constituents',target.id,'Combined contacts or segments exceed supported limits; reconcile them first');
  const mergedTarget={...target,email:target.email||source.email,phone:target.phone||source.phone,contacts,segments,parentId,household:target.household||source.household,preference:target.preference==='Do not contact'||source.preference==='Do not contact'?'Do not contact':target.preference};
  const sourceVolunteers=new Set((all.volunteers||[]).filter(v=>v.constituentId===source.id).map(v=>v.id));
  for(const t of all.volunteerTime||[])if(t.constituentId===source.id||sourceVolunteers.has(t.volunteerId))block('volunteerTime',t.id,'Recorded volunteer identity is retained; a history-aware alias workflow is required');
  for(const v of all.volunteers||[])if(v.constituentId===source.id&&v.clockIn)block('volunteers',v.id,'Clock out and reconcile volunteer history before merging');
  for(const r of all.shiftReservations||[])if(r.constituentId===source.id)block('shiftReservations',r.id,'Reservation identity history is protected; canceling does not remove retained identity');
  for(const c of collections)for(const old of all[c]){
   if(c==='constituents'&&[target.id,source.id].includes(old.id))continue;
   const next=structuredClone(old);let affected=false;
   for(const field of ['constituentId','softCreditId','funderId',...(c==='constituents'?['parentId']:[])])if(next[field]===source.id){next[field]=target.id;affected=true;}
   if(c==='events'&&next.registrations?.some(r=>r.constituentId===source.id)){
    if(next.registrations.some(r=>r.constituentId===source.id&&r.checkedIn))block(c,old.id,'Checked-in attendance identity is protected');
    if(next.registrations.some(r=>r.constituentId===target.id))block(c,old.id,'Both constituents are registered; resolve duplicate event registration before merging');
    next.registrations=next.registrations.map(r=>r.constituentId===source.id?{...r,constituentId:target.id}:r);affected=true;
   }
   if(affected){
    if(c==='constituents'&&old.mergedInto)block(c,old.id,'Retained merged-source relationships are protected; a history-aware alias workflow is required');
    if(c==='gifts'&&(old.status==='Voided'||old.acknowledgment))block(c,old.id,'Voided and acknowledged gift identity is retained');
    if(c==='communications'&&(old.giftId||(all.gifts||[]).some(g=>g.acknowledgment?.communicationId===old.id)))block(c,old.id,'Completed linked acknowledgment identity is retained');
    if(!fields[c])block(c,old.id,'This record has protected identity references');
    changes.push({collection:c,recordId:old.id,previous:old,next});
   }
  }
  if(mergedTarget.preference==='Do not contact')for(const m of all.communications||[])if(m.status==='Draft'&&[target.id,source.id].includes(m.constituentId))block('communications',m.id,'Resolve unsent drafts before merging into a Do not contact constituent');
  changes.unshift({collection:'constituents',recordId:target.id,previous:target,next:mergedTarget});
  // Validate the complete proposed graph in a rollback-only savepoint. Financial parent/receipt pairs change together.
  if(!blockers.length){db.exec('SAVEPOINT identity_preview');try{for(const change of changes)put(change.collection,change.next);for(const change of changes)validate(change.collection,editable(change.collection,change.next),change.recordId,change.previous);}catch(e){block('validation',null,e.message);}finally{db.exec('ROLLBACK TO identity_preview; RELEASE identity_preview');}}
  const previewDigest=digest({input:p,records:all,households:households(),aliases:db.prepare('SELECT source_id,target_id FROM identity_aliases ORDER BY source_id').all()});
  return {target,source,mergedTarget,changes,blockers,previewDigest,householdId:targetHousehold||sourceHousehold||null};
 }
 app.post('/api/identity/merge/preview',csrf,admin,(req,res)=>{const p=mergeSchema.parse(req.body);res.json({preview:transaction(()=>plan(p))});});
 app.post('/api/identity/merge',csrf,admin,(req,res)=>{
  const parsed=z.object({...mergeShape,previewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body),{previewDigest,...p}=parsed;
  const result=transaction(()=>{const preview=plan(p);if(preview.previewDigest!==previewDigest)fail(409,'Merge preview changed. Review a fresh preview before committing');if(preview.blockers.length)fail(409,'Merge blocked by protected history or conflicting relationships');const at=new Date().toISOString();
   for(const change of preview.changes){const next={...change.next,version:change.previous.version+1,updatedAt:at};put(change.collection,next);audit(req.user,'merge_rewire',change.collection,change.recordId,{sourceId:p.sourceId,targetId:p.targetId,reason:p.reason,previousVersion:change.previous.version});}
   put('constituents',{...preview.source,mergedInto:p.targetId,version:preview.source.version+1,updatedAt:at});
   db.prepare('INSERT INTO identity_aliases VALUES(?,?,?,?,?,?)').run(p.sourceId,p.targetId,JSON.stringify(preview.source),p.reason,req.user.id,at);
   if(preview.householdId){db.prepare('DELETE FROM household_members WHERE constituent_id=?').run(p.sourceId);if(!membership(p.targetId))db.prepare('INSERT INTO household_members VALUES(?,?)').run(preview.householdId,p.targetId);db.prepare('UPDATE households SET version=version+1,updated_at=? WHERE id=?').run(at,preview.householdId);audit(req.user,'merge_household_member',null,preview.householdId,{sourceId:p.sourceId,targetId:p.targetId,reason:p.reason});}
   audit(req.user,'merge_identity','constituents',p.targetId,{sourceId:p.sourceId,targetId:p.targetId,reason:p.reason,previewDigest,rewired:preview.changes.map(c=>({collection:c.collection,recordId:c.recordId})),policy:'Keep target name and contact choices; fill empty email/phone; union contacts/segments; preserve Do not contact; retain original source snapshot'});
   if(hasProtectedConstituentHistory(p.sourceId))fail(409,'Protected fundraising identity history changed before merge commit');
   return {target:get('constituents',p.targetId),source:get('constituents',p.sourceId),rewired:preview.changes.length-1};});res.json(result);
 });
 // These guards run before generic mutations and dedicated identity-reference routes.
 app.use('/api',(req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const match=/^\/records\/constituents\/([^/]+)$/.exec(req.path);if(match){const id=decodeURIComponent(match[1]);if(alias(id))return res.status(409).json({error:'Merged identity is retained; update the surviving constituent'});if(req.method==='DELETE'&&db.prepare('SELECT 1 FROM identity_aliases WHERE target_id=?').get(id))return res.status(409).json({error:'This surviving constituent has retained merged identities and cannot be deleted'});const owner=membership(id);if(owner&&req.method==='DELETE')return res.status(409).json({error:'Remove managed household membership before deleting this constituent'});if(owner&&req.body){const r=get('constituents',id);if(Object.hasOwn(req.body,'household')&&req.body.household!==r.household)return res.status(409).json({error:'Change household membership through its managed household record'});if(req.body.type&&!personTypes.has(req.body.type))return res.status(409).json({error:'Managed household members must remain individuals, alumni, employees or staff'});}}
  function inspect(value){if(!value||typeof value!=='object')return false;return Object.entries(value).some(([k,v])=>['constituentId','softCreditId','funderId','parentId'].includes(k)&&typeof v==='string'&&alias(v)||typeof v==='object'&&inspect(v));}
  if(inspect(req.body))return res.status(409).json({error:'A referenced identity has been merged; select the surviving constituent'});next();
 });
 return {isMerged:id=>Boolean(alias(id)),households};
}
