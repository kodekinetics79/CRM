import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {createPlatformApp,PLAN_ENTITLEMENTS,PLANS,planEntitlements,planBillingState} from '../server/platform.js';

const password='SyntheticEntitlements!2026',invitedPassword='SyntheticInvited2026pass';
const cookies=headers=>headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');

async function workspace(t,{plan=null}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-entitlements-')),dbPath=join(dir,'workspace.sqlite');
 const initialAdmin={name:'Synthetic seat administrator',email:'admin.seats@example.test',password};
 const app=createApp({dbPath,seed:false,tenantId:randomUUID(),initialAdmin,reminderWorker:false,workflowWorker:false,
  ...(plan?{tenantInfo:{slug:'metered-workspace',name:'Metered workspace'}}:{}),
  extensions:{tenantAdministration:plan?{plan}:{}}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();await rm(dir,{recursive:true,force:true});});
 async function call(url,{method='GET',body,session,csrf=true}={}){
  const response=await fetch(url,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}
  return {status:response.status,json,text};
 }
 const request=(path,options)=>call(base+'/api'+path,options);
 async function login(mail=initialAdmin.email,secret=password){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:mail,password:secret})});
  const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));
  return {...json,cookie:cookies(response.headers)};
 }
 const admin=await login();
 const addUser=(name,role,mail,session=admin)=>request('/users',{method:'POST',session,body:{name,email:mail,password,role}});
 return {request,login,admin,addUser,accept:body=>call(base+'/api/public/invitations/accept',{method:'POST',body}),db:app.locals.db};
}

test('the plan catalogue names the entitlements the workspace enforces and never implies billing', async()=>{
 assert.deepEqual([...PLANS],['trial','subscription','dedicated']);
 for(const plan of PLANS){
  const entitlement=planEntitlements(plan);
  assert.equal(entitlement.plan,plan);
  for(const key of ['fullUserSeats','helperSeats','invitations','ai','federation','connectors','historyRetentionYears'])assert.ok(key in entitlement,plan+' must name '+key);
  assert.ok(Number.isInteger(entitlement.fullUserSeats)&&entitlement.fullUserSeats>0);
  assert.ok(Number.isInteger(entitlement.helperSeats)&&entitlement.helperSeats>0);
 }
 // Q&A86: four full users plus two optional non-administrator helpers.
 for(const plan of ['trial','subscription'])assert.deepEqual([planEntitlements(plan).fullUserSeats,planEntitlements(plan).helperSeats],[4,2]);
 assert.equal(PLAN_ENTITLEMENTS.trial.ai,false);
 assert.equal(planEntitlements('not-a-plan'),null);
 for(const plan of PLANS){
  const billing=planBillingState(plan);
  assert.equal(billing.billingConfigured,false);
  assert.equal(billing.billingProvider,null);
  assert.equal(billing.subscriptionActive,false);
  assert.deepEqual([billing.invoices,billing.charges,billing.providerEvents],[[],[],[]]);
  assert.match(billing.note,/administrative classification/);
 }
});

test('an unmanaged workspace is unmetered and no existing account behaviour changes', async t=>{
 const f=await workspace(t);
 for(let i=0;i<6;i++)assert.equal((await f.addUser('Synthetic unmetered '+i,'staff','unmetered'+i+'@example.test')).status,201);
 for(let i=0;i<4;i++)assert.equal((await f.addUser('Synthetic unmetered helper '+i,'event-helper','unmeteredhelper'+i+'@example.test')).status,201);
 const overview=await f.request('/tenant-administration/overview',{session:f.admin});
 assert.equal(overview.status,200,overview.text);
 assert.equal(overview.json.seats.metered,false);
 assert.equal(overview.json.entitlements.fullUserSeats,null);
 assert.equal(overview.json.billing.billingConfigured,false);
});

test('named seats are enforced at execution for direct accounts, invitations and role changes', async t=>{
 const f=await workspace(t,{plan:'subscription'});
 const seats=(await f.request('/tenant-administration/overview',{session:f.admin})).json.seats;
 assert.deepEqual([seats.fullUserSeats,seats.helperSeats,seats.fullUsersInUse,seats.metered],[4,2,1,true]);
 for(const [name,mail] of [['two','two'],['three','three']])assert.equal((await f.addUser('Synthetic full '+name,'staff',mail+'.seat@example.test')).status,201);
 assert.equal((await f.addUser('Synthetic full four','viewer','four.seat@example.test')).status,201);
 const overflow=await f.addUser('Synthetic full five','staff','five.seat@example.test');
 assert.equal(overflow.status,409,overflow.text);
 assert.match(overflow.json.error,/Subscription plan includes 4 full user seats/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users WHERE email='five.seat@example.test'").get().n,0,'a refused seat creates no account');
 for(const [name,mail] of [['one','helperone'],['two','helpertwo']])assert.equal((await f.addUser('Synthetic helper '+name,'event-helper',mail+'@example.test')).status,201);
 const helperOverflow=await f.addUser('Synthetic helper three','event-helper','helperthree@example.test');
 assert.equal(helperOverflow.status,409,helperOverflow.text);
 assert.match(helperOverflow.json.error,/2 optional non-administrator helper seats/);
 // A helper can never be promoted into a full seat that the plan does not have.
 const helper=f.db.prepare("SELECT * FROM users WHERE email='helperone@example.test'").get();
 const promotion=await f.request('/users/'+helper.id,{method:'PATCH',session:f.admin,body:{version:helper.version,role:'staff',active:true}});
 assert.equal(promotion.status,409,promotion.text);
 assert.equal(f.db.prepare('SELECT role FROM users WHERE id=?').get(helper.id).role,'event-helper');
 // Closing a full account frees exactly one seat.
 const closing=f.db.prepare("SELECT * FROM users WHERE email='four.seat@example.test'").get();
 assert.equal((await f.request('/users/'+closing.id,{method:'PATCH',session:f.admin,body:{version:closing.version,role:'viewer',active:false}})).status,200);
 assert.equal((await f.addUser('Synthetic replacement','staff','replacement.seat@example.test')).status,201);
 const reactivate=await f.request('/users/'+closing.id,{method:'PATCH',session:f.admin,body:{version:closing.version+1,role:'viewer',active:true}});
 assert.equal(reactivate.status,409,'a closed account cannot be reopened past the plan');
});

test('pending invitations reserve a seat and the reservation is rechecked when the invitation is accepted', async t=>{
 const f=await workspace(t,{plan:'trial'});
 for(const name of ['two','three'])assert.equal((await f.addUser('Synthetic full '+name,'staff',name+'.invite@example.test')).status,201);
 const invited=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'fourth.invite@example.test',name:'Synthetic fourth',role:'staff',reason:'Fourth approved full user'}});
 assert.equal(invited.status,201,invited.text);
 assert.equal(invited.json.seats.fullSeatsRemaining,0);
 const overInvite=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'fifth.invite@example.test',name:'Synthetic fifth',role:'staff',reason:'Fifth attempt'}});
 assert.equal(overInvite.status,409,overInvite.text);
 const overDirect=await f.addUser('Synthetic fifth direct','staff','fifth.direct@example.test');
 assert.equal(overDirect.status,409,'a pending invitation reserves the seat against direct account creation');
 const accepted=await f.accept({token:invited.json.token,name:'Synthetic fourth',password:invitedPassword});
 assert.equal(accepted.status,201,accepted.text);
 const after=(await f.request('/tenant-administration/overview',{session:f.admin})).json.seats;
 assert.deepEqual([after.fullUsersInUse,after.fullInvitationsPending,after.fullSeatsRemaining],[4,0,0]);
 // A second invitation issued while a seat existed must still be refused at acceptance.
 const helperInvite=await f.request('/tenant-administration/invitations',{method:'POST',session:f.admin,body:{email:'helper.invite@example.test',name:'Synthetic helper invite',role:'event-helper',reason:'Optional helper'}});
 assert.equal(helperInvite.status,201,helperInvite.text);
 assert.equal((await f.addUser('Synthetic helper direct one','event-helper','helperdirect1@example.test')).status,201);
 const helperDirect=await f.addUser('Synthetic helper direct two','event-helper','helperdirect2@example.test');
 assert.equal(helperDirect.status,409,'the pending helper invitation keeps the second helper seat');
 assert.equal((await f.accept({token:helperInvite.json.token,name:'Synthetic helper invite',password:invitedPassword})).status,201);
 const finalSeats=(await f.request('/tenant-administration/overview',{session:f.admin})).json.seats;
 assert.deepEqual([finalSeats.helperUsersInUse,finalSeats.helperSeatsRemaining],[2,0]);
});

test('entitlement enforcement never replaces an existing role, CSRF or validation control', async t=>{
 const f=await workspace(t,{plan:'trial'});
 for(const name of ['two','three','four'])assert.equal((await f.addUser('Synthetic full '+name,'staff',name+'.control@example.test')).status,201);
 const staff=await f.login('two.control@example.test');
 const staffDenied=await f.addUser('Synthetic escalation','admin','escalation@example.test',staff);
 assert.equal(staffDenied.status,403);assert.equal(staffDenied.json.error,'Administrator required');
 const noCsrf=await f.request('/users',{method:'POST',session:f.admin,csrf:false,body:{name:'Synthetic no csrf',email:'nocsrf@example.test',password,role:'staff'}});
 assert.equal(noCsrf.status,403);assert.equal(noCsrf.json.error,'Invalid CSRF token');
 const invalid=await f.request('/users',{method:'POST',session:f.admin,body:{name:'Synthetic invalid',email:'not-an-email',password,role:'staff'}});
 assert.equal(invalid.status,400);
 const unknownRole=await f.request('/users',{method:'POST',session:f.admin,body:{name:'Synthetic unknown role',email:'unknown.role@example.test',password,role:'superuser'}});
 assert.equal(unknownRole.status,400);
 const entitlementDenied=await f.addUser('Synthetic fifth','staff','fifth.control@example.test');
 assert.equal(entitlementDenied.status,409);
});

test('the control plane owns the plan and refuses AI beyond the plan entitlement', async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wimblo-entitlement-plane-'));
 const app=createPlatformApp({rootDir:join(dir,'registry'),legacyDbPath:join(dir,'legacy.sqlite'),seedLegacy:false,
  initialPlatformAdmin:{name:'Synthetic operator',email:'operator.entitlement@example.test',password:'PlatformEntitlement!2026'},
  tenantFactory:args=>createApp({...args,reminderWorker:false,workflowWorker:false})});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const response=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}
  return {status:response.status,json,text,headers:response.headers};
 }
 const login=await request('/api/platform/auth/login',{method:'POST',body:{email:'operator.entitlement@example.test',password:'PlatformEntitlement!2026'}});
 assert.equal(login.status,200,login.text);
 const operator={...login.json,cookie:cookies(login.headers)};
 const tenantAdmin={name:'Synthetic workspace administrator',email:'admin.plane@example.test',password:'WorkspacePlane!2026'};
 const body=(slug,changes={})=>({slug,name:'Workspace '+slug,plan:'trial',admin:tenantAdmin,dataMode:'restricted',aiEnabled:false,...changes});
 const refused=await request('/api/platform/tenants',{method:'POST',session:operator,body:body('trial-ai',{aiEnabled:true})});
 assert.equal(refused.status,409,refused.text);
 assert.match(refused.json.error,/Trial plan does not include AI assistance/);
 const created=await request('/api/platform/tenants',{method:'POST',session:operator,body:body('metered')});
 assert.equal(created.status,201,created.text);
 assert.deepEqual([created.json.tenant.entitlements.fullUserSeats,created.json.tenant.entitlements.helperSeats],[4,2]);
 assert.equal(created.json.tenant.billing.billingConfigured,false);
 assert.deepEqual(created.json.tenant.billing.invoices,[]);
 const upgrade=await request('/api/platform/tenants/'+created.json.tenant.id,{method:'PATCH',session:operator,body:{version:created.json.tenant.version,plan:'dedicated',aiEnabled:true}});
 assert.equal(upgrade.status,200,upgrade.text);
 assert.equal(upgrade.json.tenant.entitlements.fullUserSeats,25);
 const downgrade=await request('/api/platform/tenants/'+created.json.tenant.id,{method:'PATCH',session:operator,body:{version:upgrade.json.tenant.version,plan:'trial'}});
 assert.equal(downgrade.status,409,'AI must be turned off before a workspace drops to a plan without it');
 // The live plan reaches the workspace and is enforced there, not merely displayed.
 const signIn=await request('/api/auth/login',{method:'POST',body:{email:tenantAdmin.email,password:tenantAdmin.password,tenantSlug:'metered'}});
 assert.equal(signIn.status,200,signIn.text);
 const session={...signIn.json,cookie:cookies(signIn.headers)};
 const overview=await request('/api/tenant-administration/overview',{session});
 assert.equal(overview.status,200,overview.text);
 assert.equal(overview.json.entitlements.plan,'dedicated');
 assert.equal(overview.json.entitlements.fullUserSeats,25);
 assert.equal(overview.json.billing.plan,'dedicated');
 assert.equal(overview.json.billing.billingConfigured,false);
 assert.equal(overview.json.workspace.managed,true);
 // The workspace identity payload is unchanged by the entitlement model.
 const config=await request('/api/config',{session});
 assert.deepEqual(config.json.tenant,{slug:'metered',name:'Workspace metered'});
});
