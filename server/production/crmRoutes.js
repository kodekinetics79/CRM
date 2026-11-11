import {z} from 'zod';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const uuid=z.string().uuid();
const partySchema=z.object({
  partyId:uuid.optional(),displayName:z.string().trim().min(1).max(200),status:z.enum(['active','inactive','merged']).optional()
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
  contactId:uuid.optional(),partyId:uuid,type:z.enum(['email','phone','address','website']),
  value:z.string().trim().min(1).max(500),displayValue:z.string().trim().min(1).max(500).optional(),
  isPrimary:z.boolean().optional(),verifiedAt:z.string().datetime().optional().nullable()
});
const relationshipSchema=z.object({
  relationshipId:uuid.optional(),fromPartyId:uuid,toPartyId:uuid,type:z.enum(['employee','owner','member','parent','partner','other']),
  status:z.enum(['active','ended','merged']).optional(),effectiveFrom:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
});

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
  app.patch('/api/crm/parties/:partyId',...write,async(req,res)=>res.json({party:await crmService.updateParty({...parse(partySchema,req.body),partyId:req.params.partyId,...context(req)})}));
  app.get('/api/crm/parties/:partyId/contacts',...read,async(req,res)=>res.json({contacts:await crmService.listContacts({...parseQuery(req),partyId:req.params.partyId,...context(req)})}));
  app.post('/api/crm/parties/:partyId/contacts',...write,async(req,res)=>res.status(201).json({contact:await crmService.createContact({...parse(contactSchema,req.body),partyId:req.params.partyId,...context(req)})}));
  app.get('/api/crm/relationships',...read,async(req,res)=>res.json({relationships:await crmService.listRelationships({...parseQuery(req),...context(req)})}));
  app.post('/api/crm/relationships',...write,async(req,res)=>res.status(201).json({relationship:await crmService.createRelationship({...parse(relationshipSchema,req.body),...context(req)})}));
  return crmService;
}
