import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createPlatformApp} from '../../server/platform.js';
import {createApp} from '../../server/app.js';
import {schemaNameFor} from '../../server/persistence/postgresDatabase.js';

// PostgreSQL counterpart of tests/platform.test.js "lost nonlegacy storage fails closed
// after restart". That test loses storage by deleting the workspace's SQLite file, which
// cannot represent loss on PostgreSQL, where a workspace is a schema. The guarantee is the
// same on both engines and is what matters: a workspace whose storage is gone must refuse
// service, and must never silently recreate itself empty and carry on as if nothing happened.
// Run through the PostgreSQL harness: node scripts/test-postgres.mjs <this file>
const harness=globalThis.__wimbloPostgresHarness;
const platformAdmin={name:'Platform operator',email:'operator@example.test',password:'PlatformSecure!2026'};
const tenantAdmin={name:'Tenant administrator',email:'tenant-admin@example.test',password:'TenantSecure!2026'};
const cookies=headers=>headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');

async function fixture(t){
 assert.ok(harness?.pool,'This test requires the PostgreSQL harness preload; run it with scripts/test-postgres.mjs');
 const dir=await mkdtemp(join(tmpdir(),'wimblo-pg-lost-storage-'));
 const policies=new Map();let app,server,base;
 async function open(){
  app=createPlatformApp({rootDir:join(dir,'registry'),legacyDbPath:join(dir,'legacy.sqlite'),seedLegacy:true,initialPlatformAdmin:platformAdmin,tenantFactory:args=>{policies.set(args.tenantInfo.slug,{...args});return createApp(args);}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 }
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session}={}){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrfToken;}
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,json:await r.json()};
 }
 const loginWith=async(path,credentials,extra={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password,...extra})});assert.equal(r.status,200);return {...await r.json(),cookie:cookies(r.headers)};};
 return {request,policies,restart:async()=>{await close();await open();},
  loginPlatform:()=>loginWith('/api/platform/auth/login',platformAdmin),
  loginTenant:slug=>loginWith('/api/auth/login',tenantAdmin,{tenantSlug:slug})};
}

// Direct catalog access through a pooled handle, never through the application.
function withHandle(fn){const handle=harness.pool.acquire('lost-storage-probe');try{return fn(handle);}finally{handle.exec('DISCARD ALL');harness.pool.release(handle);}}
const schemaExists=schema=>withHandle(h=>Boolean(h.prepare('SELECT 1 FROM pg_namespace WHERE nspname=$1').get(schema)));

test('on PostgreSQL, a workspace whose schema is lost fails closed and is never silently recreated empty',async t=>{
 const f=await fixture(t);
 const operator=await f.loginPlatform();
 const created=await f.request('/api/platform/tenants',{method:'POST',session:operator,body:{slug:'alpha',name:'Workspace alpha',plan:'trial',admin:tenantAdmin,dataMode:'restricted',aiEnabled:false}});
 assert.equal(created.status,201,JSON.stringify(created.json));
 const alpha=await f.loginTenant('alpha');
 const schema=schemaNameFor(f.policies.get('alpha').dbPath,harness.pool.schemaPrefix);
 assert.equal(schemaExists(schema),true,'the workspace schema must exist before storage is lost');

 await f.restart();
 withHandle(h=>h.exec(`DROP SCHEMA "${schema}" CASCADE`));
 assert.equal(schemaExists(schema),false);

 assert.equal((await f.request('/api/workspace',{session:alpha})).status,503,'a workspace with lost storage must refuse service');
 assert.equal((await f.request('/api/auth/login',{method:'POST',body:{email:tenantAdmin.email,password:tenantAdmin.password,tenantSlug:'alpha'}})).status,503,'signing in to a workspace with lost storage must also refuse');
 assert.equal(schemaExists(schema),false,'serving requests must never silently recreate the lost workspace as an empty schema');

 const registry=await f.request('/api/platform/tenants',{session:operator});
 assert.equal(registry.status,200);
 assert.ok(registry.json.tenants.some(r=>r.id===created.json.tenant.id),'the control plane must still list the tenant so the loss is visible and recoverable');
});
