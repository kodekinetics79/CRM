import {performance} from 'node:perf_hooks';
import {createCrmRepository} from './crmRepository.js';

const bounded=(value,label,{min=1,max})=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError(`${label} must be between ${min} and ${max}.`);return value;};

export async function runRepresentativeCrmCapacity({tenantPool,tenantId,operations=40,concurrency=4,poolMax=2}={}){
 if(!tenantPool||typeof tenantPool.withTenantSession!=='function')throw new TypeError('Capacity certification requires a tenant PostgreSQL pool.');
 const total=bounded(operations,'Operations',{max:200}),requestedConcurrency=bounded(concurrency,'Concurrency',{max:16}),configuredPoolMax=bounded(poolMax,'Pool maximum',{max:32});
 let actualQueries=0,activeQueries=0,maxConcurrentQueries=0,activeOperations=0,maxConcurrentOperations=0,cursor=0,errors=0;
 const measuredSession=session=>({query:async(...args)=>{actualQueries++;activeQueries++;maxConcurrentQueries=Math.max(maxConcurrentQueries,activeQueries);try{return await session.query(...args);}finally{activeQueries--;}}});
 const measuredPool={
  withTenantSession:(id,fn)=>tenantPool.withTenantSession(id,session=>fn(measuredSession(session))),
  withTransaction:(id,fn)=>typeof tenantPool.withTransaction==='function'?tenantPool.withTransaction(id,session=>fn(measuredSession(session))):tenantPool.withTenantSession(id,session=>fn(measuredSession(session)))
 };
 const repository=createCrmRepository({tenantPool:measuredPool}),started=performance.now(),workerCount=Math.min(requestedConcurrency,configuredPoolMax,total);
 const worker=async()=>{while(cursor<total){const operation=cursor++;activeOperations++;maxConcurrentOperations=Math.max(maxConcurrentOperations,activeOperations);try{await repository.listParties(tenantId,{type:operation%2===0?'person':'organization',search:operation%3===0?'capacity':null,limit:25,offset:0});}catch{errors++;}finally{activeOperations--;}}};
 await Promise.all(Array.from({length:workerCount},worker));
 const elapsedMs=Math.max(1,Math.round(performance.now()-started)),queriesPerOperation=actualQueries/total;
 const evidence={status:errors===0&&actualQueries>0&&queriesPerOperation<=2&&maxConcurrentQueries<=configuredPoolMax?'passed':'failed',workload:'crm.listParties',operations:total,errors,elapsedMs,poolMax:configuredPoolMax,maxConcurrentOperations,maxConcurrentQueries,actualQueries,queriesPerOperation};
 if(evidence.status!=='passed')throw new Error(`CRM capacity certification failed: operations=${total}, errors=${errors}, queries=${actualQueries}, maxConcurrentQueries=${maxConcurrentQueries}.`);
 return evidence;
}
