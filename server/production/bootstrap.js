import {randomBytes,randomUUID,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parsePostgresConnectionUrl} from '../persistence/databaseUrl.js';
import {createPostgresPool} from '../persistence/index.js';

const derive=promisify(scrypt);
const text=(value,label,max)=>{const out=typeof value==='string'?value.trim():'';if(!out||out.length>max)throw new Error(`Production bootstrap requires ${label}.`);return out;};
const secret=(value,label,max)=>{if(typeof value!=='string'||!value||value.length>max)throw new Error(`Production bootstrap requires ${label}.`);return value;};
const email=value=>{const out=text(value,'BOOTSTRAP_OWNER_EMAIL',320).toLowerCase();if(!/^[^\s@]+@[^\s@]+$/.test(out))throw new Error('Production bootstrap requires a valid BOOTSTRAP_OWNER_EMAIL.');return out;};
const region=value=>{const out=text(value,'an approved region',32);if(!['us-east-1','us-east-2','us-west-1','us-west-2','ca-central-1','ca-west-1'].includes(out))throw new Error('Production bootstrap region is not approved.');return out;};

async function defaultHashPassword(password){const salt=randomBytes(16).toString('hex'),digest=await derive(password,salt,64);return `scrypt-v1:${salt}:${digest.toString('hex')}`;}

function bootstrapConfig(env){
 if(env.NODE_ENV!=='production'||env.BOOTSTRAP_CONFIRM!=='CREATE_INITIAL_TENANT')throw new Error('Production bootstrap requires NODE_ENV=production and the exact one-time confirmation.');
 const url=parsePostgresConnectionUrl(env.MIGRATION_DATABASE_URL,{label:'MIGRATION_DATABASE_URL',production:true,requireCredentials:true});
 const password=secret(env.BOOTSTRAP_OWNER_PASSWORD,'BOOTSTRAP_OWNER_PASSWORD',200);if(Buffer.byteLength(password,'utf8')<14)throw new Error('Production bootstrap owner password must contain at least 14 bytes.');
 return {url:url.toString(),tenantName:text(env.BOOTSTRAP_TENANT_NAME,'BOOTSTRAP_TENANT_NAME',200),ownerEmail:email(env.BOOTSTRAP_OWNER_EMAIL),ownerName:text(env.BOOTSTRAP_OWNER_NAME,'BOOTSTRAP_OWNER_NAME',200),password,databaseRegion:region(env.BOOTSTRAP_DATABASE_REGION),storageRegion:region(env.BOOTSTRAP_STORAGE_REGION)};
}

export async function runProductionBootstrap({env=process.env,poolFactory=createPostgresPool,hashPassword=defaultHashPassword,idFactory=randomUUID,now=()=>new Date()}={}){
 const config=bootstrapConfig(env),pool=poolFactory({connectionString:config.url,applicationName:'wimblo-production-bootstrap',max:1,min:0});
 try{return await pool.withAdminSession(async session=>{
  await session.query('BEGIN');
  try{
   await session.query("SELECT pg_advisory_xact_lock(hashtextextended('wimblo:production-bootstrap',0))");
   const {rows:[state]}=await session.query(`/*bootstrap_state*/ SELECT (SELECT count(*)::int FROM tenants) AS tenant_count,(SELECT count(*)::int FROM wimblo_platform.global_identities) AS identity_count,(SELECT count(*)::int FROM wimblo_platform.memberships) AS membership_count`);
   if(!state||state.tenant_count!==0||state.identity_count!==0||state.membership_count!==0)throw new Error('Production bootstrap refused because the target database is not empty.');
   const tenantId=idFactory(),identityId=idFactory(),membershipId=idFactory(),at=now().toISOString(),passwordHash=await hashPassword(config.password),modules=['core','sales'];
   await session.query(`INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region,status,created_at) VALUES($1,$2,'north-america',$3,$4,'active',$5::timestamptz)`,[tenantId,config.tenantName,config.databaseRegion,config.storageRegion,at]);
   await session.query(`INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5::timestamptz,$5::timestamptz)`,[identityId,config.ownerEmail,config.ownerName,passwordHash,at]);
   await session.query(`INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',$4::timestamptz,$4::timestamptz)`,[membershipId,tenantId,identityId,at]);
   for(const code of modules){
    await session.query(`INSERT INTO wimblo_platform.tenant_modules(tenant_id,module_key,state,config,enabled_at,updated_at) VALUES($1,$2,'enabled','{}'::jsonb,$3::timestamptz,$3::timestamptz)`,[tenantId,code,at]);
    await session.query(`INSERT INTO wimblo_platform.module_events(tenant_id,event_id,module_key,event_type,actor_identity_id,details,at) VALUES($1,$2,$3,'bootstrap_enabled',$4,$5::jsonb,$6::timestamptz)`,[tenantId,idFactory(),code,identityId,JSON.stringify({reason:'Initial production bootstrap',catalogVersion:1}),at]);
   }
   await session.query(`INSERT INTO wimblo_platform.control_audit(tenant_id,identity_id,actor_identity_id,action,target_type,target_id,details,at) VALUES($1,$2,$2,'production.bootstrap','tenant',$5,$3::jsonb,$4::timestamptz)`,[tenantId,identityId,JSON.stringify({modules}),at,tenantId]);
   await session.query('COMMIT');return {tenantId,ownerIdentityId:identityId,ownerMembershipId:membershipId,modules};
  }catch(error){await session.query('ROLLBACK').catch(()=>{});throw error;}
 });}finally{await pool.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runProductionBootstrap().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`Wimblo production bootstrap failed: ${error.message}\n`);process.exitCode=1;});
