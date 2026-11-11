import {isAbsolute,resolve} from 'node:path';

const fail=message=>{throw new Error(message);};
const TLS_MODES=new Set(['require','verify-ca','verify-full']);
const REGIONS=new Set(['us-east-1','us-east-2','us-west-1','us-west-2','ca-central-1','ca-west-1']);
const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const bucket=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);

function exactOrigin(value){
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==value)return null;
  return url.origin;
 }catch{return null;}
}

function databaseUrl(value){
 try{
  const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.hostname||!url.pathname||url.pathname==='/')return null;
  if(!TLS_MODES.has(url.searchParams.get('sslmode')||''))return null;
  return url;
 }catch{return null;}
}

function key32(value){
 if(typeof value!=='string')return false;
 if(/^[a-f0-9]{64}$/i.test(value))return true;
 if(!/^[A-Za-z0-9+/]{43}=$/.test(value))return false;
 const bytes=Buffer.from(value,'base64');
 return bytes.length===32&&bytes.toString('base64')===value;
}

function integer(env,name,{min,max,defaultValue}){
 const raw=env[name]??String(defaultValue),value=Number(raw);
 if(!Number.isSafeInteger(value)||value<min||value>max)fail(`SaaS production ${name} must be an integer between ${min} and ${max}.`);
 return value;
}

function rejectedLegacySetting(env){
 if(['CLIENT_EVALUATION_MODE','DEMO_MODE','ALLOW_DEMO','ENABLE_ACCEPTANCE'].some(key=>env[key]===true||String(env[key]||'').toLowerCase()==='true'))return true;
 if(typeof env.CLIENT_EVALUATION_DATA_DIR==='string'&&env.CLIENT_EVALUATION_DATA_DIR.trim())return true;
 return ['sync-postgres','sync','worker-thread'].includes(String(env.PERSISTENCE_DRIVER||'').toLowerCase());
}

export function resolveSaasRuntimeConfig(env=process.env,root=process.cwd()){
 if(env.NODE_ENV!=='production'||env.WIMBLO_RUNTIME!=='saas')fail('SaaS runtime requires NODE_ENV=production and WIMBLO_RUNTIME=saas.');
 if(!['web','worker'].includes(env.PROCESS_ROLE))fail('SaaS production requires PROCESS_ROLE=web or worker.');
 const appOrigin=exactOrigin(env.APP_ORIGIN);
 if(!appOrigin)fail('SaaS production requires APP_ORIGIN to be an exact HTTPS origin.');
 if(!env.DATABASE_URL||!env.CONTROL_DATABASE_URL)fail('SaaS production requires DATABASE_URL and CONTROL_DATABASE_URL.');
 const tenantUrl=databaseUrl(env.DATABASE_URL),controlUrl=databaseUrl(env.CONTROL_DATABASE_URL);
 if(!tenantUrl||!controlUrl)fail('SaaS production database URLs must require TLS.');
 if(tenantUrl.username.toLowerCase()===controlUrl.username.toLowerCase())fail('SaaS tenant and control databases require distinct runtime roles.');
 if(rejectedLegacySetting(env))fail('SaaS production rejects evaluator, demo, temporary-storage and synchronous PostgreSQL settings.');
 if(!key32(env.MFA_ENCRYPTION_KEY))fail('SaaS production requires a valid 32-byte MFA_ENCRYPTION_KEY.');
 if(typeof env.SESSION_SECRET!=='string'||Buffer.byteLength(env.SESSION_SECRET,'utf8')<32)fail('SaaS production requires SESSION_SECRET with at least 32 bytes.');
 if(!key32(env.BACKUP_ENCRYPTION_KEY))fail('SaaS production requires a valid 32-byte BACKUP_ENCRYPTION_KEY.');
 if(env.DOCUMENT_STORAGE_PROVIDER!=='s3'||!bucket(env.DOCUMENT_STORAGE_BUCKET)||!safeName(env.DOCUMENT_STORAGE_NAMESPACE)||env.DOCUMENT_STORAGE_PRIVATE_CONFIRMED!=='true'||!REGIONS.has(env.AWS_REGION))fail('SaaS production requires verified private document storage in an approved region.');
 if(!bucket(env.BACKUP_STORAGE_BUCKET)||!safeName(env.BACKUP_STORAGE_NAMESPACE)||env.BACKUP_STORAGE_PRIVATE_CONFIRMED!=='true'||!REGIONS.has(env.BACKUP_AWS_REGION||env.AWS_REGION))fail('SaaS production requires verified private backup storage in an approved region.');
 if(!env.AWS_ACCESS_KEY_ID||!env.AWS_SECRET_ACCESS_KEY)fail('SaaS production requires server-only object storage credentials.');
 if(env.AWS_ENDPOINT_URL||env.AWS_ENDPOINT_URL_S3||env.BACKUP_AWS_ENDPOINT_URL||env.BACKUP_AWS_ENDPOINT_URL_S3)fail('SaaS production object storage cannot use a custom endpoint.');
 if(typeof root!=='string'||!isAbsolute(resolve(root)))fail('SaaS production requires an absolute application root.');
 const cookieName=env.SESSION_COOKIE_NAME||'wimblo_session';
 if(!/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(cookieName))fail('SaaS production session cookie name is invalid.');
 const limits=Object.freeze({
  trustProxyHops:integer(env,'TRUST_PROXY_HOPS',{min:1,max:3,defaultValue:1}),
  dbPoolMax:integer(env,'DB_POOL_MAX',{min:1,max:50,defaultValue:10}),
  jobConcurrency:integer(env,'JOB_CONCURRENCY',{min:1,max:32,defaultValue:4}),
  jobLeaseMs:integer(env,'JOB_LEASE_MS',{min:5000,max:300000,defaultValue:30000})
 });
 const objectStorage=Object.freeze({
  provider:'s3',bucket:env.DOCUMENT_STORAGE_BUCKET,namespace:env.DOCUMENT_STORAGE_NAMESPACE,region:env.AWS_REGION,privateConfirmed:true,
  credentials:Object.freeze({accessKeyId:env.AWS_ACCESS_KEY_ID,secretAccessKey:env.AWS_SECRET_ACCESS_KEY,...(env.AWS_SESSION_TOKEN?{sessionToken:env.AWS_SESSION_TOKEN}:{})})
 });
 const publicMetadata=()=>Object.freeze({mode:'saas',processRole:env.PROCESS_ROLE,appOrigin,cookieName,objectStorage:Object.freeze({provider:'s3',region:env.AWS_REGION,privateConfirmed:true}),limits});
 return Object.freeze({
  mode:'saas',root:resolve(root),processRole:env.PROCESS_ROLE,appOrigin,cookieName,
  tenantDatabaseUrl:env.DATABASE_URL,controlDatabaseUrl:env.CONTROL_DATABASE_URL,
  mfaEncryptionKey:env.MFA_ENCRYPTION_KEY,sessionSecret:env.SESSION_SECRET,backupEncryptionKey:env.BACKUP_ENCRYPTION_KEY,
  objectStorage,backupStorage:Object.freeze({bucket:env.BACKUP_STORAGE_BUCKET,namespace:env.BACKUP_STORAGE_NAMESPACE,region:env.BACKUP_AWS_REGION||env.AWS_REGION,privateConfirmed:true}),
  limits,publicMetadata
 });
}
