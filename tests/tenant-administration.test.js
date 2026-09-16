import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';

const password='SyntheticTenantAdministration!2026',mfaKey='7'.repeat(64),poison='PRIVATE_DONOR_FINANCE_HISTORY_MARKER';
const invitedPassword='SyntheticInvited2026pass';

async function fixture(t,{plan='dedicated'}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-tenant-admin-')),dbPath=join(dir,'workspace.sqlite'),tenantId=randomUUID();
 const initialAdmin={name:'Synthetic administrator',email:'admin.tenant@example.test',password};
 let app,server,base,active=true,time=Date.now();
 async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
 async function open(){
  app=createApp({dbPath,seed:false,tenantId,initialAdmin,mfaKey,isTenantActive:()=>active,reminderWorker:false,workflowWorker:false,
   tenantInfo:{slug:'synthetic-workspace',name:'Synthetic workspace'},
   extensions:{tenantAdministration:{plan,clock:()=>time}}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 }
 await open();
 t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function call(url,{method='GET',body,session,csrf=true}={}){
  const response=await fetch(url,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}
  return {status:response.status,json,text};
 }
 const request=(path,options)=>call(base+'/api'+path,options);
 // The wired, unauthenticated public route on the running application.
 const accept=body=>call(base+'/api/public/invitations/accept',{method:'POST',body});
 async function login(mail=initialAdmin.email,secret=password){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:mail,password:secret})});
  const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));
  return {...json,cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
 }
 const admin=await login();
 async function addUser(name,role,mail){const result=await request('/users',{method:'POST',session:admin,body:{name,email:mail,password,role}});assert.equal(result.status,201,result.text);return result.json.user;}
 return {request,accept,login,admin,addUser,restart:async()=>{await close();await open();},
  db:()=>app.locals.db,setActive:value=>{active=value;},suspend:()=>{active=false;return app.locals.suppressTenantAdministration();},
  advance:ms=>{time+=ms;},get app(){return app;}};
}

test('tenant administration is administrator-only; other roles read policy but never change access', async t=>{
 const f=await fixture(t);
 await f.addUser('Synthetic staff','staff','staff.tenant@example.test');
 await f.addUser('Synthetic viewer','viewer','viewer.tenant@example.test');
 await f.addUser('Synthetic helper','event-helper','helper.tenant@example.test');
 const staff=await f.login('staff.tenant@example.test'),viewer=await f.login('viewer.tenant@example.test'),helper=await f.login('helper.tenant@example.test');
 for(const session of [staff,viewer]){
  for(const path of ['/tenant-administration/overview','/tenant-administration/invitations','/tenant-administration/security','/tenant-administration/federation']){
   const denied=await f.request(path,{session});assert.equal(denied.status,403,path+' '+denied.text);assert.equal(denied.json.error,'Administrator required');
  }
  const blocked=await f.request('/tenant-administration/invitations',{method:'POST',session,body:{email:'nope@example.test',name:'No',role:'admin',reason:'Escalation attempt'}});
  assert.equal(blocked.status,403);
  const policy=await f.request('/tenant-administration/duty-policies',{session});assert.equal(policy.status,200,policy.text);
  assert.ok(policy.json.duties.every(d=>d.distinctApproverRequired===true));
 }
 // The event helper is confined by the existing workspace control; nothing here widens it.
 assert.equal((await f.request('/tenant-administration/overview',{session:helper})).status,403);
 assert.equal((await f.request('/tenant-administration/duty-policies',{session:helper})).status,403);
 assert.equal((await f.request('/tenant-administration/overview')).status,401);
 const overview=await f.request('/tenant-administration/overview',{session:f.admin});assert.equal(overview.status,200,overview.text);
 assert.equal(overview.json.roles.find(r=>r.role==='event-helper').accountAdministration,false);
 assert.equal(overview.json.productIdentity.productName,'Wimblo');
 assert.equal(overview.json.productIdentity.providedBy,'Kode Kinetics');
});

test('invitation lifecycle issues a single-use signed token and never escalates the invited role', async t=>{
 const f=await fixture(t);
 const issued=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'Invited.Staff@Example.test',name:'Synthetic invited staff',role:'staff',reason:'Approved additional staff seat'}});
 assert.equal(issued.status,201,issued.text);
 const token=issued.json.token;assert.match(token,/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/);
 assert.equal(issued.json.invitation.email,'invited.staff@example.test');
 assert.equal(issued.json.invitation.status,'Pending');
 const listed=await f.request('/tenant-administration/invitations',{session:f.admin});
 assert.ok(!JSON.stringify(listed.json).includes(token),'a listing never republishes the single-use token');
 // A tampered token cannot change the invited role or the identity it was issued for.
 const [id,signature]=token.split('.');
 for(const bad of [id+'.'+signature.slice(0,-2)+'xy',randomUUID()+'.'+signature,id+'.',signature])
  assert.ok([400,404,409].includes((await f.accept({token:bad,name:'Attacker',password:invitedPassword})).status));
 const weak=await f.accept({token,name:'Synthetic invited staff',password:'short'});assert.equal(weak.status,400);
 const accepted=await f.accept({token,name:'Synthetic invited staff',password:invitedPassword});
 assert.equal(accepted.status,201,accepted.text);
 assert.equal(accepted.json.user.role,'staff');
 assert.equal(accepted.json.user.email,'invited.staff@example.test');
 const replay=await f.accept({token,name:'Synthetic replay',password:invitedPassword});
 assert.equal(replay.status,409);assert.match(replay.json.error,/accepted/);
 const invited=await f.login('invited.staff@example.test',invitedPassword);
 assert.equal(invited.user.role,'staff');
 assert.equal((await f.request('/tenant-administration/overview',{session:invited})).status,403,'an accepted staff invitation grants no administrator authority');
 const events=await f.request('/tenant-administration/invitations/'+issued.json.invitation.id,{session:f.admin});
 assert.deepEqual(events.json.events.map(e=>e.status),['Pending','Accepted']);
 assert.equal(events.json.invitation.status,'Accepted');
 assert.throws(()=>f.db().exec("DELETE FROM user_invitations"),/retained/i);
 assert.throws(()=>f.db().exec("UPDATE user_invitation_events SET reason='rewritten'"),/immutable/i);
 const audit=f.db().prepare("SELECT action FROM audit WHERE action IN ('issue_user_invitation','accept_user_invitation')").all();
 assert.equal(audit.length,2);
});

test('invitations expire, revoke and refuse replay after expiry or revocation', async t=>{
 const f=await fixture(t);
 const first=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'expiring@example.test',name:'Synthetic expiring',role:'viewer',expiresInHours:1,reason:'Short window invitation'}});
 assert.equal(first.status,201,first.text);
 f.advance(2*3600*1000);
 const stale=await f.accept({token:first.json.token,name:'Synthetic expiring',password:invitedPassword});
 assert.equal(stale.status,409);assert.match(stale.json.error,/expired/i);
 const relisted=await f.request('/tenant-administration/invitations',{session:f.admin});
 assert.equal(relisted.json.invitations.find(i=>i.id===first.json.invitation.id).status,'Expired');
 const second=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'revoked@example.test',name:'Synthetic revoked',role:'staff',reason:'Issued then withdrawn'}});
 assert.equal(second.status,201,second.text);
 const staleVersion=await f.request('/tenant-administration/invitations/'+second.json.invitation.id+'/revoke',{method:'POST',session:f.admin,body:{version:99,reason:'Wrong version attempt'}});
 assert.equal(staleVersion.status,409);
 const noCsrf=await f.request('/tenant-administration/invitations/'+second.json.invitation.id+'/revoke',{method:'POST',session:f.admin,csrf:false,body:{version:1,reason:'No CSRF token'}});
 assert.equal(noCsrf.status,403);
 const revoked=await f.request('/tenant-administration/invitations/'+second.json.invitation.id+'/revoke',{method:'POST',session:f.admin,body:{version:1,reason:'Recipient left the organization'}});
 assert.equal(revoked.status,200,revoked.text);assert.equal(revoked.json.invitation.status,'Revoked');
 const afterRevoke=await f.accept({token:second.json.token,name:'Synthetic revoked',password:invitedPassword});
 assert.equal(afterRevoke.status,409);assert.match(afterRevoke.json.error,/revoked/i);
 assert.equal(f.db().prepare("SELECT COUNT(*) n FROM users WHERE email IN ('expiring@example.test','revoked@example.test')").get().n,0);
});

test('suspension stops queued invitations and resumption never revives suppressed work', async t=>{
 const f=await fixture(t);
 const pending=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'suspended@example.test',name:'Synthetic suspended',role:'staff',reason:'Issued before suspension'}});
 assert.equal(pending.status,201,pending.text);
 const result=f.suspend();
 assert.equal(result.suppressed,1);
 assert.equal((await f.accept({token:pending.json.token,name:'Synthetic suspended',password:invitedPassword})).status,403);
 assert.equal((await f.request('/tenant-administration/overview',{session:f.admin})).status,403);
 f.setActive(true);
 await f.restart();
 const admin=await f.login();
 const listed=await f.request('/tenant-administration/invitations',{session:admin});
 assert.equal(listed.json.invitations.find(i=>i.id===pending.json.invitation.id).status,'Suppressed','a suppressed invitation is never reactivated by resumption');
 const replay=await f.accept({token:pending.json.token,name:'Synthetic suspended',password:invitedPassword});
 assert.equal(replay.status,409);assert.match(replay.json.error,/suppressed/i);
 assert.equal(f.db().prepare("SELECT COUNT(*) n FROM users WHERE email='suspended@example.test'").get().n,0);
});

test('separation of duties refuses the preparer as sole approver and rechecks authority at the decision', async t=>{
 const f=await fixture(t);
 await f.addUser('Synthetic preparer','staff','preparer.tenant@example.test');
 await f.addUser('Synthetic second administrator','admin','second.tenant@example.test');
 const preparer=await f.login('preparer.tenant@example.test'),second=await f.login('second.tenant@example.test');
 const donor=(await f.request('/records/constituents',{method:'POST',session:f.admin,body:{name:'Synthetic review donor',type:'Individual',email:'review.donor@example.test',notes:poison}})).json.record;
 const fund=(await f.request('/records/designations',{method:'POST',session:f.admin,body:{name:'Synthetic review fund',accountCode:'REVIEW-101'}})).json.record;
 const gift=(await f.request('/records/gifts',{method:'POST',session:f.admin,body:{constituentId:donor.id,amount:25000,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:25000}],notes:poison}})).json.record;
 const viewerDenied=await f.request('/tenant-administration/reviews',{method:'POST',session:await f.login('admin.tenant@example.test'),body:{duty:'gift-void',subjectId:gift.id,subjectVersion:999,summary:'Stale version preparation'}});
 assert.equal(viewerDenied.status,409,viewerDenied.text);
 const prepared=await f.request('/tenant-administration/reviews',{method:'POST',session:preparer,body:{duty:'gift-void',subjectId:gift.id,subjectVersion:gift.version,summary:'Duplicate deposit identified by the finance clerk',amountCents:25000}});
 assert.equal(prepared.status,201,prepared.text);
 assert.equal(prepared.json.review.amountCents,25000);
 const sole=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:preparer,body:{version:1,decision:'approved',reason:'Approving my own preparation'}});
 assert.equal(sole.status,403,sole.text);assert.match(sole.json.error,/different approver/i);
 const duplicate=await f.request('/tenant-administration/reviews',{method:'POST',session:preparer,body:{duty:'gift-void',subjectId:gift.id,subjectVersion:gift.version,summary:'A second open review for the same record'}});
 assert.equal(duplicate.status,409);
 const staleReview=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:second,body:{version:99,decision:'approved',reason:'Wrong review version'}});
 assert.equal(staleReview.status,409);
 const approved=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:second,body:{version:1,decision:'approved',reason:'Verified against the bank statement'}});
 assert.equal(approved.status,200,approved.text);
 assert.equal(approved.json.review.status,'Approved');
 assert.notEqual(approved.json.review.approvedBy,approved.json.review.preparedBy);
 const service=f.app.locals.tenantAdministrationService;
 assert.deepEqual(service.assertApproved('gift-void',gift.id,gift.version).status,'Approved');
 assert.throws(()=>service.assertApproved('gift-void',gift.id,gift.version+1),/changed after approval/);
 assert.throws(()=>service.assertApproved('receipt-issue',gift.id,gift.version),/second authorized person/);
 assert.equal((await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:second,body:{version:2,decision:'rejected',reason:'Attempt to decide twice'}})).status,409);
 assert.throws(()=>f.db().exec('DELETE FROM duty_reviews'),/retained/i);
});

test('a changed preparer authority invalidates a prepared review before it can be approved', async t=>{
 const f=await fixture(t);
 await f.addUser('Synthetic changing preparer','staff','changing.tenant@example.test');
 await f.addUser('Synthetic approving administrator','admin','approver.tenant@example.test');
 const preparer=await f.login('changing.tenant@example.test'),approver=await f.login('approver.tenant@example.test');
 const donor=(await f.request('/records/constituents',{method:'POST',session:f.admin,body:{name:'Synthetic authority donor',type:'Individual',email:'authority.donor@example.test'}})).json.record;
 const prepared=await f.request('/tenant-administration/reviews',{method:'POST',session:preparer,body:{duty:'user-access-change',subjectId:preparer.user.id,subjectVersion:1,summary:'Access change proposed for review'}});
 assert.equal(prepared.status,403,'only an administrator may prepare an account access review');
 const adminPrepared=await f.request('/tenant-administration/reviews',{method:'POST',session:f.admin,body:{duty:'user-access-change',subjectId:preparer.user.id,subjectVersion:1,summary:'Move the finance clerk to read-only access'}});
 assert.equal(adminPrepared.status,201,adminPrepared.text);
 const changed=await f.request('/users/'+preparer.user.id,{method:'PATCH',session:f.admin,body:{version:1,role:'viewer',active:true}});
 assert.equal(changed.status,200,changed.text);
 const afterChange=await f.request('/tenant-administration/reviews/'+adminPrepared.json.review.id+'/decision',{method:'POST',session:approver,body:{version:1,decision:'approved',reason:'Approving after the subject changed'}});
 assert.equal(afterChange.status,409,afterChange.text);
 assert.match(afterChange.json.error,/changed after the review was prepared/i);
 assert.ok(donor.id);
});

test('administrative MFA visibility shows enrollment without secrets and offers no bypass', async t=>{
 const f=await fixture(t);
 await f.addUser('Synthetic security staff','staff','security.tenant@example.test');
 const security=await f.request('/tenant-administration/security',{session:f.admin});
 assert.equal(security.status,200,security.text);
 assert.equal(security.json.accounts.length,2);
 assert.ok(security.json.accounts.every(a=>a.mfaEnabled===false&&typeof a.recoveryCodesRemaining==='number'));
 const serialized=JSON.stringify(security.json);
 for(const secret of ['encrypted_secret','pending_secret','password_hash','"secret"','recoveryCodes"'])assert.ok(!serialized.includes(secret),secret+' must never appear');
 const enroll=await f.request('/auth/mfa/enroll',{method:'POST',session:f.admin,body:{password}});
 assert.equal(enroll.status,200,enroll.text);
 const afterEnrollment=await f.request('/tenant-administration/security',{session:f.admin});
 assert.ok(!JSON.stringify(afterEnrollment.json).includes(enroll.json.secret),'a pending authenticator secret is never exposed administratively');
 for(const path of ['/tenant-administration/security','/tenant-administration/security/disable'])
  assert.ok([403,404].includes((await f.request(path,{method:'POST',session:f.admin,body:{userId:f.admin.user.id}})).status),'no administrative MFA bypass exists');
});

test('branding is optional, keeps the product identity and survives restart with its history', async t=>{
 const f=await fixture(t);
 const initial=await f.request('/tenant-administration/branding',{session:f.admin});
 assert.equal(initial.json.branding.enabled,false);
 assert.equal(initial.json.branding.productIdentity.statement.includes('Kode Kinetics'),true);
 const missingName=await f.request('/tenant-administration/branding',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,displayName:'',supportEmail:'',footerNote:''}});
 assert.equal(missingName.status,400);
 const rejected=await f.request('/tenant-administration/branding',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,displayName:'Jefferson Education Foundation',supportEmail:'',footerNote:'',productName:'Not Wimblo'}});
 assert.equal(rejected.status,400,'the product identity can never be overridden');
 const saved=await f.request('/tenant-administration/branding',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,displayName:'Jefferson Education Foundation',supportEmail:'support@example.test',footerNote:'Community grants only'}});
 assert.equal(saved.status,200,saved.text);
 assert.equal(saved.json.branding.version,2);
 assert.equal(saved.json.branding.productIdentity.productName,'Wimblo');
 const conflict=await f.request('/tenant-administration/branding',{method:'PATCH',session:f.admin,body:{version:1,enabled:false,displayName:'Jefferson Education Foundation',supportEmail:'',footerNote:''}});
 assert.equal(conflict.status,409);
 await f.restart();
 const admin=await f.login();
 const reopened=await f.request('/tenant-administration/branding',{session:admin});
 assert.equal(reopened.json.branding.displayName,'Jefferson Education Foundation');
 assert.equal(reopened.json.branding.enabled,true);
 assert.equal(reopened.json.branding.productIdentity.providedBy,'Kode Kinetics');
});

test('acceptance is atomic: a colliding account leaves the invitation open and creates no partial user', async t=>{
 const f=await fixture(t);
 const issued=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'collision@example.test',name:'Synthetic collision',role:'staff',reason:'Invitation issued before a direct account'}});
 assert.equal(issued.status,201,issued.text);
 await f.addUser('Synthetic direct account','staff','collision@example.test');
 const blocked=await f.accept({token:issued.json.token,name:'Synthetic collision',password:invitedPassword});
 assert.equal(blocked.status,409,blocked.text);
 const listed=await f.request('/tenant-administration/invitations',{session:f.admin});
 assert.equal(listed.json.invitations.find(i=>i.id===issued.json.invitation.id).status,'Pending');
 assert.equal(f.db().prepare("SELECT COUNT(*) n FROM users WHERE email='collision@example.test'").get().n,1);
 assert.equal(f.db().prepare("SELECT COUNT(*) n FROM user_invitation_events WHERE invitation_id=? AND status='Accepted'").get(issued.json.invitation.id).n,0);
});

test('an invited account signs in through the ordinary login route, proving the shared credential format', async t=>{
 const f=await fixture(t);
 const issued=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'signin@example.test',name:'Synthetic sign-in',role:'staff',reason:'Proves the invited credential works'}});
 assert.equal(issued.status,201,issued.text);
 const accepted=await f.accept({token:issued.json.token,name:'Synthetic sign-in',password:invitedPassword});
 assert.equal(accepted.status,201,accepted.text);
 // The real proof: the ordinary /api/auth/login route accepts the chosen password.
 const session=await f.login('signin@example.test',invitedPassword);
 assert.equal(session.user.role,'staff');
 assert.equal((await f.request('/workspace',{session})).status,200);
 const wrong=await f.request('/auth/login',{method:'POST',body:{email:'signin@example.test',password:'NotTheChosenPassword1'}});
 assert.equal(wrong.status,401,'the shared verifier rejects a wrong password');
 const stored=f.db().prepare('SELECT password_hash FROM users WHERE email=?').get('signin@example.test').password_hash;
 const direct=f.db().prepare('SELECT password_hash FROM users WHERE email=?').get('admin.tenant@example.test').password_hash;
 assert.equal(stored.split(':').length,2);
 assert.equal(stored.split(':')[0].length,direct.split(':')[0].length,'the invited credential uses the host application format');
 assert.equal(stored.split(':')[1].length,direct.split(':')[1].length);
});

test('duty policies are disabled by default and enforceIfEnabled changes nothing while a control is off', async t=>{
 const f=await fixture(t);
 const policies=await f.request('/tenant-administration/duty-policies',{session:f.admin});
 assert.equal(policies.status,200,policies.text);
 assert.ok(policies.json.duties.length>=4);
 assert.ok(policies.json.duties.every(d=>d.enabled===false),'every duty policy starts disabled');
 const donor=(await f.request('/records/constituents',{method:'POST',session:f.admin,body:{name:'Synthetic default-path donor',type:'Individual',email:'default.donor@example.test'}})).json.record;
 const fund=(await f.request('/records/designations',{method:'POST',session:f.admin,body:{name:'Synthetic default fund',accountCode:'DEFAULT-101'}})).json.record;
 const gift=(await f.request('/records/gifts',{method:'POST',session:f.admin,body:{constituentId:donor.id,amount:30000,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:30000}]}})).json.record;
 const service=f.app.locals.tenantAdministrationService;
 // The intended call site: a strict no-op while the control is disabled.
 assert.equal(service.enforceIfEnabled('gift-void',gift.id,gift.version),null);
 assert.equal(service.enforceIfEnabled('gift-correction',gift.id,gift.version),null);
 assert.equal(service.dutyPolicyEnabled('gift-void'),false);
 const voided=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:f.admin,body:{version:gift.version,reason:'Voided on the unchanged default path'}});
 assert.equal(voided.status,200,voided.text);
 assert.equal(voided.json.record.status,'Voided');
 assert.throws(()=>service.assertApproved('gift-void',gift.id,gift.version),/second authorized person/,'the strict check is still available on request');
});

test('an enabled duty policy refuses the action until a different authorized person approves the current version', async t=>{
 const f=await fixture(t);
 await f.addUser('Synthetic finance clerk','staff','clerk.duty@example.test');
 await f.addUser('Synthetic reviewing administrator','admin','reviewer.duty@example.test');
 const clerk=await f.login('clerk.duty@example.test'),reviewer=await f.login('reviewer.duty@example.test');
 const donor=(await f.request('/records/constituents',{method:'POST',session:f.admin,body:{name:'Synthetic enabled-path donor',type:'Individual',email:'enabled.donor@example.test'}})).json.record;
 const fund=(await f.request('/records/designations',{method:'POST',session:f.admin,body:{name:'Synthetic enabled fund',accountCode:'ENABLED-101'}})).json.record;
 const gift=(await f.request('/records/gifts',{method:'POST',session:f.admin,body:{constituentId:donor.id,amount:40000,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:40000}]}})).json.record;
 const service=f.app.locals.tenantAdministrationService;
 const staffDenied=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:clerk,body:{version:1,enabled:true,reason:'Staff attempting to change a control'}});
 assert.equal(staffDenied.status,403);
 const noCsrf=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:f.admin,csrf:false,body:{version:1,enabled:true,reason:'No CSRF token'}});
 assert.equal(noCsrf.status,403);
 const enabled=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,reason:'Board asked for two-person voids'}});
 assert.equal(enabled.status,200,enabled.text);
 assert.equal(enabled.json.duty.enabled,true);
 assert.equal(enabled.json.duty.version,2);
 const staleEnable=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:f.admin,body:{version:1,enabled:false,reason:'Stale version attempt'}});
 assert.equal(staleEnable.status,409);
 // The intended call site now refuses the action outright.
 assert.equal(service.dutyPolicyEnabled('gift-void'),true);
 assert.throws(()=>service.enforceIfEnabled('gift-void',gift.id,gift.version),/second authorized person/);
 // Only gift-void was enabled; every other duty stays a no-op.
 assert.equal(service.enforceIfEnabled('gift-correction',gift.id,gift.version),null);
 const prepared=await f.request('/tenant-administration/reviews',{method:'POST',session:clerk,body:{duty:'gift-void',subjectId:gift.id,subjectVersion:gift.version,summary:'Duplicate deposit identified at the monthly close',amountCents:40000}});
 assert.equal(prepared.status,201,prepared.text);
 assert.throws(()=>service.enforceIfEnabled('gift-void',gift.id,gift.version),/second authorized person/,'a prepared but undecided review is not an approval');
 const sole=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:clerk,body:{version:1,decision:'approved',reason:'Approving my own preparation'}});
 assert.equal(sole.status,403);
 const approved=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:reviewer,body:{version:1,decision:'approved',reason:'Checked against the bank statement'}});
 assert.equal(approved.status,200,approved.text);
 // Approved for the current version: the call site now passes and the void succeeds.
 const cleared=service.enforceIfEnabled('gift-void',gift.id,gift.version);
 assert.equal(cleared.status,'Approved');
 assert.notEqual(cleared.approvedBy,cleared.preparedBy);
 assert.throws(()=>service.enforceIfEnabled('gift-void',gift.id,gift.version+1),/changed after approval/,'the approval is bound to the version that was reviewed');
 const voided=await f.request('/gifts/'+gift.id+'/void',{method:'POST',session:clerk,body:{version:gift.version,reason:'Voided after the recorded second approval'}});
 assert.equal(voided.status,200,voided.text);
 assert.equal(voided.json.record.status,'Voided');
 const history=await f.request('/tenant-administration/duty-policies/gift-void/history',{session:f.admin});
 assert.deepEqual(history.json.changes.map(c=>c.enabled),[true]);
 assert.equal(history.json.changes[0].reason,'Board asked for two-person voids');
 assert.throws(()=>f.db().exec('DELETE FROM duty_policy_changes'),/retained/i);
 const disabled=await f.request('/tenant-administration/duty-policies/gift-void',{method:'PATCH',session:f.admin,body:{version:2,enabled:false,reason:'Control withdrawn after the close'}});
 assert.equal(disabled.status,200,disabled.text);
 assert.equal(service.enforceIfEnabled('gift-void',gift.id,gift.version),null,'disabling restores the default path exactly');
});

test('a control cannot be enabled when it would leave the only administrator unable to obtain an approval', async t=>{
 const f=await fixture(t);
 const lockout=await f.request('/tenant-administration/duty-policies/user-access-change',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,reason:'Attempting to enable with a single administrator'}});
 assert.equal(lockout.status,409,lockout.text);
 assert.match(lockout.json.error,/second active admin/i);
 assert.equal(f.db().prepare("SELECT enabled FROM duty_policy_settings WHERE duty='user-access-change'").get().enabled,0);
 await f.addUser('Synthetic staff only','staff','stafffonly.lock@example.test');
 assert.equal((await f.request('/tenant-administration/duty-policies/user-access-change',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,reason:'Staff is not an approver for this duty'}})).status,409);
 await f.addUser('Synthetic second administrator','admin','second.lock@example.test');
 const enabled=await f.request('/tenant-administration/duty-policies/user-access-change',{method:'PATCH',session:f.admin,body:{version:1,enabled:true,reason:'A second administrator is now in place'}});
 assert.equal(enabled.status,200,enabled.text);
 assert.equal(enabled.json.duty.enabled,true);
});
