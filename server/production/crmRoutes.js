import {z} from 'zod';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const uuid=z.string().uuid();
const partySchema=z.object({
  partyId:uuid.optional(),displayName:z.string().trim().min(1).max(200),status:z.enum(['active','inactive','merged']).optional()
});
const partyUpdateSchema=z.object({
  displayName:z.string().trim().min(1).max(200).optional(),status:z.enum(['active','inactive','merged']).optional(),
  expectedVersion:z.number().int().min(1)
});
const personSchema=partySchema.extend({
  firstName:z.string().trim().min(1).max(120),middleName:z.string().trim().min(1).max(120).optional().nullable(),
  lastName:z.string().trim().min(1).max(160),preferredName:z.string().trim().min(1).max(160).optional().nullable(),
  birthDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),isDeceased:z.boolean().optional()
});
const organizationSchema=partySchema.extend({
  legalName:z.string().trim().min(1).max(240),domain:z.string().trim().min(1).max(253).optional().nullable(),
  industry:z.string().trim().min(1).max(120).optional().nullable(),employeeCount:z.number().int().min(0).optional().nullable(),
  foundedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
});
const contactSchema=z.object({
  contactId:uuid.optional(),type:z.enum(['email','phone','address','website']),
  value:z.string().trim().min(1).max(500),displayValue:z.string().trim().min(1).max(500).optional(),
  isPrimary:z.boolean().optional(),verifiedAt:z.string().datetime().optional().nullable()
});
const relationshipSchema=z.object({
  relationshipId:uuid.optional(),fromPartyId:uuid,toPartyId:uuid,type:z.enum(['employee','owner','member','parent','partner','other']),
  status:z.enum(['active','ended','merged']).optional(),effectiveFrom:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
});
const stageSchema=z.object({
  stageId:uuid,name:z.string().trim().min(1).max(160),kind:z.enum(['open','won','lost']),
  position:z.number().int().min(1).max(100),probability:z.number().int().min(0).max(100)
});
const defaultPipelineSchema=z.object({
  pipelineId:uuid.optional(),name:z.string().trim().min(1).max(200),stages:z.array(stageSchema).min(3).max(100)
});
const leadSchema=z.object({
  leadId:uuid.optional(),partyId:uuid,pipelineId:uuid,stageId:uuid,source:z.string().trim().min(1).max(120),
  expectedValueCents:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),currency:z.string().trim().length(3),
  probability:z.number().int().min(0).max(100),expectedCloseDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownerIdentityId:uuid.optional().nullable()
});
const convertLeadSchema=z.object({
  opportunityId:uuid.optional(),expectedVersion:z.number().int().min(1),
  name:z.string().trim().min(1).max(200),amountCents:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency:z.string().trim().length(3),probability:z.number().int().min(0).max(100),
  expectedCloseDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
const opportunityStageSchema=z.object({
  stageId:uuid,expectedVersion:z.number().int().min(1)
});
const activitySchema=z.object({
  activityId:uuid.optional(),activityType:z.enum(['call','meeting','email','message','other']),summary:z.string().trim().min(1).max(500),
  outcome:z.string().trim().min(1).max(2000).optional().nullable(),occurredAt:z.string().datetime().optional()
});
const taskSchema=z.object({
  taskId:uuid.optional(),title:z.string().trim().min(1).max(300),details:z.string().trim().min(1).max(4000).optional().nullable(),
  ownerIdentityId:uuid,dueAt:z.string().datetime().optional().nullable(),reminderAt:z.string().datetime().optional().nullable()
});
const taskUpdateSchema=z.object({
  expectedVersion:z.number().int().min(1),title:z.string().trim().min(1).max(300).optional(),details:z.string().trim().min(1).max(4000).optional().nullable(),
  status:z.enum(['open','in_progress','completed','cancelled']).optional(),ownerIdentityId:uuid.optional(),dueAt:z.string().datetime().optional().nullable(),reminderAt:z.string().datetime().optional().nullable()
});
const noteSchema=z.object({noteId:uuid.optional(),title:z.string().trim().min(1).max(300),body:z.string().trim().min(1).max(10000)});
const noteRevisionSchema=z.object({expectedVersion:z.number().int().min(1),body:z.string().trim().min(1).max(10000)});
const attachmentSchema=z.object({linkId:uuid.optional(),objectId:z.string().trim().min(1).max(500),objectRevision:z.number().int().min(1),fileName:z.string().trim().min(1).max(255)});
const ownerSchema=z.object({newOwnerIdentityId:uuid.nullable(),expectedVersion:z.number().int().min(1)});

const parse=(schema,value)=>{
  const result=schema.safeParse(value);
  if(!result.success)persistenceFail(PERSISTENCE_CODES.INVALID,'Request body is invalid.');
  return result.data;
};
const parseQuery=(req)=>{
  const type=req.query.type;
  const limit=Number(req.query.limit??50),offset=Number(req.query.offset??0);
  if(type!==undefined&&!['person','organization'].includes(type))persistenceFail(PERSISTENCE_CODES.INVALID,'Party type is invalid.');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)persistenceFail(PERSISTENCE_CODES.INVALID,'Limit must be between 1 and 100.');
  if(!Number.isSafeInteger(offset)||offset<0)persistenceFail(PERSISTENCE_CODES.INVALID,'Offset must be zero or a positive integer.');
  return {type:type??null,search:typeof req.query.search==='string'?req.query.search.trim()||null:null,limit,offset};
};
const parseSalesQuery=(req,allowedStatuses)=>{
  const status=req.query.status;
  const limit=Number(req.query.limit??50),offset=Number(req.query.offset??0);
  if(status!==undefined&&!allowedStatuses.includes(status))persistenceFail(PERSISTENCE_CODES.INVALID,'Status is invalid.');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)persistenceFail(PERSISTENCE_CODES.INVALID,'Limit must be between 1 and 100.');
  if(!Number.isSafeInteger(offset)||offset<0)persistenceFail(PERSISTENCE_CODES.INVALID,'Offset must be zero or a positive integer.');
  return {status:status??null,limit,offset};
};

export function installCrmRoutes(app,{crmService,requireTenantSession,requireCsrf,requireRecentAuthentication}={}){
  if(!app||typeof app.get!=='function')throw new TypeError('CRM routes require an Express app.');
  if(!crmService||typeof crmService!=='object')throw new TypeError('CRM routes require crmService.');
  for(const [name,value] of [['requireTenantSession',requireTenantSession],['requireCsrf',requireCsrf],['requireRecentAuthentication',requireRecentAuthentication]])if(typeof value!=='function')throw new TypeError(`CRM routes require ${name}.`);
  const readRole=(req,res,next)=>{
    const role=req.productionSession?.membership?.role;
    if(!['owner','admin','staff','viewer'].includes(role))return persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized CRM read role is required.');
    next();
  };
  const writeRole=(req,res,next)=>{
    const role=req.productionSession?.membership?.role;
    if(!['owner','admin','staff'].includes(role))return persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized CRM write role is required.');
    next();
  };
  const write=[requireTenantSession,requireCsrf,requireRecentAuthentication,writeRole];
  const read=[requireTenantSession,readRole];
  const context=req=>({tenantId:req.productionSession.tenantId,actorRole:req.productionSession.membership.role,actorIdentityId:req.productionSession.identityId});

  app.get('/api/crm/parties',...read,async(req,res)=>res.json({parties:await crmService.listParties({...parseQuery(req),...context(req)})}));
  app.get('/api/crm/parties/:partyId',...read,async(req,res)=>res.json({party:await crmService.getParty({partyId:req.params.partyId,...context(req)})}));
  app.post('/api/crm/people',...write,async(req,res)=>res.status(201).json({party:await crmService.createPerson({...parse(personSchema,req.body),...context(req)})}));
  app.post('/api/crm/organizations',...write,async(req,res)=>res.status(201).json({party:await crmService.createOrganization({...parse(organizationSchema,req.body),...context(req)})}));
  app.patch('/api/crm/parties/:partyId',...write,async(req,res)=>res.json({party:await crmService.updateParty({...parse(partyUpdateSchema,req.body),partyId:req.params.partyId,...context(req)})}));
  app.get('/api/crm/parties/:partyId/contacts',...read,async(req,res)=>res.json({contacts:await crmService.listContacts({...parseQuery(req),partyId:req.params.partyId,...context(req)})}));
  app.post('/api/crm/parties/:partyId/contacts',...write,async(req,res)=>res.status(201).json({contact:await crmService.createContact({...parse(contactSchema,req.body),partyId:req.params.partyId,...context(req)})}));
  app.get('/api/crm/relationships',...read,async(req,res)=>res.json({relationships:await crmService.listRelationships({...parseQuery(req),...context(req)})}));
  app.post('/api/crm/relationships',...write,async(req,res)=>res.status(201).json({relationship:await crmService.createRelationship({...parse(relationshipSchema,req.body),...context(req)})}));
  app.get('/api/crm/pipelines',...read,async(req,res)=>res.json({pipelines:await crmService.listPipelines({...parseSalesQuery(req,[]),...context(req)})}));
  app.post('/api/crm/pipelines/default',...write,async(req,res)=>res.status(201).json({pipeline:await crmService.ensureDefaultPipeline({...parse(defaultPipelineSchema,req.body),...context(req)})}));
  app.get('/api/crm/leads',...read,async(req,res)=>res.json({leads:await crmService.listLeads({...parseSalesQuery(req,['new','working','qualified','converted','disqualified']),...context(req)})}));
  app.post('/api/crm/leads',...write,async(req,res)=>res.status(201).json({lead:await crmService.createLead({...parse(leadSchema,req.body),...context(req)})}));
  app.post('/api/crm/leads/:leadId/convert',...write,async(req,res)=>res.status(201).json(await crmService.convertLead({...parse(convertLeadSchema,req.body),leadId:req.params.leadId,...context(req)})));
  app.get('/api/crm/opportunities',...read,async(req,res)=>res.json({opportunities:await crmService.listOpportunities({...parseSalesQuery(req,['open','won','lost']),...context(req)})}));
  app.post('/api/crm/opportunities/:opportunityId/stage',...write,async(req,res)=>res.json({opportunity:await crmService.changeOpportunityStage({...parse(opportunityStageSchema,req.body),opportunityId:req.params.opportunityId,...context(req)})}));
  app.post('/api/crm/subjects/:subjectId/activities',...write,async(req,res)=>res.status(201).json({activity:await crmService.createActivity({...parse(activitySchema,req.body),subjectId:req.params.subjectId,...context(req)})}));
  app.post('/api/crm/subjects/:subjectId/tasks',...write,async(req,res)=>res.status(201).json({task:await crmService.createTask({...parse(taskSchema,req.body),subjectId:req.params.subjectId,...context(req)})}));
  app.patch('/api/crm/tasks/:taskId',...write,async(req,res)=>res.json({task:await crmService.updateTask({...parse(taskUpdateSchema,req.body),taskId:req.params.taskId,...context(req)})}));
  app.post('/api/crm/subjects/:subjectId/notes',...write,async(req,res)=>res.status(201).json({note:await crmService.createNote({...parse(noteSchema,req.body),subjectId:req.params.subjectId,...context(req)})}));
  app.post('/api/crm/notes/:noteId/revisions',...write,async(req,res)=>res.status(201).json({note:await crmService.reviseNote({...parse(noteRevisionSchema,req.body),noteId:req.params.noteId,...context(req)})}));
  app.post('/api/crm/subjects/:subjectId/attachments',...write,async(req,res)=>res.status(201).json({attachment:await crmService.linkAttachment({...parse(attachmentSchema,req.body),subjectId:req.params.subjectId,...context(req)})}));
  app.patch('/api/crm/subjects/:subjectId/owner',...write,async(req,res)=>res.json({subject:await crmService.changeSubjectOwner({...parse(ownerSchema,req.body),subjectId:req.params.subjectId,...context(req)})}));
  app.get('/api/crm/subjects/:subjectId/timeline',...read,async(req,res)=>{
    const limit=Number(req.query.limit??50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)persistenceFail(PERSISTENCE_CODES.INVALID,'Limit must be between 1 and 100.');
    res.json(await crmService.listTimeline({subjectId:req.params.subjectId,limit,cursor:typeof req.query.cursor==='string'?req.query.cursor:null,...context(req)}));
  });
  return crmService;
}
