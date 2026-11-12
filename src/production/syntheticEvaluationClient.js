const clone=value=>structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};

export const SYNTHETIC_BASELINE=freeze({
 synthetic:true,
 tenant:{tenantId:'10000000-0000-4000-8000-000000000001',name:'Northstar Synthetic Evaluation',slug:'northstar-evaluation'},
 identity:{identityId:'10000000-0000-4000-8000-000000000002',displayName:'Jordan Evaluator',normalizedEmail:'jordan@northstar.example'},
 membership:{membershipId:'10000000-0000-4000-8000-000000000003',tenantId:'10000000-0000-4000-8000-000000000001',role:'owner',status:'active',version:1},
 modules:[
  {code:'core',name:'Core CRM',state:'enabled',capabilities:{read:true,write:true,export:true}},
  {code:'sales',name:'Sales',state:'enabled',capabilities:{read:true,write:true,export:true}},
  {code:'reporting',name:'Reporting',state:'enabled',capabilities:{read:true,write:true,export:true}}
 ],
 parties:[
  {partyId:'20000000-0000-4000-8000-000000000001',partyType:'organization',displayName:'Atlas Workshop (Synthetic)',status:'active',version:1},
  {partyId:'20000000-0000-4000-8000-000000000002',partyType:'person',displayName:'Morgan Rivera (Synthetic)',status:'active',version:1}
 ],
 pipelines:[{pipelineId:'30000000-0000-4000-8000-000000000001',name:'Evaluation pipeline',isDefault:true,stages:[
  {stageId:'30000000-0000-4000-8000-000000000011',name:'Discovery',kind:'open',position:1,probability:20},
  {stageId:'30000000-0000-4000-8000-000000000012',name:'Review',kind:'open',position:2,probability:60},
  {stageId:'30000000-0000-4000-8000-000000000013',name:'Won',kind:'won',position:3,probability:100},
  {stageId:'30000000-0000-4000-8000-000000000014',name:'Lost',kind:'lost',position:4,probability:0}
 ]}],
 opportunities:[{opportunityId:'40000000-0000-4000-8000-000000000001',partyId:'20000000-0000-4000-8000-000000000001',name:'Synthetic service renewal',stageId:'30000000-0000-4000-8000-000000000011',status:'open',amountCents:2400000,currency:'USD',version:1,expectedCloseDate:'2026-12-15'}],
 contacts:{},tasks:[],notes:[],subjectVersions:{},subjectOwners:{},
 timeline:{'20000000-0000-4000-8000-000000000001':[{kind:'activity',sourceId:'50000000-0000-4000-8000-000000000001',sourceVersion:1,summary:'Synthetic discovery meeting recorded',occurredAt:'2026-11-11T14:00:00.000Z'}]}
});

const uuid=index=>`90000000-0000-4000-8000-${String(index).padStart(12,'0')}`;

export function createSyntheticEvaluationClient(){
 let state=clone(SYNTHETIC_BASELINE),sequence=1;
 const ok=value=>Promise.resolve(clone(value));
 async function request(path,{method='GET',body}={}){
  const verb=String(method).toUpperCase();
  if(path==='/auth/me')return ok({identity:state.identity,membership:state.membership,csrfToken:'synthetic-memory-csrf',mfaVerifiedAt:'2026-11-11T12:00:00.000Z'});
  if(path==='/auth/tenants')return ok({memberships:[{...state.membership,tenantName:state.tenant.name,tenantSlug:state.tenant.slug}]});
  if(path==='/modules')return ok({modules:state.modules});
  if(path==='/crm/members')return ok({members:[{identityId:state.identity.identityId,displayName:state.identity.displayName,role:state.membership.role}]});
  if(path==='/crm/parties'&&verb==='GET')return ok({parties:state.parties});
  if(path.startsWith('/crm/parties?')&&verb==='GET'){const query=new URLSearchParams(path.split('?')[1]),needle=(query.get('search')||'').toLowerCase(),offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||50);return ok({parties:state.parties.filter(item=>item.displayName.toLowerCase().includes(needle)).slice(offset,offset+limit)});}
  const contactsMatch=path.match(/^\/crm\/parties\/([^/?]+)\/contacts(?:\?.*)?$/);
  if(contactsMatch&&verb==='GET')return ok({contacts:state.contacts[contactsMatch[1]]||[]});
  if(contactsMatch&&verb==='POST'){const contact={contactId:uuid(sequence++),partyId:contactsMatch[1],...body,displayValue:body.value,status:'active',version:1};(state.contacts[contactsMatch[1]]??=[]).push(contact);return ok({contact});}
  const partyMatch=path.match(/^\/crm\/parties\/([^/?]+)$/);
  if(partyMatch&&verb==='GET'){const party=state.parties.find(item=>item.partyId===partyMatch[1]);if(!party)throw Object.assign(new Error('Relationship not found.'),{status:404});return ok({party});}
  if(partyMatch&&verb==='PATCH'){const party=state.parties.find(item=>item.partyId===partyMatch[1]);if(!party)throw Object.assign(new Error('Relationship not found.'),{status:404});if(party.version!==body.expectedVersion)throw Object.assign(new Error('Relationship changed.'),{status:409});Object.assign(party,{displayName:body.displayName??party.displayName,status:body.status??party.status,version:party.version+1});return ok({party});}
  if(path==='/crm/people'&&verb==='POST'){const party={partyId:uuid(sequence++),partyType:'person',displayName:body.displayName,firstName:body.firstName,lastName:body.lastName,status:'active',version:1};state.parties.push(party);return ok({party});}
  if(path==='/crm/organizations'&&verb==='POST'){const party={partyId:uuid(sequence++),partyType:'organization',displayName:body.displayName,legalName:body.legalName,status:'active',version:1};state.parties.push(party);return ok({party});}
  if(path==='/crm/pipelines')return ok({pipelines:state.pipelines});
  const stageMatch=path.match(/^\/crm\/opportunities\/([^/]+)\/stage$/);
  if(stageMatch&&verb==='POST'){const opportunity=state.opportunities.find(item=>item.opportunityId===stageMatch[1]);if(!opportunity)throw Object.assign(new Error('Opportunity not found.'),{status:404});if(opportunity.version!==body.expectedVersion)throw Object.assign(new Error('Opportunity changed.'),{status:409});opportunity.stageId=body.stageId;opportunity.version++;return ok({opportunity});}
  if(path.startsWith('/crm/opportunities')&&verb==='GET')return ok({opportunities:state.opportunities});
  if(path.match(/^\/crm\/subjects\/[^/]+\/timeline/)){const subjectId=path.split('/')[3];return ok({items:state.timeline[subjectId]||[],nextCursor:null});}
  const subjectMatch=path.match(/^\/crm\/subjects\/([^/]+)$/);
  if(subjectMatch&&verb==='GET')return ok({subject:{subjectId:subjectMatch[1],subjectType:'party',ownerIdentityId:state.subjectOwners[subjectMatch[1]]||state.identity.identityId,version:state.subjectVersions[subjectMatch[1]]||1}});
  const activityMatch=path.match(/^\/crm\/subjects\/([^/]+)\/activities$/);
  if(activityMatch&&verb==='POST'){const activity={activityId:uuid(sequence++),version:1,...body},item={kind:'activity',sourceId:activity.activityId,sourceVersion:1,summary:activity.summary,occurredAt:'2026-11-11T15:00:00.000Z'};(state.timeline[activityMatch[1]]??=[]).push(item);return ok({activity});}
  const taskCreate=path.match(/^\/crm\/subjects\/([^/?]+)\/tasks(?:\?(.*))?$/);
  if(taskCreate&&verb==='GET'){const query=new URLSearchParams(taskCreate[2]||''),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),offset=Math.max(0,Number(query.get('cursor')||0)),matching=state.tasks.filter(item=>item.subjectId===taskCreate[1]),page=matching.slice(offset,offset+limit).map(({details,...task})=>task);return ok({tasks:page,nextCursor:offset+page.length<matching.length?String(offset+page.length):null});}
  if(taskCreate&&verb==='POST'){const task={taskId:uuid(sequence++),subjectId:taskCreate[1],status:'open',version:1,...body};state.tasks.push(task);return ok({task});}
  const taskUpdate=path.match(/^\/crm\/tasks\/([^/]+)$/);
  if(taskUpdate&&verb==='GET'){const task=state.tasks.find(item=>item.taskId===taskUpdate[1]);if(!task)throw Object.assign(new Error('Task not found.'),{status:404});return ok({task});}
  if(taskUpdate&&verb==='PATCH'){const task=state.tasks.find(item=>item.taskId===taskUpdate[1]);if(!task||task.version!==body.expectedVersion)throw Object.assign(new Error('Task changed.'),{status:409});Object.assign(task,body,{version:task.version+1});delete task.expectedVersion;return ok({task});}
  const noteCreate=path.match(/^\/crm\/subjects\/([^/?]+)\/notes(?:\?(.*))?$/);
  if(noteCreate&&verb==='GET'){const query=new URLSearchParams(noteCreate[2]||''),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),offset=Math.max(0,Number(query.get('cursor')||0)),matching=state.notes.filter(item=>item.subjectId===noteCreate[1]),page=matching.slice(offset,offset+limit).map(({body,...note})=>note);return ok({notes:page,nextCursor:offset+page.length<matching.length?String(offset+page.length):null});}
  if(noteCreate&&verb==='POST'){const note={noteId:uuid(sequence++),subjectId:noteCreate[1],currentRevision:1,version:1,...body};state.notes.push(note);return ok({note});}
  const noteDetail=path.match(/^\/crm\/notes\/([^/]+)$/);
  if(noteDetail&&verb==='GET'){const note=state.notes.find(item=>item.noteId===noteDetail[1]);if(!note)throw Object.assign(new Error('Note not found.'),{status:404});return ok({note});}
  const noteRevision=path.match(/^\/crm\/notes\/([^/]+)\/revisions$/);
  if(noteRevision&&verb==='POST'){const note=state.notes.find(item=>item.noteId===noteRevision[1]);if(!note||note.version!==body.expectedVersion)throw Object.assign(new Error('Note changed.'),{status:409});note.body=body.body;note.version++;note.currentRevision++;return ok({note});}
  const attachment=path.match(/^\/crm\/subjects\/([^/]+)\/attachments$/);
  if(attachment&&verb==='POST')return ok({attachment:{linkId:uuid(sequence++),subjectId:attachment[1],version:1,...body}});
  const owner=path.match(/^\/crm\/subjects\/([^/]+)\/owner$/);
  if(owner&&verb==='PATCH'){const current=state.subjectVersions[owner[1]]||1;if(current!==body.expectedVersion)throw Object.assign(new Error('Owner changed.'),{status:409});state.subjectVersions[owner[1]]=current+1;state.subjectOwners[owner[1]]=body.newOwnerIdentityId;return ok({subject:{subjectId:owner[1],subjectType:'party',ownerIdentityId:body.newOwnerIdentityId,version:current+1}});}
  if(path.startsWith('/crm/dashboard')){const dataset=new URLSearchParams(path.split('?')[1]).get('dataset')||'opportunities';return ok({dashboard:{dataset,total:dataset==='parties'?state.parties.length:state.opportunities.length}});}
  if(path==='/crm/reports/execute')return ok({dataset:body?.definition?.dataset||'parties',rows:state.parties,truncated:false});
  if(path==='/crm/reports'&&verb==='POST')return ok({report:{reportId:uuid(sequence++),name:body.name,dataset:body.definition.dataset,version:1}});
  if(path==='/crm/exports')return 'displayName\r\nAtlas Workshop (Synthetic)\r\n';
  if(path==='/crm/imports/preview'&&verb==='POST')return ok({batch:{batchId:uuid(sequence++),version:1,sourceSha256:'synthetic-source-sha256',insertedCount:1,updatedCount:0,unchangedCount:0}});
  if(path.match(/^\/crm\/imports\/[^/]+\/commit$/)&&verb==='POST')return ok({batch:{status:'committed',version:2}});
  if(path==='/auth/logout')return ok({ok:true});
  throw Object.assign(new Error('Synthetic evaluation route is unavailable.'),{status:404,code:'NOT_FOUND'});
 }
 return Object.freeze({synthetic:true,request,restore:()=>request('/auth/me'),setCsrf:()=>{},clear:()=>{},subscribeSession:()=>()=>{},reset:async()=>{state=clone(SYNTHETIC_BASELINE);sequence=1;return ok({ok:true});}});
}
