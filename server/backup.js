import {DatabaseSync} from 'node:sqlite';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtemp,chmod,readFile,open,link,rm,lstat} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';

const MAGIC=Buffer.from('WIMBLO-BACKUP\n');
const FORMAT='Wimblo SQLite backup';
export const BACKUP_LIMITS=Object.freeze({maxArchiveBytes:128*1024*1024,maxTables:200,maxRows:500000,maxManifestBytes:1024*1024});
const fail=message=>{throw new Error(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('An explicit tenant UUID is required.');return value.toLowerCase();};
export function parseBackupKey(value){if(typeof value!=='string')fail('BACKUP_ENCRYPTION_KEY must explicitly contain a 32-byte hex or base64 key.');let key;if(/^[a-f0-9]{64}$/i.test(value))key=Buffer.from(value,'hex');else if(/^[A-Za-z0-9+/]{43}=$/.test(value)){key=Buffer.from(value,'base64');if(key.toString('base64')!==value)key=null;}if(key?.length!==32)fail('BACKUP_ENCRYPTION_KEY must explicitly contain a 32-byte hex or base64 key.');return key;}
const bound=value=>{if(value===undefined)return BACKUP_LIMITS.maxArchiveBytes;if(!Number.isSafeInteger(value)||value<1024||value>BACKUP_LIMITS.maxArchiveBytes)fail('Archive limit must be between 1 KiB and 128 MiB.');return value;};
async function absent(path){try{await lstat(path);fail('Destination already exists; overwrite is refused.');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function privateDir(parent){const dir=await mkdtemp(join(parent,'.wimblo-backup-'));await chmod(dir,0o700);return dir;}
async function writePrivate(path,bytes){const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
async function publish(path,destination){await chmod(path,0o600);try{await link(path,destination);}catch(e){if(e.code==='EEXIST')fail('Destination already exists; overwrite is refused.');throw e;}const directory=await open(dirname(destination),'r');try{await directory.sync();}finally{await directory.close();}}

function inventory(db,kind='workspace'){
 db.exec('PRAGMA trusted_schema=OFF');
 const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')fail('SQLite integrity verification failed.');
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all();
 if(Buffer.byteLength(canonical(schema))>BACKUP_LIMITS.maxManifestBytes)fail('Workspace schema exceeds the backup limit.');
 const names=schema.filter(r=>r.type==='table').map(r=>r.name).sort();if(names.length>BACKUP_LIMITS.maxTables)fail('Workspace exceeds the 200-table backup limit.');
 for(const required of kind==='platform'?['tenants','administrators','platform_sessions','platform_audit']:['records','users','sessions','settings','audit'])if(!names.includes(required))fail('Source is not a complete Wimblo workspace database.');
 if(kind!=='platform'&&(names.includes('platform_sessions')||names.includes('administrators')||names.includes('tenants')))fail('Platform registry databases are outside this workspace-only backup.');
 let totalRows=0;const tables=[];
 for(const name of names){const hashes=[],statement=db.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);for(const row of statement.iterate()){
   if(++totalRows>BACKUP_LIMITS.maxRows)fail('Workspace exceeds the 500,000-row backup limit.');
   const normalized=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?{integer:v.toString()}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('base64')}:v]));hashes.push(Buffer.from(hash(canonical(normalized)),'hex'));
  }
  hashes.sort(Buffer.compare);const content=createHash('sha256');for(const h of hashes)content.update(h);tables.push({name,count:hashes.length,dataDigest:content.digest('hex')});
 }
 return {schemaFingerprint:hash(canonical(schema)),tables,totalRows,tableCount:tables.length};
}
function verifyInventory(actual,expected){if(canonical(actual)!==canonical(expected))fail('Restored schema, record counts or record digests do not match the encrypted manifest.');}
const prefix=length=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(length);return bytes;};

const storageRows=db=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_revision_storage'").get()?db.prepare('SELECT * FROM document_revision_storage ORDER BY document_id,revision').all():[];
function verifyStorageReference(row,tenant){
 if(row.tenant_id!==tenant||typeof row.document_id!=='string'||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.size)||row.size<1||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.object_key!=='string'||!row.object_key)fail('Document storage reference tenant, checksum or immutable identity is invalid.');
 if(typeof row.provider!=='string'||!['s3','neon'].includes(row.provider.toLowerCase())||typeof row.bucket!=='string'||!row.bucket||typeof row.namespace!=='string'||!row.namespace||row.provider.toLowerCase()==='s3'&&(typeof row.object_version!=='string'||!row.object_version)||row.object_version!==null&&row.object_version!==undefined&&(typeof row.object_version!=='string'||!row.object_version))fail('Document provider or exact immutable version reference is invalid.');
}
function verifyDocumentRevisions(db,mapped){
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_revisions'").get())for(const row of db.prepare('SELECT document_id,revision,bytes,sha256,metadata FROM document_revisions').iterate()){
  let metadata;try{metadata=JSON.parse(row.metadata);}catch{fail('Document revision metadata is invalid.');}const bytes=Buffer.from(row.bytes),hasReference=mapped.has(row.document_id+':'+row.revision);
  if((metadata.storage?.kind==='object'||!bytes.length)&&!hasReference)fail('External document revision mapping is missing.');
  if(bytes.length&&hash(bytes)!==row.sha256)fail('Inline document revision checksum verification failed.');
 }
}
async function captureDocumentObjects(db,tenant,adapter,limit){
 const references=[],chunks=[],stored=storageRows(db),mapped=new Set(stored.map(r=>r.document_id+':'+r.revision));let offset=0;
 verifyDocumentRevisions(db,mapped);
 for(const reference of stored){
  verifyStorageReference(reference,tenant);const revision=db.prepare('SELECT bytes,sha256 FROM document_revisions WHERE document_id=? AND revision=?').get(reference.document_id,reference.revision);
  if(!revision||revision.sha256!==reference.sha256)fail('Document storage mapping does not match its immutable revision.');
  let bytes=Buffer.from(revision.bytes);if(!bytes.length){if(typeof adapter?.exportStoredRevision!=='function')fail('External document recovery adapter is required.');const result=await adapter.exportStoredRevision(reference);const recovered=result instanceof Uint8Array?result:result?.bytes;if(!(recovered instanceof Uint8Array))fail('External document recovery adapter returned invalid bytes.');bytes=Buffer.from(recovered);}
  if(bytes.length!==reference.size||hash(bytes)!==reference.sha256)fail('External document revision checksum or size verification failed.');
  if(offset+bytes.length>limit)fail('Document recovery bundle exceeds archive byte limit.');references.push({reference,offset,size:bytes.length});chunks.push(bytes);offset+=bytes.length;
 }
 return {references,bytes:Buffer.concat(chunks)};
}
function verifyObjectEnvelope(manifest,payload,tenant){
 const objects=manifest.objects||[];if(!Array.isArray(objects)||objects.length>BACKUP_LIMITS.maxRows||!Number.isSafeInteger(manifest.sourceBytes)||manifest.sourceBytes<16)fail('Encrypted document bundle metadata is invalid.');
 if(manifest.version===1&&objects.length||payload.length!==(manifest.objectBytes||0))fail('Encrypted document bundle length is invalid.');
 const seen=new Set();let offset=0;const verified=[];
 for(const object of objects){const ref=object?.reference;verifyStorageReference(ref||{},tenant);const id=ref.document_id+':'+ref.revision;if(seen.has(id)||object.offset!==offset||object.size!==ref.size||offset+object.size>payload.length)fail('Encrypted document bundle identity or bounds are invalid.');seen.add(id);const bytes=payload.subarray(offset,offset+object.size);if(hash(bytes)!==ref.sha256)fail('Encrypted document recovery checksum is invalid.');verified.push({reference:ref,bytes});offset+=object.size;}
 if(offset!==payload.length)fail('Encrypted document bundle contains unreferenced bytes.');return verified;
}
function materializeDocumentObjects(db,objects,tenant){
 const current=storageRows(db);if(current.length!==objects.length)fail('External document archive is incomplete.');if(!objects.length)return 0;
 const byId=new Map(objects.map(o=>[o.reference.document_id+':'+o.reference.revision,o]));
 const trigger=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name='document_revision_no_update' AND tbl_name='document_revisions'").get();if(!trigger?.sql)fail('Immutable document revision update guard is missing.');
 let materialized=0;db.exec('DROP TRIGGER '+quote(trigger.name));try{
  for(const reference of current){verifyStorageReference(reference,tenant);const object=byId.get(reference.document_id+':'+reference.revision);if(!object||canonical(object.reference)!==canonical(reference))fail('Encrypted document mapping differs from restored database provenance.');const row=db.prepare('SELECT bytes,sha256 FROM document_revisions WHERE document_id=? AND revision=?').get(reference.document_id,reference.revision);if(!row||row.sha256!==reference.sha256)fail('Restored document checksum differs from its provenance.');const bytes=Buffer.from(row.bytes);if(bytes.length){if(bytes.length!==reference.size||hash(bytes)!==reference.sha256)fail('Restored inline document checksum is invalid.');}else{db.prepare('UPDATE document_revisions SET bytes=? WHERE document_id=? AND revision=?').run(object.bytes,reference.document_id,reference.revision);materialized++;}const verified=db.prepare('SELECT bytes FROM document_revisions WHERE document_id=? AND revision=?').get(reference.document_id,reference.revision);if(Buffer.from(verified.bytes).length!==reference.size||hash(verified.bytes)!==reference.sha256)fail('Recovered inline document verification failed.');}
 }finally{db.exec(trigger.sql);}return materialized;
}

export async function backupWorkspace({db,outputPath,tenantId,encryptionKey,maxBytes,documentStorage,_databaseKind='workspace'}={}){
 const tenant=uuid(tenantId),key=parseBackupKey(encryptionKey),limit=bound(maxBytes);if(!db?.prepare||typeof outputPath!=='string'||!outputPath)fail('A live SQLite connection and explicit output path are required.');
 const output=resolve(outputPath);await absent(output);const dir=await privateDir(dirname(output));let snapshot;
 try{
  const sourcePath=join(dir,'source.sqlite');db.prepare('VACUUM INTO ?').run(sourcePath);await chmod(sourcePath,0o600);
  const stat=await lstat(sourcePath);if(stat.size>limit)fail('Workspace snapshot exceeds the archive byte limit.');
  snapshot=new DatabaseSync(sourcePath,{readOnly:true});const contents=inventory(snapshot,_databaseKind),objects=await captureDocumentObjects(snapshot,tenant,documentStorage,limit);snapshot.close();snapshot=null;
  const source=await readFile(sourcePath),manifest={version:objects.references.length?2:1,tenantId:tenant,createdAt:new Date().toISOString(),databaseKind:_databaseKind,sourceSha256:hash(source),sourceBytes:source.length,objects:objects.references,objectBytes:objects.bytes.length,inventory:contents,scope:_databaseKind==='platform'?'Full platform registry SQLite snapshot; workspace databases and external keys are not included.':'Full workspace SQLite snapshot with exact external document recovery bytes; platform registry and external keys are not included.',mfaDependency:'Retain MFA_ENCRYPTION_KEY separately to use restored enabled MFA accounts.'};
  const metadata=Buffer.from(JSON.stringify(manifest));if(metadata.length>BACKUP_LIMITS.maxManifestBytes)fail('Backup manifest exceeds the limit.');
  const iv=randomBytes(12),aad={format:FORMAT,version:1,tenantId:tenant},cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(canonical(aad)));
  const encrypted=Buffer.concat([cipher.update(prefix(metadata.length)),cipher.update(metadata),cipher.update(source),cipher.update(objects.bytes),cipher.final()]);
  const header=Buffer.from(JSON.stringify({...aad,nonce:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));
  const archive=Buffer.concat([MAGIC,prefix(header.length),header,encrypted]);if(archive.length>limit)fail('Encrypted archive exceeds the byte limit including metadata.');
  const staged=join(dir,'archive.wbackup');await writePrivate(staged,archive);await publish(staged,output);
  return {outputPath:output,tenantId:tenant,archiveBytes:archive.length,archiveSha256:hash(archive),createdAt:manifest.createdAt,sourceBytes:source.length,sourceSha256:manifest.sourceSha256,...contents,externalDocumentRevisions:objects.references.length,encrypted:true};
 }finally{snapshot?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
}

export async function restoreWorkspace({archivePath,destinationPath,expectedTenantId,encryptionKey,maxBytes,_databaseKind='workspace'}={}){
 const tenant=uuid(expectedTenantId),key=parseBackupKey(encryptionKey),limit=bound(maxBytes);if(typeof archivePath!=='string'||typeof destinationPath!=='string'||!archivePath||!destinationPath)fail('Explicit archive and new destination paths are required.');
 const destination=resolve(destinationPath);await absent(destination);let dir,db;
 try{
  const handle=await open(resolve(archivePath),'r');let archive;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit||stat.size<MAGIC.length+4)fail('Backup archive is invalid or exceeds the byte limit.');archive=Buffer.alloc(stat.size);let position=0;while(position<archive.length){const {bytesRead}=await handle.read(archive,position,archive.length-position,position);if(!bytesRead)fail('Backup archive changed or was truncated while reading.');position+=bytesRead;}if((await handle.stat()).size!==stat.size)fail('Backup archive changed while reading.');}finally{await handle.close();}
  if(!archive.subarray(0,MAGIC.length).equals(MAGIC))fail('Backup archive format is invalid.');const headerLength=archive.readUInt32BE(MAGIC.length),start=MAGIC.length+4;if(headerLength>4096||headerLength<1||start+headerLength>=archive.length)fail('Backup archive header is invalid.');
  let header;try{header=JSON.parse(archive.subarray(start,start+headerLength).toString('utf8'));}catch{fail('Backup archive header is invalid.');}
  if(!header||Object.keys(header).sort().join(',')!=='format,nonce,tag,tenantId,version'||header.format!==FORMAT||header.version!==1||uuid(header.tenantId)!==tenant)fail('Backup version or expected tenant does not match.');
  const iv=Buffer.from(String(header.nonce),'base64'),tag=Buffer.from(String(header.tag),'base64');if(iv.length!==12||tag.length!==16||iv.toString('base64')!==header.nonce||tag.toString('base64')!==header.tag)fail('Backup encryption header is invalid.');
  let plaintext;try{const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(canonical({format:FORMAT,version:1,tenantId:tenant})));decipher.setAuthTag(tag);plaintext=Buffer.concat([decipher.update(archive.subarray(start+headerLength)),decipher.final()]);}catch{fail('Backup authentication failed; key or encrypted archive is invalid.');}
  if(plaintext.length<4)fail('Encrypted backup envelope is invalid.');const manifestLength=plaintext.readUInt32BE();if(manifestLength<1||manifestLength>BACKUP_LIMITS.maxManifestBytes||manifestLength+4>=plaintext.length)fail('Encrypted backup manifest is invalid.');let manifest;try{manifest=JSON.parse(plaintext.subarray(4,4+manifestLength).toString('utf8'));}catch{fail('Encrypted backup manifest is invalid.');}
  const payload=plaintext.subarray(4+manifestLength),source=payload.subarray(0,manifest.sourceBytes);if(![1,2].includes(manifest.version)||manifest.tenantId!==tenant||manifest.sourceBytes!==source.length||manifest.sourceSha256!==hash(source))fail('Encrypted source hash or tenant verification failed.');
  if((manifest.databaseKind||'workspace')!==_databaseKind)fail('Encrypted database recovery kind does not match.');
  const objects=verifyObjectEnvelope(manifest,payload.subarray(manifest.sourceBytes),tenant);
  if(!source.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))fail('Encrypted source is not a SQLite database.');
  dir=await privateDir(dirname(destination));const staged=join(dir,'restored.sqlite');await writePrivate(staged,source);
  db=new DatabaseSync(staged);db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;');const before=inventory(db,_databaseKind);verifyInventory(before,manifest.inventory);
  const names=new Set(before.tables.map(t=>t.name));db.exec('BEGIN IMMEDIATE');const cleared={};let materializedDocumentRevisions=0;try{
   materializedDocumentRevisions=materializeDocumentObjects(db,objects,tenant);verifyDocumentRevisions(db,new Set(storageRows(db).map(r=>r.document_id+':'+r.revision)));
   if(names.has('sessions'))cleared.sessions=db.prepare('DELETE FROM sessions').run().changes;
   if(names.has('platform_sessions'))cleared.platformSessions=db.prepare('DELETE FROM platform_sessions').run().changes;
   if(names.has('mfa_challenges'))cleared.mfaChallenges=db.prepare('DELETE FROM mfa_challenges').run().changes;
   if(names.has('mfa_settings'))cleared.pendingMfaEnrollments=db.prepare('UPDATE mfa_settings SET pending_secret=NULL,pending_expires=NULL,pending_attempts=0,pending_binding=NULL WHERE pending_secret IS NOT NULL OR pending_expires IS NOT NULL OR pending_binding IS NOT NULL OR pending_attempts<>0').run().changes;
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const after=inventory(db,_databaseKind);if(after.schemaFingerprint!==before.schemaFingerprint)fail('Restored schema changed during authentication cleanup.');
  for(const table of before.tables)if(!['sessions','platform_sessions','mfa_challenges','mfa_settings',...(materializedDocumentRevisions?['document_revisions']:[])].includes(table.name)&&canonical(table)!==canonical(after.tables.find(t=>t.name===table.name)))fail('Retained business or audit history changed during restore.');
  if(names.has('sessions')&&after.tables.find(t=>t.name==='sessions').count!==0||names.has('platform_sessions')&&after.tables.find(t=>t.name==='platform_sessions').count!==0||names.has('mfa_challenges')&&after.tables.find(t=>t.name==='mfa_challenges').count!==0)fail('Restored authentication cleanup failed.');
  if(materializedDocumentRevisions&&before.tables.find(t=>t.name==='document_revisions').count!==after.tables.find(t=>t.name==='document_revisions').count)fail('Recovered document revision count changed.');
  db.close();db=null;const finalFile=await open(staged,'r');try{await finalFile.sync();}finally{await finalFile.close();}await publish(staged,destination);
  return {destinationPath:destination,tenantId:tenant,verified:true,restoredAt:new Date().toISOString(),archiveSha256:hash(archive),sourceSha256:manifest.sourceSha256,restoredSha256:hash(await readFile(staged)),verifiedSourceInventory:before,restoredInventory:after,cleared,materializedDocumentRevisions,mfaDependency:manifest.mfaDependency,notice:'Offline local restore verified. No automatic scheduling, cloud durability or funded recovery service is implied.'};
 }finally{db?.close();key.fill(0);if(dir)await rm(dir,{recursive:true,force:true});}
}

// This adapter must address immutable private object versions. The archive is
// already encrypted; upload acknowledgment alone never counts as durability.
export async function publishOffHostBackup({archivePath,tenantId,encryptionKey,store,maxBytes}={}){
 const tenant=uuid(tenantId),limit=bound(maxBytes);
 if(!store||store.offHost!==true||store.private!==true||typeof store.putImmutable!=='function'||typeof store.readVersion!=='function')fail('A private off-host immutable archive store with exact-version readback is required.');
 const file=await open(resolve(archivePath),'r');let bytes;try{const stat=await file.stat();if(!stat.isFile()||stat.size>limit)fail('Encrypted archive exceeds the archive limit.');bytes=await file.readFile();if(bytes.length!==stat.size)fail('Archive changed during publication.');}finally{await file.close();}
 if(!bytes.subarray(0,MAGIC.length).equals(MAGIC)||bytes.length<MAGIC.length+4)fail('Only a Wimblo encrypted backup archive can be published.');
 const size=bytes.readUInt32BE(MAGIC.length),start=MAGIC.length+4;let header;try{if(size<1||size>4096||start+size>=bytes.length)throw Error();header=JSON.parse(bytes.subarray(start,start+size));}catch{fail('Backup archive header is invalid.');}
 if(header.format!==FORMAT||header.version!==1||uuid(header.tenantId)!==tenant)fail('Off-host archive tenant or format does not match.');
 const verificationDir=await privateDir(dirname(resolve(archivePath)));try{const captured=join(verificationDir,'captured.wbackup');await writePrivate(captured,bytes);await restoreWorkspace({archivePath:captured,destinationPath:join(verificationDir,'verified.sqlite'),expectedTenantId:tenant,encryptionKey,maxBytes:limit});}finally{await rm(verificationDir,{recursive:true,force:true});}
 const archiveSha256=hash(bytes),reference=await store.putImmutable({tenantId:tenant,bytes,sha256:archiveSha256});
 if(!reference||typeof reference.key!=='string'||!reference.key||typeof reference.versionId!=='string'||!reference.versionId)fail('Off-host store did not return an immutable object version.');
 const readback=await store.readVersion({tenantId:tenant,key:reference.key,versionId:reference.versionId,maxBytes:limit});
 if(!(readback instanceof Uint8Array)||readback.length!==bytes.length||hash(readback)!==archiveSha256)fail('Off-host archive readback verification failed. Uploaded object is not a verified recovery archive.');
 return {tenantId:tenant,archiveSha256,archiveBytes:bytes.length,key:reference.key,versionId:reference.versionId,createdAt:new Date().toISOString(),verified:true,offHost:true,encrypted:true,notice:'Exact encrypted archive readback verified. Store retention and geographic durability remain deployment-owner responsibilities.'};
}

export const backupPlatformRegistry=options=>backupWorkspace({...options,_databaseKind:'platform'});
export const restorePlatformRegistry=options=>restoreWorkspace({...options,_databaseKind:'platform'});
