import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
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
const compareKeys=(left,right)=>left<right?-1:left>right?1:0;

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
 sourceSha256:row.source_sha256,mappingSha256:row.mapping_sha256,previewSha256:row.preview_sha256,rowCount:Number(row.row_count),
 validCount:Number(row.valid_count),invalidCount:Number(row.invalid_count),insertedCount:Number(row.inserted_count),
 updatedCount:Number(row.updated_count),unchangedCount:Number(row.unchanged_count),version:Number(row.version),expiresAt:row.expires_at
});

async function readSnapshot(session,{tenantId,sourceSystem,parsed,lock=false}){
 const keys=parsed.rows.map(row=>row.externalKey).sort(compareKeys);
 const {rows}=await session.query(
  `/*import-map:${lock?'commit-snapshot':'snapshot'}*/ SELECT m.external_key,m.target_subject_id,m.source_row_hash,m.target_version,p.version AS current_target_version FROM crm_import_source_mappings m JOIN people pe ON pe.tenant_id=m.tenant_id AND pe.party_id=m.target_subject_id JOIN parties p ON p.tenant_id=pe.tenant_id AND p.party_id=pe.party_id WHERE m.tenant_id=$1 AND m.source_system=$2 AND m.entity_type='people' AND m.external_key=ANY($3::text[]) ORDER BY m.external_key${lock?' FOR UPDATE OF m,p':''}`,
  [tenantId,sourceSystem,keys]
 );
 const byKey=new Map(rows.map(row=>[row.external_key,row]));
 const parsedByKey=new Map(parsed.rows.map(row=>[row.externalKey,row]));
 let inserted=0,updated=0,unchanged=0;
 const entries=keys.map(externalKey=>{
  const sourceRow=parsedByKey.get(externalKey),mapping=byKey.get(externalKey);
  if(!mapping){inserted++;return {sourceSystem,entityType:'people',externalKey,sourceRowHash:null,targetSubjectId:null,targetVersion:null};}
  if(Number(mapping.current_target_version)!==Number(mapping.target_version))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import target changed after its source mapping.');
  if(mapping.source_row_hash===sourceRow.rowHash)unchanged++;else updated++;
  return {sourceSystem,entityType:'people',externalKey,sourceRowHash:mapping.source_row_hash,targetSubjectId:mapping.target_subject_id,targetVersion:Number(mapping.current_target_version)};
 });
 return {digest:digest(JSON.stringify(entries)),byKey,inserted,updated,unchanged};
}

export function createCrmImportService({tenantPool,moduleService,reconciliationSecret=null,clock=()=>new Date()}={}){
 if(!tenantPool||typeof tenantPool.withTransaction!=='function'||!moduleService||typeof moduleService.authorize!=='function')fail('Import dependencies are required.');
 const reviewSecret=typeof reconciliationSecret==='string'&&reconciliationSecret.length>=32?Buffer.from(reconciliationSecret):null;

 function issueReviewedToken(facts){
  if(!reviewSecret)persistenceFail(PERSISTENCE_CODES.INVALID,'Import reconciliation review is unavailable.');
  const payload=Buffer.from(JSON.stringify(facts)).toString('base64url'),signature=createHmac('sha256',reviewSecret).update(payload).digest('base64url');return `${payload}.${signature}`;
 }

 function verifyReviewedToken(value,tenantId,actorIdentityId){
  try{
   if(!reviewSecret||typeof value!=='string'||value.length>3000)throw new Error();const [payload,signature,...rest]=value.split('.');if(rest.length||!payload||!signature)throw new Error();
   const expected=createHmac('sha256',reviewSecret).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||actual.toString('base64url')!==signature)throw new Error();
   const parsed=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(parsed.kind!=='people-mapping-review'||parsed.tenantId!==tenantId||parsed.actorIdentityId!==actorIdentityId||!UUID.test(parsed.targetSubjectId)||!UUID.test(parsed.actorIdentityId)||typeof parsed.sourceSystem!=='string'||!parsed.sourceSystem||typeof parsed.externalKey!=='string'||!parsed.externalKey||!/^[a-f0-9]{64}$/.test(parsed.sourceRowHash)||!Number.isSafeInteger(parsed.mappingTargetVersion)||!Number.isSafeInteger(parsed.currentTargetVersion)||parsed.mappingTargetVersion<1||parsed.currentTargetVersion<1||parsed.mappingTargetVersion===parsed.currentTargetVersion||typeof parsed.expiresAt!=='string'||new Date(parsed.expiresAt)<=new Date(clock()))throw new Error();
   return parsed;
  }catch{persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import reconciliation review token is invalid, stale, or belongs to another user.');}
 }

 async function reviewPeopleMappingConflicts(input){
  await authorize(moduleService,input);if(!reviewSecret)persistenceFail(PERSISTENCE_CODES.INVALID,'Import reconciliation review is unavailable.');
  const parsed=parsePeopleCsv(input.csv),source=typeof input.sourceSystem==='string'?input.sourceSystem.trim():'',actorIdentityId=typeof input.actorIdentityId==='string'?input.actorIdentityId.toLowerCase():'';
  if(!source||source.length>120||!UUID.test(actorIdentityId))fail('Import reconciliation review is invalid.');const keys=parsed.rows.map(row=>row.externalKey).sort(compareKeys),reviewedAt=new Date(clock()),expiresAt=new Date(reviewedAt.getTime()+15*60*1000).toISOString();
  const rows=await tenantPool.withTransaction(input.tenantId,async session=>(await session.query(`/*import-map:review-conflicts*/ SELECT m.external_key,m.target_subject_id,m.source_row_hash,m.target_version,p.version AS current_target_version FROM crm_import_source_mappings m JOIN people pe ON pe.tenant_id=m.tenant_id AND pe.party_id=m.target_subject_id JOIN parties p ON p.tenant_id=pe.tenant_id AND p.party_id=pe.party_id WHERE m.tenant_id=$1 AND m.source_system=$2 AND m.entity_type='people' AND m.external_key=ANY($3::text[]) AND m.target_version<>p.version ORDER BY m.external_key LIMIT 101`,[input.tenantId,source,keys])).rows);
  const conflicts=rows.slice(0,100).map(row=>{const facts={kind:'people-mapping-review',tenantId:input.tenantId,actorIdentityId,sourceSystem:source,externalKey:row.external_key,targetSubjectId:row.target_subject_id,sourceRowHash:row.source_row_hash,mappingTargetVersion:Number(row.target_version),currentTargetVersion:Number(row.current_target_version),expiresAt};return {externalKey:facts.externalKey,targetSubjectId:facts.targetSubjectId,mappingTargetVersion:facts.mappingTargetVersion,currentTargetVersion:facts.currentTargetVersion,reviewedToken:issueReviewedToken(facts)};});
  return {conflicts,truncated:rows.length>100,reviewedAt:reviewedAt.toISOString(),expiresAt};
 }

 async function reconcilePeopleMapping(input){
  await authorize(moduleService,input);
  const reason=typeof input.reason==='string'?input.reason.trim():'',actorIdentityId=typeof input.actorIdentityId==='string'?input.actorIdentityId.toLowerCase():'';if(!UUID.test(actorIdentityId)||reason.length<10||reason.length>500)fail('Import reconciliation review is invalid.');
  const reviewed=verifyReviewedToken(input.reviewedToken,input.tenantId,actorIdentityId),{sourceSystem:source,externalKey,targetSubjectId,sourceRowHash,mappingTargetVersion:expectedMapping,currentTargetVersion:expectedCurrent}=reviewed;
  return tenantPool.withTransaction(input.tenantId,async session=>{
   const {rows:[mapping]}=await session.query(
    `/*import-map:reconcile-lock*/ SELECT m.external_key,m.target_subject_id,m.source_row_hash,m.target_version,p.version AS current_target_version FROM crm_import_source_mappings m JOIN people pe ON pe.tenant_id=m.tenant_id AND pe.party_id=m.target_subject_id JOIN parties p ON p.tenant_id=pe.tenant_id AND p.party_id=pe.party_id WHERE m.tenant_id=$1 AND m.source_system=$2 AND m.entity_type='people' AND m.external_key=$3 FOR UPDATE OF m,p`,
    [input.tenantId,source,externalKey]
   );
   if(!mapping)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Import mapping was not found.');
   if(mapping.target_subject_id!==targetSubjectId||mapping.source_row_hash!==sourceRowHash||Number(mapping.target_version)!==expectedMapping||Number(mapping.current_target_version)!==expectedCurrent||expectedMapping===expectedCurrent)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import reconciliation review is stale or no longer matches the saved mapping.');
   const reconciledAt=new Date(clock()).toISOString();
   const {rows:[updated]}=await session.query(
    `/*import-map:reconcile-update*/ UPDATE crm_import_source_mappings SET target_version=$7,updated_at=$8::timestamptz WHERE tenant_id=$1 AND source_system=$2 AND entity_type='people' AND external_key=$3 AND target_subject_id=$4 AND target_version=$5 AND source_row_hash=$6 RETURNING target_version,updated_at`,
    [input.tenantId,source,externalKey,targetSubjectId,expectedMapping,sourceRowHash,expectedCurrent,reconciledAt]
   );
   if(!updated)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import reconciliation lost its concurrency race.');
   await session.query(
    `/*import-map:reconcile-audit*/ INSERT INTO party_events(tenant_id,event_id,target_type,target_id,action,actor_identity_id,details,at) VALUES($1,$2,'party',$3,'import_mapping_reconciled',$4,$5::jsonb,$6::timestamptz)`,
    [input.tenantId,randomUUID(),targetSubjectId,actorIdentityId,JSON.stringify({sourceSystem:source,externalKey,sourceRowHash,priorTargetVersion:expectedMapping,targetVersion:expectedCurrent,reason}),reconciledAt]
   );
   return {sourceSystem:source,entityType:'people',externalKey,targetSubjectId,targetVersion:Number(updated.target_version),reconciledAt:updated.updated_at};
  });
 }

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
   const snapshot=await readSnapshot(session,{tenantId:input.tenantId,sourceSystem:source,parsed});
   const {rows:[created]}=await session.query(
    "/*import-batch:insert*/ INSERT INTO crm_import_batches(tenant_id,batch_id,idempotency_key,source_system,entity_type,source_sha256,mapping_sha256,preview_sha256,byte_count,row_count,valid_count,invalid_count,inserted_count,updated_count,unchanged_count,actor_identity_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'people',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *",
    [input.tenantId,batchId,key,source,parsed.sourceSha256,parsed.mappingSha256,snapshot.digest,parsed.byteCount,parsed.rowCount,parsed.validCount,parsed.invalidCount,snapshot.inserted,snapshot.updated,snapshot.unchanged,input.actorIdentityId,expires,now.toISOString()]
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
   const snapshot=await readSnapshot(session,{tenantId:input.tenantId,sourceSystem:input.sourceSystem,parsed,lock:true});
   if(snapshot.digest!==batch.preview_sha256||snapshot.inserted!==Number(batch.inserted_count)||snapshot.updated!==Number(batch.updated_count)||snapshot.unchanged!==Number(batch.unchanged_count))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import mappings or targets changed after preview.');
   let inserted=0,updated=0,unchanged=0;
   for(const row of [...parsed.rows].sort((a,b)=>compareKeys(a.externalKey,b.externalKey))){
    const mapping=snapshot.byKey.get(row.externalKey);
    if(mapping){
     if(mapping.source_row_hash===row.rowHash){unchanged++;continue;}
     const now=new Date(clock()).toISOString();
     const {rows:[party]}=await session.query(
      '/*import-party:update*/ UPDATE parties SET display_name=$3,version=version+1,updated_at=$4 WHERE tenant_id=$1 AND party_id=$2 AND version=$5 RETURNING version',
      [input.tenantId,mapping.target_subject_id,row.displayName,now,mapping.target_version]
     );
     if(!party)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import target is stale.');
     const person=await session.query(
      '/*import-person:update*/ UPDATE people SET first_name=$3,last_name=$4,updated_at=$5 WHERE tenant_id=$1 AND party_id=$2',
      [input.tenantId,mapping.target_subject_id,row.firstName,row.lastName,now]
     );
     if(person.rowCount!==1)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import target person subtype is missing or stale.');
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
   if(inserted+updated+unchanged!==parsed.validCount||inserted!==Number(batch.inserted_count)||updated!==Number(batch.updated_count)||unchanged!==Number(batch.unchanged_count))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import reconciliation failed.');
   const committedAt=new Date(clock()).toISOString();
   const {rows:[committed]}=await session.query(
    "/*import-batch:commit*/ UPDATE crm_import_batches SET status='committed',inserted_count=$3,updated_count=$4,unchanged_count=$5,committed_at=$6,version=version+1,updated_at=$6 WHERE tenant_id=$1 AND batch_id=$2 AND status='previewed' RETURNING *",
    [input.tenantId,input.batchId,inserted,updated,unchanged,committedAt]
   );
   if(!committed)persistenceFail(PERSISTENCE_CODES.CONFLICT,'Import commit lost its concurrency race.');
   return mapBatch(committed);
  });
 }

 return Object.freeze({previewPeople,commitPeople,reviewPeopleMappingConflicts,reconcilePeopleMapping});
}
