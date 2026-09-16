import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Isolated component state harness, not a replacement for browser integration.
function component(file,dependencies={}){let index=0,effects=[],state=[];const mock={...React,lazy:()=>()=>null,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useCallback(fn){index++;return fn;},useEffect(fn){index++;effects.push(fn);}};const icon=()=>null,require=id=>id==='react'?mock:id==='lucide-react'?new Proxy({},{get:()=>icon}):dependencies[id]||{__esModule:true,default:()=>null};const module={exports:{}};new Function('require','module','exports',transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(require,module,module.exports);const render=props=>{index=0;effects=[];return module.exports.default(props);};return {render,effects:()=>effects,html:props=>renderToStaticMarkup(render(props))};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function findAll(tree,predicate,found=[]){if(!tree||typeof tree!=='object')return found;if(predicate(tree))found.push(tree);for(const child of React.Children.toArray(tree.props?.children))findAll(child,predicate,found);return found;}
const flush=()=>new Promise(r=>setImmediate(r));
const lib={__esModule:true,money:cents=>'$'+(Number(cents)/100).toFixed(2),dateLabel:value=>String(value).slice(0,10),cents:v=>Number(v),today:()=>'2026-09-15',nameOf:()=>''};

const overview={
 workspace:{name:'Jefferson Education Foundation',slug:'jefferson',managed:true,status:'active'},
 entitlements:{plan:'subscription',label:'Subscription',fullUserSeats:4,helperSeats:2,invitations:true,ai:true,federation:false,connectors:['mailchimp'],historyRetentionYears:10},
 seats:{plan:'subscription',planLabel:'Subscription',fullUserSeats:4,helperSeats:2,fullUsersInUse:4,helperUsersInUse:2,fullInvitationsPending:0,helperInvitationsPending:0,fullSeatsRemaining:0,helperSeatsRemaining:0,metered:true},
 billing:{plan:'subscription',planLabel:'Subscription',billingConfigured:false,billingProvider:null,subscriptionActive:false,invoices:[],charges:[],providerEvents:[],note:'A plan label is an administrative classification of included capability. No billing provider is connected to this workspace.'},
 branding:{enabled:false,displayName:'',supportEmail:'',footerNote:'',version:1,updatedAt:'2026-09-15T00:00:00.000Z',productIdentity:{productName:'Wimblo',providedBy:'Kode Kinetics',statement:'Wimblo by Kode Kinetics. Customer branding is optional and never replaces the product identity.'}},
 productIdentity:{productName:'Wimblo',providedBy:'Kode Kinetics',statement:'Wimblo by Kode Kinetics. Customer branding is optional and never replaces the product identity.'},
 roles:[{role:'admin',label:'Administrator',businessRecords:'Create, change and delete',accountAdministration:true,tenantAdministration:true,eventCheckIn:true,summary:'Full workspace authority.'},
  {role:'event-helper',label:'Event helper',businessRecords:'None; assigned event ticket check-in only',accountAdministration:false,tenantAdministration:false,eventCheckIn:'Assigned events only',summary:'Optional non-administrator helper.'}],
 accounts:[{id:'admin-1',name:'Synthetic administrator',email:'admin@example.test',role:'admin',seatClass:'full',active:true,version:1,mfaEnabled:true,mfaAvailable:true,recoveryCodesRemaining:7},
  {id:'staff-1',name:'Synthetic staff',email:'staff@example.test',role:'staff',seatClass:'full',active:true,version:1,mfaEnabled:false,mfaAvailable:true,recoveryCodesRemaining:0}],
 invitations:[{id:'invite-1',email:'invited@example.test',name:'Synthetic invitee',role:'staff',seatClass:'full',status:'Pending',issuedBy:'admin-1',issuedAt:'2026-09-15T00:00:00.000Z',expiresAt:'2026-09-18T00:00:00.000Z',closedAt:null,closedReason:null,acceptedUserId:null,version:1}],
 reviews:[{id:'review-1',duty:'gift-void',dutyLabel:'Void a posted gift',subjectCollection:'gifts',subjectId:'gift-1',subjectVersion:1,summary:'Duplicate deposit',amountCents:25000,preparedBy:'staff-1',preparerRole:'staff',status:'Prepared',approvedBy:null,approverRole:null,decisionReason:null,decidedAt:null,version:1,createdAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-15T00:00:00.000Z'}],
 duties:[{duty:'gift-void',label:'Void a posted gift',collection:'gifts',preparerRoles:['admin','staff'],approverRoles:['admin'],financiallyMeaningful:true,distinctApproverRequired:true,enabled:false,version:1,reason:'',updatedAt:null}],
 federation:{enabled:false,configured:false,issuer:'',clientId:'',redirectUri:'',discoveryUrl:'',roleClaim:'groups',roleMappings:[],allowedEmailDomains:[],discoveredAt:null,keyCount:0,authorizationReference:'',version:1,entitled:false,assignableRoles:['staff','viewer','event-helper'],productionEnablementAuthorized:false,scope:'Optional boundary. Federated sign-in is disabled by default, issues no workspace session in this release, and never replaces MFA.',assertions:[]},
 mfaRequired:false
};
const data={gifts:[{id:'gift-1',name:'',amount:25000,version:1}],constituents:[]};

test('a non-administrator sees an explicit permission-denied state and no administration request is made',async()=>{
 const calls=[],h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async path=>{calls.push(path);return overview;},user:{id:'staff-1',role:'staff'},data,notify:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 const html=h.html(props);
 assert.match(html,/Administrator access is required/);
 assert.match(html,/ordinary duties never grant it/);
 assert.deepEqual(calls,[],'no administration data is requested for a denied role');
});

test('the administrator screen loads, names the plan and never claims a billing subscription',async()=>{
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async()=>overview,user:{id:'admin-1',role:'admin'},data,notify:()=>{}};
 const loadingHtml=h.html(props);
 assert.match(loadingHtml,/Opening tenant administration/);
 h.render(props);h.effects()[0]();await flush();
 const html=h.html(props);
 assert.match(html,/Subscription plan/);
 assert.match(html,/Full user seats<\/dt><dd>4 of 4/);
 assert.match(html,/Optional helper seats<\/dt><dd>2 of 2/);
 assert.match(html,/No billing provider is connected/);
 assert.match(html,/Not connected/);
 assert.doesNotMatch(html,/invoice #|paid|charged|receipt of payment/i);
 assert.match(html,/Wimblo by Kode Kinetics/);
 const tabs=findAll(h.render(props),e=>e.props?.role==='tab');
 assert.equal(tabs.length,6);
 assert.ok(tabs.every(t=>typeof t.props['aria-selected']==='boolean'),'every tab states its selection');
 assert.equal(tabs.filter(t=>t.props.tabIndex===0).length,1,'exactly one roving tab stop');
 for(const tab of tabs)assert.ok(tab.props['aria-controls'],'each tab controls a named panel');
});

test('issuing an invitation shows the single-use link once, states no message was sent and clears the form',async()=>{
 const calls=[];let issued=0;
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async(path,options)=>{calls.push([path,options?.method||'GET']);
  if(path==='/tenant-administration/invitations'&&options?.method==='POST'){issued++;return {invitation:{id:'invite-2',email:'new@example.test',role:'staff',expiresAt:'2026-09-18T00:00:00.000Z',version:1},token:'11111111-1111-4111-8111-111111111111.SYNTHETICSINGLEUSETOKEN'};}
  return overview;},user:{id:'admin-1',role:'admin'},data,notify:()=>{},onDirty:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-people').props.onClick();
 tree=h.render(props);
 const fields=[['Full name','Synthetic new staff'],['Email','new@example.test']];
 for(const [label,value] of fields){
  tree=h.render(props);
  const field=findAll(tree,e=>e.type==='label').find(e=>React.Children.toArray(e.props.children).some(child=>typeof child==='string'&&child.startsWith(label)));
  find(field,e=>e.type==='input').props.onChange({target:{value}});
 }
 tree=h.render(props);
 const reasonField=findAll(tree,e=>e.type==='label').find(e=>React.Children.toArray(e.props.children).some(child=>typeof child==='string'&&child.startsWith('Reason')));
 find(reasonField,e=>e.type==='textarea').props.onChange({target:{value:'Approved additional staff seat'}});
 tree=h.render(props);
 const submission=find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
 await submission;await flush();
 const html=h.html(props);
 assert.equal(issued,1);
 assert.match(html,/SYNTHETICSINGLEUSETOKEN/);
 assert.match(html,/shown once/);
 assert.match(html,/No message was sent/i);
 tree=h.render(props);
 const nameInput=find(findAll(tree,e=>e.type==='label').find(e=>React.Children.toArray(e.props.children).some(c=>typeof c==='string'&&c.startsWith('Full name'))),e=>e.type==='input');
 assert.equal(nameInput.props.value,'','the form clears after the link is issued');
 assert.ok(calls.some(([path,method])=>path==='/tenant-administration/invitations'&&method==='POST'));
});

test('a conflict reloads the current values and explains the refusal instead of silently failing',async()=>{
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 let reloads=0;
 const props={api:async(path,options)=>{
  if(options?.method==='POST'&&path.includes('/decision')){const error=new Error('Review changed. Reload its current version before deciding');error.status=409;throw error;}
  reloads++;return overview;},user:{id:'admin-1',role:'admin'},data,notify:()=>{},onDirty:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-duties').props.onClick();
 tree=h.render(props);
 find(tree,e=>e.type==='button'&&e.props['aria-label']==='Decide the Void a posted gift review').props.onClick();
 tree=h.render(props);
 const reasonField=findAll(tree,e=>e.type==='label').find(e=>React.Children.toArray(e.props.children).some(c=>typeof c==='string'&&c.startsWith('Reason for this decision')));
 find(reasonField,e=>e.type==='textarea').props.onChange({target:{value:'Checked against the bank statement'}});
 tree=h.render(props);
 const forms=findAll(tree,e=>e.type==='form');
 await forms.at(-1).props.onSubmit({preventDefault(){}});
 await flush();
 const html=h.html(props);
 assert.match(html,/Review changed/);
 assert.match(html,/latest values have been reloaded/);
 assert.ok(reloads>=2,'the screen reloads after a conflict');
});

test('the separation-of-duties list refuses to offer a decision to the actor who prepared it',async()=>{
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async()=>overview,user:{id:'staff-1',role:'admin'},data,notify:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-duties').props.onClick();
 tree=h.render(props);
 assert.equal(find(tree,e=>e.type==='button'&&e.props['aria-label']==='Decide the Void a posted gift review'),null);
 assert.match(renderToStaticMarkup(tree),/You prepared this/);
});

test('the federated sign-in panel stays disabled, states the boundary and never offers an administrator mapping',async()=>{
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async()=>overview,user:{id:'admin-1',role:'admin'},data,notify:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-federation').props.onClick();
 const html=renderToStaticMarkup(h.render(props));
 assert.match(html,/not configured on this server/);
 assert.match(html,/Wimblo credentials remain the supported sign-in/);
 assert.match(html,/never satisfied by a federated assertion/);
 assert.match(html,/staff, viewer, event-helper/);
 assert.doesNotMatch(html,/Assignable roles<\/dt><dd>[^<]*admin/);
 assert.equal(find(h.render(props),e=>e.type==='button'&&/Enable federated sign-in/.test(String(e.props.children))),null,'an unconfigured server offers no enable control');
});

test('account security shows enrollment state only, with no administrative bypass control',async()=>{
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async()=>overview,user:{id:'admin-1',role:'admin'},data,notify:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-security').props.onClick();
 const html=renderToStaticMarkup(h.render(props));
 assert.match(html,/Enrolled/);
 assert.match(html,/Setup required/);
 assert.match(html,/never readable here/);
 assert.doesNotMatch(html,/<button[^>]*>[^<]*(Disable|Reset|Revoke|Bypass)/i,'no administrative factor control is offered');
 assert.doesNotMatch(html,/<form/,'the enrollment view is read-only');
});

test('platform administration shows plan entitlements and keeps the lifecycle statement honest',async t=>{
 const savedFetch=globalThis.fetch,savedDocument=globalThis.document;
 globalThis.document={title:''};
 t.after(()=>{globalThis.fetch=savedFetch;globalThis.document=savedDocument;});
 const tenant={id:'tenant-1',slug:'jefferson',name:'Jefferson Education Foundation',plan:'subscription',status:'active',aiEnabled:false,dataMode:'restricted',version:1,createdAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-15T00:00:00.000Z',
  entitlements:{plan:'subscription',label:'Subscription',fullUserSeats:4,helperSeats:2,invitations:true,ai:true,federation:false,connectors:['mailchimp'],historyRetentionYears:10},
  billing:{plan:'subscription',planLabel:'Subscription',billingConfigured:false,billingProvider:null,subscriptionActive:false,invoices:[],charges:[],providerEvents:[],note:'A plan label is an administrative classification.'}};
 globalThis.fetch=async path=>{let payload;
  if(path.endsWith('/auth/me'))payload={user:{id:'operator',name:'Synthetic operator'},csrfToken:'csrf',platformCapabilities:{syntheticWorkspaceCreation:false}};
  else if(path.endsWith('/tenants'))payload={tenants:[tenant],audit:[]};
  else if(path.endsWith('/administrators'))payload={administrators:[]};
  else throw Error('Unexpected request '+path);
  return {ok:true,json:async()=>payload};};
 const h=component('../src/features/PlatformAdmin.jsx');
 h.render();h.effects()[0]();await flush();await flush();
 const html=h.html();
 assert.match(html,/Subscription/);
 assert.match(html,/4 full · 2 helper/);
 assert.match(html,/Full seats entitled/);
 assert.match(html,/name the entitlements each workspace enforces/);
 assert.match(html,/no invoice, charge or provider event is held/);
 const tree=h.render();
 find(tree,e=>e.type==='button'&&e.props['aria-label']==='Manage Jefferson Education Foundation').props.onClick();
 const managed=renderToStaticMarkup(h.render());
 assert.match(managed,/ends every workspace session, stops queued automation and retains all records/);
 assert.match(managed,/Resuming restores access without reviving anything that was suppressed/);
 assert.match(managed,/Optional non-administrator helper seats/);
 assert.match(managed,/No provider connected/);
});

test('two-person controls are shown off by default and turning one on states the change and asks for a reason',async()=>{
 const calls=[];let saved=null;
 const h=component('../src/features/TenantAdministration.jsx',{'../lib':lib});
 const props={api:async(path,options)=>{calls.push([path,options?.method||'GET']);
  if(options?.method==='PATCH'&&path.startsWith('/tenant-administration/duty-policies/')){saved=JSON.parse(JSON.stringify(options.body));return {duty:{...overview.duties[0],enabled:true,version:2}};}
  return overview;},user:{id:'admin-1',role:'admin'},data,notify:()=>{},onDirty:()=>{}};
 h.render(props);h.effects()[0]();await flush();
 let tree=h.render(props);
 find(tree,e=>e.props?.role==='tab'&&e.props.id==='tenant-admin-tab-duties').props.onClick();
 let html=renderToStaticMarkup(h.render(props));
 assert.match(html,/Off — unchanged behaviour/);
 assert.match(html,/Each control is off unless you turn it on/);
 assert.match(html,/cannot leave a single administrator unable to obtain an approval/);
 tree=h.render(props);
 find(tree,e=>e.type==='button'&&e.props['aria-label']==='Turn on the two-person control for Void a posted gift').props.onClick();
 tree=h.render(props);
 const text=e=>React.Children.toArray(e.props.children).filter(c=>typeof c==='string').join('');
 const reasonField=findAll(tree,e=>e.type==='label').find(e=>text(e).startsWith('Reason for enabling'));
 assert.ok(reasonField,'enabling asks for a recorded reason');
 find(reasonField,e=>e.type==='textarea').props.onChange({target:{value:'Board asked for two-person voids'}});
 tree=h.render(props);
 await findAll(tree,e=>e.type==='form')[0].props.onSubmit({preventDefault(){}});
 await flush();
 assert.deepEqual(saved,{version:1,enabled:true,reason:'Board asked for two-person voids'});
 assert.match(h.html(props),/now refused until a different authorized person approves it/);
});
