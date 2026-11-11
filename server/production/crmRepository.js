import {randomUUID} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTY_TYPES=new Set(['person','organization']);
const PARTY_STATUSES=new Set(['active','inactive','merged']);
const CONTACT_TYPES=new Set(['email','phone','address','website']);
const CONTACT_STATUSES=new Set(['active','invalid','retired']);
const RELATIONSHIP_TYPES=new Set(['employee','owner','member','parent','partner','other']);
const RELATIONSHIP_STATUSES=new Set(['active','ended','merged']);

const fail=(message)=>persistenceFail(PERSISTENCE_CODES.INVALID,message);
const uuid=(value,label)=>{
  if(typeof value!=='string'||!UUID.test(value))fail(`${label} must be a UUID.`);
  return value.toLowerCase();
};
const optionalUuid=(value,label)=>value===undefined||value===null?null:uuid(value,label);
const text=(value,label,max)=>{
  const out=typeof value==='string'?value.trim():'';
  if(!out||out.length>max)fail(`${label} must contain between 1 and ${max} characters.`);
  return out;
};
const optionalText=(value,label,max)=>{
  const out=value===undefined||value===null?null:typeof value==='string'?value.trim():'';
  if(out!==null&&(out===''||out.length>max))fail(`${label} must be empty or contain at most ${max} characters.`);
  return out;
};
const oneOf=(value,allowed,label)=>{if(!allowed.has(value))fail(`${label} is invalid.`);return value;};
const date=(value,label)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value)))fail(`${label} must be an ISO calendar date.`);
  return value;
};
const optionalDate=(value,label)=>value===undefined||value===null?null:date(value,label);
const version=(value)=>{if(!Number.isSafeInteger(value)||value<1)fail('Expected version must be a positive integer.');return value;};
const count=(value,label,max)=>{if(!Number.isSafeInteger(value)||value<1||value>max)fail(`${label} must be between 1 and ${max}.`);return value;};
const safeOffset=(value)=>{if(!Number.isSafeInteger(value)||value<0)fail('Offset must be zero or a positive integer.');return value;};
const timestamp=()=>new Date().toISOString();

const normalizeContact=(type,value)=>{
  const raw=text(value,'Contact value',500);
  if(type==='email')return raw.toLowerCase();
  if(type==='phone')return raw.replace(/[^\d+]/g,'').toLowerCase();
  if(type==='website')return raw.replace(/^https?:\/\//i,'').replace(/\/$/,'').toLowerCase();
  return raw.replace(/\s+/g,' ').toLowerCase();
};

const mapPerson=row=>row?{
  firstName:row.first_name,
  middleName:row.middle_name??null,
  lastName:row.last_name,
  preferredName:row.preferred_name??null,
  birthDate:row.birth_date??null,
  isDeceased:row.is_deceased===true
}:null;
const mapOrganization=row=>row?{
  legalName:row.legal_name,
  domain:row.domain??null,
  industry:row.industry??null,
  employeeCount:row.employee_count===null?null:Number(row.employee_count),
  foundedOn:row.founded_on??null
}:null;
const mapParty=(row,subtype)=>{
  if(!row)return null;
  const mapped={
    tenantId:row.tenant_id,
    partyId:row.party_id,
    partyType:row.party_type,
    displayName:row.display_name,
    status:row.status,
    version:Number(row.version),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
  if(row.party_type==='person')mapped.person=mapPerson(subtype??row);
  else if(row.party_type==='organization')mapped.organization=mapOrganization(subtype??row);
  else persistenceFail(PERSISTENCE_CODES.INVALID,'Party type is invalid.');
  return mapped;
};
const mapContact=row=>row?{
  tenantId:row.tenant_id,
  contactId:row.contact_id,
  partyId:row.party_id,
  type:row.type,
  normalizedValue:row.normalized_value,
  displayValue:row.display_value,
  status:row.status,
  isPrimary:row.is_primary===true,
  verifiedAt:row.verified_at??null,
  version:Number(row.version),
  createdAt:row.created_at,
  updatedAt:row.updated_at
}:null;
const mapRelationship=row=>row?{
  tenantId:row.tenant_id,
  relationshipId:row.relationship_id,
  fromPartyId:row.from_party_id,
  toPartyId:row.to_party_id,
  type:row.type,
  status:row.status,
  effectiveFrom:row.effective_from,
  effectiveTo:row.effective_to??null,
  version:Number(row.version),
  createdAt:row.created_at,
  updatedAt:row.updated_at
}:null;

export function createCrmRepository({tenantPool,clock=timestamp}={}){
  if(!tenantPool||typeof tenantPool.withTenantSession!=='function'||typeof tenantPool.withTransaction!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A tenant PostgreSQL pool is required.');
  if(typeof clock!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A clock function is required.');
  const now=()=>new Date(clock()).toISOString();

  async function appendEvent(session,{tenantId,eventId=randomUUID(),targetType,targetId,action,actorIdentityId=null,details={}}){
    await session.query(
      `/*party-event:insert*/ INSERT INTO party_events(tenant_id,event_id,target_type,target_id,action,actor_identity_id,details,at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)`,
      [tenantId,eventId,targetType,targetId,action,actorIdentityId,JSON.stringify(details),now()]
    );
  }

  async function createPerson(input){
    const tenant=uuid(input.tenantId,'Tenant ID'),partyId=uuid(input.partyId??randomUUID(),'Party ID');
    const displayName=text(input.displayName,'Display name',200),firstName=text(input.firstName,'First name',120),lastName=text(input.lastName,'Last name',160);
    return tenantPool.withTransaction(tenant,async session=>{
      const {rows:[party]}=await session.query(
        `/*party:insert*/ INSERT INTO parties(tenant_id,party_id,party_type,display_name,created_at,updated_at)
         VALUES($1,$2,'person',$3,$4::timestamptz,$4::timestamptz)
         RETURNING tenant_id,party_id,party_type,display_name,status,version,created_at,updated_at`,
        [tenant,partyId,displayName,now()]
      );
      const {rows:[person]}=await session.query(
        `/*person:insert*/ INSERT INTO people(tenant_id,party_id,first_name,middle_name,last_name,preferred_name,birth_date,is_deceased)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING tenant_id,party_id,first_name,middle_name,last_name,preferred_name,birth_date,is_deceased`,
        [tenant,partyId,firstName,optionalText(input.middleName,'Middle name',120),lastName,optionalText(input.preferredName,'Preferred name',160),optionalDate(input.birthDate,'Birth date'),input.isDeceased===true]
      );
      await appendEvent(session,{tenantId:tenant,targetType:'party',targetId:partyId,action:'party.created',actorIdentityId:optionalUuid(input.actorIdentityId,'Actor identity ID'),details:{partyType:'person',displayName}});
      return {...mapParty(party),person:mapPerson(person)};
    });
  }

  async function createOrganization(input){
    const tenant=uuid(input.tenantId,'Tenant ID'),partyId=uuid(input.partyId??randomUUID(),'Party ID');
    const displayName=text(input.displayName,'Display name',200),legalName=text(input.legalName,'Legal name',240);
    const domain=optionalText(input.domain,'Domain',253),industry=optionalText(input.industry,'Industry',120);
    if(input.employeeCount!==undefined&&input.employeeCount!==null&&(!Number.isSafeInteger(input.employeeCount)||input.employeeCount<0))fail('Employee count must be a non-negative integer.');
    return tenantPool.withTransaction(tenant,async session=>{
      const {rows:[party]}=await session.query(
        `/*party:insert*/ INSERT INTO parties(tenant_id,party_id,party_type,display_name,created_at,updated_at)
         VALUES($1,$2,'organization',$3,$4::timestamptz,$4::timestamptz)
         RETURNING tenant_id,party_id,party_type,display_name,status,version,created_at,updated_at`,
        [tenant,partyId,displayName,now()]
      );
      const {rows:[organization]}=await session.query(
        `/*organization:insert*/ INSERT INTO organizations(tenant_id,party_id,legal_name,domain,industry,employee_count,founded_on)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING tenant_id,party_id,legal_name,domain,industry,employee_count,founded_on`,
        [tenant,partyId,legalName,domain,industry,input.employeeCount??null,optionalDate(input.foundedOn,'Founded on')]
      );
      await appendEvent(session,{tenantId:tenant,targetType:'party',targetId:partyId,action:'party.created',actorIdentityId:optionalUuid(input.actorIdentityId,'Actor identity ID'),details:{partyType:'organization',displayName}});
      return {...mapParty(party),organization:mapOrganization(organization)};
    });
  }

  async function getParty(tenantId,partyId){
    const tenant=uuid(tenantId,'Tenant ID'),id=uuid(partyId,'Party ID');
    const {rows:[row]}=await tenantPool.withTenantSession(tenant,session=>session.query(
      `/*party:get*/ SELECT p.*,pe.first_name,pe.middle_name,pe.last_name,pe.preferred_name,pe.birth_date,pe.is_deceased,
         o.legal_name,o.domain,o.industry,o.employee_count,o.founded_on
       FROM parties p
       LEFT JOIN people pe ON pe.tenant_id=p.tenant_id AND pe.party_id=p.party_id
       LEFT JOIN organizations o ON o.tenant_id=p.tenant_id AND o.party_id=p.party_id
       WHERE p.tenant_id=$1 AND p.party_id=$2`,
      [tenant,id]
    ));
    if(!row)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Party was not found.');
    return mapParty(row);
  }

  async function listParties(tenantId,{type=null,search=null,limit=50,offset=0}={}){
    const tenant=uuid(tenantId,'Tenant ID'),take=count(limit,'Limit',100),skip=safeOffset(offset);
    if(type!==null)oneOf(type,PARTY_TYPES,'Party type');
    if(search!==null&&search!==undefined)text(search,'Search',100);
    const values=[tenant,type,search,take,skip];
    const {rows}=await tenantPool.withTenantSession(tenant,session=>session.query(
      `/*party:list*/ SELECT p.*,pe.first_name,pe.middle_name,pe.last_name,pe.preferred_name,pe.birth_date,pe.is_deceased,
         o.legal_name,o.domain,o.industry,o.employee_count,o.founded_on
       FROM parties p
       LEFT JOIN people pe ON pe.tenant_id=p.tenant_id AND pe.party_id=p.party_id
       LEFT JOIN organizations o ON o.tenant_id=p.tenant_id AND o.party_id=p.party_id
       WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.party_type=$2) AND ($3::text IS NULL OR p.display_name ILIKE '%' || $3 || '%')
       ORDER BY p.display_name,p.party_id
       LIMIT $4 OFFSET $5`,
      values
    ));
    return rows.map(row=>mapParty(row));
  }

  async function updateParty(input){
    const tenant=uuid(input.tenantId,'Tenant ID'),partyId=uuid(input.partyId,'Party ID'),expected=version(input.expectedVersion);
    if(input.displayName===undefined&&input.status===undefined)fail('Party update requires display name or status.');
    const displayName=input.displayName===undefined?null:text(input.displayName,'Display name',200);
    const status=input.status===undefined?null:oneOf(input.status,PARTY_STATUSES,'Party status');
    return tenantPool.withTransaction(tenant,async session=>{
      const {rows:[row]}=await session.query(
        `/*party:update*/ UPDATE parties SET display_name=COALESCE($3,display_name),status=COALESCE($4,status),version=version+1,updated_at=$5::timestamptz
         WHERE tenant_id=$1 AND party_id=$2 AND version=$6
         RETURNING tenant_id,party_id,party_type,display_name,status,version,created_at,updated_at`,
        [tenant,partyId,displayName,status,now(),expected]
      );
      if(!row)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Party version conflict. Reload before retrying.');
      await appendEvent(session,{tenantId:tenant,targetType:'party',targetId:partyId,action:'party.updated',actorIdentityId:optionalUuid(input.actorIdentityId,'Actor identity ID'),details:{displayName,status}});
      return mapParty(row);
    });
  }

  async function createContact(input){
    const tenant=uuid(input.tenantId,'Tenant ID'),contactId=uuid(input.contactId??randomUUID(),'Contact ID'),partyId=uuid(input.partyId,'Party ID');
    const type=oneOf(input.type,CONTACT_TYPES,'Contact type'),normalized=normalizeContact(type,input.value),display=input.displayValue===undefined?text(input.value,'Contact value',500):text(input.displayValue,'Display value',500);
    return tenantPool.withTransaction(tenant,async session=>{
      const {rows:[row]}=await session.query(
        `/*contact:insert*/ INSERT INTO contact_points(tenant_id,contact_id,party_id,type,normalized_value,display_value,is_primary,verified_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$9::timestamptz)
         RETURNING tenant_id,contact_id,party_id,type,normalized_value,display_value,status,is_primary,verified_at,version,created_at,updated_at`,
        [tenant,contactId,partyId,type,normalized,display,input.isPrimary===true,input.verifiedAt===undefined||input.verifiedAt===null?null:new Date(input.verifiedAt).toISOString(),now()]
      );
      await appendEvent(session,{tenantId:tenant,targetType:'contact',targetId:contactId,action:'contact.created',actorIdentityId:optionalUuid(input.actorIdentityId,'Actor identity ID'),details:{type,normalizedValue:normalized}});
      return mapContact(row);
    });
  }

  async function listContacts(tenantId,{partyId=null,limit=50,offset=0}={}){
    const tenant=uuid(tenantId,'Tenant ID'),take=count(limit,'Limit',100),skip=safeOffset(offset),party=partyId===null?null:uuid(partyId,'Party ID');
    const {rows}=await tenantPool.withTenantSession(tenant,session=>session.query(
      `/*contact:list*/ SELECT tenant_id,contact_id,party_id,type,normalized_value,display_value,status,is_primary,verified_at,version,created_at,updated_at
       FROM contact_points WHERE tenant_id=$1 AND ($2::uuid IS NULL OR party_id=$2)
       ORDER BY is_primary DESC,type,contact_id LIMIT $3 OFFSET $4`,
      [tenant,party,take,skip]
    ));
    return rows.map(mapContact);
  }

  async function createRelationship(input){
    const tenant=uuid(input.tenantId,'Tenant ID'),relationshipId=uuid(input.relationshipId??randomUUID(),'Relationship ID');
    const fromPartyId=uuid(input.fromPartyId,'From party ID'),toPartyId=uuid(input.toPartyId,'To party ID');
    if(fromPartyId===toPartyId)persistenceFail(PERSISTENCE_CODES.INVALID,'A relationship cannot link the same party.');
    const type=oneOf(input.type,RELATIONSHIP_TYPES,'Relationship type'),effectiveFrom=date(input.effectiveFrom,'Effective from');
    const status=input.status===undefined?'active':oneOf(input.status,RELATIONSHIP_STATUSES,'Relationship status'),effectiveTo=optionalDate(input.effectiveTo,'Effective to');
    return tenantPool.withTransaction(tenant,async session=>{
      const {rows:[row]}=await session.query(
        `/*relationship:insert*/ INSERT INTO relationships(tenant_id,relationship_id,from_party_id,to_party_id,type,status,effective_from,effective_to,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$9::timestamptz)
         RETURNING tenant_id,relationship_id,from_party_id,to_party_id,type,status,effective_from,effective_to,version,created_at,updated_at`,
        [tenant,relationshipId,fromPartyId,toPartyId,type,status,effectiveFrom,effectiveTo,now()]
      );
      await appendEvent(session,{tenantId:tenant,targetType:'relationship',targetId:relationshipId,action:'relationship.created',actorIdentityId:optionalUuid(input.actorIdentityId,'Actor identity ID'),details:{type,fromPartyId,toPartyId}});
      return mapRelationship(row);
    });
  }

  async function listRelationships(tenantId,{partyId=null,direction='both',limit=50,offset=0}={}){
    const tenant=uuid(tenantId,'Tenant ID'),take=count(limit,'Limit',100),skip=safeOffset(offset),party=partyId===null?null:uuid(partyId,'Party ID');
    if(!['both','from','to'].includes(direction))fail('Relationship direction is invalid.');
    const {rows}=await tenantPool.withTenantSession(tenant,session=>session.query(
      `/*relationship:list*/ SELECT tenant_id,relationship_id,from_party_id,to_party_id,type,status,effective_from,effective_to,version,created_at,updated_at
       FROM relationships WHERE tenant_id=$1 AND ($2::uuid IS NULL OR from_party_id=$2 OR to_party_id=$2)
       ORDER BY effective_from DESC,relationship_id LIMIT $3 OFFSET $4`,
      [tenant,party,take,skip]
    ));
    return rows.map(mapRelationship);
  }

  return Object.freeze({createPerson,createOrganization,getParty,listParties,updateParty,createContact,listContacts,createRelationship,listRelationships});
}
