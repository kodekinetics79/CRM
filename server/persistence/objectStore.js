// Private object storage for documents and attachments.
//
// What this abstraction guarantees, and what it does not:
//
//   GUARANTEED BY CODE
//   * Every object carries a SHA-256 of its plaintext and of its ciphertext,
//     an exact byte length and a declared content type from a closed allowlist.
//   * Bytes are encrypted before they leave this process (AES-256-GCM), so the
//     backend never sees plaintext and the encryption metadata — algorithm, key
//     identifier, custody mode — is recorded with the object.
//   * The metadata catalogue is written BEFORE the upload and only promoted to
//     "active" after the upload is acknowledged with an exact provider version.
//     A failed upload leaves a "staged" row, never an object the application
//     believes it can read.
//   * Retention can be extended but never shortened. Deletion is a two-step
//     state machine (active → deletion_requested → deleted) that refuses to run
//     under a legal hold or before the retention date.
//   * Region and custody come from a residency configuration that defaults to
//     the US/Canada profile required by Addendum 2 §1(a)(iv).
//
//   NOT GUARANTEED BY CODE
//   * That a provider physically stores bytes in the configured region. That is
//     an operator evidence item, not a software property.
//   * Key custody. An application-managed key is only as private as the place
//     the operator keeps it.
//   * Off-host durability, lifecycle enforcement or geographic replication.

import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail,assertTenantId,sha256} from './contract.js';
import {resolveResidency} from './residency.js';
import {OBJECT_STORAGE_MAX_BYTES} from '../objectStorage.js';

export const OBJECT_CONTENT_TYPES=Object.freeze(['application/pdf','image/png','image/jpeg','text/plain;charset=utf-8','text/csv;charset=utf-8']);
export const OBJECT_MAX_BYTES=OBJECT_STORAGE_MAX_BYTES;
export const OBJECT_STATES=Object.freeze(['staged','active','deletion_requested','deleted']);
export const ENCRYPTION_ALGORITHM='AES-256-GCM';

const safePart=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v);
const isDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v));

export function parseObjectKey(value){
 if(typeof value!=='string')persistenceFail(PERSISTENCE_CODES.INVALID,'An object encryption key must be a 32-byte hex or base64 value.');
 let key=null;
 if(/^[a-f0-9]{64}$/i.test(value))key=Buffer.from(value,'hex');
 else if(/^[A-Za-z0-9+/]{43}=$/.test(value)){const decoded=Buffer.from(value,'base64');if(decoded.toString('base64')===value)key=decoded;}
 if(key?.length!==32)persistenceFail(PERSISTENCE_CODES.INVALID,'An object encryption key must be a 32-byte hex or base64 value.');
 return key;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------
export function createMemoryObjectBackend(){
 const objects=new Map();
 return {
  provider:'memory',
  async put(key,bytes,contentType){
   if(objects.has(key))persistenceFail(PERSISTENCE_CODES.CONFLICT,'Object keys are written once; an existing key is never overwritten.');
   const version=randomUUID();
   objects.set(key,{bytes:Buffer.from(bytes),contentType,version});
   return {version};
  },
  async get(key,version){
   const object=objects.get(key);
   if(!object||(version&&object.version!==version))persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'The exact private object version is unavailable.');
   return Buffer.from(object.bytes);
  },
  async remove(key){objects.delete(key);return true;},
  size:()=>objects.size
 };
}

/**
 * S3-compatible backend. Used against MinIO for local verification and against
 * native AWS S3 in a production profile. A custom endpoint is validated by
 * resolveResidency() and is refused entirely under NODE_ENV=production.
 */
export function createS3ObjectBackend({client,bucket}={}){
 if(!client||typeof client.send!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'An S3 client is required.');
 if(typeof bucket!=='string'||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))persistenceFail(PERSISTENCE_CODES.INVALID,'A private bucket name is required.');
 return {
  provider:'s3',
  bucket,
  async put(key,bytes,contentType,commands){
   const result=await client.send(new commands.PutObjectCommand({Bucket:bucket,Key:key,Body:Buffer.from(bytes),ContentType:contentType,CacheControl:'private, no-store',IfNoneMatch:'*',ChecksumSHA256:createHash('sha256').update(bytes).digest('base64')}));
   return {version:typeof result.VersionId==='string'&&result.VersionId?result.VersionId:null,serverSideEncryption:result.ServerSideEncryption||null};
  },
  async get(key,version,commands){
   let result;
   try{result=await client.send(new commands.GetObjectCommand({Bucket:bucket,Key:key,...(version?{VersionId:version}:{})}));}
   catch{persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'The exact private object version is unavailable.');}
   const chunks=[];let length=0;
   for await(const part of result.Body){const chunk=Buffer.from(part);length+=chunk.length;if(length>OBJECT_MAX_BYTES+64)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Private object exceeded its expected byte bound while downloading.');chunks.push(chunk);}
   return Buffer.concat(chunks,length);
  },
  async remove(key,version,commands){await client.send(new commands.DeleteObjectCommand({Bucket:bucket,Key:key,...(version?{VersionId:version}:{})}));return true;}
 };
}

// ---------------------------------------------------------------------------
// Metadata catalogues
// ---------------------------------------------------------------------------
const catalogKey=meta=>`${meta.tenantId}/${meta.objectId}/${meta.revision}`;

export function createMemoryObjectCatalog(){
 const rows=new Map();
 return {
  kind:'memory',
  async insert(meta){if(rows.has(catalogKey(meta)))persistenceFail(PERSISTENCE_CODES.CONFLICT,`Object ${meta.objectId} revision ${meta.revision} already exists.`);rows.set(catalogKey(meta),{...meta});return {...meta};},
  async update(ref,patch){const row=rows.get(catalogKey(ref));if(!row)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Object metadata was not found.');Object.assign(row,patch);return {...row};},
  async find(ref){const row=rows.get(catalogKey(ref));return row?{...row}:null;},
  async list({tenantId,state=null}={}){return [...rows.values()].filter(r=>r.tenantId===tenantId&&(!state||r.state===state)).map(r=>({...r}));}
 };
}

/** Catalogue backed by the migrated object_metadata table. */
export function createPostgresObjectCatalog({pool,tenantId}){
 const tenant=assertTenantId(tenantId);
 const COLUMNS='tenant_id,object_id,revision,object_key,provider,bucket,namespace,region,residency_profile,custody,content_type,size_bytes,sha256,ciphertext_sha256,encryption_algorithm,encryption_key_id,provider_version,state,legal_hold,retain_until,created_at,state_changed_at,deleted_at';
 const rowOf=row=>row&&({
  tenantId:row.tenant_id,objectId:row.object_id,revision:Number(row.revision),objectKey:row.object_key,provider:row.provider,bucket:row.bucket,namespace:row.namespace,
  region:row.region,residencyProfile:row.residency_profile,custody:row.custody,contentType:row.content_type,size:Number(row.size_bytes),sha256:row.sha256.trim(),
  ciphertextSha256:row.ciphertext_sha256.trim(),encryptionAlgorithm:row.encryption_algorithm,encryptionKeyId:row.encryption_key_id,providerVersion:row.provider_version,
  state:row.state,legalHold:row.legal_hold,retainUntil:row.retain_until?new Date(row.retain_until).toISOString().slice(0,10):null,
  createdAt:new Date(row.created_at).toISOString(),stateChangedAt:new Date(row.state_changed_at).toISOString(),deletedAt:row.deleted_at?new Date(row.deleted_at).toISOString():null
 });
 return {
  kind:'postgres',
  async insert(meta){
   return pool.withTransaction(tenant,async session=>{
    try{
     const {rows}=await session.query(
      `INSERT INTO object_metadata(tenant_id,object_id,revision,object_key,provider,bucket,namespace,region,residency_profile,custody,content_type,size_bytes,sha256,ciphertext_sha256,encryption_algorithm,encryption_key_id,provider_version,state,legal_hold,retain_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint,$13,$14,$15,$16,$17,$18,$19,$20::date) RETURNING ${COLUMNS}`,
      [tenant,meta.objectId,meta.revision,meta.objectKey,meta.provider,meta.bucket,meta.namespace,meta.region,meta.residencyProfile,meta.custody,meta.contentType,String(meta.size),meta.sha256,meta.ciphertextSha256,meta.encryptionAlgorithm,meta.encryptionKeyId,meta.providerVersion??null,meta.state,meta.legalHold===true,meta.retainUntil??null]);
     return rowOf(rows[0]);
    }catch(e){
     if(e.code===PERSISTENCE_CODES.CONFLICT||e.detail?.pgCode==='23505')persistenceFail(PERSISTENCE_CODES.CONFLICT,`Object ${meta.objectId} revision ${meta.revision} already exists.`);
     throw e;
    }
   });
  },
  async update(ref,patch){
   return pool.withTransaction(tenant,async session=>{
    const sets=[],values=[tenant,ref.objectId,ref.revision];
    const push=(column,value,cast='')=>{values.push(value);sets.push(`${column}=$${values.length}${cast}`);};
    if('state' in patch){push('state',patch.state);sets.push('state_changed_at=now()');}
    if('providerVersion' in patch)push('provider_version',patch.providerVersion);
    if('legalHold' in patch)push('legal_hold',patch.legalHold);
    if('retainUntil' in patch)push('retain_until',patch.retainUntil,'::date');
    if('deletedAt' in patch)push('deleted_at',patch.deletedAt,'::timestamptz');
    if(!sets.length)persistenceFail(PERSISTENCE_CODES.INVALID,'An object metadata update requires at least one field.');
    const {rows}=await session.query(`UPDATE object_metadata SET ${sets.join(',')} WHERE tenant_id=$1 AND object_id=$2 AND revision=$3 RETURNING ${COLUMNS}`,values);
    if(!rows.length)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'Object metadata was not found.');
    return rowOf(rows[0]);
   });
  },
  async find(ref){
   return pool.withTenantSession(tenant,async session=>{
    const {rows}=await session.query(`SELECT ${COLUMNS} FROM object_metadata WHERE tenant_id=$1 AND object_id=$2 AND revision=$3`,[tenant,ref.objectId,ref.revision]);
    return rows.length?rowOf(rows[0]):null;
   });
  },
  async list({state=null}={}){
   return pool.withTenantSession(tenant,async session=>{
    const {rows}=await session.query(`SELECT ${COLUMNS} FROM object_metadata WHERE tenant_id=$1 AND ($2::text IS NULL OR state=$2) ORDER BY object_id COLLATE "C", revision`,[tenant,state]);
    return rows.map(rowOf);
   });
  }
 };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
export function createPrivateObjectStore({backend,catalog,residency,encryptionKey,namespace,bucket=null,maxBytes=OBJECT_MAX_BYTES,contentTypes=OBJECT_CONTENT_TYPES,commands=null,clock=()=>new Date()}={}){
 if(!backend||typeof backend.put!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A private object backend is required.');
 if(!catalog||typeof catalog.insert!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'An object metadata catalogue is required.');
 if(!safePart(namespace))persistenceFail(PERSISTENCE_CODES.INVALID,'A stable deployment namespace is required; never reuse another installation namespace.');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>OBJECT_MAX_BYTES)persistenceFail(PERSISTENCE_CODES.INVALID,`Object size limit must be between 1 and ${OBJECT_MAX_BYTES} bytes.`);
 if(backend.provider==='s3'&&(!commands||typeof commands.PutObjectCommand!=='function'))persistenceFail(PERSISTENCE_CODES.INVALID,'The S3 backend requires its command constructors.');
 const scope=residency&&residency.profile?residency:resolveResidency(residency||{});
 const key=parseObjectKey(encryptionKey);
 const keyId=sha256(Buffer.concat([Buffer.from('wimblo-object-key-id'),key])).slice(0,32);
 const allowed=new Set(contentTypes);

 const objectKey=(tenantId,objectId,revision,attemptId)=>`namespaces/${namespace}/tenants/${tenantId}/objects/${objectId}/revisions/${revision}/${attemptId}`;

 function validateInput({tenantId,objectId,revision,bytes,contentType}){
  const tenant=assertTenantId(tenantId);
  if(!safePart(objectId))persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit object identity is required.');
  if(!Number.isSafeInteger(revision)||revision<1)persistenceFail(PERSISTENCE_CODES.INVALID,'Object revisions are positive integers.');
  if(!allowed.has(contentType))persistenceFail(PERSISTENCE_CODES.INVALID,`Content type "${contentType}" is outside the accepted set: ${[...allowed].join(', ')}.`);
  const content=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
  if(!content.length)persistenceFail(PERSISTENCE_CODES.INVALID,'An empty object is refused.');
  if(content.length>maxBytes)persistenceFail(PERSISTENCE_CODES.INVALID,`Object of ${content.length} bytes exceeds the ${maxBytes}-byte limit.`);
  return {tenant,content};
 }

 function encrypt(content){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`${ENCRYPTION_ALGORITHM}:${keyId}`));
  const ciphertext=Buffer.concat([cipher.update(content),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]);
 }
 function decrypt(envelope){
  if(envelope.length<28)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Private object envelope is truncated.');
  const iv=envelope.subarray(0,12),tag=envelope.subarray(12,28),ciphertext=envelope.subarray(28);
  try{
   const decipher=createDecipheriv('aes-256-gcm',key,iv);
   decipher.setAAD(Buffer.from(`${ENCRYPTION_ALGORITHM}:${keyId}`));
   decipher.setAuthTag(tag);
   return Buffer.concat([decipher.update(ciphertext),decipher.final()]);
  }catch{return persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Private object authentication failed; the key or the stored bytes are wrong.');}
 }

 const today=()=>clock().toISOString().slice(0,10);

 async function put({tenantId,objectId,revision=1,bytes,contentType,retainUntil=null,legalHold=false}){
  const {tenant,content}=validateInput({tenantId,objectId,revision,bytes,contentType});
  if(retainUntil!==null&&!isDate(retainUntil))persistenceFail(PERSISTENCE_CODES.INVALID,'Retention dates are ISO calendar dates.');
  const envelope=encrypt(content);
  const meta={
   tenantId:tenant,objectId,revision,
   objectKey:objectKey(tenant,objectId,revision,randomUUID()),
   provider:backend.provider,bucket:bucket||backend.bucket||'in-process',namespace,
   region:scope.storageRegion,residencyProfile:scope.profile,custody:scope.custody,
   contentType,size:content.length,sha256:sha256(content),ciphertextSha256:sha256(envelope),
   encryptionAlgorithm:ENCRYPTION_ALGORITHM,encryptionKeyId:keyId,providerVersion:null,
   state:'staged',legalHold:legalHold===true,retainUntil,
   createdAt:clock().toISOString(),stateChangedAt:clock().toISOString(),deletedAt:null
  };
  // Catalogue first: a crash between here and the upload leaves a staged row
  // that the application will not serve, never an unrecorded object.
  await catalog.insert(meta);
  let uploaded;
  try{uploaded=await backend.put(meta.objectKey,envelope,'application/octet-stream',commands);}
  catch(e){persistenceFail(PERSISTENCE_CODES.UNAVAILABLE,`Private object upload failed; the revision stays staged and unreadable: ${e.message}`,{objectKey:meta.objectKey,state:'staged'});}
  const activated=await catalog.update({tenantId:tenant,objectId,revision},{state:'active',providerVersion:uploaded?.version??null});
  return {...meta,...activated,state:'active',providerVersion:uploaded?.version??null};
 }

 async function describe({tenantId,objectId,revision=1}){
  const found=await catalog.find({tenantId:assertTenantId(tenantId),objectId,revision});
  if(!found)persistenceFail(PERSISTENCE_CODES.NOT_FOUND,`Object ${objectId} revision ${revision} is not catalogued.`);
  return found;
 }

 async function get(ref){
  const meta=await describe(ref);
  if(meta.state==='staged')persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'This revision was never confirmed as uploaded and is not readable.');
  if(meta.state==='deleted')persistenceFail(PERSISTENCE_CODES.NOT_FOUND,'This revision has been deleted; only its metadata tombstone remains.');
  const envelope=await backend.get(meta.objectKey,meta.providerVersion,commands);
  if(sha256(envelope)!==meta.ciphertextSha256)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Stored ciphertext checksum verification failed.');
  const content=decrypt(envelope);
  if(content.length!==meta.size)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Private object size verification failed.');
  const actual=Buffer.from(sha256(content),'hex'),expected=Buffer.from(meta.sha256,'hex');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Private object checksum verification failed.');
  return {bytes:content,metadata:meta};
 }

 async function setLegalHold(ref,value){
  const meta=await describe(ref);
  if(meta.state==='deleted')persistenceFail(PERSISTENCE_CODES.CONFLICT,'A deleted revision cannot change its hold state.');
  return catalog.update({tenantId:meta.tenantId,objectId:meta.objectId,revision:meta.revision},{legalHold:value===true});
 }

 // Retention extends only. Shortening a retention window is a governance act
 // this boundary refuses to perform silently.
 async function setRetention(ref,retainUntil){
  if(!isDate(retainUntil))persistenceFail(PERSISTENCE_CODES.INVALID,'Retention dates are ISO calendar dates.');
  const meta=await describe(ref);
  if(meta.retainUntil&&retainUntil<meta.retainUntil)persistenceFail(PERSISTENCE_CODES.CONFLICT,`Retention can be extended but not shortened; ${meta.objectId} is retained until ${meta.retainUntil}.`);
  return catalog.update({tenantId:meta.tenantId,objectId:meta.objectId,revision:meta.revision},{retainUntil});
 }

 async function requestDeletion(ref,{reason=''}={}){
  const meta=await describe(ref);
  if(meta.state!=='active')persistenceFail(PERSISTENCE_CODES.CONFLICT,`Only an active revision can enter deletion; ${meta.objectId} is ${meta.state}.`);
  if(meta.legalHold)persistenceFail(PERSISTENCE_CODES.CONFLICT,'A revision under legal hold cannot be deleted.');
  if(meta.retainUntil&&meta.retainUntil>today())persistenceFail(PERSISTENCE_CODES.CONFLICT,`This revision is retained until ${meta.retainUntil}.`);
  if(typeof reason!=='string'||reason.length>500)persistenceFail(PERSISTENCE_CODES.INVALID,'A deletion reason must be a string of at most 500 characters.');
  return catalog.update({tenantId:meta.tenantId,objectId:meta.objectId,revision:meta.revision},{state:'deletion_requested'});
 }

 async function confirmDeletion(ref){
  const meta=await describe(ref);
  if(meta.state!=='deletion_requested')persistenceFail(PERSISTENCE_CODES.CONFLICT,`Deletion must be requested before it is confirmed; ${meta.objectId} is ${meta.state}.`);
  if(meta.legalHold)persistenceFail(PERSISTENCE_CODES.CONFLICT,'A revision under legal hold cannot be deleted.');
  await backend.remove(meta.objectKey,meta.providerVersion,commands);
  return catalog.update({tenantId:meta.tenantId,objectId:meta.objectId,revision:meta.revision},{state:'deleted',deletedAt:clock().toISOString()});
 }

 return {
  kind:'private-object-store',
  provider:backend.provider,
  namespace,
  residency:scope,
  limits:Object.freeze({maxBytes,contentTypes:Object.freeze([...allowed])}),
  encryption:Object.freeze({algorithm:ENCRYPTION_ALGORITHM,keyId,custody:scope.custody}),
  put,get,describe,setLegalHold,setRetention,requestDeletion,confirmDeletion,
  list:filter=>catalog.list({tenantId:filter?.tenantId,state:filter?.state??null}),
  notice:'Checksums, limits, encryption metadata, retention and custody are enforced here. Physical placement, key custody and lifecycle operation remain deployment evidence.'
 };
}
