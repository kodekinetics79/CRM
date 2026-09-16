// Constituent categories describe one CRM identity, not workspace login roles,
// contact consent, additional donors, revenue classifications or permissions.
export const CONSTITUENT_TYPES=Object.freeze(['Individual','Business','Foundation','Alumni','Employee','Staff','Community partner']);
export const PERSON_TYPES=Object.freeze(['Individual','Alumni','Employee','Staff']);
const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
export function normalizeAdditionalTypes(primary,extras=[],{status=400}={}){
 if(!CONSTITUENT_TYPES.includes(primary))fail(status,'Constituent primary type is unavailable. Reconcile the identity categories.');
 if(!Array.isArray(extras)||extras.length>CONSTITUENT_TYPES.length-1||extras.some(type=>!CONSTITUENT_TYPES.includes(type)))fail(status,'Additional constituent types must use known categories.');
 if(new Set(extras).size!==extras.length||extras.includes(primary))fail(status,'Choose each constituent category once; additional types cannot repeat the primary type.');
 const personal=PERSON_TYPES.includes(primary);
 if(extras.some(type=>PERSON_TYPES.includes(type)!==personal))fail(status,'A person and an organization cannot share one constituent identity. Choose additional types from the same physical family.');
 return CONSTITUENT_TYPES.filter(type=>extras.includes(type));
}
export function getConstituentTypes(record){
 if(!record||typeof record!=='object'||Array.isArray(record))fail(503,'Stored constituent identity categories are unavailable.');
 return [record.type,...normalizeAdditionalTypes(record.type,record.additionalTypes,{status:503})];
}
export const hasConstituentType=(record,type)=>getConstituentTypes(record).includes(type);
export function isPersonConstituent(record){getConstituentTypes(record);return PERSON_TYPES.includes(record.type);}
