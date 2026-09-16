import {lstat,realpath,mkdtemp,open,rm} from 'node:fs/promises';
import {createDecipheriv} from 'node:crypto';
import {resolve,relative,join,isAbsolute} from 'node:path';
import {parseBackupKey} from './backup.js';

const validKey=value=>{let key;try{key=parseBackupKey(value);return true;}catch{return false;}finally{key?.fill(0);}};
const separateKeys=(a,b)=>{let first,second;try{first=parseBackupKey(a);second=parseBackupKey(b);return !first.equals(second);}catch{return false;}finally{first?.fill(0);second?.fill(0);}};
const fresh=(value,now,maxAge)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now&&now-Date.parse(value)<=maxAge;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const inside=(root,path)=>{const part=relative(root,path);return !part.startsWith('..')&&!isAbsolute(part);};

export function createHealthMonitoringProbe({origin,alertDrill,fetchImpl=globalThis.fetch,now=Date.now}={}){
 return {async probe(){
  const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw Error('Explicit HTTPS monitoring origin required.');
  const response=await fetchImpl(new URL('/api/health',url),{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});if(!response.ok||!response.body?.getReader)throw Error('Health monitor failed.');
  const reader=response.body.getReader();let total=0;const chunks=[];try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>2048)throw Error('Health monitor response exceeded limit.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const health=JSON.parse(Buffer.concat(chunks));return {verified:health.status==='ok'&&alertDrill?.verified===true&&fresh(alertDrill.at,now(),86400000),scope:'Live application health checked; alert drill is separately supplied operator evidence.'};
 }};
}

// Operational evidence is supplied by the deployment owner. A passing result is
// not a compliance certification, a cloud SLA, or a substitute for a restore drill.
export async function inspectProductionReadiness({env=process.env,db,dbPath,durableRoot,expectedTenantId,objectStorage,recoveryEvidence={},monitoring,now=Date.now()}={}){
 const checks=[];const add=(id,ok,detail)=>checks.push({id,status:ok?'pass':'blocked',detail});
 add('production-mode',env.NODE_ENV==='production'&&env.EVALUATOR_MODE!=='true'&&env.ALLOW_DEMO!=='true','Production requires evaluation and demo access to be disabled.');
 let origin=false;try{const u=new URL(env.APP_ORIGIN);origin=u.protocol==='https:'&&u.origin===env.APP_ORIGIN&&!u.username&&!u.password;}catch{}
 add('https-origin',origin,'A single explicit HTTPS application origin is required.');
 add('runtime',Number(process.versions.node.split('.')[0])>=24,'Node.js 24 or later is required for the SQLite runtime.');
 add('mfa-key',validKey(env.MFA_ENCRYPTION_KEY),'A separately retained 32-byte MFA encryption key is required.');
 add('backup-key',separateKeys(env.BACKUP_ENCRYPTION_KEY,env.MFA_ENCRYPTION_KEY),'Backup encryption requires a valid key separate from the MFA key.');
 let database=false,demo=false,administrator=false;try{database=Object.values(db.prepare('PRAGMA quick_check').get())[0]==='ok';demo=Boolean(db.prepare("SELECT 1 FROM users WHERE email IN ('alex@foundation.example','staff@foundation.example','board@foundation.example')").get());administrator=Boolean(db.prepare("SELECT 1 FROM users WHERE active=1 AND role='admin'").get());}catch{}
 add('workspace-integrity',database,'The current workspace must pass SQLite verification.');add('workspace-accounts',database&&!demo&&administrator,'A current administrator and no synthetic demonstration accounts are required.');
 let adminMfa=false,workspaceMfa=false,mfaKey;try{mfaKey=parseBackupKey(env.MFA_ENCRYPTION_KEY);const accounts=db.prepare("SELECT u.id,u.role,m.enabled,m.encrypted_secret FROM users u LEFT JOIN mfa_settings m ON m.user_id=u.id WHERE u.active=1").all();const readable=a=>{if(a.enabled!==1)return false;const [version,nonce,tag,ciphertext,...extra]=a.encrypted_secret.split('.');if(version!=='v1'||extra.length)return false;const decipher=createDecipheriv('aes-256-gcm',mfaKey,Buffer.from(nonce,'base64'));decipher.setAAD(Buffer.from('wimblo-mfa-v1:'+a.id));decipher.setAuthTag(Buffer.from(tag,'base64'));const plaintext=Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]);try{return plaintext.length>0;}finally{plaintext.fill(0);}};const admins=accounts.filter(a=>a.role==='admin');adminMfa=admins.length>0&&admins.every(readable);workspaceMfa=accounts.length>0&&accounts.every(a=>['admin','staff','viewer','event-helper'].includes(a.role)&&readable(a));}catch{}finally{mfaKey?.fill(0);}
 add('administrator-mfa',adminMfa,'Every active workspace administrator must have enabled MFA readable with the configured retained key.');
 add('workspace-user-mfa',workspaceMfa,'Every active interactive workspace account (administrator, staff, viewer or event helper) must have enabled MFA readable with the configured retained key.');
 let persistence=false;let probe;try{if(!durableRoot||!dbPath||dbPath===':memory:'||!isAbsolute(dbPath)||!isAbsolute(durableRoot))throw Error();const root=await realpath(resolve(durableRoot)),file=await realpath(resolve(dbPath));const metadata=await lstat(dbPath);if(!metadata.isFile()||metadata.isSymbolicLink()||!inside(root,file))throw Error();probe=await mkdtemp(join(root,'.readiness-'));const handle=await open(join(probe,'write-check'),'wx',0o600);try{await handle.writeFile('Wimblo storage probe');await handle.sync();}finally{await handle.close();}persistence=true;}catch{}finally{if(probe)await rm(probe,{recursive:true,force:true});}
 add('persistent-workspace',persistence&&env.PERSISTENT_STORAGE_CONFIRMED==='true','A writable workspace under an explicitly confirmed persistent mount is required; the mount declaration remains operator evidence.');
 let externalCount=0,storage=true;try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_revision_storage'").get())externalCount=db.prepare('SELECT COUNT(*) n FROM document_revision_storage').get().n;if(externalCount)storage=typeof objectStorage?.verifyReadiness==='function'&&(await objectStorage.verifyReadiness()).verified===true;}catch{storage=false;}
 add('document-storage',storage,'Every external document revision requires a verified private immutable-version storage provider; inline SQLite revisions are covered by the workspace archive.');
 let pendingUploads=0,stagingKnown=true;try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_upload_attempts'").get())pendingUploads=db.prepare("SELECT COUNT(*) n FROM document_upload_attempts WHERE state IN ('Uploading','Verified','Orphaned')").get().n;}catch{stagingKnown=false;}
 add('document-upload-reconciliation',stagingKnown&&pendingUploads===0,'Uncommitted or unresolved private uploads require verified reconciliation before handover; an orphan is not covered by a completed-document backup.');
 const backup=recoveryEvidence.backup,restore=recoveryEvidence.restore,tenant=expectedTenantId;const tenantBound=typeof tenant==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(tenant)&&recoveryEvidence.tenantId===tenant;let storageBound=true;try{if(externalCount)storageBound=db.prepare('SELECT COUNT(*) n FROM document_revision_storage WHERE tenant_id<>?').get(tenant).n===0;}catch{storageBound=false;}add('recovery-identity',tenantBound&&storageBound,'Recovery evidence must match the explicitly selected workspace identity and every external revision tenant.');
 const backupOk=Boolean(tenantBound&&storageBound&&backup?.tenantId===tenant&&backup.verified===true&&backup.offHost===true&&digest(backup.archiveSha256)&&fresh(backup.createdAt,now,24*3600000));
 add('off-host-backup',backupOk,'A matching-tenant encrypted archive verified by off-host readback within 24 hours is required.');
 add('restore-drill',backupOk&&restore?.tenantId===tenant&&restore.verified===true&&restore.archiveSha256===backup.archiveSha256&&fresh(restore.restoredAt,now,30*86400000),'A successful matching-archive restore drill within 30 days is required, including document versions and business history.');
 let observed=false;try{observed=typeof monitoring?.probe==='function'&&(await monitoring.probe()).verified===true;}catch{}
 add('monitoring',observed,'An exercised external monitoring and alert path is required; a configured URL alone is insufficient.');
 add('retention-policy',recoveryEvidence.retention?.approved===true&&Number.isSafeInteger(recoveryEvidence.retention?.backupDays)&&recoveryEvidence.retention.backupDays>0,'The deployment owner must approve backup/document retention, deletion exceptions and tenant export procedures. No automated business-history deletion is implied.');
 return {ready:checks.every(c=>c.status==='pass'),checks,externalDocumentRevisions:externalCount,scope:'Runtime checks and supplied operational evidence only. Buyer approval, legal compliance, penetration testing, provider durability and service commitments are not certified.'};
}
