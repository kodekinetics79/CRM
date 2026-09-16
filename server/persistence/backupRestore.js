// Logical backup, restore, and — the part that matters — restore VERIFICATION.
//
// A backup that has never been restored is a file, not a recovery capability.
// So this module has three steps and the third is not optional:
//
//   1. createTenantBackup()  — a portable, encrypted, checksummed dump of every
//      row the persistence boundary owns for one tenant, with a manifest that
//      records the row counts, per-collection checksum digests and exact
//      integer-cent financial totals at capture time.
//   2. restoreTenantBackup() — decrypt, authenticate and load into a FRESH,
//      empty target. The target refuses a non-empty tenant, so a restore can
//      never half-overwrite live data.
//   3. verifyRestore()       — recompute the digest from the restored store and
//      compare it to the manifest captured at backup time AND, when available,
//      to the live source. Row counts, per-collection checksums, audit and user
//      digests and integer-cent totals must all be equal or the restore is
//      reported as failed.
//
// The archive is encrypted with the same 32-byte key discipline as the existing
// SQLite archives (server/backup.js), and the key is never written into the
// archive or the manifest.

import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {PERSISTENCE_CODES,persistenceFail,assertTenantId,canonicalJson,sha256} from './contract.js';
import {parseBackupKey} from '../backup.js';

const MAGIC=Buffer.from('WIMBLO-PERSISTENCE-BACKUP\n');
const FORMAT='Wimblo persistence logical backup';
const VERSION=1;
export const MAX_ARCHIVE_BYTES=128*1024*1024;

const prefix=length=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(length);return bytes;};
const differences=(expected,actual,path='')=>{
 const out=[];
 const keys=new Set([...Object.keys(expected||{}),...Object.keys(actual||{})]);
 for(const key of keys){
  const a=expected?.[key],b=actual?.[key],here=path?`${path}.${key}`:key;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a))out.push(...differences(a,b,here));
  else if(canonicalJson(a)!==canonicalJson(b))out.push({field:here,expected:a===undefined?null:a,actual:b===undefined?null:b});
 }
 return out;
};

/** @param {{repository:object, encryptionKey:string, now?:() => string}} options */
export async function createTenantBackup({repository,encryptionKey,now=()=>new Date().toISOString()}={}){
 if(!repository||typeof repository.exportTenant!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A repository implementing the persistence boundary is required.');
 const key=parseBackupKey(encryptionKey);
 try{
  const tenantId=assertTenantId(repository.tenantId);
  const dump=await repository.exportTenant();
  const digest=await repository.snapshotDigest();
  const payload=Buffer.from(canonicalJson(dump),'utf8');
  const manifest={
   format:FORMAT,version:VERSION,tenantId,
   store:repository.kind,
   schemaVersion:await repository.schemaVersion(),
   createdAt:now(),
   payloadBytes:payload.length,
   payloadSha256:sha256(payload),
   digest,
   scope:'One tenant: records, users, settings and audit owned by the persistence boundary. Private object bytes are held in the object store and are not inside this archive.'
  };
  const metadata=Buffer.from(JSON.stringify(manifest),'utf8');
  const iv=randomBytes(12),aad={format:FORMAT,version:VERSION,tenantId};
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(canonicalJson(aad)));
  const encrypted=Buffer.concat([cipher.update(prefix(metadata.length)),cipher.update(metadata),cipher.update(payload),cipher.final()]);
  const header=Buffer.from(JSON.stringify({...aad,nonce:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')}),'utf8');
  const archive=Buffer.concat([MAGIC,prefix(header.length),header,encrypted]);
  if(archive.length>MAX_ARCHIVE_BYTES)persistenceFail(PERSISTENCE_CODES.INVALID,'Encrypted archive exceeds the 128 MiB bound.');
  return {archive,manifest,archiveSha256:sha256(archive),archiveBytes:archive.length};
 }finally{key.fill(0);}
}

export function readBackupManifest({archive,encryptionKey,expectedTenantId=null}={}){
 const key=parseBackupKey(encryptionKey);
 try{
  const bytes=Buffer.isBuffer(archive)?archive:Buffer.from(archive||[]);
  if(bytes.length<MAGIC.length+5||bytes.length>MAX_ARCHIVE_BYTES||!bytes.subarray(0,MAGIC.length).equals(MAGIC))persistenceFail(PERSISTENCE_CODES.INVALID,'This is not a Wimblo persistence archive.');
  const headerLength=bytes.readUInt32BE(MAGIC.length),start=MAGIC.length+4;
  if(headerLength<1||headerLength>4096||start+headerLength>=bytes.length)persistenceFail(PERSISTENCE_CODES.INVALID,'Archive header is invalid.');
  let header;try{header=JSON.parse(bytes.subarray(start,start+headerLength).toString('utf8'));}catch{persistenceFail(PERSISTENCE_CODES.INVALID,'Archive header is invalid.');}
  if(header.format!==FORMAT||header.version!==VERSION)persistenceFail(PERSISTENCE_CODES.INVALID,'Archive format or version does not match.');
  const tenantId=assertTenantId(header.tenantId);
  if(expectedTenantId&&assertTenantId(expectedTenantId)!==tenantId)persistenceFail(PERSISTENCE_CODES.INVALID,'Archive tenant does not match the expected tenant.');
  const iv=Buffer.from(String(header.nonce),'base64'),tag=Buffer.from(String(header.tag),'base64');
  if(iv.length!==12||tag.length!==16)persistenceFail(PERSISTENCE_CODES.INVALID,'Archive encryption header is invalid.');
  let plaintext;
  try{
   const decipher=createDecipheriv('aes-256-gcm',key,iv);
   decipher.setAAD(Buffer.from(canonicalJson({format:FORMAT,version:VERSION,tenantId})));
   decipher.setAuthTag(tag);
   plaintext=Buffer.concat([decipher.update(bytes.subarray(start+headerLength)),decipher.final()]);
  }catch{persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Archive authentication failed; the key or the archive is wrong.');}
  const manifestLength=plaintext.readUInt32BE();
  if(manifestLength<1||manifestLength+4>=plaintext.length)persistenceFail(PERSISTENCE_CODES.INVALID,'Archive manifest is invalid.');
  let manifest;try{manifest=JSON.parse(plaintext.subarray(4,4+manifestLength).toString('utf8'));}catch{persistenceFail(PERSISTENCE_CODES.INVALID,'Archive manifest is invalid.');}
  const payload=plaintext.subarray(4+manifestLength);
  if(manifest.payloadBytes!==payload.length||manifest.payloadSha256!==sha256(payload))persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Archive payload checksum verification failed.');
  let dump;try{dump=JSON.parse(payload.toString('utf8'));}catch{persistenceFail(PERSISTENCE_CODES.INVALID,'Archive payload is not a tenant dump.');}
  if(dump.tenantId!==tenantId)persistenceFail(PERSISTENCE_CODES.VERIFICATION,'Archive payload tenant does not match its header.');
  return {manifest,dump};
 }finally{key.fill(0);}
}

/**
 * Restore into a FRESH target and verify it. createTargetRepository must return
 * an empty repository — a fresh database, a fresh workspace file, or an
 * unregistered tenant. A non-empty target is refused by importTenant().
 */
export async function restoreTenantBackup({archive,encryptionKey,createTargetRepository,expectedTenantId=null,closeTarget=true}={}){
 if(typeof createTargetRepository!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A fresh-target repository factory is required; restores never write over a live store.');
 const {manifest,dump}=readBackupManifest({archive,encryptionKey,expectedTenantId});
 const target=await createTargetRepository(manifest);
 try{
  if(target.tenantId!==manifest.tenantId)persistenceFail(PERSISTENCE_CODES.INVALID,'The restore target is scoped to a different tenant than the archive.');
  const counts=await target.importTenant(dump);
  const verification=await verifyRestore({manifest,restored:target});
  return {tenantId:manifest.tenantId,store:target.kind,counts,manifest,verification,repository:closeTarget?null:target};
 }finally{if(closeTarget)await target.close();}
}

/**
 * Prove the restored store equals what was captured. Compares row counts,
 * per-collection checksum digests, user and audit digests, settings checksum
 * and exact integer-cent financial totals. Throws with the exact differing
 * fields when anything disagrees.
 */
export async function verifyRestore({manifest=null,source=null,restored}={}){
 if(!restored||typeof restored.snapshotDigest!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A restored repository is required.');
 const actual=await restored.snapshotDigest();
 const comparisons=[];
 const baselines=[];
 if(manifest?.digest)baselines.push(['backup manifest',manifest.digest]);
 if(source)baselines.push(['live source',await source.snapshotDigest()]);
 if(!baselines.length)persistenceFail(PERSISTENCE_CODES.INVALID,'Restore verification needs a manifest or a live source to compare against.');
 for(const [label,expected] of baselines){
  // schemaVersion is intentionally compared: restoring into a differently
  // migrated database is a failure, not a convenience.
  const diff=differences(expected,actual);
  comparisons.push({against:label,equal:diff.length===0,differences:diff});
 }
 const failed=comparisons.filter(c=>!c.equal);
 const evidence={
  tenantId:actual.tenantId,
  store:restored.kind,
  schemaVersion:actual.schemaVersion,
  rowCounts:actual.totals,
  collections:Object.fromEntries(Object.entries(actual.collections).map(([k,v])=>[k,v.count])),
  checksums:Object.fromEntries(Object.entries(actual.collections).map(([k,v])=>[k,v.digest])),
  financial:actual.financial,
  comparisons,
  verified:failed.length===0
 };
 if(failed.length)persistenceFail(PERSISTENCE_CODES.VERIFICATION,`Restore verification failed against ${failed.map(f=>f.against).join(' and ')}: ${canonicalJson(failed[0].differences.slice(0,5))}`,{evidence});
 return evidence;
}
