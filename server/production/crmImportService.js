import {createHash,randomUUID} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

export const IMPORT_LIMITS=Object.freeze({maxBytes:1024*1024,maxRows:5000,maxColumns:64,maxCellBytes:4096});
const REQUIRED=['external_key','display_name','first_name','last_name'];
const WRITE_ROLES=new Set(['owner','admin','staff']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>persistenceFail(PERSISTENCE_CODES.INVALID,message);
const digest=value=>createHash('sha256').update(value).digest('hex');
const MAPPING=Object.freeze({externalKey:'external_key',displayName:'display_name',firstName:'first_name',lastName:'last_name'});
const mappingDigest=digest(JSON.stringify(MAPPING));
const FIELD_LIMITS=Object.freeze({external_key:300,display_name:200,first_name:120,last_name:160});

function parseCells(source){
 const rows=[];let row=[],cell='',quoted=false,afterQuote=false;
 for(let index=0;index<source.length;index++){
  const char=source[index];
  if(char==='\0')fail('CSV contains a NUL byte.');
  if(quoted){
   if(char==='"'){
    if(source[index+1]==='"'){cell+='"';index++;}
    else {quoted=false;afterQuote=true;}
   }else cell+=char;
   continue;
  }
  if(afterQuote&&char!==','&&char!=='\n'&&char!=='\r')fail('CSV quote is malformed.');
  if(char==='"'){if(cell.length||afterQuote)fail('CSV quote is malformed.');quoted=true;continue;}
  if(char===','){row.push(cell);cell='';afterQuote=false;continue;}
  if(char==='\n'||char==='\r'){
   if(char==='\r'&&source[index+1]==='\n')index++;
   row.push(cell);cell='';afterQuote=false;
   if(row.some(value=>value!==''))rows.push(row);
   row=[];
   continue;
  }
  cell+=char;
 }
 if(quoted)fail('CSV quote is malformed.');
 if(cell||row.length){row.push(cell);if(row.some(value=>value!==''))rows.push(row);}
 return rows;
}

export function parsePeopleCsv(csv){
 if(typeof csv!=='string')fail('CSV text is required.');
 if(csv.includes('\uFFFD'))fail('CSV encoding is invalid.');
 const bytes=Buffer.byteLength(csv,'utf8');
 if(bytes<1||bytes>IMPORT_LIMITS.maxBytes)fail('CSV byte limit was exceeded.');
 const matrix=parseCells(csv);
 if(!matrix.length)fail('CSV header is required.');
 const headers=matrix[0].map(value=>value.trim());
 if(headers.length>IMPORT_LIMITS.maxColumns||headers.some(value=>!value)||new Set(headers).size!==headers.length)fail('CSV headers are invalid.');
 for(const name of REQUIRED)if(!headers.includes(name))fail('CSV required header is missing.');
 if(matrix.length-1>IMPORT_LIMITS.maxRows)fail('CSV row limit was exceeded.');
 const rows=[];const errors=[];const externalKeys=new Set();
 for(let i=1;i<matrix.length;i++){
  const values=matrix[i];
  if(values.some(value=>Buffer.byteLength(value,'utf8')>IMPORT_LIMITS.maxCellBytes))fail('CSV cell limit was exceeded.');
  if(values.length!==headers.length){errors.push({rowNumber:i+1,field:'row',code:'COLUMN_COUNT'});continue;}
  const raw=Object.fromEntries(headers.map((name,index)=>[name,values[index].trim()]));
  const missing=REQUIRED.find(name=>!raw[name]);
  if(missing){errors.push({rowNumber:i+1,field:missing,code:'REQUIRED'});continue;}
  const tooLong=REQUIRED.find(name=>Array.from(raw[name]).length>FIELD_LIMITS[name]);
  if(tooLong){errors.push({rowNumber:i+1,field:tooLong,code:'MAX_LENGTH'});continue;}
  if(externalKeys.has(raw.external_key)){errors.push({rowNumber:i+1,field:'external_key',code:'DUPLICATE_EXTERNAL_KEY'});continue;}
  externalKeys.add(raw.external_key);
  rows.push({rowNumber:i+1,externalKey:raw.external_key,displayName:raw.display_name,firstName:raw.first_name,lastName:raw.last_name,rowHash:digest(JSON.stringify(raw))});
 }
 return {rows,errors:errors.slice(0,100),rowCount:matrix.length-1,validCount:rows.length,invalidCount:errors.length,byteCount:bytes,sourceSha256:digest(Buffer.from(csv,'utf8')),mappingSha256:mappingDigest};
}

async function authorize(moduleService,input){
 if(!WRITE_ROLES.has(input.actorRole))persistenceFail(PERSISTENCE_CODES.ISOLATION,'An authorized import role is required.');
 const result=await moduleService.authorize({tenantId:input.tenantId,code:'core',action:'write'});
 if(!result?.allowed)persistenceFail(PERSISTENCE_CODES.ISOLATION,'Import capability is unavailable.');
}

const mapBatch=row=>({
 batchId:row.batch_id,idempotencyKey:row.idempotency_key,sourceSystem:row.source_system,status:row.status,
 sourceSha256:row.source_sha256,mappingSha256:row.mapping_sha256,rowCount:Number(row.row_count),
 validCount:Number(row.valid_count),invalidCount:Number(row.invalid_count),insertedCount:Number(row.inserted_count),
 updatedCount:Number(row.updated_count),unchangedCount:Number(row.unchanged_count),version:Number(row.version),expiresAt:row.expires_at
});

export function createCrmImportService({tenantPool,moduleService,clock=()=>new Date()}={}){
 if(!tenantPool||typeof tenantPool.withTransaction!=='function'||!moduleService||typeof moduleService.authorize!=='function')fail('Import dependencies are required.');

 async function previewPeople(input){
  await authorize(moduleService,input);
  const parsed=parsePeopleCsv(input.csv),batchId=input.batchId??randomUUID();
  const key=String(input.idempotencyKey??'').trim(),source=String(input.sourceSystem??'').trim();
  if(!key||key.length>200||!source||source.length>120)fail('Import identity is invalid.');
  const now=new Date(clock()),expires=new Date(now.getTime()+60*60*1000).toISOString();
  const batch=await tenantPool.withTransaction(input.tenantId,async session=>{
   const {rows:[existing]}=await session.query(
    '/*import-batch:by-key*/ SELECT * FROM crm_import_batches WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
    [input.tenantId,key]
   );
   if(existing){
    if(existing.source_sha256!==parsed.sourceSha256||existing.mapping_sha256!==parsed.mappingSha256)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import idempotency key conflicts with different content.');
    return existing;
   }
   const {rows:[created]}=await session.query(
    "/*import-batch:insert*/ INSERT INTO crm_import_batches(tenant_id,batch_id,idempotency_key,source_system,entity_type,source_sha256,mapping_sha256,byte_count,row_count,valid_count,invalid_count,actor_identity_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'people',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *",
    [input.tenantId,batchId,key,source,parsed.sourceSha256,parsed.mappingSha256,parsed.byteCount,parsed.rowCount,parsed.validCount,parsed.invalidCount,input.actorIdentityId,expires,now.toISOString()]
   );
   return created;
  });
  return {...mapBatch(batch),errors:parsed.errors};
 }

 async function commitPeople(input){
  await authorize(moduleService,input);
  const parsed=parsePeopleCsv(input.csv);
  if(input.expectedSourceSha256&&input.expectedSourceSha256!==parsed.sourceSha256)fail('Import source does not match its preview.');
  if(!UUID.test(input.batchId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('Import commit identity is invalid.');
  return tenantPool.withTransaction(input.tenantId,async session=>{
   const {rows:[batch]}=await session.query(
    '/*import-batch:lock*/ SELECT * FROM crm_import_batches WHERE tenant_id=$1 AND batch_id=$2 FOR UPDATE',
    [input.tenantId,input.batchId]
   );
   if(!batch)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Import preview was not found.');
   if(batch.source_sha256!==parsed.sourceSha256||batch.mapping_sha256!==parsed.mappingSha256||batch.source_system!==input.sourceSystem||batch.idempotency_key!==input.idempotencyKey)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import source or mapping changed after preview.');
   if(batch.status==='committed')return mapBatch(batch);
   if(batch.status!=='previewed'||Number(batch.version)!==input.expectedVersion||new Date(batch.expires_at)<=new Date(clock())||parsed.invalidCount)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import preview is stale or cannot be committed.');
   let inserted=0,updated=0,unchanged=0;
   for(const row of [...parsed.rows].sort((a,b)=>a.externalKey.localeCompare(b.externalKey))){
    const {rows:[mapping]}=await session.query(
     "/*import-map:lock*/ SELECT m.*,p.version AS current_target_version FROM crm_import_source_mappings m JOIN crm_subjects s ON s.tenant_id=m.tenant_id AND s.subject_id=m.target_subject_id AND s.subject_type='party' JOIN parties p ON p.tenant_id=s.tenant_id AND p.party_id=s.party_id WHERE m.tenant_id=$1 AND m.source_system=$2 AND m.entity_type='people' AND m.external_key=$3 FOR UPDATE OF m,p",
     [input.tenantId,input.sourceSystem,row.externalKey]
    );
    if(mapping){
     if(Number(mapping.current_target_version)!==Number(mapping.target_version))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import target changed after its source mapping.');
     if(mapping.source_row_hash===row.rowHash){unchanged++;continue;}
     const now=new Date(clock()).toISOString();
     const {rows:[party]}=await session.query(
      '/*import-party:update*/ UPDATE parties SET display_name=$3,version=version+1,updated_at=$4 WHERE tenant_id=$1 AND party_id=$2 AND version=$5 RETURNING version',
      [input.tenantId,mapping.target_subject_id,row.displayName,now,mapping.target_version]
     );
     if(!party)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import target is stale.');
     await session.query(
      '/*import-person:update*/ UPDATE people SET first_name=$3,last_name=$4,updated_at=$5 WHERE tenant_id=$1 AND party_id=$2',
      [input.tenantId,mapping.target_subject_id,row.firstName,row.lastName,now]
     );
     await session.query(
      '/*import-map:update*/ UPDATE crm_import_source_mappings SET source_row_hash=$4,target_version=$5,last_batch_id=$6,updated_at=$7 WHERE tenant_id=$1 AND source_system=$2 AND external_key=$3',
      [input.tenantId,input.sourceSystem,row.externalKey,row.rowHash,party.version,input.batchId,now]
     );
     updated++;
     continue;
    }
    const partyId=randomUUID(),now=new Date(clock()).toISOString();
    await session.query(
     "/*import-party:insert*/ INSERT INTO parties(tenant_id,party_id,party_type,display_name,status,created_at,updated_at) VALUES($1,$2,'person',$3,'active',$4,$4)",
     [input.tenantId,partyId,row.displayName,now]
    );
    await session.query(
     '/*import-person:insert*/ INSERT INTO people(tenant_id,party_id,first_name,last_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
     [input.tenantId,partyId,row.firstName,row.lastName,now]
    );
    await session.query(
     "/*import-subject:insert*/ INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id,created_at,updated_at) VALUES($1,$2,'party',$2,$3,$3)",
     [input.tenantId,partyId,now]
    );
    await session.query(
     "/*import-map:insert*/ INSERT INTO crm_import_source_mappings(tenant_id,source_system,entity_type,external_key,target_subject_id,source_row_hash,target_version,last_batch_id,created_at,updated_at) VALUES($1,$2,'people',$3,$4,$5,1,$6,$7,$7)",
     [input.tenantId,input.sourceSystem,row.externalKey,partyId,row.rowHash,input.batchId,now]
    );
    inserted++;
   }
   if(inserted+updated+unchanged!==parsed.validCount)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import reconciliation failed.');
   const committedAt=new Date(clock()).toISOString();
   const {rows:[committed]}=await session.query(
    "/*import-batch:commit*/ UPDATE crm_import_batches SET status='committed',inserted_count=$3,updated_count=$4,unchanged_count=$5,committed_at=$6,version=version+1,updated_at=$6 WHERE tenant_id=$1 AND batch_id=$2 AND status='previewed' RETURNING *",
    [input.tenantId,input.batchId,inserted,updated,unchanged,committedAt]
   );
   if(!committed)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import commit lost its concurrency race.');
   return mapBatch(committed);
  });
 }

 return Object.freeze({previewPeople,commitPeople});
}
