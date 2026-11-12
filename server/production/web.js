import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveSaasRuntimeConfig} from './runtimeConfig.js';
import {poolFromEnv,controlPoolFromEnv} from '../persistence/index.js';
import {createProductionApp} from './app.js';
import {certifyProductionPools} from './startupChecks.js';

const closeServer=server=>new Promise((resolveClose,reject)=>{if(!server?.close)return resolveClose();let settled=false;const done=error=>{if(settled)return;settled=true;error?reject(error):resolveClose();};const result=server.close(done);if(result&&typeof result.then==='function')result.then(()=>done(),done);});

export async function startWebRuntime({config,app,pools=[],listen,verify=async()=>{}}={}){
 if(config?.processRole!=='web')throw new Error('SaaS web entrypoint requires the web process role.');
 if(typeof listen!=='function')throw new TypeError('SaaS web entrypoint requires an HTTP listener factory.');
 let poolClose;const closePools=()=>poolClose??=Promise.allSettled(pools.map(pool=>pool.end()));let server;
 try{await verify();server=await listen(app);}catch(error){await closePools();throw error;}
 let closed=false;return {server,async close(){if(closed)return;closed=true;try{await closeServer(server);}finally{await closePools();}}};
}

export async function main(env=process.env){
 const config=resolveSaasRuntimeConfig(env,process.cwd()),overrides={max:config.limits.dbPoolMax};
 const tenantPool=poolFromEnv(env,overrides),controlPool=controlPoolFromEnv(env,overrides),app=createProductionApp({config,controlPool,tenantPool});
 const runtime=await startWebRuntime({config,app,pools:[controlPool,tenantPool],verify:()=>certifyProductionPools({tenantPool,controlPool}),listen:value=>new Promise((resolveListen,reject)=>{const server=value.listen(config.http.port,config.http.host,()=>resolveListen(server));server.once('error',reject);})});
 const shutdown=()=>runtime.close().catch(error=>{process.stderr.write(`Wimblo web shutdown failed: ${error.message}\n`);process.exitCode=1;});process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 return runtime;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{process.stderr.write(`Wimblo web startup failed: ${error.message}\n`);process.exitCode=1;});
