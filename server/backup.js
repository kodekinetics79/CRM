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

function inventory(db){
 db.exec('PRAGMA trusted_schema=OFF');
 const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')fail('SQLite integrity verification failed.');
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all();
 if(Buffer.byteLength(canonical(schema))>BACKUP_LIMITS.maxManifestBytes)fail('Workspace schema exceeds the backup limit.');
 const names=schema.filter(r=>r.type==='table').map(r=>r.name).sort();if(names.length>BACKUP_LIMITS.maxTables)fail('Workspace exceeds the 200-table backup limit.');
 for(const required of ['records','users','sessions','settings','audit'])if(!names.includes(required))fail('Source is not a complete Wimblo workspace database.');
 if(names.includes('platform_sessions')||names.includes('administrators')||names.includes('tenants'))fail('Platform registry databases are outside this workspace-only backup.');
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

export async function backupWorkspace({db,outputPath,tenantId,encryptionKey,maxBytes}={}){
 const tenant=uuid(tenantId),key=parseBackupKey(encryptionKey),limit=bound(maxBytes);if(!db?.prepare||typeof outputPath!=='string'||!outputPath)fail('A live SQLite connection and explicit output path are required.');
 const output=resolve(outputPath);await absent(output);const dir=await privateDir(dirname(output));let snapshot;
 try{
  const sourcePath=join(dir,'source.sqlite');db.prepare('VACUUM INTO ?').run(sourcePath);await chmod(sourcePath,0o600);
  const stat=await lstat(sourcePath);if(stat.size>limit)fail('Workspace snapshot exceeds the archive byte limit.');
  snapshot=new DatabaseSync(sourcePath,{readOnly:true});const contents=inventory(snapshot);snapshot.close();snapshot=null;
  const source=await readFile(sourcePath),manifest={version:1,tenantId:tenant,createdAt:new Date().toISOString(),sourceSha256:hash(source),sourceBytes:source.length,inventory:contents,scope:'Full workspace SQLite snapshot; platform registry and external keys are not included.',mfaDependency:'Retain MFA_ENCRYPTION_KEY separately to use restored enabled MFA accounts.'};
  const metadata=Buffer.from(JSON.stringify(manifest));if(metadata.length>BACKUP_LIMITS.maxManifestBytes)fail('Backup manifest exceeds the limit.');
  const iv=randomBytes(12),aad={format:FORMAT,version:1,tenantId:tenant},cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(canonical(aad)));
  const encrypted=Buffer.concat([cipher.update(prefix(metadata.length)),cipher.update(metadata),cipher.update(source),cipher.final()]);
  const header=Buffer.from(JSON.stringify({...aad,nonce:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));
  const archive=Buffer.concat([MAGIC,prefix(header.length),header,encrypted]);if(archive.length>limit)fail('Encrypted archive exceeds the byte limit including metadata.');
  const staged=join(dir,'archive.wbackup');await writePrivate(staged,archive);await publish(staged,output);
  return {outputPath:output,tenantId:tenant,archiveBytes:archive.length,sourceBytes:source.length,sourceSha256:manifest.sourceSha256,...contents,encrypted:true};
 }finally{snapshot?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
}

export async function restoreWorkspace({archivePath,destinationPath,expectedTenantId,encryptionKey,maxBytes}={}){
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
  const source=plaintext.subarray(4+manifestLength);if(manifest.version!==1||manifest.tenantId!==tenant||manifest.sourceBytes!==source.length||manifest.sourceSha256!==hash(source))fail('Encrypted source hash or tenant verification failed.');
  if(!source.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))fail('Encrypted source is not a SQLite database.');
  dir=await privateDir(dirname(destination));const staged=join(dir,'restored.sqlite');await writePrivate(staged,source);
  db=new DatabaseSync(staged);db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;');const before=inventory(db);verifyInventory(before,manifest.inventory);
  const names=new Set(before.tables.map(t=>t.name));db.exec('BEGIN IMMEDIATE');const cleared={};try{
   cleared.sessions=db.prepare('DELETE FROM sessions').run().changes;
   if(names.has('mfa_challenges'))cleared.mfaChallenges=db.prepare('DELETE FROM mfa_challenges').run().changes;
   if(names.has('mfa_settings'))cleared.pendingMfaEnrollments=db.prepare('UPDATE mfa_settings SET pending_secret=NULL,pending_expires=NULL,pending_attempts=0,pending_binding=NULL WHERE pending_secret IS NOT NULL OR pending_expires IS NOT NULL OR pending_binding IS NOT NULL OR pending_attempts<>0').run().changes;
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const after=inventory(db);if(after.schemaFingerprint!==before.schemaFingerprint)fail('Restored schema changed during authentication cleanup.');
  for(const table of before.tables)if(!['sessions','mfa_challenges','mfa_settings'].includes(table.name)&&canonical(table)!==canonical(after.tables.find(t=>t.name===table.name)))fail('Retained business or audit history changed during restore.');
  if(after.tables.find(t=>t.name==='sessions').count!==0||names.has('mfa_challenges')&&after.tables.find(t=>t.name==='mfa_challenges').count!==0)fail('Restored authentication cleanup failed.');
  db.close();db=null;const finalFile=await open(staged,'r');try{await finalFile.sync();}finally{await finalFile.close();}await publish(staged,destination);
  return {destinationPath:destination,tenantId:tenant,sourceSha256:manifest.sourceSha256,restoredSha256:hash(await readFile(staged)),verifiedSourceInventory:before,restoredInventory:after,cleared,mfaDependency:manifest.mfaDependency,notice:'Offline local restore verified. No automatic scheduling, cloud durability or funded recovery service is implied.'};
 }finally{db?.close();key.fill(0);if(dir)await rm(dir,{recursive:true,force:true});}
}
