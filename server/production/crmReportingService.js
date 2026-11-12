import {randomUUID} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const READ_ROLES=new Set(['owner','admin','staff','viewer']);
const WRITE_ROLES=new Set(['owner','admin','staff']);
const SALES_DATASETS=new Set(['leads','opportunities']);
const DATASETS=Object.freeze({
 parties:{table:'parties',id:'party_id',date:'created_at',fields:{displayName:'display_name',status:'status',createdAt:'created_at'}},
 leads:{table:'leads',id:'lead_id',date:'created_at',fields:{source:'source',status:'status',expectedValueCents:'expected_value_cents',currency:'currency',probability:'probability',expectedCloseDate:'expected_close_date',createdAt:'created_at'}},
 opportunities:{table:'opportunities',id:'opportunity_id',date:'created_at',fields:{name:'name',status:'status',amountCents:'amount_cents',currency:'currency',probability:'probability',expectedCloseDate:'expected_close_date',createdAt:'created_at'}},
 tasks:{table:'crm_tasks',id:'task_id',date:'created_at',fields:{title:'title',status:'status',dueAt:'due_at',completedAt:'completed_at',createdAt:'created_at'}},
 activities:{table:'crm_activities',id:'activity_id',date:'occurred_at',fields:{activityType:'activity_type',summary:'summary',occurredAt:'occurred_at',createdAt:'created_at'}}
});
const OPERATORS=new Set(['eq','neq','contains','gte','lte']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>persistenceFail(PERSISTENCE_CODES.INVALID,message);
const exactKeys=(object,allowed)=>{for(const key of Object.keys(object))if(!allowed.has(key))fail('Report definition contains an unknown key.');};
const isoDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export function validateReportDefinition(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Report definition is required.');
 exactKeys(input,new Set(['dataset','columns','filters','sort','dateRange']));
 const spec=DATASETS[input.dataset];if(!spec)fail('Report dataset is invalid.');
 if(!Array.isArray(input.columns)||input.columns.length<1||input.columns.length>20||new Set(input.columns).size!==input.columns.length)fail('Report columns are invalid.');
 for(const field of input.columns)if(!Object.hasOwn(spec.fields,field))fail('Report field is invalid.');
 const filters=input.filters??[];if(!Array.isArray(filters)||filters.length>10)fail('Report filter limit was exceeded.');
 const normalizedFilters=filters.map(filter=>{
  if(!filter||typeof filter!=='object'||Array.isArray(filter))fail('Report filter is invalid.');
  exactKeys(filter,new Set(['field','operator','value']));
  if(!Object.hasOwn(spec.fields,filter.field)||!OPERATORS.has(filter.operator)||!['string','number','boolean'].includes(typeof filter.value))fail('Report filter is invalid.');
  if(filter.operator==='contains'&&typeof filter.value!=='string')fail('Report filter is invalid.');
  if(typeof filter.value==='string'&&filter.value.length>500)fail('Report filter is too long.');
  return {field:filter.field,operator:filter.operator,value:filter.value};
 });
 let sort=null;if(input.sort!==undefined){if(!input.sort||typeof input.sort!=='object'||Array.isArray(input.sort))fail('Report sort is invalid.');exactKeys(input.sort,new Set(['field','direction']));if(!Object.hasOwn(spec.fields,input.sort.field)||!['asc','desc'].includes(input.sort.direction))fail('Report sort is invalid.');sort={field:input.sort.field,direction:input.sort.direction};}
 let dateRange=null;if(input.dateRange!==undefined){const range=input.dateRange;if(!range||typeof range!=='object'||Array.isArray(range))fail('Report date range is invalid.');exactKeys(range,new Set(['from','to']));if(!isoDate(range.from)||!isoDate(range.to))fail('Report date range is invalid.');const from=Date.parse(`${range.from}T00:00:00Z`),to=Date.parse(`${range.to}T00:00:00Z`);if(to<from||(to-from)/86400000>366)fail('Report date range exceeds 366 days.');dateRange={from:range.from,to:range.to};}
 return {dataset:input.dataset,columns:[...input.columns],filters:normalizedFilters,...(sort?{sort}:{}),...(dateRange?{dateRange}:{})};
}

function compile(definition,{limit=1001}={}){
 const def=validateReportDefinition(definition),spec=DATASETS[def.dataset],values=[],where=[];
 values.push(null);where.push('tenant_id=$1');
 for(const filter of def.filters){const column=spec.fields[filter.field],index=values.push(filter.value);const expression=filter.operator==='eq'?`${column}=$${index}`:filter.operator==='neq'?`${column}<>$${index}`:filter.operator==='contains'?`${column} ILIKE '%' || $${index} || '%'`:filter.operator==='gte'?`${column}>=$${index}`:`${column}<=$${index}`;where.push(expression);}
 if(def.dateRange){const from=values.push(def.dateRange.from),to=values.push(def.dateRange.to);where.push(`${spec.date}>=$${from}::date AND ${spec.date}<($${to}::date + INTERVAL '1 day')`);}
 const selected=[`${spec.id} AS _id`,...def.columns.map(field=>`${spec.fields[field]} AS ${spec.fields[field]}`)];
 const order=def.sort?`${spec.fields[def.sort.field]} ${def.sort.direction.toUpperCase()}, ${spec.id}`:`${spec.id}`;
 const bound=values.push(limit);
 return {definition:def,sql:`SELECT ${selected.join(',')} FROM ${spec.table} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${bound}`,values};
}

const mapRow=(dataset,row)=>{const out={};for(const [field,column] of Object.entries(DATASETS[dataset].fields))if(Object.hasOwn(row,column)){const value=row[column];out[field]=['expectedValueCents','amountCents','probability'].includes(field)&&value!==null?Number(value):value;}return out;};
const authorize=async(moduleService,{tenantId,actorRole,dataset,action})=>{const roles=action==='read'?READ_ROLES:WRITE_ROLES;if(!roles.has(actorRole))persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized reporting role is required.');for(const code of ['core',...(SALES_DATASETS.has(dataset)?['sales']:[])]){const result=await moduleService.authorize({tenantId,code,action});if(!result?.allowed)persistenceFail(PERSISTENCE_CODES.ISOLATION,'Reporting capability is unavailable.');}};

export const formulaSafeText=value=>{const text=String(value??'');return /^[\s]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text)?`'${text}`:text;};
const quote=value=>{const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;};
export function csvFromRows(rows,columns,{maxRows=10000,maxBytes=10*1024*1024}={}){
 if(!Array.isArray(rows)||rows.length>maxRows)fail('CSV export row limit was exceeded.');
 const lines=[columns.map(quote).join(',')];
 for(const row of rows)lines.push(columns.map(column=>quote(typeof row[column]==='number'?row[column]:formulaSafeText(row[column]))).join(','));
 const csv=`${lines.join('\r\n')}\r\n`;if(Buffer.byteLength(csv,'utf8')>maxBytes)fail('CSV export byte limit was exceeded.');return {csv,rowCount:rows.length};
}

export function createCrmReportingService({tenantPool,moduleService,clock=()=>new Date()}={}){
 if(!tenantPool||typeof tenantPool.withTenantSession!=='function'||!moduleService||typeof moduleService.authorize!=='function')fail('Reporting dependencies are required.');
 async function executeReport(input){const definition=validateReportDefinition(input.definition);await authorize(moduleService,{...input,dataset:definition.dataset,action:'read'});const compiled=compile(definition);compiled.values[0]=input.tenantId;const {rows}=await tenantPool.withTenantSession(input.tenantId,session=>session.query(compiled.sql,compiled.values));const truncated=rows.length>1000;return {dataset:definition.dataset,rows:rows.slice(0,1000).map(row=>mapRow(definition.dataset,row)),truncated};}
 async function saveReport(input){const definition=validateReportDefinition(input.definition);await authorize(moduleService,{...input,dataset:definition.dataset,action:'write'});const reportId=input.reportId??randomUUID(),name=String(input.name??'').trim();if(!name||name.length>200)fail('Report name is invalid.');const now=new Date(clock()).toISOString();const {rows:[row]}=await tenantPool.withTenantSession(input.tenantId,session=>session.query(`/*report:insert*/ INSERT INTO crm_saved_reports(tenant_id,report_id,name,kind,dataset,definition,owner_identity_id,created_at,updated_at) VALUES($1,$2,$3,'report',$4,$5::jsonb,$6,$7,$7) RETURNING tenant_id,report_id,name,dataset,definition,state,version,created_at,updated_at`,[input.tenantId,reportId,name,definition.dataset,JSON.stringify(definition),input.actorIdentityId,now]));return row;}
 async function updateReport(input){const definition=validateReportDefinition(input.definition);await authorize(moduleService,{...input,dataset:definition.dataset,action:'write'});if(!UUID.test(input.reportId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('Report update identity is invalid.');const name=String(input.name??'').trim();if(!name||name.length>200)fail('Report name is invalid.');const now=new Date(clock()).toISOString();const {rows:[row]}=await tenantPool.withTenantSession(input.tenantId,session=>session.query(`/*report:update*/ UPDATE crm_saved_reports SET name=$3,dataset=$4,definition=$5::jsonb,version=version+1,updated_at=$6 WHERE tenant_id=$1 AND report_id=$2 AND version=$7 AND state='active' RETURNING tenant_id,report_id,name,dataset,definition,state,version,created_at,updated_at`,[input.tenantId,input.reportId,name,definition.dataset,JSON.stringify(definition),now,input.expectedVersion]));if(!row)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Saved report version conflict.');return row;}
 async function dashboard(input){const dataset=input.dataset??'opportunities',spec=DATASETS[dataset];if(!spec)fail('Dashboard dataset is invalid.');validateReportDefinition({dataset,columns:[Object.keys(spec.fields)[0]],dateRange:{from:input.from,to:input.to}});await authorize(moduleService,{...input,dataset,action:'read'});const {rows:[row]}=await tenantPool.withTenantSession(input.tenantId,session=>session.query(`SELECT COUNT(*)::int AS total FROM ${spec.table} WHERE tenant_id=$1 AND ${spec.date}>=$2::date AND ${spec.date}<($3::date + INTERVAL '1 day')`,[input.tenantId,input.from,input.to]));return {dataset,total:Number(row?.total??0)};}
 async function exportReport(input){if(!WRITE_ROLES.has(input.actorRole))persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized export role is required.');const definition=validateReportDefinition(input.definition);await authorize(moduleService,{...input,dataset:definition.dataset,action:'export'});const compiled=compile(definition,{limit:10001});compiled.values[0]=input.tenantId;const {rows}=await tenantPool.withTenantSession(input.tenantId,session=>session.query(compiled.sql,compiled.values));if(rows.length>10000)fail('CSV export row limit was exceeded.');return {...csvFromRows(rows.map(row=>mapRow(definition.dataset,row)),definition.columns),filename:`wimblo-${definition.dataset}.csv`};}
 return Object.freeze({executeReport,saveReport,updateReport,dashboard,exportReport});
}
