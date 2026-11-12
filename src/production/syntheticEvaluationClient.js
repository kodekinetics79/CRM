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
  if(path==='/crm/parties'&&verb==='GET')return ok({parties:state.parties});
  if(path.startsWith('/crm/parties?')&&verb==='GET'){const query=new URLSearchParams(path.split('?')[1]),needle=(query.get('search')||'').toLowerCase();return ok({parties:state.parties.filter(item=>item.displayName.toLowerCase().includes(needle))});}
  if(path==='/crm/people'&&verb==='POST'){const party={partyId:uuid(sequence++),partyType:'person',displayName:body.displayName,status:'active',version:1};state.parties.push(party);return ok({party});}
  if(path==='/crm/pipelines')return ok({pipelines:state.pipelines});
  if(path.startsWith('/crm/opportunities'))return ok({opportunities:state.opportunities});
  if(path.match(/^\/crm\/subjects\/[^/]+\/timeline/)){const subjectId=path.split('/')[3];return ok({items:state.timeline[subjectId]||[],nextCursor:null});}
  if(path.startsWith('/crm/dashboard'))return ok({dashboard:{dataset:'opportunities',total:state.opportunities.length}});
  if(path==='/crm/reports/execute')return ok({dataset:body?.definition?.dataset||'parties',rows:state.parties,truncated:false});
  if(path==='/crm/exports')return 'displayName\r\nAtlas Workshop (Synthetic)\r\n';
  if(path==='/auth/logout')return ok({ok:true});
  throw Object.assign(new Error('Synthetic evaluation route is unavailable.'),{status:404,code:'NOT_FOUND'});
 }
 return Object.freeze({synthetic:true,request,restore:()=>request('/auth/me'),setCsrf:()=>{},clear:()=>{},reset:async()=>{state=clone(SYNTHETIC_BASELINE);sequence=1;return ok({ok:true});}});
}
