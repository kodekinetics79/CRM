// One controlled seam for capabilities added after the September 13 checkpoint.
// Every module stays independent: it installs its own tables, routes and guards
// and returns optional guard callbacks. No module may weaken an existing control,
// post financial records without its own explicit authority checks or claim
// external delivery. Provider execution stays disabled unless explicitly configured.
import {install as installMessaging} from './messaging.js';
import {install as installRecurringGiving} from './recurringGiving.js';
import {installPublic as installPublicGiving} from './publicGiving.js';
import {install as installVolunteerPortal,installPublic as installPublicVolunteer} from './volunteerPortal.js';
import {install as installEventPlanning} from './eventPlanning.js';
import {install as installAccountStructure} from './accountStructure.js';
import {install as installReportPacks} from './reportPacks.js';
import {install as installTenantAdministration,installPublic as installPublicInvitations} from './tenantAdministration.js';
import {install as installObservability} from './observability.js';
import {install as installDataQuality} from './dataQuality.js';

const withConfig=(context,config)=>Object.create(context,{config:{value:config,enumerable:true}});

const modules=[
 ['messaging',installMessaging],
 ['recurringGiving',installRecurringGiving],
 ['volunteerPortal',installVolunteerPortal],
 ['eventPlanning',installEventPlanning],
 ['accountStructure',installAccountStructure],
 ['reportPacks',installReportPacks],
 ['tenantAdministration',installTenantAdministration],
 ['observability',installObservability],
 ['dataQuality',installDataQuality]
];
// Volunteer notices address a constituent, so they can route through the governed
// transactional queue, which re-checks suppression, contact preference and a current
// address at execution. Task escalations address an internal staff account, which that
// constituent-addressed queue deliberately cannot carry, so they stay internal.
const VOLUNTEER_PURPOSES={'Shift reminder':'volunteer-shift-reminder','Waitlist promotion':'volunteer-shift-promotion'};
function volunteerOutbox(services,context){
 const queue=services.messaging?.queueTransactional;
 const options=context.options?.messaging;
 // Only route where a messaging workspace is actually configured; otherwise the
 // programs modules keep their internal-only default and behave exactly as before.
 if(typeof queue!=='function'||!options||!Object.keys(options).filter(key=>key!=='clock').length)return null;
 return envelope=>{
  const purpose=VOLUNTEER_PURPOSES[envelope?.kind];
  if(!purpose)return {accepted:false,reason:'Unsupported volunteer notice kind'};
  let constituent;
  try{constituent=context.get('constituents',envelope.constituentId);}catch{return {accepted:false,reason:'Volunteer identity is unavailable'};}
  const summary=(envelope.shiftName?String(envelope.shiftName).slice(0,200):'Volunteer shift')+' starting '+String(envelope.startsAt||'').slice(0,40);
  return queue({purpose,constituentId:constituent.id,constituentVersion:constituent.version,channel:'Email',reference:'volunteer-notice:'+envelope.reminderId,summary});
 };
}

const publicModules=[['publicGiving',installPublicGiving],['volunteerPortal',installPublicVolunteer],['tenantAdministration',installPublicInvitations]];

// Public, unauthenticated surfaces. These carry no session cookie: every request
// proves itself with an explicitly issued signed token, so a browser CSRF token
// does not apply and each module enforces its own rate and replay limits.
export function installPublicExtensions(app,context){
 const installed={};
 for(const [key,install] of publicModules){const guard=install?.(app,withConfig(context,context.options?.[key]??null));if(guard)installed[key]=guard;}
 return installed;
}

export function installExtensions(app,context){
 const guards=[],services={};
 for(const [key,install] of modules){
  let config=context.options?.[key]??null;
  if(key==='volunteerPortal'&&typeof config?.sendReminder!=='function'){const outbox=volunteerOutbox(services,context);if(outbox)config={...(config||{}),sendReminder:outbox};}
  const service=install?.(app,withConfig(context,config));
  if(service){services[key]=service;guards.push(service);}
 }
 const each=(method,...args)=>{for(const guard of guards)guard[method]?.(...args);};
 return {
  services,
  validateMutation:(collection,previous,next)=>each('validateMutation',collection,previous,next),
  validateDeletion:(collection,record)=>each('validateDeletion',collection,record),
  hasConstituentReferences:id=>guards.some(guard=>guard.hasConstituentReferences?.(id)),
  workspaceData:req=>Object.assign({},...guards.map(guard=>guard.workspaceData?.(req)||{})),
  close:()=>{for(const guard of guards)try{guard.close?.();}catch{}}
 };
}
