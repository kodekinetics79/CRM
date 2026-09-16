import {randomUUID,randomBytes,createHash,createHmac,timingSafeEqual,createPublicKey,createVerify} from 'node:crypto';
import {z} from 'zod';
import {mfaAccountBinding} from './mfa.js';
import {planEntitlements,planBillingState} from './platform.js';

// Identity and tenancy for one workspace. Roles, entitlements and separation of
// duties are enforced at execution time, never merely displayed. A plan label is
// an administrative classification, never a paid subscription: this module never
// fabricates an invoice, a charge or a provider event. The federated sign-in
// boundary is implemented but disabled by default and never contacts a provider.
const FULL_ROLES=['admin','staff','viewer'],HELPER_ROLE='event-helper',ALL_ROLES=[...FULL_ROLES,HELPER_ROLE];
const INVITABLE_ROLES=['admin','staff','viewer',HELPER_ROLE];
// Claim mapping can never select an administrator: privilege escalation through a
// federated assertion is impossible by construction, not by configuration.
const FEDERATED_ROLES=['staff','viewer',HELPER_ROLE];
const UNMANAGED=Object.freeze({plan:'unmanaged',label:'Unmanaged workspace',fullUserSeats:null,helperSeats:null,invitations:true,ai:true,federation:true,connectors:[],historyRetentionYears:10});
const PRODUCT_IDENTITY=Object.freeze({productName:'Wimblo',providedBy:'Kode Kinetics',statement:'Wimblo by Kode Kinetics. Customer branding is optional and never replaces the product identity.'});
const ROLE_MATRIX=Object.freeze([
 {role:'admin',label:'Administrator',businessRecords:'Create, change and delete',accountAdministration:true,tenantAdministration:true,eventCheckIn:true,platformControlPlane:false,summary:'Full workspace authority. Administrator is the only role that may change accounts or workspace administration.'},
 {role:'staff',label:'Staff',businessRecords:'Create and change',accountAdministration:false,tenantAdministration:false,eventCheckIn:true,platformControlPlane:false,summary:'Ordinary duties: view and enter data, prepare communications and forms. No account administration.'},
 {role:'viewer',label:'Viewer',businessRecords:'Read only',accountAdministration:false,tenantAdministration:false,eventCheckIn:true,platformControlPlane:false,summary:'Read-only business access. Cannot write any record.'},
 {role:HELPER_ROLE,label:'Event helper',businessRecords:'None; assigned event ticket check-in only',accountAdministration:false,tenantAdministration:false,eventCheckIn:'Assigned events only',platformControlPlane:false,summary:'Optional non-administrator helper for events, data entry support and volunteers. Ordinary duties never justify administrator privileges.'}
]);
// Duties the codebase already treats as reviewable. A preparer is never the sole
// approver: the decision requires a different, currently authorized actor.
const DUTIES=Object.freeze([
 {duty:'gift-void',label:'Void a posted gift',collection:'gifts',preparerRoles:['admin','staff'],approverRoles:['admin'],financiallyMeaningful:true},
 {duty:'gift-correction',label:'Correct a posted gift',collection:'gifts',preparerRoles:['admin','staff'],approverRoles:['admin'],financiallyMeaningful:true},
 {duty:'receipt-issue',label:'Issue a tax receipt',collection:'receipts',preparerRoles:['admin','staff'],approverRoles:['admin'],financiallyMeaningful:true},
 {duty:'user-access-change',label:'Change workspace account access',collection:'users',preparerRoles:['admin'],approverRoles:['admin'],financiallyMeaningful:false}
]);
const DUTY_KEYS=DUTIES.map(d=>d.duty);
const dutyPolicy=key=>DUTIES.find(d=>d.duty===key)||null;
const sha=value=>createHash('sha256').update(value).digest('hex');
const fromB64u=value=>Buffer.from(String(value),'base64url');
const equal=(a,b)=>{const left=Buffer.from(String(a)),right=Buffer.from(String(b));return left.length===right.length&&timingSafeEqual(left,right);};
const email=z.email().max(254).transform(v=>v.toLowerCase());
const reason=z.string().trim().min(5).max(1000);
const invitationPassword=z.string().min(12).max(200).refine(p=>/[a-z]/.test(p)&&/[A-Z]/.test(p)&&/[0-9]/.test(p),'Choose 12 or more characters with upper case, lower case and a number');
const brandingSchema=z.object({version:z.number().int().min(1),displayName:z.string().trim().max(120),supportEmail:z.union([email,z.literal('')]),footerNote:z.string().trim().max(200),enabled:z.boolean()}).strict();
const federationSchema=z.object({
 issuer:z.url().max(500),clientId:z.string().trim().min(1).max(200),redirectUri:z.url().max(500),discoveryUrl:z.url().max(500),
 roleClaim:z.string().trim().min(1).max(100),
 roleMappings:z.array(z.object({claimValue:z.string().trim().min(1).max(200),role:z.enum(FEDERATED_ROLES)}).strict()).min(1).max(20),
 allowedEmailDomains:z.array(z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/).transform(v=>v.toLowerCase())).max(10),
 version:z.number().int().min(0)
}).strict();

export function install(app,{db,get,audit,csrf,transaction,passwordHash=null,isTenantActive=()=>true,recheckAccess=()=>false,mfaStatus,fail,now,tenantInfo=null,production=false,config=null}){
 const clock=typeof config?.clock==='function'?config.clock:Date.now;
 const stamp=()=>new Date(clock()).toISOString();
 const transport=config?.transport&&typeof config.transport==='object'?config.transport:null;
 const federationConfigured=config?.allowFederation===true&&Boolean(transport);
 const productionFederationAuthorized=config?.allowProductionFederation===true;
 db.exec(`CREATE TABLE IF NOT EXISTS tenant_administration_secrets(name TEXT PRIMARY KEY,value TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workspace_branding(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,display_name TEXT NOT NULL DEFAULT '',support_email TEXT NOT NULL DEFAULT '',footer_note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS user_invitations(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','staff','viewer','event-helper')),token_hash TEXT NOT NULL UNIQUE,signature TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Pending','Accepted','Revoked','Expired','Suppressed')),issued_by TEXT NOT NULL REFERENCES users(id),issued_by_version INTEGER NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,closed_at TEXT,closed_reason TEXT,accepted_user_id TEXT,version INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS user_invitation_one_pending ON user_invitations(email) WHERE status='Pending';
 CREATE INDEX IF NOT EXISTS user_invitation_status ON user_invitations(status,expires_at);
 CREATE TABLE IF NOT EXISTS user_invitation_events(id TEXT PRIMARY KEY,invitation_id TEXT NOT NULL REFERENCES user_invitations(id),status TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS user_invitation_no_delete BEFORE DELETE ON user_invitations BEGIN SELECT RAISE(ABORT,'Invitation history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS user_invitation_event_no_update BEFORE UPDATE ON user_invitation_events BEGIN SELECT RAISE(ABORT,'Invitation events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS user_invitation_event_no_delete BEFORE DELETE ON user_invitation_events BEGIN SELECT RAISE(ABORT,'Invitation events are retained'); END;
 CREATE TABLE IF NOT EXISTS duty_reviews(id TEXT PRIMARY KEY,duty TEXT NOT NULL,subject_collection TEXT NOT NULL,subject_id TEXT NOT NULL,subject_version INTEGER NOT NULL,summary TEXT NOT NULL,amount_cents INTEGER,preparer_id TEXT NOT NULL REFERENCES users(id),preparer_role TEXT NOT NULL,preparer_version INTEGER NOT NULL,preparer_binding TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Prepared','Approved','Rejected','Withdrawn','Suppressed')),approver_id TEXT,approver_role TEXT,decision_reason TEXT,decided_at TEXT,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS duty_review_one_open ON duty_reviews(duty,subject_id) WHERE status='Prepared';
 CREATE TABLE IF NOT EXISTS duty_policy_settings(duty TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),reason TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS duty_policy_changes(id TEXT PRIMARY KEY,duty TEXT NOT NULL,from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,enabled INTEGER NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS duty_policy_no_delete BEFORE DELETE ON duty_policy_settings BEGIN SELECT RAISE(ABORT,'Duty policy settings are retained'); END;
 CREATE TRIGGER IF NOT EXISTS duty_policy_change_no_update BEFORE UPDATE ON duty_policy_changes BEGIN SELECT RAISE(ABORT,'Duty policy history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS duty_policy_change_no_delete BEFORE DELETE ON duty_policy_changes BEGIN SELECT RAISE(ABORT,'Duty policy history is retained'); END;
 CREATE TABLE IF NOT EXISTS duty_review_events(id TEXT PRIMARY KEY,review_id TEXT NOT NULL REFERENCES duty_reviews(id),status TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS duty_review_no_delete BEFORE DELETE ON duty_reviews BEGIN SELECT RAISE(ABORT,'Separation-of-duties history is retained'); END;
 CREATE TRIGGER IF NOT EXISTS duty_review_event_no_update BEFORE UPDATE ON duty_review_events BEGIN SELECT RAISE(ABORT,'Review events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS duty_review_event_no_delete BEFORE DELETE ON duty_review_events BEGIN SELECT RAISE(ABORT,'Review events are retained'); END;
 CREATE TABLE IF NOT EXISTS federation_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,issuer TEXT NOT NULL DEFAULT '',client_id TEXT NOT NULL DEFAULT '',redirect_uri TEXT NOT NULL DEFAULT '',discovery_url TEXT NOT NULL DEFAULT '',role_claim TEXT NOT NULL DEFAULT 'groups',role_mappings TEXT NOT NULL DEFAULT '[]',allowed_domains TEXT NOT NULL DEFAULT '[]',metadata TEXT,jwks TEXT,discovered_at TEXT,authorization_reference TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS federation_requests(state_hash TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL,code_challenge TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,expires INTEGER NOT NULL,consumed_at TEXT);
 CREATE TABLE IF NOT EXISTS federation_assertions(id TEXT PRIMARY KEY,subject TEXT NOT NULL,email TEXT NOT NULL,mapped_role TEXT NOT NULL,issuer TEXT NOT NULL,session_issued INTEGER NOT NULL DEFAULT 0,at TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS federation_assertion_no_update BEFORE UPDATE ON federation_assertions BEGIN SELECT RAISE(ABORT,'Federation assertions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS federation_assertion_no_delete BEFORE DELETE ON federation_assertions BEGIN SELECT RAISE(ABORT,'Federation assertions are retained'); END;`);
 if(!db.prepare('SELECT 1 FROM workspace_branding WHERE id=1').get())db.prepare('INSERT INTO workspace_branding(id,enabled,display_name,support_email,footer_note,version,updated_at) VALUES(1,0,?,?,?,1,?)').run('','','',stamp());
 if(!db.prepare('SELECT 1 FROM federation_settings WHERE id=1').get())db.prepare('INSERT INTO federation_settings(id,updated_at) VALUES(1,?)').run(stamp());
 // Separation of duties is an available control, not a silent new obligation:
 // every duty policy starts DISABLED and changes nothing until it is enabled.
 for(const policy of DUTIES)if(!db.prepare('SELECT 1 FROM duty_policy_settings WHERE duty=?').get(policy.duty))db.prepare('INSERT INTO duty_policy_settings(duty,enabled,reason,version,updated_at) VALUES(?,0,?,1,?)').run(policy.duty,'Disabled by default',stamp());
 const secret=(()=>{const existing=db.prepare("SELECT value FROM tenant_administration_secrets WHERE name='invitation'").get();if(existing)return Buffer.from(existing.value,'hex');const value=randomBytes(32);db.prepare('INSERT INTO tenant_administration_secrets(name,value,created_at) VALUES(?,?,?)').run('invitation',value.toString('hex'),stamp());return value;})();

 const entitlements=()=>{const supplied=config?.entitlements||(config?.plan?planEntitlements(config.plan):null)||tenantInfo?.entitlements||null;return supplied?{...UNMANAGED,...supplied,connectors:[...(supplied.connectors||[])]}:{...UNMANAGED,connectors:[]};};
 const billing=()=>{const plan=config?.plan||config?.entitlements?.plan||tenantInfo?.plan||null;return plan?planBillingState(plan):{plan:'unmanaged',planLabel:'Unmanaged workspace',billingConfigured:false,billingProvider:null,subscriptionActive:false,invoices:[],charges:[],providerEvents:[],note:'This workspace has no plan classification and no billing provider. No invoice, charge, subscription or payment event exists.'};};
 const account=key=>db.prepare('SELECT * FROM users WHERE id=?').get(key);
 const live=req=>{if(!isTenantActive())fail(403,'Workspace is suspended');if(!recheckAccess(req))fail(401,'Account access changed. Sign in again');};
 const action=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 const asyncAction=fn=>(req,res,next)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
 const authorized=(req,res,next)=>{try{if(req.user?.role!=='admin')fail(403,'Administrator required');live(req);next();}catch(e){next(e);}};
 const factor=user=>{try{const status=mfaStatus?.(user);return status?{mfaEnabled:Boolean(status.enabled),mfaAvailable:Boolean(status.available),recoveryCodesRemaining:Number(status.recoveryCodesRemaining||0)}:{mfaEnabled:false,mfaAvailable:false,recoveryCodesRemaining:0};}catch{return {mfaEnabled:false,mfaAvailable:false,recoveryCodesRemaining:0};}};

 // ---- seats -------------------------------------------------------------
 const helperRole=role=>role===HELPER_ROLE;
 const seatClass=role=>helperRole(role)?'helper':'full';
 function seatUsage(){
  const users=db.prepare('SELECT role,COUNT(*) n FROM users WHERE active=1 GROUP BY role').all();
  const invitations=db.prepare("SELECT role,COUNT(*) n FROM user_invitations WHERE status='Pending' GROUP BY role").all();
  const count=(rows,helper)=>rows.filter(r=>helperRole(r.role)===helper).reduce((total,r)=>total+r.n,0);
  return {fullUsers:count(users,false),helperUsers:count(users,true),fullInvitations:count(invitations,false),helperInvitations:count(invitations,true)};
 }
 function seatReport(){const e=entitlements(),usage=seatUsage();
  return {plan:e.plan,planLabel:e.label,fullUserSeats:e.fullUserSeats,helperSeats:e.helperSeats,
   fullUsersInUse:usage.fullUsers,fullInvitationsPending:usage.fullInvitations,helperUsersInUse:usage.helperUsers,helperInvitationsPending:usage.helperInvitations,
   fullSeatsRemaining:e.fullUserSeats===null?null:Math.max(0,e.fullUserSeats-usage.fullUsers-usage.fullInvitations),
   helperSeatsRemaining:e.helperSeats===null?null:Math.max(0,e.helperSeats-usage.helperUsers-usage.helperInvitations),
   metered:e.fullUserSeats!==null||e.helperSeats!==null};
 }
 // Execution-time entitlement check. Pending invitations reserve a seat so an
 // invitation can never be redeemed past the plan.
 function assertSeat(role,{excludeUserId=null,excludeInvitationId=null}={}){
  const e=entitlements(),helper=helperRole(role),limit=helper?e.helperSeats:e.fullUserSeats;
  if(limit===null||limit===undefined)return null;
  const users=db.prepare('SELECT role FROM users WHERE active=1 AND id<>?').all(excludeUserId||'').filter(r=>helperRole(r.role)===helper).length;
  const invitations=db.prepare("SELECT role FROM user_invitations WHERE status='Pending' AND id<>?").all(excludeInvitationId||'').filter(r=>helperRole(r.role)===helper).length;
  if(users+invitations+1>limit)fail(409,`The ${e.label} plan includes ${limit} ${helper?'optional non-administrator helper seats':'full user seats'}. ${users} in use and ${invitations} invited. Close an account or revoke an invitation before adding another.`);
  return {limit,inUse:users,invited:invitations};
 }
 // Registered before the existing account routes so the plan is enforced at
 // execution. Role denial, CSRF and every existing control stay with app.js.
 const seatGuard=(req,res,next)=>{
  try{
   if(req.user?.role!=='admin'||req.get('X-CSRF-Token')!==req.session?.csrf)return next();
   // Only a request that would otherwise succeed is metered, so an existing
   // validation, role or CSRF refusal is never replaced by a seat message.
   const shape=req.method==='POST'
    ?z.object({name:z.string().trim().min(1).max(250),email:z.email().max(254),password:z.string().min(12).max(200),role:z.enum(ALL_ROLES)}).strict()
    :z.object({version:z.number().int().min(1),role:z.enum(ALL_ROLES),active:z.boolean()}).strict();
   const parsed=shape.safeParse(req.body);
   if(!parsed.success)return next();
   if(req.method==='POST'){if(db.prepare('SELECT 1 FROM users WHERE email=?').get(String(parsed.data.email).toLowerCase()))return next();assertSeat(parsed.data.role);return next();}
   const target=account(req.params.id);
   if(!target||parsed.data.active===false)return next();
   if(Boolean(target.active)&&target.role===parsed.data.role)return next();
   assertSeat(parsed.data.role,{excludeUserId:target.id});
   next();
  }catch(e){next(e);}
 };
 app.post('/api/users',seatGuard);
 app.patch('/api/users/:id',seatGuard);

 // ---- invitations -------------------------------------------------------
 const invitationView=row=>({id:row.id,email:row.email,name:row.name,role:row.role,seatClass:seatClass(row.role),status:row.status,issuedBy:row.issued_by,issuedAt:row.issued_at,expiresAt:row.expires_at,closedAt:row.closed_at||null,closedReason:row.closed_reason||null,acceptedUserId:row.accepted_user_id||null,version:row.version});
 const invitationEvents=key=>db.prepare('SELECT * FROM user_invitation_events WHERE invitation_id=? ORDER BY at,rowid').all(key).map(r=>({id:r.id,status:r.status,reason:r.reason,actor:r.actor,at:r.at}));
 const recordInvitationEvent=(key,status,why,actor)=>db.prepare('INSERT INTO user_invitation_events VALUES(?,?,?,?,?,?)').run(randomUUID(),key,status,why,actor,stamp());
 const signInvitation=(key,mail,role,expiresAt)=>createHmac('sha256',secret).update([key,mail,role,expiresAt].join('|')).digest('base64url');
 function expireStale(){const at=stamp();for(const row of db.prepare("SELECT * FROM user_invitations WHERE status='Pending' AND expires_at<=?").all(at)){db.prepare("UPDATE user_invitations SET status='Expired',closed_at=?,closed_reason=?,version=version+1 WHERE id=? AND status='Pending'").run(at,'Invitation expired',row.id);recordInvitationEvent(row.id,'Expired','Invitation expired','system');}}
 function suppressPendingInvitations(why='Workspace suspended'){let suppressed=0;transaction(()=>{const at=stamp();for(const row of db.prepare("SELECT * FROM user_invitations WHERE status='Pending' ORDER BY id").all()){db.prepare("UPDATE user_invitations SET status='Suppressed',closed_at=?,closed_reason=?,version=version+1 WHERE id=? AND status='Pending'").run(at,why,row.id);recordInvitationEvent(row.id,'Suppressed',why,'system');suppressed++;}db.prepare('UPDATE federation_requests SET consumed_at=? WHERE consumed_at IS NULL').run(at);});
  if(suppressed)audit({id:'system'},'suppress_user_invitations','users',null,{suppressed,reason:why,delivery:'No message sent'});
  return {suppressed};
 }
 app.locals.suppressTenantAdministration=()=>{try{return suppressPendingInvitations();}catch{return {suppressed:0};}};

 app.get('/api/tenant-administration/invitations',authorized,action((req,res)=>{z.object({}).strict().parse(req.query);transaction(()=>expireStale());
  const rows=db.prepare('SELECT * FROM user_invitations ORDER BY issued_at DESC,id LIMIT 200').all();
  res.json({invitations:rows.map(invitationView),seats:seatReport(),limit:200,delivery:'No message is sent. Hand the invitation link to the recipient through your approved secure process.'});}));
 app.get('/api/tenant-administration/invitations/:id',authorized,action((req,res)=>{z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);const row=db.prepare('SELECT * FROM user_invitations WHERE id=?').get(req.params.id);if(!row)fail(404,'Invitation not found');res.json({invitation:invitationView(row),events:invitationEvents(row.id)});}));
 app.post('/api/tenant-administration/invitations',authorized,csrf,action((req,res)=>{
  const body=z.object({email,name:z.string().trim().min(1).max(250),role:z.enum(INVITABLE_ROLES),expiresInHours:z.number().int().min(1).max(336).default(72),reason}).strict().parse(req.body);
  const issued=transaction(()=>{
   live(req);expireStale();
   const e=entitlements();if(!e.invitations)fail(409,`The ${e.label} plan does not include user invitations. Add accounts directly, or change the plan.`);
   if(db.prepare('SELECT 1 FROM users WHERE email=?').get(body.email))fail(409,'An account already uses this email address');
   if(db.prepare("SELECT 1 FROM user_invitations WHERE email=? AND status='Pending'").get(body.email))fail(409,'This email already has an open invitation. Revoke it before issuing another');
   assertSeat(body.role);
   const key=randomUUID(),at=stamp(),expiresAt=new Date(clock()+body.expiresInHours*3600000).toISOString(),signature=signInvitation(key,body.email,body.role,expiresAt),token=key+'.'+signature,issuer=account(req.user.id);
   if(!issuer?.active||issuer.role!=='admin')fail(401,'Account access changed. Sign in again');
   db.prepare('INSERT INTO user_invitations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,body.email,body.name,body.role,sha(token),signature,'Pending',issuer.id,issuer.version,at,expiresAt,null,null,null,1);
   recordInvitationEvent(key,'Pending',body.reason,issuer.id);
   audit(req.user,'issue_user_invitation','users',key,{email:body.email,role:body.role,seatClass:seatClass(body.role),expiresAt,reason:body.reason,delivery:'No message sent'});
   live(req);
   return {invitation:invitationView(db.prepare('SELECT * FROM user_invitations WHERE id=?').get(key)),token};
  });
  res.status(201).json({...issued,seats:seatReport(),delivery:'No message sent. This single-use token is shown once; hand it over through your approved secure process.',privilege:'The invited role is signed into the token. It cannot be changed at acceptance.'});
 }));
 app.post('/api/tenant-administration/invitations/:id/revoke',authorized,csrf,action((req,res)=>{
  z.uuid().parse(req.params.id);const body=z.object({version:z.number().int().min(1),reason}).strict().parse(req.body);
  const result=transaction(()=>{live(req);expireStale();const row=db.prepare('SELECT * FROM user_invitations WHERE id=?').get(req.params.id);if(!row)fail(404,'Invitation not found');
   if(row.status!=='Pending')fail(409,`This invitation is ${row.status.toLowerCase()}. Issue a new invitation if access is still needed`);
   if(row.version!==body.version)fail(409,'Invitation changed. Reload its current version before continuing');
   const at=stamp();const changed=db.prepare("UPDATE user_invitations SET status='Revoked',closed_at=?,closed_reason=?,version=version+1 WHERE id=? AND version=? AND status='Pending'").run(at,body.reason,row.id,row.version);
   if(changed.changes!==1)fail(409,'Invitation changed. Reload its current version before continuing');
   recordInvitationEvent(row.id,'Revoked',body.reason,req.user.id);
   audit(req.user,'revoke_user_invitation','users',row.id,{email:row.email,role:row.role,reason:body.reason});
   live(req);return invitationView(db.prepare('SELECT * FROM user_invitations WHERE id=?').get(row.id));});
  res.json({invitation:result,seats:seatReport()});
 }));
 // Acceptance surface. Used by the unauthenticated public router; exported on the
 // service so the workspace owns one implementation of the rule set.
 function acceptInvitation({token,name,password}){
  const parsed=z.object({token:z.string().min(10).max(500),name:z.string().trim().min(1).max(250),password:invitationPassword}).strict().parse({token,name,password});
  const [key,signature]=parsed.token.split('.');
  if(!key||!signature||!z.uuid().safeParse(key).success)fail(400,'This invitation link is not valid. Ask an administrator for a new invitation.');
  return transaction(()=>{
   if(!isTenantActive())fail(403,'Workspace is suspended');
   expireStale();
   const row=db.prepare('SELECT * FROM user_invitations WHERE id=?').get(key);
   if(!row||!equal(row.token_hash,sha(parsed.token)))fail(404,'This invitation link is not valid. Ask an administrator for a new invitation.');
   if(!equal(row.signature,signInvitation(row.id,row.email,row.role,row.expires_at)))fail(400,'This invitation link was altered and cannot be used.');
   if(row.status!=='Pending')fail(409,`This invitation is ${row.status.toLowerCase()} and cannot be used again. Ask an administrator for a new invitation.`);
   if(row.expires_at<=stamp())fail(409,'This invitation has expired. Ask an administrator for a new invitation.');
   if(db.prepare('SELECT 1 FROM users WHERE email=?').get(row.email))fail(409,'An account already uses this email address');
   assertSeat(row.role,{excludeInvitationId:row.id});
   // The workspace credential format is owned by the host application; this module
   // never re-implements it, so an invited account signs in like any other account.
   if(typeof passwordHash!=='function')fail(503,'Account credential creation is unavailable on this server. Ask an administrator to add the account directly.');
   const id=randomUUID();
   db.prepare('INSERT INTO users(id,name,email,role,password_hash,active,version) VALUES(?,?,?,?,?,1,1)').run(id,parsed.name,row.email,row.role,passwordHash(parsed.password));
   const closed=db.prepare("UPDATE user_invitations SET status='Accepted',closed_at=?,closed_reason=?,accepted_user_id=?,version=version+1 WHERE id=? AND version=? AND status='Pending'").run(stamp(),'Invitation accepted',id,row.id,row.version);
   if(closed.changes!==1)fail(409,'This invitation changed while it was being accepted. Ask an administrator for a new invitation.');
   recordInvitationEvent(row.id,'Accepted','Invitation accepted',id);
   audit({id},'accept_user_invitation','users',id,{invitationId:row.id,role:row.role,seatClass:seatClass(row.role),email:row.email,privilege:'Role fixed by the signed invitation'});
   return {user:{id,name:parsed.name,email:row.email,role:row.role,active:true,version:1},invitationId:row.id,mfa:production?'Required. Complete authenticator setup at first sign-in.':'Available in Account security.'};
  });
 }

 // ---- separation of duties ---------------------------------------------
 const reviewView=row=>({id:row.id,duty:row.duty,dutyLabel:dutyPolicy(row.duty)?.label||row.duty,subjectCollection:row.subject_collection,subjectId:row.subject_id,subjectVersion:row.subject_version,summary:row.summary,amountCents:row.amount_cents===null?null:row.amount_cents,preparedBy:row.preparer_id,preparerRole:row.preparer_role,status:row.status,approvedBy:row.approver_id||null,approverRole:row.approver_role||null,decisionReason:row.decision_reason||null,decidedAt:row.decided_at||null,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at});
 const recordReviewEvent=(key,status,why,actor)=>db.prepare('INSERT INTO duty_review_events VALUES(?,?,?,?,?,?)').run(randomUUID(),key,status,why,actor,stamp());
 function subjectVersionOf(policy,key){
  if(policy.collection==='users'){const user=account(key);if(!user)fail(404,'Account not found');return user.version;}
  try{return get(policy.collection,key).version;}catch(e){if(e.status===404)fail(404,'The record for this review was not found');throw e;}
 }
 const reviewAuthority=(req,roles)=>{const user=account(req.user.id);if(!user?.active||user.role!==req.user.role||!roles.includes(user.role))fail(403,'Your role cannot take this separation-of-duties action');return user;};
 const preparerGuard=(req,res,next)=>{try{if(!ALL_ROLES.includes(req.user?.role))fail(403,'Workspace access required');live(req);next();}catch(e){next(e);}};
  const policyRow=key=>db.prepare('SELECT * FROM duty_policy_settings WHERE duty=?').get(key);
 const policyEnabled=key=>Boolean(policyRow(key)?.enabled);
 const policyView=policy=>{const row=policyRow(policy.duty);return {...policy,preparerRoles:[...policy.preparerRoles],approverRoles:[...policy.approverRoles],distinctApproverRequired:true,enabled:Boolean(row?.enabled),version:row?.version??1,reason:row?.reason||'',updatedAt:row?.updated_at||null};};
 // Enabling a control must never strand the workspace: an approval can only be
 // obtained if a second, distinct account already holds an approver role.
 const availableApprovers=policy=>db.prepare('SELECT COUNT(*) n FROM users WHERE active=1 AND role IN ('+policy.approverRoles.map(()=>'?').join(',')+')').get(...policy.approverRoles).n;
 app.get('/api/tenant-administration/duty-policies',preparerGuard,action((req,res)=>{z.object({}).strict().parse(req.query);res.json({duties:DUTIES.map(policyView),roles:ROLE_MATRIX,note:'Separation of duties is disabled by default. While a duty policy is disabled nothing changes; while it is enabled the prepared action is refused until a different authorized person approves the current version.'});}));
 app.patch('/api/tenant-administration/duty-policies/:duty',authorized,csrf,action((req,res)=>{
  const key=z.enum(DUTY_KEYS).parse(req.params.duty),body=z.object({version:z.number().int().min(1),enabled:z.boolean(),reason}).strict().parse(req.body),policy=dutyPolicy(key);
  const updated=transaction(()=>{live(req);const row=policyRow(key);
   if(row.version!==body.version)fail(409,'This control changed. Reload its current version before saving');
   if(Boolean(row.enabled)===body.enabled)fail(409,'Choose a change to this control');
   if(body.enabled&&availableApprovers(policy)<2)fail(409,`Add a second active ${policy.approverRoles.join(' or ')} account before enabling this control. With only one, the prepared action could never obtain an approval.`);
   const at=stamp(),changed=db.prepare('UPDATE duty_policy_settings SET enabled=?,reason=?,version=version+1,updated_at=? WHERE duty=? AND version=?').run(body.enabled?1:0,body.reason,at,key,row.version);
   if(changed.changes!==1)fail(409,'This control changed. Reload its current version before saving');
   db.prepare('INSERT INTO duty_policy_changes VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),key,row.version,row.version+1,body.enabled?1:0,body.reason,req.user.id,at);
   audit(req.user,body.enabled?'enable_duty_policy':'disable_duty_policy',policy.collection,null,{duty:key,previousEnabled:Boolean(row.enabled),enabled:body.enabled,reason:body.reason});
   live(req);return policyView(policy);});
  res.json({duty:updated,note:updated.enabled?'This action is now refused until a different authorized person approves the current record version.':'This control is off. The action behaves exactly as it did before it was enabled.'});
 }));
 app.get('/api/tenant-administration/duty-policies/:duty/history',authorized,action((req,res)=>{const key=z.enum(DUTY_KEYS).parse(req.params.duty);z.object({}).strict().parse(req.query);
  res.json({duty:policyView(dutyPolicy(key)),changes:db.prepare('SELECT * FROM duty_policy_changes WHERE duty=? ORDER BY at,rowid').all(key).map(r=>({id:r.id,fromVersion:r.from_version,toVersion:r.to_version,enabled:Boolean(r.enabled),reason:r.reason,actor:r.actor,at:r.at}))});}));
 app.get('/api/tenant-administration/reviews',preparerGuard,action((req,res)=>{const query=z.object({status:z.enum(['Prepared','Approved','Rejected','Withdrawn','Suppressed']).optional()}).strict().parse(req.query);
  const rows=query.status?db.prepare('SELECT * FROM duty_reviews WHERE status=? ORDER BY created_at DESC,id LIMIT 200').all(query.status):db.prepare('SELECT * FROM duty_reviews ORDER BY created_at DESC,id LIMIT 200').all();
  res.json({reviews:rows.map(reviewView),limit:200});}));
 app.post('/api/tenant-administration/reviews',preparerGuard,csrf,action((req,res)=>{
  const body=z.object({duty:z.enum(DUTY_KEYS),subjectId:z.uuid(),subjectVersion:z.number().int().min(1),summary:z.string().trim().min(5).max(1000),amountCents:z.number().int().min(-1000000000).max(1000000000).optional()}).strict().parse(req.body);
  const policy=dutyPolicy(body.duty);
  const review=transaction(()=>{live(req);const preparer=reviewAuthority(req,policy.preparerRoles);
   const current=subjectVersionOf(policy,body.subjectId);
   if(current!==body.subjectVersion)fail(409,'This record changed. Reload its current version before preparing a review');
   if(db.prepare("SELECT 1 FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Prepared'").get(body.duty,body.subjectId))fail(409,'This record already has an open review. Decide or withdraw it first');
   const key=randomUUID(),at=stamp();
   db.prepare('INSERT INTO duty_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,body.duty,policy.collection,body.subjectId,body.subjectVersion,body.summary,body.amountCents===undefined?null:body.amountCents,preparer.id,preparer.role,preparer.version,mfaAccountBinding(preparer),'Prepared',null,null,null,null,1,at,at);
   recordReviewEvent(key,'Prepared',body.summary,preparer.id);
   audit(req.user,'prepare_duty_review',policy.collection,body.subjectId,{reviewId:key,duty:body.duty,subjectVersion:body.subjectVersion,amountCents:body.amountCents??null});
   live(req);return reviewView(db.prepare('SELECT * FROM duty_reviews WHERE id=?').get(key));});
  res.status(201).json({review,separationOfDuties:'A different, currently authorized approver must decide this review.'});
 }));
 app.post('/api/tenant-administration/reviews/:id/decision',preparerGuard,csrf,action((req,res)=>{
  z.uuid().parse(req.params.id);
  const body=z.object({version:z.number().int().min(1),decision:z.enum(['approved','rejected']),reason}).strict().parse(req.body);
  const review=transaction(()=>{live(req);
   const row=db.prepare('SELECT * FROM duty_reviews WHERE id=?').get(req.params.id);if(!row)fail(404,'Review not found');
   const policy=dutyPolicy(row.duty);
   if(row.status!=='Prepared')fail(409,`This review is ${row.status.toLowerCase()} and cannot be decided again`);
   if(row.version!==body.version)fail(409,'Review changed. Reload its current version before deciding');
   // The same-actor rule is checked first so the preparer always sees why the
   // decision is refused, whatever role the preparer currently holds.
   if(req.user.id===row.preparer_id)fail(403,'Separation of duties requires a different approver. The actor who prepared this action cannot approve it.');
   const approver=reviewAuthority(req,policy.approverRoles);
   const preparer=account(row.preparer_id);
   if(!preparer?.active||!policy.preparerRoles.includes(preparer.role)||preparer.version!==row.preparer_version||mfaAccountBinding(preparer)!==row.preparer_binding)fail(409,'The preparer’s access changed after preparation. Prepare this action again before approving it.');
   const current=subjectVersionOf(policy,row.subject_id);
   if(current!==row.subject_version)fail(409,'This record changed after the review was prepared. Prepare the action again against the current version.');
   const at=stamp(),status=body.decision==='approved'?'Approved':'Rejected';
   const changed=db.prepare('UPDATE duty_reviews SET status=?,approver_id=?,approver_role=?,decision_reason=?,decided_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status=\'Prepared\'').run(status,approver.id,approver.role,body.reason,at,at,row.id,row.version);
   if(changed.changes!==1)fail(409,'Review changed. Reload its current version before deciding');
   recordReviewEvent(row.id,status,body.reason,approver.id);
   audit(req.user,'decide_duty_review',policy.collection,row.subject_id,{reviewId:row.id,duty:row.duty,decision:status,preparedBy:row.preparer_id,approvedBy:approver.id,reason:body.reason});
   live(req);return reviewView(db.prepare('SELECT * FROM duty_reviews WHERE id=?').get(row.id));});
  res.json({review});
 }));
 // Consumable by any module that must not let one actor both prepare and approve.
 // enforceIfEnabled is the safe call site: it is a strict no-op while the duty
 // policy is disabled, so a workspace that never enables it is unchanged.
 function assertApproved(duty,subjectId,subjectVersion){
  const policy=dutyPolicy(duty);if(!policy)fail(400,'Unknown reviewable duty');
  const row=db.prepare("SELECT * FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Approved' ORDER BY decided_at DESC,rowid DESC LIMIT 1").get(duty,subjectId);
  if(!row)fail(409,`${policy.label} requires a recorded approval by a second authorized person.`);
  if(row.subject_version!==subjectVersion)fail(409,'This record changed after approval. Prepare and approve the action against the current version.');
  if(row.approver_id===row.preparer_id)fail(409,'Separation of duties was not satisfied for this action.');
  return reviewView(row);
 }

 // ---- branding, security visibility, overview ---------------------------
 const brandingRow=()=>db.prepare('SELECT * FROM workspace_branding WHERE id=1').get();
 const brandingView=row=>({enabled:Boolean(row.enabled),displayName:row.display_name,supportEmail:row.support_email,footerNote:row.footer_note,version:row.version,updatedAt:row.updated_at,productIdentity:PRODUCT_IDENTITY});
 app.get('/api/tenant-administration/branding',preparerGuard,action((req,res)=>{z.object({}).strict().parse(req.query);res.json({branding:brandingView(brandingRow())});}));
 app.patch('/api/tenant-administration/branding',authorized,csrf,action((req,res)=>{
  const body=brandingSchema.parse(req.body);
  const branding=transaction(()=>{live(req);const row=brandingRow();if(row.version!==body.version)fail(409,'Branding changed. Reload its current version before saving');
   if(body.enabled&&!body.displayName)fail(400,'Add the organization display name before turning customer branding on');
   const changed=db.prepare('UPDATE workspace_branding SET enabled=?,display_name=?,support_email=?,footer_note=?,version=version+1,updated_at=? WHERE id=1 AND version=?').run(body.enabled?1:0,body.displayName,body.supportEmail,body.footerNote,stamp(),row.version);
   if(changed.changes!==1)fail(409,'Branding changed. Reload its current version before saving');
   audit(req.user,'update_workspace_branding',null,null,{enabled:body.enabled,displayName:body.displayName,productIdentity:PRODUCT_IDENTITY.productName});
   live(req);return brandingView(brandingRow());});
  res.json({branding});
 }));
 app.get('/api/tenant-administration/security',authorized,action((req,res)=>{z.object({}).strict().parse(req.query);
  const rows=db.prepare('SELECT id,name,email,role,active,version FROM users ORDER BY name,id').all();
  const accounts=rows.map(u=>({id:u.id,name:u.name,email:u.email,role:u.role,active:Boolean(u.active),version:u.version,...factor(u)}));
  res.json({accounts,mfaRequired:production,scope:'Enrollment state only. Authenticator secrets, pending secrets and recovery codes are never readable here, and no administrator can disable or bypass another account’s MFA.',
   enrolled:accounts.filter(a=>a.mfaEnabled).length,notEnrolled:accounts.filter(a=>!a.mfaEnabled).length});}));
 app.get('/api/tenant-administration/overview',authorized,action((req,res)=>{z.object({}).strict().parse(req.query);transaction(()=>expireStale());
  const e=entitlements(),rows=db.prepare('SELECT id,name,email,role,active,version FROM users ORDER BY name,id').all();
  res.json({
   workspace:{name:tenantInfo?.name||null,slug:tenantInfo?.slug||null,managed:Boolean(tenantInfo),status:isTenantActive()?'active':'suspended'},
   entitlements:{...e,connectors:[...e.connectors]},seats:seatReport(),billing:billing(),branding:brandingView(brandingRow()),productIdentity:PRODUCT_IDENTITY,roles:ROLE_MATRIX,
   accounts:rows.map(u=>({id:u.id,name:u.name,email:u.email,role:u.role,seatClass:seatClass(u.role),active:Boolean(u.active),version:u.version,...factor(u)})),
   invitations:db.prepare('SELECT * FROM user_invitations ORDER BY issued_at DESC,id LIMIT 50').all().map(invitationView),
   reviews:db.prepare('SELECT * FROM duty_reviews ORDER BY created_at DESC,id LIMIT 50').all().map(reviewView),
   duties:DUTIES.map(policyView),
   federation:federationView(),mfaRequired:production});}));

 // ---- optional federated sign-in boundary (disabled by default) ---------
 const federationRow=()=>db.prepare('SELECT * FROM federation_settings WHERE id=1').get();
 function federationView(){const row=federationRow();
  return {enabled:Boolean(row.enabled),configured:federationConfigured,issuer:row.issuer,clientId:row.client_id,redirectUri:row.redirect_uri,discoveryUrl:row.discovery_url,
   roleClaim:row.role_claim,roleMappings:JSON.parse(row.role_mappings),allowedEmailDomains:JSON.parse(row.allowed_domains),
   discoveredAt:row.discovered_at||null,keyCount:row.jwks?JSON.parse(row.jwks).keys.length:0,authorizationReference:row.authorization_reference||'',version:row.version,
   entitled:entitlements().federation===true,assignableRoles:[...FEDERATED_ROLES],
   productionEnablementAuthorized:productionFederationAuthorized,
   scope:'Optional boundary. Federated sign-in is disabled by default, issues no workspace session in this release, and never replaces MFA.',
   assertions:db.prepare('SELECT * FROM federation_assertions ORDER BY at DESC,rowid DESC LIMIT 25').all().map(r=>({id:r.id,subject:r.subject,email:r.email,mappedRole:r.mapped_role,issuer:r.issuer,sessionIssued:Boolean(r.session_issued),at:r.at,detail:r.detail}))};
 }
 const federationAvailable=()=>{
  if(!federationConfigured)fail(503,'Optional federated sign-in is not configured on this server. No identity provider is contacted.');
  if(!entitlements().federation)fail(409,`The ${entitlements().label} plan does not include the federated sign-in connector.`);
 };
 app.get('/api/tenant-administration/federation',authorized,action((req,res)=>{z.object({}).strict().parse(req.query);res.json({federation:federationView()});}));
 app.put('/api/tenant-administration/federation',authorized,csrf,action((req,res)=>{
  const body=federationSchema.parse(req.body);
  const federation=transaction(()=>{live(req);federationAvailable();const row=federationRow();if(row.version!==body.version)fail(409,'Federation settings changed. Reload the current version before saving');
   if(Boolean(row.enabled))fail(409,'Disable federated sign-in before changing its provider settings');
   if(new URL(body.discoveryUrl).origin!==new URL(body.issuer).origin)fail(400,'The discovery document must be published by the issuer’s own origin');
   if(new URL(body.issuer).protocol!=='https:'&&production)fail(400,'A production issuer must use HTTPS');
   db.prepare('UPDATE federation_settings SET issuer=?,client_id=?,redirect_uri=?,discovery_url=?,role_claim=?,role_mappings=?,allowed_domains=?,metadata=NULL,jwks=NULL,discovered_at=NULL,version=version+1,updated_at=? WHERE id=1 AND version=?').run(body.issuer,body.clientId,body.redirectUri,body.discoveryUrl,body.roleClaim,JSON.stringify(body.roleMappings),JSON.stringify(body.allowedEmailDomains),stamp(),row.version);
   audit(req.user,'update_federation_settings',null,null,{issuer:body.issuer,clientId:body.clientId,roleClaim:body.roleClaim,roleMappings:body.roleMappings,enabled:false,note:'No provider contacted'});
   live(req);return federationView();});
  res.json({federation});
 }));
 app.post('/api/tenant-administration/federation/discovery',authorized,csrf,asyncAction(async(req,res)=>{
  z.object({}).strict().parse(req.body??{});
  live(req);federationAvailable();
  const row=federationRow();if(!row.issuer||!row.discovery_url)fail(409,'Add the issuer and discovery document before running discovery');
  let metadata,jwks;
  try{metadata=await transport.discovery(row.discovery_url);jwks=await transport.jwks(metadata?.jwks_uri);}
  catch{fail(502,'The configured identity provider transport could not return discovery metadata.');}
  if(!metadata||metadata.issuer!==row.issuer)fail(400,'The discovery document does not belong to the configured issuer');
  for(const field of ['authorization_endpoint','token_endpoint','jwks_uri'])if(typeof metadata[field]!=='string')fail(400,'The discovery document is missing '+field);
  if(new URL(metadata.jwks_uri).origin!==new URL(row.issuer).origin)fail(400,'The published key set must be served by the issuer’s own origin');
  const algorithms=metadata.id_token_signing_alg_values_supported;
  if(!Array.isArray(algorithms)||!algorithms.includes('RS256'))fail(400,'Only RS256 identity tokens are accepted');
  const keys=Array.isArray(jwks?.keys)?jwks.keys.filter(k=>k&&k.kty==='RSA'&&typeof k.kid==='string'&&(k.use===undefined||k.use==='sig')):[];
  if(!keys.length)fail(400,'The published key set contains no usable RSA signing key');
  const federation=transaction(()=>{live(req);const current=federationRow();
   db.prepare('UPDATE federation_settings SET metadata=?,jwks=?,discovered_at=?,version=version+1,updated_at=? WHERE id=1 AND version=?').run(JSON.stringify({issuer:metadata.issuer,authorization_endpoint:metadata.authorization_endpoint,token_endpoint:metadata.token_endpoint,jwks_uri:metadata.jwks_uri}),JSON.stringify({keys}),stamp(),stamp(),current.version);
   audit(req.user,'discover_federation_metadata',null,null,{issuer:row.issuer,keyCount:keys.length,transport:'Configured boundary transport only'});
   return federationView();});
  res.json({federation});
 }));
 app.post('/api/tenant-administration/federation/enablement',authorized,csrf,action((req,res)=>{
  const body=z.object({version:z.number().int().min(1),enabled:z.boolean(),authorizationReference:z.string().trim().min(5).max(500),reason}).strict().parse(req.body);
  const federation=transaction(()=>{live(req);const row=federationRow();
   if(row.version!==body.version)fail(409,'Federation settings changed. Reload the current version before saving');
   if(Boolean(row.enabled)===body.enabled)fail(409,'Choose a change to federated sign-in');
   if(body.enabled){
    federationAvailable();
    if(production&&!productionFederationAuthorized)fail(403,'Optional federated sign-in cannot be enabled in production without explicit server configuration and recorded authorization.');
    if(!row.discovered_at||!row.jwks)fail(409,'Run provider discovery before enabling federated sign-in');
    if(!JSON.parse(row.role_mappings).length)fail(409,'Add at least one claim-to-role mapping before enabling federated sign-in');
   }
   const changed=db.prepare('UPDATE federation_settings SET enabled=?,authorization_reference=?,version=version+1,updated_at=? WHERE id=1 AND version=?').run(body.enabled?1:0,body.authorizationReference,stamp(),row.version);
   if(changed.changes!==1)fail(409,'Federation settings changed. Reload the current version before saving');
   audit(req.user,body.enabled?'enable_federated_signin':'disable_federated_signin',null,null,{issuer:row.issuer,authorizationReference:body.authorizationReference,reason:body.reason,sessionIssuance:'Not enabled in this release'});
   live(req);return federationView();});
  res.json({federation,note:'Federated sign-in remains a validated boundary: it issues no workspace session and never replaces MFA.'});
 }));
 app.post('/api/tenant-administration/federation/authorization',authorized,csrf,action((req,res)=>{
  z.object({}).strict().parse(req.body??{});
  const result=transaction(()=>{live(req);federationAvailable();const row=federationRow();
   if(!row.enabled)fail(409,'Federated sign-in is disabled. Enable it before starting an authorization request');
   if(!row.metadata)fail(409,'Run provider discovery before starting an authorization request');
   const metadata=JSON.parse(row.metadata),time=clock();
   db.prepare('DELETE FROM federation_requests WHERE expires<=?').run(time);
   const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
   const challenge=createHash('sha256').update(verifier).digest('base64url');
   db.prepare('INSERT INTO federation_requests VALUES(?,?,?,?,?,?,?)').run(sha(state),sha(nonce),challenge,req.user.id,stamp(),time+600000,null);
   audit(req.user,'start_federated_authorization',null,null,{issuer:row.issuer,pkce:'S256',secrets:'Not recorded'});
   const url=new URL(metadata.authorization_endpoint);
   for(const [key,value] of [['response_type','code'],['client_id',row.client_id],['redirect_uri',row.redirect_uri],['scope','openid email profile'],['state',state],['nonce',nonce],['code_challenge',challenge],['code_challenge_method','S256']])url.searchParams.set(key,value);
   return {authorizationUrl:url.toString(),state,nonce,codeVerifier:verifier,codeChallengeMethod:'S256',expiresInSeconds:600};});
  res.status(201).json({request:result,note:'State, nonce and PKCE verifier are shown once. No identity provider was contacted.'});
 }));
 function verifyIdToken(token,{issuer,clientId,nonce,keys,time}){
  const parts=String(token).split('.');
  if(parts.length!==3)fail(400,'The identity token is not a signed JWT');
  let header,payload;
  try{header=JSON.parse(fromB64u(parts[0]).toString('utf8'));payload=JSON.parse(fromB64u(parts[1]).toString('utf8'));}catch{fail(400,'The identity token could not be read');}
  if(header.alg!=='RS256')fail(400,'Only RS256 identity tokens are accepted');
  if(typeof header.kid!=='string')fail(400,'The identity token names no signing key');
  const jwk=keys.find(k=>k.kid===header.kid);
  if(!jwk)fail(400,'No published signing key matches this identity token');
  let key;try{key=createPublicKey({key:jwk,format:'jwk'});}catch{fail(400,'The published signing key could not be read');}
  if(!createVerify('RSA-SHA256').update(parts[0]+'.'+parts[1]).verify(key,fromB64u(parts[2])))fail(401,'The identity token signature did not verify');
  if(payload.iss!==issuer)fail(401,'The identity token was issued by a different issuer');
  const audience=Array.isArray(payload.aud)?payload.aud:[payload.aud];
  if(!audience.includes(clientId))fail(401,'The identity token was issued for a different client');
  if(audience.length>1&&payload.azp!==clientId)fail(401,'The identity token authorized party does not match this client');
  const seconds=Math.floor(time/1000);
  if(typeof payload.exp!=='number'||payload.exp<=seconds)fail(401,'The identity token has expired');
  if(typeof payload.iat!=='number'||payload.iat>seconds+300)fail(401,'The identity token is not yet valid');
  if(payload.nbf!==undefined&&(typeof payload.nbf!=='number'||payload.nbf>seconds+300))fail(401,'The identity token is not yet valid');
  if(typeof payload.nonce!=='string'||!equal(sha(payload.nonce),nonce))fail(401,'The identity token nonce does not match this sign-in attempt');
  if(typeof payload.sub!=='string'||!payload.sub.trim())fail(401,'The identity token has no subject');
  return payload;
 }
 app.post('/api/tenant-administration/federation/callback',authorized,csrf,action((req,res)=>{
  const body=z.object({state:z.string().min(10).max(500),codeVerifier:z.string().min(43).max(128),idToken:z.string().min(20).max(8000)}).strict().parse(req.body);
  const result=transaction(()=>{live(req);federationAvailable();const row=federationRow();
   if(!row.enabled)fail(409,'Federated sign-in is disabled');
   if(!row.jwks)fail(409,'Run provider discovery before validating an assertion');
   const time=clock(),request=db.prepare('SELECT * FROM federation_requests WHERE state_hash=?').get(sha(body.state));
   if(!request)fail(401,'This sign-in attempt is unknown. Start again.');
   if(request.consumed_at)fail(409,'This sign-in attempt was already used. Start again.');
   if(request.expires<=time)fail(401,'This sign-in attempt expired. Start again.');
   if(!equal(request.code_challenge,createHash('sha256').update(body.codeVerifier).digest('base64url')))fail(401,'The PKCE verifier does not match this sign-in attempt');
   db.prepare('UPDATE federation_requests SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL').run(stamp(),request.state_hash);
   const claims=verifyIdToken(body.idToken,{issuer:row.issuer,clientId:row.client_id,nonce:request.nonce_hash,keys:JSON.parse(row.jwks).keys,time});
   const domains=JSON.parse(row.allowed_domains),mail=typeof claims.email==='string'?claims.email.toLowerCase():'';
   if(domains.length){
    if(!mail||!domains.includes(mail.split('@').pop()))fail(403,'This identity is outside the approved email domains for this workspace');
    if(claims.email_verified!==undefined&&claims.email_verified!==true)fail(403,'This identity provider has not verified the email address');
   }
   const raw=claims[row.role_claim],values=Array.isArray(raw)?raw.map(String):typeof raw==='string'?[raw]:[];
   const mappings=JSON.parse(row.role_mappings);
   const mapped=mappings.find(m=>values.includes(m.claimValue));
   if(!mapped)fail(403,'No approved claim-to-role mapping matched this identity. Access denied.');
   if(!FEDERATED_ROLES.includes(mapped.role))fail(403,'A federated assertion can never grant administrator access');
   const key=randomUUID(),detail='Boundary validation only; no workspace session issued';
   db.prepare('INSERT INTO federation_assertions VALUES(?,?,?,?,?,?,?,?)').run(key,claims.sub,mail,mapped.role,row.issuer,0,stamp(),detail);
   audit(req.user,'validate_federated_assertion',null,null,{assertionId:key,subject:claims.sub,mappedRole:mapped.role,issuer:row.issuer,sessionIssued:false});
   return {assertionId:key,subject:claims.sub,email:mail,mappedRole:mapped.role,sessionIssued:false,mfa:'Multi-factor authentication is enforced separately and is never satisfied by a federated assertion.',note:detail};});
  res.json({assertion:result});
 }));

 function enforceIfEnabled(duty,subjectId,subjectVersion){
  const policy=dutyPolicy(duty);if(!policy)fail(400,'Unknown reviewable duty');
  if(!policyEnabled(duty))return null;
  return assertApproved(duty,subjectId,subjectVersion);
 }
 const service={
  acceptInvitation,assertApproved,enforceIfEnabled,dutyPolicyEnabled:policyEnabled,assertSeat,seatReport,suppressPendingInvitations,
  entitlements,roles:ROLE_MATRIX,duties:DUTIES,productIdentity:PRODUCT_IDENTITY,
  validateDeletion:(collection,record)=>{if(collection==='gifts'&&db.prepare('SELECT 1 FROM duty_reviews WHERE subject_id=?').get(record.id))fail(409,'Retained separation-of-duties review history protects this record from deletion');}
 };
 app.locals.tenantAdministrationService=service;
 return service;
}

// Unauthenticated acceptance surface. It carries no session cookie: the caller
// proves itself with the single-use signed invitation token only, and this router
// enforces its own rate and size limits. Wire it into the public seam.
export function installPublic(app,{production=false}={}){
 const attempts=new Map();
 app.post('/api/public/invitations/accept',(req,res,next)=>{
  try{
   res.set('Cache-Control','no-store');
   if(production&&!req.secure)return res.status(403).json({error:'HTTPS required'});
   const time=Date.now();for(const [key,value] of attempts)if(value.until<=time)attempts.delete(key);
   const key=req.ip||'unknown';let rate=attempts.get(key);
   if(!rate){if(attempts.size>=1024)return res.status(429).json({error:'Invitation capacity reached; retry later'});rate={count:0,until:time+900000};attempts.set(key,rate);}
   if(++rate.count>20)return res.status(429).json({error:'Too many invitation attempts; retry later'});
   const service=req.app.locals.tenantAdministrationService||req.app.locals.extensions?.services?.tenantAdministration;
   if(!service?.acceptInvitation)return res.status(503).json({error:'Invitation acceptance is unavailable'});
   const result=service.acceptInvitation({token:req.body?.token,name:req.body?.name,password:req.body?.password});
   res.status(201).json({...result,signIn:'Sign in with this email address and the password you just chose.'});
  }catch(e){next(e);}
 });
 return {name:'tenantAdministrationPublic'};
}
