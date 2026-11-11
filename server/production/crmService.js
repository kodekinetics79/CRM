import {createCrmRepository} from './crmRepository.js';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const READ_ROLES=new Set(['owner','admin','staff','viewer']);
const WRITE_ROLES=new Set(['owner','admin','staff']);

export {createCrmRepository};

export function createCrmService({repository,moduleService}={}){
  if(!repository||typeof repository.createPerson!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A CRM repository is required.');
  if(!moduleService||typeof moduleService.authorize!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A module service is required.');

  async function requireCapability(tenantId,action){
    const result=await moduleService.authorize({tenantId,code:'core',action});
    if(!result?.allowed)persistenceFail(PERSISTENCE_CODES.ISOLATION,'Capability is unavailable for this action.');
    return result;
  }
  async function requireSalesCapability(tenantId,action){
    const result=await moduleService.authorize({tenantId,code:'sales',action});
    if(!result?.allowed)persistenceFail(PERSISTENCE_CODES.ISOLATION,'Capability is unavailable for this action.');
    return result;
  }
  function requireReadRole(actorRole){
    if(!READ_ROLES.has(actorRole))persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized CRM read role is required.');
  }
  function requireWriteRole(actorRole){
    if(!WRITE_ROLES.has(actorRole))persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized CRM write role is required.');
  }
  const writeContext=async(tenantId,actorRole)=>{await requireCapability(tenantId,'write');requireWriteRole(actorRole);};
  const readContext=async(tenantId,actorRole)=>{await requireCapability(tenantId,'read');requireReadRole(actorRole);};
  const salesWriteContext=async(tenantId,actorRole)=>{await requireSalesCapability(tenantId,'write');requireWriteRole(actorRole);};
  const salesReadContext=async(tenantId,actorRole)=>{await requireSalesCapability(tenantId,'read');requireReadRole(actorRole);};

  return Object.freeze({
    createPerson:async input=>{await writeContext(input.tenantId,input.actorRole);return repository.createPerson(input);},
    createOrganization:async input=>{await writeContext(input.tenantId,input.actorRole);return repository.createOrganization(input);},
    updateParty:async input=>{await writeContext(input.tenantId,input.actorRole);return repository.updateParty(input);},
    createContact:async input=>{await writeContext(input.tenantId,input.actorRole);return repository.createContact(input);},
    createRelationship:async input=>{await writeContext(input.tenantId,input.actorRole);return repository.createRelationship(input);},
    getParty:async input=>{await readContext(input.tenantId,input.actorRole);return repository.getParty(input.tenantId,input.partyId);},
    listParties:async input=>{await readContext(input.tenantId,input.actorRole);return repository.listParties(input.tenantId,input);},
    listContacts:async input=>{await readContext(input.tenantId,input.actorRole);return repository.listContacts(input.tenantId,input);},
    listRelationships:async input=>{await readContext(input.tenantId,input.actorRole);return repository.listRelationships(input.tenantId,input);},
    ensureDefaultPipeline:async input=>{await salesWriteContext(input.tenantId,input.actorRole);return repository.ensureDefaultPipeline(input);},
    createLead:async input=>{await salesWriteContext(input.tenantId,input.actorRole);return repository.createLead(input);},
    convertLead:async input=>{await salesWriteContext(input.tenantId,input.actorRole);return repository.convertLead(input);},
    changeOpportunityStage:async input=>{await salesWriteContext(input.tenantId,input.actorRole);return repository.changeOpportunityStage(input);},
    listPipelines:async input=>{await salesReadContext(input.tenantId,input.actorRole);return repository.listPipelines(input.tenantId,input);},
    listLeads:async input=>{await salesReadContext(input.tenantId,input.actorRole);return repository.listLeads(input.tenantId,input);},
    listOpportunities:async input=>{await salesReadContext(input.tenantId,input.actorRole);return repository.listOpportunities(input.tenantId,input);}
  });
}
