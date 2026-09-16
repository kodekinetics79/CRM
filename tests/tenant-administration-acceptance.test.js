import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {createPlatformApp} from '../server/platform.js';

// A8.3 acceptance scenario. One subscription workspace with FOUR full users and
// TWO optional non-administrator helpers, exercising allowed and denied work
// concurrently, with stale writes, entitlement refusals and a suspension that
// revokes sessions and stops queued work. Synthetic records only.
const operator={name:'Synthetic platform operator',email:'operator.a83@example.test',password:'PlatformAcceptance!2026'};
const founder={name:'Synthetic foundation administrator',email:'admin.a83@example.test',password:'WorkspaceAcceptance!2026'};
const password='SyntheticAcceptance!2026',invitedPassword='SyntheticInvited2026pass',poison='PRIVATE_DONOR_FINANCE_HISTORY_MARKER';
const cookies=headers=>headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');

async function scenario(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-a83-'));
 let app,server,base,workspaceApp;const workspaces=new Map();
 async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
 async function open(){
  app=createPlatformApp({rootDir:join(dir,'registry'),legacyDbPath:join(dir,'legacy.sqlite'),seedLegacy:false,initialPlatformAdmin:operator,
   tenantFactory:args=>{workspaceApp=createApp({...args,reminderWorker:false,workflowWorker:false});workspaces.set(args.tenantInfo.slug,workspaceApp);return workspaceApp;}});
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
 // The wired, workspace-bound public route. An anonymous request names its
 // workspace in the path; it never falls back to the legacy workspace.
 const accept=(body,slug='jefferson')=>call(base+'/api/public/invitations/'+slug+'/accept',{method:'POST',body});
 async function signIn(mail,secret,slug='jefferson'){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:mail,password:secret,tenantSlug:slug})});
  const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));
  return {...json,cookie:cookies(response.headers)};
 }
 const platform=await(async()=>{const response=await fetch(base+'/api/platform/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:operator.email,password:operator.password})});const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return {...json,cookie:cookies(response.headers)};})();
 const created=await request('/platform/tenants',{method:'POST',session:platform,body:{slug:'jefferson',name:'Jefferson Education Foundation',plan:'subscription',dataMode:'restricted',aiEnabled:false,admin:founder}});
 assert.equal(created.status,201,created.text);
 return {request,accept,signIn,platform,tenant:created.json.tenant,restart:async()=>{await close();await open();},workspace:slug=>workspaces.get(slug),get workspaceApp(){return workspaces.get('jefferson')||workspaceApp;}};
}

test('A8.3: four full users and two non-administrator helpers work concurrently within one subscription plan', async t=>{
 const f=await scenario(t);
 assert.deepEqual([f.tenant.entitlements.fullUserSeats,f.tenant.entitlements.helperSeats],[4,2]);
 assert.equal(f.tenant.billing.billingConfigured,false);
 const admin=await f.signIn(founder.email,founder.password);

 // Full user two arrives through the invitation lifecycle; three and four directly.
 const invitation=await f.request('/tenant-administration/invitations',{method:'POST',session:admin,body:{email:'second.admin@example.test',name:'Synthetic second administrator',role:'admin',reason:'Second approved administrator for separation of duties'}});
 assert.equal(invitation.status,201,invitation.text);
 assert.equal((await f.accept({token:invitation.json.token,name:'Synthetic second administrator',password:invitedPassword})).status,201);
 for(const [name,role,mail] of [['Synthetic program staff','staff','staff.a83@example.test'],['Synthetic board viewer','viewer','viewer.a83@example.test']])
  assert.equal((await f.request('/users',{method:'POST',session:admin,body:{name,email:mail,password,role}})).status,201,mail);
 for(const [name,mail] of [['Synthetic event helper one','helper.one@example.test'],['Synthetic event helper two','helper.two@example.test']])
  assert.equal((await f.request('/users',{method:'POST',session:admin,body:{name,email:mail,password,role:'event-helper'}})).status,201,mail);

 // The plan is enforced at execution, not merely displayed.
 const fifth=await f.request('/users',{method:'POST',session:admin,body:{name:'Synthetic fifth full user',email:'fifth.a83@example.test',password,role:'staff'}});
 assert.equal(fifth.status,409,fifth.text);assert.match(fifth.json.error,/4 full user seats/);
 const thirdHelper=await f.request('/users',{method:'POST',session:admin,body:{name:'Synthetic third helper',email:'helper.three@example.test',password,role:'event-helper'}});
 assert.equal(thirdHelper.status,409,thirdHelper.text);assert.match(thirdHelper.json.error,/2 optional non-administrator helper seats/);

 const second=await f.signIn('second.admin@example.test',invitedPassword);
 const staff=await f.signIn('staff.a83@example.test',password);
 const viewer=await f.signIn('viewer.a83@example.test',password);
 const helperOne=await f.signIn('helper.one@example.test',password);
 let helperTwo=await f.signIn('helper.two@example.test',password);
 const seats=(await f.request('/tenant-administration/overview',{session:admin})).json.seats;
 assert.deepEqual([seats.fullUsersInUse,seats.helperUsersInUse,seats.fullSeatsRemaining,seats.helperSeatsRemaining],[4,2,0,0]);

 // Synthetic business records for the concurrent phase.
 const donor=(await f.request('/records/constituents',{method:'POST',session:admin,body:{name:'Synthetic acceptance donor',type:'Individual',email:'donor.a83@example.test',notes:poison}})).json.record;
 const fund=(await f.request('/records/designations',{method:'POST',session:admin,body:{name:'Synthetic acceptance fund',accountCode:'A83-101'}})).json.record;
 const gift=(await f.request('/records/gifts',{method:'POST',session:admin,body:{constituentId:donor.id,amount:50000,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:50000}],notes:poison}})).json.record;
 const event=(await f.request('/records/events',{method:'POST',session:admin,body:{name:'Synthetic acceptance event',date:'2026-09-20',location:'Synthetic venue',capacity:10,ticketPrice:2500,sponsorGoal:10000}})).json.record;
 assert.equal((await f.request('/events/'+event.id+'/register',{method:'POST',session:admin,body:{constituentId:donor.id}})).status,200);
 const currentEvent=async()=>(await f.request('/workspace',{session:admin})).json.data.events.find(e=>e.id===event.id);
 const ticket=(await f.request('/event-operations/events/'+event.id+'/tickets',{method:'POST',session:staff,body:{eventVersion:(await currentEvent()).version,constituentId:donor.id}})).json.ticket;
 const access=await f.request('/users/'+helperTwo.user.id+'/event-access',{session:admin});
 assert.equal((await f.request('/users/'+helperTwo.user.id+'/event-access',{method:'PATCH',session:admin,body:{version:access.json.version,eventIds:[event.id],reason:'Assigned event-day check-in duty'}})).status,200);
 helperTwo=await f.signIn('helper.two@example.test',password);
 const eventVersion=(await currentEvent()).version;

 // ---- concurrent allowed and denied work across all six accounts ----
 const outcomes=await Promise.all([
  f.request('/tenant-administration/overview',{session:admin}),
  f.request('/tenant-administration/security',{session:second}),
  f.request('/records/constituents',{method:'POST',session:staff,body:{name:'Synthetic concurrent constituent',type:'Individual',email:'concurrent.a83@example.test'}}),
  f.request('/records/constituents',{method:'POST',session:viewer,body:{name:'Synthetic denied constituent',type:'Individual',email:'denied.a83@example.test'}}),
  f.request('/workspace',{session:viewer}),
  f.request('/tenant-administration/overview',{session:staff}),
  f.request('/users',{session:staff}),
  f.request('/event-checkin/events',{session:helperOne}),
  f.request('/event-checkin/events',{session:helperTwo}),
  f.request('/workspace',{session:helperTwo}),
  f.request('/records/gifts',{method:'POST',session:helperOne,body:{constituentId:donor.id,amount:100,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:100}]}}),
  f.request('/event-checkin/events/'+event.id+'/tickets/'+ticket.id+'/checkin',{method:'POST',session:helperTwo,body:{version:ticket.version,eventVersion}}),
  f.request('/tenant-administration/reviews',{method:'POST',session:staff,body:{duty:'gift-void',subjectId:gift.id,subjectVersion:gift.version,summary:'Duplicate deposit found during the concurrent close'}}),
  f.request('/tenant-administration/invitations',{method:'POST',session:admin,body:{email:'waiting.a83@example.test',name:'Synthetic waiting invitee',role:'staff',reason:'Queued while seats are full'}})
 ]);
 const [adminOverview,secondSecurity,staffWrite,viewerWrite,viewerRead,staffAdminRead,staffUsers,helperOneEvents,helperTwoEvents,helperWorkspace,helperGift,checkIn,prepared,queuedInvitation]=outcomes;
 assert.equal(adminOverview.status,200,adminOverview.text);
 assert.equal(secondSecurity.status,200,secondSecurity.text);
 assert.equal(staffWrite.status,201,staffWrite.text);
 assert.equal(viewerWrite.status,403);assert.equal(viewerWrite.json.error,'Readonly role');
 assert.equal(viewerRead.status,200);
 assert.equal(staffAdminRead.status,403);assert.equal(staffAdminRead.json.error,'Administrator required');
 assert.equal(staffUsers.status,403);
 assert.equal(helperOneEvents.status,200);assert.deepEqual(helperOneEvents.json.events,[],'an unassigned helper sees no event');
 assert.equal(helperTwoEvents.status,200);assert.equal(helperTwoEvents.json.events.length,1);
 assert.equal(helperWorkspace.status,403,'a helper never reaches the business workspace');
 assert.equal(helperGift.status,403,'a helper never posts a gift');
 assert.equal(checkIn.status,200,checkIn.text);
 assert.equal(prepared.status,201,prepared.text);
 assert.equal(queuedInvitation.status,409,'the fourth seat is taken, so the queued invitation is refused at execution');

 // Concurrent stale writes against one record: exactly one wins.
 const target=staffWrite.json.record;
 const races=await Promise.all([
  f.request('/records/constituents/'+target.id,{method:'PATCH',session:staff,body:{version:target.version,name:'Synthetic concurrent constituent A',type:'Individual',email:'concurrent.a83@example.test'}}),
  f.request('/records/constituents/'+target.id,{method:'PATCH',session:second,body:{version:target.version,name:'Synthetic concurrent constituent B',type:'Individual',email:'concurrent.a83@example.test'}})
 ]);
 assert.equal(races.filter(r=>r.status===200).length,1,JSON.stringify(races.map(r=>[r.status,r.json?.error])));
 assert.equal(races.filter(r=>r.status===409).length,1);

 // Separation of duties: the preparer cannot be the sole approver.
 const sole=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:staff,body:{version:1,decision:'approved',reason:'Approving my own preparation'}});
 assert.equal(sole.status,403);assert.match(sole.json.error,/different approver/i);
 const viewerDecision=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:viewer,body:{version:1,decision:'approved',reason:'Read-only account attempting a decision'}});
 assert.equal(viewerDecision.status,403);
 const approved=await f.request('/tenant-administration/reviews/'+prepared.json.review.id+'/decision',{method:'POST',session:second,body:{version:1,decision:'approved',reason:'Checked against the bank statement'}});
 assert.equal(approved.status,200,approved.text);
 assert.notEqual(approved.json.review.approvedBy,approved.json.review.preparedBy);

 // A queued invitation exists only when a seat is freed; it is then suppressed by suspension.
 const closing=await f.request('/users/'+viewer.user.id,{method:'PATCH',session:admin,body:{version:viewer.user.version??1,role:'viewer',active:false}});
 assert.equal(closing.status,200,closing.text);
 const queued=await f.request('/tenant-administration/invitations',{method:'POST',session:admin,body:{email:'waiting.a83@example.test',name:'Synthetic waiting invitee',role:'staff',reason:'Issued after a seat was released'}});
 assert.equal(queued.status,201,queued.text);

 // ---- suspension revokes sessions and stops queued work ----
 const suspended=await f.request('/platform/tenants/'+f.tenant.id,{method:'PATCH',session:f.platform,body:{version:f.tenant.version,status:'suspended'}});
 assert.equal(suspended.status,200,suspended.text);
 for(const session of [admin,second,staff,helperOne,helperTwo]){
  const denied=await f.request('/workspace',{session});
  assert.equal(denied.status,403,'suspension blocks every workspace session');
 }
 assert.equal((await f.request('/event-checkin/events',{session:helperTwo})).status,403);
 assert.equal((await f.accept({token:queued.json.token,name:'Synthetic waiting invitee',password:invitedPassword})).status,403);
 const db=f.workspaceApp.locals.db;
 assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n,0,'suspension revoked every workspace session');
 assert.equal(db.prepare('SELECT status FROM user_invitations WHERE id=?').get(queued.json.invitation.id).status,'Suppressed');

 // ---- resumption restores access but never revives suppressed work ----
 const resumed=await f.request('/platform/tenants/'+f.tenant.id,{method:'PATCH',session:f.platform,body:{version:suspended.json.tenant.version,status:'active'}});
 assert.equal(resumed.status,200,resumed.text);
 assert.equal((await f.request('/workspace',{session:admin})).status,401,'a revoked session is not restored by resumption');
 const replay=await f.accept({token:queued.json.token,name:'Synthetic waiting invitee',password:invitedPassword});
 assert.equal(replay.status,409);assert.match(replay.json.error,/suppressed/i);
 await f.restart();
 const renewed=await f.signIn(founder.email,founder.password);
 const overview=await f.request('/tenant-administration/overview',{session:renewed});
 assert.equal(overview.status,200,overview.text);
 assert.equal(overview.json.entitlements.plan,'subscription');
 assert.equal(overview.json.reviews.find(r=>r.id===approved.json.review.id).status,'Approved');
 assert.equal(overview.json.invitations.find(i=>i.id===queued.json.invitation.id).status,'Suppressed');
 assert.equal(overview.json.accounts.filter(a=>a.active&&a.role!=='event-helper').length,3);
 assert.equal(overview.json.accounts.filter(a=>a.active&&a.role==='event-helper').length,2);
 assert.equal(overview.json.billing.subscriptionActive,false);
 assert.deepEqual(overview.json.billing.invoices,[]);
});

test('anonymous invitation acceptance is workspace-bound and never falls back to another workspace', async t=>{
 const f=await scenario(t);
 const admin=await f.signIn(founder.email,founder.password);
 const issued=await f.request('/tenant-administration/invitations',{method:'POST',session:admin,body:{email:'bound.invite@example.test',name:'Synthetic bound invitee',role:'staff',reason:'Proves the acceptance route is workspace-bound'}});
 assert.equal(issued.status,201,issued.text);
 const body={token:issued.json.token,name:'Synthetic bound invitee',password:invitedPassword};
 // A second workspace must never accept another workspace's invitation token.
 const other=await f.request('/platform/tenants',{method:'POST',session:f.platform,body:{slug:'other',name:'Other workspace',plan:'trial',dataMode:'restricted',aiEnabled:false,admin:{name:'Synthetic other administrator',email:'admin.other@example.test',password:'OtherWorkspace!2026'}}});
 assert.equal(other.status,201,other.text);
 const crossed=await f.accept(body,'other');
 assert.equal(crossed.status,404,crossed.text);
 assert.equal((await f.accept(body,'missing-workspace')).status,404);
 // A traversal attempt is normalized away and then denied; it never reaches an acceptance handler.
 assert.ok([401,404].includes((await f.accept(body,'../escape')).status));
 assert.ok([401,404].includes((await f.accept(body,'WIMBLO')).status));
 const unbound=await f.request('/public/invitations/accept',{method:'POST',body});
 assert.equal(unbound.status,404,'an unbound acceptance request is refused rather than routed to the legacy workspace');
 assert.match(unbound.json.error,/workspace-bound/);
 const accepted=await f.accept(body);
 assert.equal(accepted.status,201,accepted.text);
 const session=await f.signIn('bound.invite@example.test',invitedPassword);
 assert.equal(session.user.role,'staff');
 assert.equal(f.workspace('jefferson').locals.db.prepare("SELECT COUNT(*) n FROM users WHERE email='bound.invite@example.test'").get().n,1);
 assert.equal(f.workspace('other').locals.db.prepare("SELECT COUNT(*) n FROM users WHERE email='bound.invite@example.test'").get().n,0,'the other workspace was never touched');
});
