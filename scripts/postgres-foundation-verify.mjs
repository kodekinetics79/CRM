#!/usr/bin/env node

// Destructive only inside a uniquely named disposable database and uniquely
// named runtime roles. This script never accepts a production runtime URL.

import {randomUUID} from 'node:crypto';
import {createControlRepository} from '../server/production/controlRepository.js';
import {createJobRepository} from '../server/production/jobRepository.js';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  applyMigrations,
  createPostgresPool,
  applicationRoleGrants,
  controlPlaneRoleGrants,
  assertRowLevelSecurityEffective,
  assertControlPlaneRole,
  TENANT_TABLES,
  TENANT_FOUNDATION_TABLES,
  PERSISTENCE_CODES
} from '../server/persistence/index.js';

const BASE_URL=process.env.WIMBLO_FOUNDATION_VERIFY_PG_URL||'postgres://wimblo_admin:wimblo-foundation@127.0.0.1:57733/wimblo_foundation';
const stamp=`${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const database=`wimblo_foundation_${stamp}`;
const tenantRole=`wimblo_tenant_${stamp}`;
const controlRole=`wimblo_control_${stamp}`;
const tenantPassword='wimblo-local-tenant';
const controlPassword='wimblo-local-control';
const tenantA=randomUUID();
const tenantB=randomUUID();
const tenantC=randomUUID();
const identityId=randomUUID();

const pools=[];
const line=value=>process.stdout.write(`${value}\n`);
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const identifier=value=>{
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(value))throw new Error(`Unsafe generated identifier: ${value}`);
  return `"${value}"`;
};
const databaseUrl=(name,user,password)=>{
  const url=new URL(BASE_URL);
  url.pathname=`/${name}`;
  if(user)url.username=user;
  if(password)url.password=password;
  return url.toString();
};
async function expectFailure(fn,code,label){
  let failure;
  try{await fn();}catch(error){failure=error;}
  assert(failure,`${label} unexpectedly succeeded`);
  if(code)assert(failure.code===code,`${label} returned ${failure.code||failure.message}, expected ${code}`);
  return failure;
}
async function runStep(name,fn){
  const started=Date.now();
  const evidence=await fn();
  line(`PASS ${name} (${Date.now()-started}ms)${evidence?` — ${evidence}`:''}`);
}

const admin=createPostgresPool({connectionString:BASE_URL,acquireAttempts:1,connectionTimeoutMs:3000,applicationName:'wimblo-foundation-verify-admin'});
pools.push(admin);

async function cleanup(){
  for(const pool of pools.slice(1).reverse())await pool.end().catch(()=>{});
  await admin.withAdminSession(async session=>{
    await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()',[database]).catch(()=>{});
    await session.query(`DROP DATABASE IF EXISTS ${identifier(database)}`).catch(()=>{});
    await session.query(`DROP ROLE IF EXISTS ${identifier(tenantRole)}`).catch(()=>{});
    await session.query(`DROP ROLE IF EXISTS ${identifier(controlRole)}`).catch(()=>{});
  }).catch(()=>{});
  await admin.end().catch(()=>{});
}

async function main(){
  const parsed=new URL(BASE_URL);
  if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname))throw new Error('Foundation verification refuses non-loopback PostgreSQL targets. Use a dedicated disposable local database.');

  await admin.withAdminSession(async session=>{
    await session.query(`CREATE ROLE ${identifier(tenantRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${tenantPassword}'`);
    await session.query(`CREATE ROLE ${identifier(controlRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${controlPassword}'`);
    await session.query(`CREATE DATABASE ${identifier(database)}`);
  });

  const owner=createPostgresPool({connectionString:databaseUrl(database),max:2,applicationName:'wimblo-foundation-owner'});
  const tenantPool=createPostgresPool({connectionString:databaseUrl(database,tenantRole,tenantPassword),max:2,applicationName:'wimblo-foundation-tenant'});
  const controlPool=createPostgresPool({connectionString:databaseUrl(database,controlRole,controlPassword),max:2,applicationName:'wimblo-foundation-control'});
  pools.push(owner,tenantPool,controlPool);

  await runStep('explicit migrations apply versions 1 through 14',async()=>{
    const result=await owner.withAdminSession(session=>applyMigrations(session));
    assert(result.currentVersion===14&&SCHEMA_VERSION===14,'schema did not reach version 14');
    assert(result.applied.map(entry=>entry.version).join(',')===MIGRATIONS.map(entry=>entry.version).join(','),'migration order differs');
    for(const sql of applicationRoleGrants(tenantRole))await owner.withAdminSession(session=>session.query(sql));
    for(const sql of controlPlaneRoleGrants(controlRole))await owner.withAdminSession(session=>session.query(sql));
    return `schema=${result.currentVersion}, ledger=${result.applied.length}`;
  });

  await owner.withAdminSession(async session=>{
    await session.query('INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region) VALUES($1,$2,$3,$4,$5),($6,$7,$3,$4,$5)',[tenantA,'Foundation tenant A','north-america','us-east-1','us-east-1',tenantB,'Foundation tenant B']);
  });

  await runStep('expanded tenant lifecycle accepts closed and requires a scheduled deletion date',async()=>{
    const closedTenant=randomUUID();
    await owner.withAdminSession(session=>session.query("INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region,status) VALUES($1,'Closed verifier','north-america','us-east-1','us-east-1','closed')",[closedTenant]));
    const error=await expectFailure(()=>owner.withAdminSession(session=>session.query("INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region,status) VALUES($1,'Scheduled verifier','north-america','us-east-1','us-east-1','deletion_scheduled')",[randomUUID()])),PERSISTENCE_CODES.INVALID,'undated deletion schedule');
    assert(error.code===PERSISTENCE_CODES.INVALID,'deletion lifecycle constraint did not classify as invalid');
    return 'closed=accepted, undated-deletion=refused';
  });

  await runStep('tenant and control connections use distinct non-bypassing roles',async()=>{
    const tenantEvidence=await tenantPool.withAdminSession(session=>assertRowLevelSecurityEffective(session));
    const controlEvidence=await controlPool.withAdminSession(session=>assertControlPlaneRole(session));
    assert(tenantEvidence.role===tenantRole,'tenant connection role mismatch');
    assert(controlEvidence.role===controlRole,'control connection role mismatch');
    assert(tenantEvidence.role!==controlEvidence.role,'runtime roles are not distinct');
    return `tenant=${tenantEvidence.role}, control=${controlEvidence.role}`;
  });

  await runStep('control role enumerates only runnable tenant identifiers for scoped workers',async()=>{
    const result=await controlPool.withAdminSession(session=>session.query('SELECT tenant_id::text AS tenant_id FROM wimblo_platform.runnable_tenant_ids() ORDER BY tenant_id'));
    assert(result.rowCount===2,'worker tenant source did not return the two active tenants');
    assert(result.rows.some(row=>row.tenant_id===tenantA)&&result.rows.some(row=>row.tenant_id===tenantB),'worker tenant source omitted an active tenant');
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT tenant_id FROM wimblo_platform.runnable_tenant_ids()')),PERSISTENCE_CODES.ISOLATION,'tenant-role worker enumeration');
    return 'active=2, tenant-role=refused';
  });

  await runStep('control role reads only the global dead-letter aggregate',async()=>{
    const result=await controlPool.withAdminSession(session=>session.query('SELECT wimblo_platform.dead_letter_count()::int AS count'));
    assert(result.rows[0]?.count===0,'fresh foundation unexpectedly contains dead letters');
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT wimblo_platform.dead_letter_count()')),PERSISTENCE_CODES.ISOLATION,'tenant-role dead-letter aggregate');
    return 'dead-letters=0, tenant-role=refused';
  });

  await runStep('forced row-level security covers original and foundation tenant tables',async()=>{
    const expected=[...TENANT_TABLES.map(table=>['public',table]),...TENANT_FOUNDATION_TABLES.map(table=>table.split('.'))];
    const {rows}=await owner.withAdminSession(session=>session.query(
      `SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE (n.nspname='public' AND c.relname=ANY($1)) OR (n.nspname='wimblo_platform' AND c.relname=ANY($2))`,
      [TENANT_TABLES,TENANT_FOUNDATION_TABLES.map(table=>table.split('.')[1])]));
    const found=new Map(rows.map(row=>[`${row.nspname}.${row.relname}`,row]));
    for(const [schema,table] of expected){
      const row=found.get(`${schema}.${table}`);
      assert(row?.relrowsecurity&&row?.relforcerowsecurity,`${schema}.${table} is not forced-RLS`);
    }
    return `forced=${expected.length}`;
  });

  await runStep('canonical CRM tables enforce typed parties, contacts, relationships and tenant isolation',async()=>{
    const personId=randomUUID(),organizationId=randomUUID(),otherPersonId=randomUUID();
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person',$3),($1,$4,'organization',$5)",[tenantA,personId,'Ada Lovelace',organizationId,'Wimblo Test Systems']);
      await session.query('INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,$3,$4)',[tenantA,personId,'Ada','Lovelace']);
      await session.query('INSERT INTO organizations(tenant_id,party_id,legal_name,domain,industry,employee_count) VALUES($1,$2,$3,$4,$5,$6)',[tenantA,organizationId,'Wimblo Test Systems','wimblo.test','technology',12]);
      await session.query('INSERT INTO contact_points(tenant_id,contact_id,party_id,type,normalized_value,display_value,is_primary) VALUES($1,$2,$3,$4,$5,$6,true)',[tenantA,randomUUID(),personId,'email','ada@example.invalid','ada@example.invalid']);
      await session.query('INSERT INTO relationships(tenant_id,relationship_id,from_party_id,to_party_id,type,effective_from) VALUES($1,$2,$3,$4,$5,$6)',[tenantA,randomUUID(),personId,organizationId,'employee','2026-01-02']);
    });
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO organizations(tenant_id,party_id,legal_name) VALUES($1,$2,$3)',[tenantA,personId,'Wrong subtype']);
    }),PERSISTENCE_CODES.INVALID,'person subtype used for an organization row');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query("UPDATE parties SET party_type='organization' WHERE tenant_id=$1 AND party_id=$2",[tenantA,personId]);
    }),PERSISTENCE_CODES.INVALID,'party type mutation');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO contact_points(tenant_id,contact_id,party_id,type,normalized_value,display_value) VALUES($1,$2,$3,$4,$5,$6)',[tenantA,randomUUID(),personId,'email','ada@example.invalid','ada@example.invalid']);
    }),PERSISTENCE_CODES.CONFLICT,'duplicate normalized contact');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO relationships(tenant_id,relationship_id,from_party_id,to_party_id,type,effective_from) VALUES($1,$2,$3,$3,$4,$5)',[tenantA,randomUUID(),personId,'employee','2026-01-02']);
    }),PERSISTENCE_CODES.INVALID,'relationship self-link');

    await tenantPool.withTransaction(tenantB,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person',$3)",[tenantB,otherPersonId,'Grace Hopper']);
      await session.query('INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,$3,$4)',[tenantB,otherPersonId,'Grace','Hopper']);
      await session.query('INSERT INTO contact_points(tenant_id,contact_id,party_id,type,normalized_value,display_value,is_primary) VALUES($1,$2,$3,$4,$5,$6,true)',[tenantB,randomUUID(),otherPersonId,'email','ada@example.invalid','ada@example.invalid']);
    });
    const own=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT party_id::text FROM parties'));
    const cross=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT party_id::text FROM parties WHERE party_id=$1',[otherPersonId]));
    assert(own.rowCount===2&&cross.rowCount===0,'CRM tenant isolation hid or exposed the wrong rows');
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM parties')),PERSISTENCE_CODES.ISOLATION,'unscoped CRM read');
    await expectFailure(()=>controlPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM parties')),PERSISTENCE_CODES.ISOLATION,'control-role CRM read');
    return 'typed-subtype=refused, duplicate-contact=refused, self-link=refused, cross-read=0, unscoped/control=refused';
  });

  await runStep('production sales tables enforce pipelines, opportunities and tenant isolation',async()=>{
    const salesPartyId=randomUUID(),pipelineId=randomUUID(),openStageId=randomUUID(),wonStageId=randomUUID(),lostStageId=randomUUID();
    const leadId=randomUUID(),opportunityId=randomUUID(),otherPipelineId=randomUUID(),otherStageId=randomUUID();
    const tenantBPartyId=randomUUID(),tenantBPipelineId=randomUUID(),tenantBStageId=randomUUID(),tenantBLeadId=randomUUID(),tenantBOpportunityId=randomUUID();
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person',$3)",[tenantA,salesPartyId,'Sales verifier']);
      await session.query('INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,$3,$4)',[tenantA,salesPartyId,'Sales','Verifier']);
      await session.query('INSERT INTO pipelines(tenant_id,pipeline_id,name,is_default) VALUES($1,$2,$3,true)',[tenantA,pipelineId,'Default Sales Pipeline']);
      await session.query('INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantA,openStageId,pipelineId,'Discovery','open',1,10]);
      await session.query('INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantA,wonStageId,pipelineId,'Won','won',2,100]);
      await session.query('INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantA,lostStageId,pipelineId,'Lost','lost',3,0]);
      await session.query('INSERT INTO leads(tenant_id,lead_id,party_id,pipeline_id,stage_id,source,expected_value_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
        tenantA,leadId,salesPartyId,pipelineId,openStageId,'web',12500,'USD',10,'2026-12-31'
      ]);
      await session.query('INSERT INTO opportunities(tenant_id,opportunity_id,party_id,pipeline_id,stage_id,lead_id,name,amount_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[
        tenantA,opportunityId,salesPartyId,pipelineId,openStageId,leadId,'Ada expansion',12500,'USD',10,'2026-12-31'
      ]);
    });
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO pipelines(tenant_id,pipeline_id,name,is_default) VALUES($1,$2,$3,true)',[tenantA,otherPipelineId,'Duplicate default']);
    }),PERSISTENCE_CODES.CONFLICT,'second default pipeline');
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO pipelines(tenant_id,pipeline_id,name,is_default) VALUES($1,$2,$3,false)',[tenantA,otherPipelineId,'Secondary pipeline']);
      await session.query("INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,'Other open','open',1,10)",[tenantA,otherStageId,otherPipelineId]);
    });
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query('INSERT INTO leads(tenant_id,lead_id,party_id,pipeline_id,stage_id,source,expected_value_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
        tenantA,randomUUID(),salesPartyId,pipelineId,otherStageId,'web',12500,'USD',10,'2026-12-31'
      ]);
    }),PERSISTENCE_CODES.INVALID,'stage from another pipeline');
    await tenantPool.withTransaction(tenantB,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person',$3)",[tenantB,tenantBPartyId,'Tenant B sales verifier']);
      await session.query('INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,$3,$4)',[tenantB,tenantBPartyId,'Tenant B','Verifier']);
      await session.query('INSERT INTO pipelines(tenant_id,pipeline_id,name,is_default) VALUES($1,$2,$3,true)',[tenantB,tenantBPipelineId,'Tenant B default']);
      await session.query("INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,'Discovery','open',1,10)",[tenantB,tenantBStageId,tenantBPipelineId]);
      await session.query('INSERT INTO leads(tenant_id,lead_id,party_id,pipeline_id,stage_id,source,expected_value_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenantB,tenantBLeadId,tenantBPartyId,tenantBPipelineId,tenantBStageId,'web',100,'USD',10,'2026-12-31']);
      await session.query('INSERT INTO opportunities(tenant_id,opportunity_id,party_id,pipeline_id,stage_id,lead_id,name,amount_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[tenantB,tenantBOpportunityId,tenantBPartyId,tenantBPipelineId,tenantBStageId,tenantBLeadId,'Tenant B opportunity',100,'USD',10,'2026-12-31']);
    });
    const own=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT opportunity_id::text FROM opportunities'));
    const cross=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT opportunity_id::text FROM opportunities WHERE opportunity_id=$1',[tenantBOpportunityId]));
    assert(own.rowCount===1&&cross.rowCount===0,'sales tenant isolation hid or exposed the wrong opportunity rows');
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM opportunities')),PERSISTENCE_CODES.ISOLATION,'unscoped sales read');
    await expectFailure(()=>controlPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM opportunities')),PERSISTENCE_CODES.ISOLATION,'control-role sales read');
    return 'default-pipeline=unique, cross-pipeline-stage=refused, cross-tenant-read=0, unscoped/control=refused';
  });

  await tenantPool.withTransaction(tenantA,session=>session.query("INSERT INTO wimblo_platform.tenant_modules(tenant_id,module_key,state) VALUES($1,'core','enabled')",[tenantA]));
  await tenantPool.withTransaction(tenantB,session=>session.query("INSERT INTO wimblo_platform.tenant_modules(tenant_id,module_key,state) VALUES($1,'core','enabled')",[tenantB]));

  await runStep('durable jobs claim concurrently, recover expired leases and fence stale completion',async()=>{
    let clockMs=Date.parse('2026-11-11T12:00:00.000Z');
    const jobs=createJobRepository({tenantPool,clock:()=>new Date(clockMs),leaseMs:1_000,retryBaseMs:100,retryMaxMs:200});
    const first=await jobs.enqueue({tenantId:tenantA,kind:'verify.job',idempotencyKey:'verify-one',payload:{sequence:1}});
    const replay=await jobs.enqueue({tenantId:tenantA,kind:'verify.job',idempotencyKey:'verify-one',payload:{sequence:999}});
    const second=await jobs.enqueue({tenantId:tenantA,kind:'verify.job',idempotencyKey:'verify-two',payload:{sequence:2}});
    const otherTenant=await jobs.enqueue({tenantId:tenantB,kind:'verify.job',idempotencyKey:'verify-one',payload:{sequence:3}});
    assert(first.jobId===replay.jobId&&replay.payload.sequence===1,'tenant idempotency replay overwrote or duplicated the original job');
    assert(otherTenant.jobId!==first.jobId,'idempotency key leaked across tenants');
    const [a,b]=await Promise.all([jobs.claim({tenantId:tenantA,workerId:'verify-worker-a'}),jobs.claim({tenantId:tenantA,workerId:'verify-worker-b'})]);
    assert(a.length===1&&b.length===1&&a[0].jobId!==b[0].jobId,'concurrent claims did not receive distinct rows');
    assert((await jobs.claim({tenantId:tenantA,workerId:'verify-worker-c'})).length===0,'already leased rows were claimed twice');
    const stale=a[0];clockMs+=1_001;
    const [reclaimed]=await jobs.claim({tenantId:tenantA,workerId:'verify-worker-c'});
    assert(reclaimed.jobId===stale.jobId&&reclaimed.attempts===2,'expired lease was not reclaimed as the next attempt');
    const completed=await jobs.complete({...reclaimed,workerId:'verify-worker-c'});
    assert(completed.state==='completed','reclaimed job did not complete');
    await expectFailure(()=>jobs.complete({...stale,workerId:'verify-worker-a'}),PERSISTENCE_CODES.CONFLICT,'stale job completion');
    const attemptRows=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT attempt,outcome,error_code FROM wimblo_platform.durable_job_attempts WHERE job_id=$1 ORDER BY attempt',[stale.jobId]));
    assert(attemptRows.rowCount===2&&attemptRows.rows[0].error_code==='LEASE_EXPIRED'&&attemptRows.rows[1].outcome==='completed','attempt ledger did not preserve lease recovery');
    const terminal=await jobs.enqueue({tenantId:tenantA,kind:'verify.final',idempotencyKey:'verify-final-crash',payload:{sequence:4},maxAttempts:1});const [terminalLease]=await jobs.claim({tenantId:tenantA,workerId:'verify-worker-final',kinds:['verify.final']});assert(terminalLease.jobId===terminal.jobId&&terminalLease.attempts===1,'final-attempt lease was not claimed');clockMs+=1_001;assert((await jobs.claim({tenantId:tenantA,workerId:'verify-worker-sweeper',kinds:['verify.final']})).length===0,'exhausted final lease was reclaimed');const terminalState=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT state FROM wimblo_platform.durable_jobs WHERE job_id=$1',[terminal.jobId])),terminalDead=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT reason_code FROM wimblo_platform.dead_letter_jobs WHERE job_id=$1',[terminal.jobId]));assert(terminalState.rows[0]?.state==='dead_lettered'&&terminalDead.rows[0]?.reason_code==='LEASE_EXPIRED_FINAL_ATTEMPT','exhausted final lease did not enter dead-letter state');
    return `distinct-claims=2, recovered-attempt=${reclaimed.attempts}, final-crash=dead-lettered, schema=${SCHEMA_VERSION}, second=${second.jobId.slice(0,8)}`;
  });

  await runStep('two tenants cannot read or write each other module rows',async()=>{
    const own=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT tenant_id::text FROM wimblo_platform.tenant_modules'));
    assert(own.rowCount===1&&own.rows[0].tenant_id===tenantA,'tenant A did not see exactly its own row');
    const cross=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT tenant_id::text FROM wimblo_platform.tenant_modules WHERE tenant_id=$1',[tenantB]));
    assert(cross.rowCount===0,'tenant A read tenant B module state');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query("UPDATE wimblo_platform.tenant_modules SET state='suspended' WHERE tenant_id=$1 AND module_key='core' RETURNING tenant_id",[tenantB])).then(result=>{
      if(result.rowCount===0)throw Object.assign(new Error('cross-tenant update was hidden by RLS'),{code:PERSISTENCE_CODES.ISOLATION});
      return result;
    }),PERSISTENCE_CODES.ISOLATION,'cross-tenant write');
    return 'cross-read=0, cross-write=refused';
  });

  await runStep('missing tenant scope fails closed',async()=>{
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM wimblo_platform.tenant_modules')),PERSISTENCE_CODES.ISOLATION,'unscoped tenant read');
    return 'unscoped=refused';
  });

  await runStep('control role can use platform identity tables but cannot read tenant business tables',async()=>{
    await controlPool.withAdminSession(session=>session.query('INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash) VALUES($1,$2,$3,$4)',[identityId,'foundation@example.invalid','Foundation verifier','not-a-real-login-hash']));
    const found=await controlPool.withAdminSession(session=>session.query('SELECT identity_id::text FROM wimblo_platform.global_identities WHERE identity_id=$1',[identityId]));
    assert(found.rowCount===1,'control role could not read its platform identity');
    await expectFailure(()=>controlPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM records')),PERSISTENCE_CODES.ISOLATION,'control-plane business read');
    await expectFailure(()=>controlPool.withAdminSession(async session=>{await session.query('SELECT set_config($1,$2,$3)',['wimblo.tenant_id',tenantA,false]);return session.query('SELECT payload FROM wimblo_platform.durable_jobs');}),PERSISTENCE_CODES.ISOLATION,'control-plane tenant-job read with forged scope');
    return 'platform-read=1, business-read=refused, tenant-job-read=refused';
  });

  await runStep('tenant role cannot read global identities',async()=>{
    await expectFailure(()=>tenantPool.withAdminSession(session=>session.query('SELECT identity_id FROM wimblo_platform.global_identities')),PERSISTENCE_CODES.ISOLATION,'tenant global-identity read');
    return 'global-identity-read=refused';
  });

  await runStep('asynchronous control repository preserves identity, membership, invitation, session and audit contracts',async()=>{
    const repository=createControlRepository({pool:controlPool});
    const repositoryIdentity=randomUUID();
    const membershipA=randomUUID(),membershipB=randomUUID();
    const invitationId=randomUUID(),invitationToken=`invite-${randomUUID()}`;
    const sessionToken=`session-${randomUUID()}`;

    const identity=await repository.createIdentity({identityId:repositoryIdentity,email:'  CONTROL@Example.Invalid ',displayName:'Control verifier',passwordHash:'not-a-login-hash'});
    assert(identity.identityId===repositoryIdentity&&identity.normalizedEmail==='control@example.invalid','identity normalization or UUID changed');
    await expectFailure(()=>repository.createIdentity({identityId:randomUUID(),email:'control@example.invalid',displayName:'Duplicate verifier',passwordHash:'not-a-login-hash'}),PERSISTENCE_CODES.CONFLICT,'normalized email duplicate');

    const first=await repository.createMembership({membershipId:membershipA,tenantId:tenantA,identityId:repositoryIdentity,role:'owner'});
    const second=await repository.createMembership({membershipId:membershipB,tenantId:tenantB,identityId:repositoryIdentity,role:'viewer'});
    const memberships=await repository.listMemberships(repositoryIdentity,{status:'active'});
    assert(memberships.length===2&&first.tenantId!==second.tenantId,'multi-tenant memberships were merged');
    await expectFailure(()=>repository.changeMembership({membershipId:membershipA,role:'admin',expectedVersion:99}),PERSISTENCE_CODES.CONFLICT,'stale membership version');

    const invitation=await repository.createInvitation({invitationId,tenantId:tenantA,token:invitationToken,email:'Invitee@Example.Invalid',role:'staff',createdBy:repositoryIdentity,expiresAt:new Date(Date.now()+60_000)});
    assert(invitation.status==='pending'&&!Object.hasOwn(invitation,'tokenHash'),'invitation exposed token custody');
    const tokenEvidence=await owner.withAdminSession(session=>session.query('SELECT token_hash FROM wimblo_platform.invitations WHERE invitation_id=$1',[invitationId]));
    assert(tokenEvidence.rows[0].token_hash!==invitationToken&&tokenEvidence.rows[0].token_hash.length===64,'invitation token was not hashed');
    const consumed=await repository.consumeInvitation({token:invitationToken,identityId:repositoryIdentity,expectedVersion:1});
    assert(consumed.status==='consumed','invitation was not consumed once');

    await owner.withAdminSession(db=>db.query("INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region) VALUES($1,'Atomic tenant','north-america','us-east-1','us-east-1')",[tenantC]));
    const atomicIdentity=randomUUID(),atomicInvitation=randomUUID(),atomicMembership=randomUUID(),atomicToken=`atomic-${randomUUID()}`;
    await repository.createInvitation({invitationId:atomicInvitation,tenantId:tenantC,token:atomicToken,email:'atomic@example.invalid',role:'staff',createdBy:repositoryIdentity,expiresAt:new Date(Date.now()+60_000)});
    const atomic=await repository.acceptInvitationMembership({token:atomicToken,expectedVersion:1,identityId:atomicIdentity,membershipId:atomicMembership,newIdentity:{email:'atomic@example.invalid',displayName:'Atomic verifier',passwordHash:'not-a-login-hash'}});
    assert(atomic.identity.identityId===atomicIdentity&&atomic.membership.membershipId===atomicMembership&&atomic.invitation.status==='consumed','atomic invitation acceptance did not commit all records');

    const raceOwnerA=await repository.createMembership({membershipId:randomUUID(),tenantId:tenantC,identityId:repositoryIdentity,role:'owner'});
    const raceOwnerB=await repository.changeMembership({membershipId:atomicMembership,role:'owner',expectedVersion:atomic.membership.version,actorIdentityId:atomicIdentity});
    const demotions=await Promise.allSettled([
      repository.changeMembership({membershipId:raceOwnerA.membershipId,role:'admin',expectedVersion:raceOwnerA.version,actorIdentityId:repositoryIdentity}),
      repository.changeMembership({membershipId:raceOwnerB.membershipId,role:'admin',expectedVersion:raceOwnerB.version,actorIdentityId:atomicIdentity})
    ]);
    assert(demotions.filter(result=>result.status==='fulfilled').length===1,'concurrent owner demotions did not have exactly one winner');
    assert(demotions.filter(result=>result.status==='rejected'&&result.reason?.code===PERSISTENCE_CODES.CONFLICT).length===1,'concurrent final-owner demotion was not refused as a conflict');
    const retainedOwners=await repository.listTenantMemberships(tenantC,{status:'active',role:'owner'});assert(retainedOwners.length===1,'concurrent demotions removed every active owner');

    await repository.createSession({token:sessionToken,csrfHash:'c'.repeat(64),tenantId:tenantA,identityId:repositoryIdentity,membershipVersion:first.version,securityVersion:identity.securityVersion,mfaVerifiedAt:new Date(),recentAuthenticatedAt:new Date(),expiresAt:new Date(Date.now()+60_000)});
    const session=await repository.getSession(sessionToken);
    assert(session.identityId===repositoryIdentity&&!Object.hasOwn(session,'tokenHash'),'session lookup exposed token custody');
    const sessionEvidence=await owner.withAdminSession(db=>db.query('SELECT token_hash FROM wimblo_platform.opaque_sessions WHERE identity_id=$1',[repositoryIdentity]));
    assert(sessionEvidence.rows[0].token_hash!==sessionToken&&sessionEvidence.rows[0].token_hash.length===64,'session token was not hashed');

    const audit=await repository.appendAudit({identityId:repositoryIdentity,actorIdentityId:repositoryIdentity,action:'foundation.verified',targetType:'identity',targetId:repositoryIdentity});
    await expectFailure(()=>controlPool.withAdminSession(db=>db.query('UPDATE wimblo_platform.control_audit SET action=$1 WHERE audit_id=$2',['tampered',audit.auditId])),PERSISTENCE_CODES.ISOLATION,'append-only audit update');

    const rollbackIdentity=randomUUID();await repository.createIdentity({identityId:rollbackIdentity,email:'rollback@example.invalid',displayName:'Rollback verifier',passwordHash:'not-a-login-hash'});
    const rolledBackMembership=randomUUID();
    await expectFailure(()=>repository.createMembership({membershipId:rolledBackMembership,tenantId:tenantC,identityId:rollbackIdentity,role:'viewer',actorIdentityId:randomUUID()}),PERSISTENCE_CODES.INVALID,'membership audit foreign-key rollback');
    const rolledBack=await owner.withAdminSession(db=>db.query('SELECT membership_id FROM wimblo_platform.memberships WHERE membership_id=$1',[rolledBackMembership]));
    assert(rolledBack.rowCount===0,'membership survived a failed same-transaction audit');
    return 'identities=1, memberships=2, token-hashes=2, stale-write=refused, rollback=clean';
  });

  line('FOUNDATION VERIFICATION PASSED');
}

main().catch(error=>{
  process.stderr.write(`FOUNDATION VERIFICATION FAILED: ${error.message}\n`);
  process.exitCode=1;
}).finally(cleanup);
