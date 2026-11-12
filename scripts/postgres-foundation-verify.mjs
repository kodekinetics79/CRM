#!/usr/bin/env node

// Destructive only inside a uniquely named disposable database and uniquely
// named runtime roles. This script never accepts a production runtime URL.

import {randomUUID} from 'node:crypto';
import {createControlRepository} from '../server/production/controlRepository.js';
import {createCrmRepository} from '../server/production/crmRepository.js';
import {createJobRepository} from '../server/production/jobRepository.js';
import {createProductionJobHandlers,runWorker} from '../server/production/worker.js';
import {createCrmImportService} from '../server/production/crmImportService.js';
import {runRepresentativeCrmCapacity} from '../server/production/capacityCertification.js';
import {redactCertificationDiagnostic} from './certification-redaction.mjs';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  applyMigrations,
  createPostgresPool,
  applicationRoleGrants,
  controlPlaneRoleGrants,
  assertRowLevelSecurityEffective,
  assertControlPlaneRole,
  assertSecurityDefinerOwnersBypassRls,
  TENANT_TABLES,
  TENANT_FOUNDATION_TABLES,
  PERSISTENCE_CODES
} from '../server/persistence/index.js';

const BASE_URL=process.env.WIMBLO_FOUNDATION_VERIFY_PG_URL||'postgres://wimblo_admin:wimblo-foundation@127.0.0.1:57733/wimblo_foundation';
const REDACTION_ENV={...process.env,WIMBLO_FOUNDATION_VERIFY_PG_URL:BASE_URL};
const stamp=`${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const database=`wimblo_foundation_${stamp}`;
const ownerRole=`wimblo_owner_${stamp}`;
const tenantRole=`wimblo_tenant_${stamp}`;
const controlRole=`wimblo_control_${stamp}`;
const ownerPassword='wimblo-local-owner';
const tenantPassword='wimblo-local-tenant';
const controlPassword='wimblo-local-control';
const tenantA=randomUUID();
const tenantB=randomUUID();
const tenantC=randomUUID();
const identityId=randomUUID();

const pools=[];
const line=value=>process.stdout.write(redactCertificationDiagnostic(`${value}\n`,REDACTION_ENV));
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
    await session.query(`DROP ROLE IF EXISTS ${identifier(ownerRole)}`).catch(()=>{});
  }).catch(()=>{});
  await admin.end().catch(()=>{});
}

async function main(){
  const parsed=new URL(BASE_URL);
  if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname))throw new Error('Foundation verification refuses non-loopback PostgreSQL targets. Use a dedicated disposable local database.');

  await admin.withAdminSession(async session=>{
    await session.query(`CREATE ROLE ${identifier(ownerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '${ownerPassword}'`);
    await session.query(`CREATE ROLE ${identifier(tenantRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${tenantPassword}'`);
    await session.query(`CREATE ROLE ${identifier(controlRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${controlPassword}'`);
    await session.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(ownerRole)}`);
  });

  const owner=createPostgresPool({connectionString:databaseUrl(database,ownerRole,ownerPassword),max:2,applicationName:'wimblo-foundation-owner'});
  const tenantPool=createPostgresPool({connectionString:databaseUrl(database,tenantRole,tenantPassword),max:2,applicationName:'wimblo-foundation-tenant'});
  const controlPool=createPostgresPool({connectionString:databaseUrl(database,controlRole,controlPassword),max:2,applicationName:'wimblo-foundation-control'});
  pools.push(owner,tenantPool,controlPool);

  await runStep('explicit migrations apply versions 1 through 18 with a non-superuser BYPASSRLS owner',async()=>{
    const result=await owner.withAdminSession(session=>applyMigrations(session));
    assert(result.currentVersion===18&&SCHEMA_VERSION===18,'schema did not reach version 18');
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
    const controlEvidence=await controlPool.withAdminSession(async session=>{const evidence=await assertControlPlaneRole(session);await assertSecurityDefinerOwnersBypassRls(session);return evidence;});
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
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query(
      "INSERT INTO opportunity_stage_events(tenant_id,event_id,opportunity_id,pipeline_id,to_stage_id,action) VALUES($1,$2,$3,$4,$5,'invalid.cross_pipeline')",
      [tenantA,randomUUID(),opportunityId,otherPipelineId,otherStageId]
    )),PERSISTENCE_CODES.INVALID,'stage history from another opportunity pipeline');
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
    return 'default-pipeline=unique, cross-pipeline-stage=refused, cross-pipeline-history=refused, cross-tenant-read=0, unscoped/control=refused';
  });

  await runStep('CRM work facts enforce ownership, append-only history, attachment integrity and atomic reminders',async()=>{
    const partyId=randomUUID(),otherPartyId=randomUUID(),subjectId=partyId,activityId=randomUUID(),timelineFirstId=randomUUID(),timelineOlderId=randomUUID(),timelineLateId=randomUUID(),taskId=randomUUID(),objectId=`verify-${randomUUID()}`,linkId=randomUUID();
    await owner.withAdminSession(async session=>{
      await session.query("INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash) VALUES($1,'foundation@example.invalid','Foundation verifier','not-a-real-login-hash') ON CONFLICT (identity_id) DO NOTHING",[identityId]);
      await session.query("INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status) VALUES($1,$2,$3,'owner','active'),($4,$5,$3,'viewer','active') ON CONFLICT (tenant_id,identity_id) DO NOTHING",[randomUUID(),tenantA,identityId,randomUUID(),tenantB]);
    });
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Work verifier')",[tenantA,partyId]);
      await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Work','Verifier')",[tenantA,partyId]);
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Other work verifier')",[tenantA,otherPartyId]);
      await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Other','Verifier')",[tenantA,otherPartyId]);
      await session.query("INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id,owner_identity_id) VALUES($1,$2,'party',$2,$3)",[tenantA,subjectId,identityId]);
      await session.query("INSERT INTO crm_activities(tenant_id,activity_id,subject_id,activity_type,summary,actor_identity_id,occurred_at) VALUES($1,$2,$3,'call','Verified call',$4,now())",[tenantA,activityId,subjectId,identityId]);
      await session.query("INSERT INTO crm_activities(tenant_id,activity_id,subject_id,activity_type,summary,actor_identity_id,occurred_at) VALUES($1,$2,$3,'call','Timeline first',$4,'2098-12-31T00:00:00.000Z'),($1,$5,$3,'call','Timeline older',$4,'2098-12-29T00:00:00.000Z')",[tenantA,timelineFirstId,subjectId,identityId,timelineOlderId]);
      await session.query("INSERT INTO crm_tasks(tenant_id,task_id,subject_id,title,status,owner_identity_id) VALUES($1,$2,$3,'Verify reminder','open',$4)",[tenantA,taskId,subjectId,identityId]);
      await session.query("INSERT INTO object_metadata(tenant_id,object_id,revision,object_key,provider,bucket,namespace,region,residency_profile,custody,content_type,size_bytes,sha256,ciphertext_sha256,encryption_algorithm,encryption_key_id,state) VALUES($1,$2,1,$3,'memory','private','crm','us-east-1','north-america','provider-managed-key','application/pdf',10,$4,$4,'AES-256-GCM','verify','active')",[tenantA,objectId,`tenants/${tenantA}/crm/${objectId}`,'a'.repeat(64)]);
      await session.query("INSERT INTO crm_attachment_links(tenant_id,link_id,subject_id,object_id,object_revision,file_name,content_type,size_bytes,actor_identity_id,occurred_at) VALUES($1,$2,$3,$4,1,'verify.pdf','application/pdf',10,$5,now())",[tenantA,linkId,subjectId,objectId,identityId]);
    });
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query('UPDATE crm_subjects SET party_id=$3 WHERE tenant_id=$1 AND subject_id=$2',[tenantA,subjectId,otherPartyId])),PERSISTENCE_CODES.INVALID,'CRM subject identity mutation');
    const timelineRepository=createCrmRepository({tenantPool,clock:()=>new Date('2099-01-01T00:00:00.000Z')});
    const firstTimelinePage=await timelineRepository.listTimeline({tenantId:tenantA,subjectId,limit:1});
    assert(firstTimelinePage.items[0]?.id===timelineFirstId&&firstTimelinePage.nextCursor,'timeline first page did not establish the expected cursor');
    await tenantPool.withTransaction(tenantA,session=>session.query("INSERT INTO crm_activities(tenant_id,activity_id,subject_id,activity_type,summary,actor_identity_id,occurred_at,created_at) VALUES($1,$2,$3,'call','Inserted after page one',$4,'2098-12-30T00:00:00.000Z','2099-01-02T00:00:00.000Z')",[tenantA,timelineLateId,subjectId,identityId]));
    const secondTimelinePage=await timelineRepository.listTimeline({tenantId:tenantA,subjectId,limit:1,cursor:firstTimelinePage.nextCursor});
    assert(secondTimelinePage.items[0]?.id===timelineOlderId&&!secondTimelinePage.items.some(item=>item.id===timelineLateId),'backdated fact inserted after asOf changed timeline continuation');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query("UPDATE crm_activities SET summary='changed' WHERE tenant_id=$1 AND activity_id=$2",[tenantA,activityId])),null,'activity history update');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query("UPDATE crm_tasks SET status='completed' WHERE tenant_id=$1 AND task_id=$2",[tenantA,taskId])),PERSISTENCE_CODES.INVALID,'completed task without timestamp');
    const cross=await tenantPool.withTenantSession(tenantB,session=>session.query('SELECT subject_id FROM crm_subjects WHERE subject_id=$1',[subjectId]));
    assert(cross.rowCount===0,'CRM work subject leaked across tenants');
    const rollbackTask=randomUUID(),rollbackKey=`crm.task-reminder:${rollbackTask}:1`,jobs=createJobRepository({tenantPool});
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO crm_tasks(tenant_id,task_id,subject_id,title,status,owner_identity_id) VALUES($1,$2,$3,'Rollback reminder','open',$4)",[tenantA,rollbackTask,subjectId,identityId]);
      await jobs.enqueueInTransaction(session,{tenantId:tenantA,kind:'crm.task_reminder',idempotencyKey:rollbackKey,payload:{taskId:rollbackTask,subjectId,expectedTaskVersion:1}});
      throw new Error('force rollback');
    }),null,'work reminder transaction rollback');
    const rolledBack=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT (SELECT COUNT(*) FROM crm_tasks WHERE task_id=$1)::int AS tasks,(SELECT COUNT(*) FROM wimblo_platform.durable_jobs WHERE idempotency_key=$2)::int AS jobs',[rollbackTask,rollbackKey]));
    assert(rolledBack.rows[0].tasks===0&&rolledBack.rows[0].jobs===0,'task or reminder survived transaction rollback');
    await expectFailure(()=>controlPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM crm_tasks')),PERSISTENCE_CODES.ISOLATION,'control-role CRM task read');
    return 'subject-identity=immutable, timeline-asof=stable, append-only=refused, completion=consistent, attachment=active-revision, cross-tenant=0, reminder-rollback=clean';
  });

  await runStep('due CRM reminders complete through the worker exactly once while stale work is suppressed',async()=>{
    const subjectId=randomUUID(),dueTaskId=randomUUID(),staleTaskId=randomUUID(),at='2099-02-01T02:00:00.000Z',reminderAt='2099-02-01T01:59:00.000Z';
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Reminder verifier')",[tenantA,subjectId]);
      await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Reminder','Verifier')",[tenantA,subjectId]);
      await session.query("INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id,owner_identity_id) VALUES($1,$2,'party',$2,$3)",[tenantA,subjectId,identityId]);
    });
    const jobs=createJobRepository({tenantPool,clock:()=>new Date(at),leaseMs:60_000}),crm=createCrmRepository({tenantPool,jobRepository:jobs,clock:()=>new Date(at)});
    await crm.createTask({tenantId:tenantA,taskId:dueTaskId,subjectId,title:'Due reminder',ownerIdentityId:identityId,actorIdentityId:identityId,reminderAt});
    await crm.createTask({tenantId:tenantA,taskId:staleTaskId,subjectId,title:'Completed before reminder',ownerIdentityId:identityId,actorIdentityId:identityId,reminderAt});
    await crm.updateTask({tenantId:tenantA,taskId:staleTaskId,expectedVersion:1,status:'completed',actorIdentityId:identityId});
    const baseHandlers=createProductionJobHandlers({crmRepository:crm}),controller=new AbortController();let handled=0;
    const handlers={...baseHandlers,'crm.task_reminder':async job=>{await baseHandlers['crm.task_reminder'](job);if(++handled===2)controller.abort();}};
    await runWorker({repository:jobs,handlers,signal:controller.signal,concurrency:1,tenantIds:[tenantA],pollIntervalMs:1,heartbeatIntervalMs:1_000,workerId:'foundation-reminder-worker'});
    const jobRows=await tenantPool.withTenantSession(tenantA,session=>session.query("SELECT job_id::text,payload,state FROM wimblo_platform.durable_jobs WHERE kind='crm.task_reminder' AND payload->>'taskId'=ANY($1::text[]) ORDER BY payload->>'taskId'",[[dueTaskId,staleTaskId]]));
    assert(jobRows.rowCount===2&&jobRows.rows.every(row=>row.state==='completed'),'reminder worker did not complete due and suppressed jobs');
    const dueJob=jobRows.rows.find(row=>row.payload.taskId===dueTaskId),staleJob=jobRows.rows.find(row=>row.payload.taskId===staleTaskId);
    const events=await tenantPool.withTenantSession(tenantA,session=>session.query("SELECT event_id::text,task_id::text,action FROM crm_task_events WHERE action='reminder_due' AND task_id=ANY($1::uuid[]) ORDER BY task_id",[[dueTaskId,staleTaskId]]));
    assert(events.rowCount===1&&events.rows[0].task_id===dueTaskId&&events.rows[0].event_id===dueJob.job_id,'worker did not create exactly one deterministic event or failed to suppress stale work');
    assert(!events.rows.some(row=>row.task_id===staleTaskId)&&staleJob,'stale reminder produced visible history');
    const taskState=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT reminder_at,version FROM crm_tasks WHERE task_id=$1',[dueTaskId]));
    assert(taskState.rows[0]?.reminder_at===null&&Number(taskState.rows[0]?.version)===2,'delivered reminder did not clear its schedule exactly once');
    const timeline=await crm.listTimeline({tenantId:tenantA,subjectId,limit:20});
    assert(timeline.items.some(item=>item.kind==='task'&&item.id===dueJob.job_id&&item.summary==='Task reminder due'),`delivered reminder is not visible in the task timeline: job=${dueJob.job_id}, timeline=${JSON.stringify(timeline.items)}`);
    const replay=await crm.processTaskReminder({tenantId:tenantA,taskId:dueTaskId,expectedTaskVersion:1,jobId:dueJob.job_id});
    assert(replay.outcome==='delivered'&&replay.replayed===true,'post-commit retry did not return success from durable history');
    const finalCount=await tenantPool.withTenantSession(tenantA,session=>session.query("SELECT count(*)::int AS count FROM crm_task_events WHERE task_id=$1 AND action='reminder_due'",[dueTaskId]));
    assert(finalCount.rows[0]?.count===1,'post-commit retry duplicated the reminder event');
    return 'worker-jobs=2-completed, due-events=1, stale-events=0, retry=replayed, delivery=in-product-timeline-only';
  });

  await runStep('governed CRM reporting and import controls enforce tenant idempotency and retention',async()=>{
    const subjectA=randomUUID(),subjectB=randomUUID(),batchA=randomUUID(),batchB=randomUUID(),reportId=randomUUID(),key='foundation-import-replay';
    for(const [tenant,subject,batch] of [[tenantA,subjectA,batchA],[tenantB,subjectB,batchB]])await tenantPool.withTransaction(tenant,async session=>{
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Import verifier')",[tenant,subject]);
      await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Import','Verifier')",[tenant,subject]);
      await session.query("INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id) VALUES($1,$2,'party',$2)",[tenant,subject]);
      await session.query("INSERT INTO crm_import_batches(tenant_id,batch_id,idempotency_key,source_system,entity_type,source_sha256,mapping_sha256,preview_sha256,byte_count,row_count,valid_count,invalid_count,inserted_count,actor_identity_id,expires_at) VALUES($1,$2,$3,'legacy','people',$4,$5,$6,100,1,1,0,1,$7,now()+interval '1 hour')",[tenant,batch,key,'a'.repeat(64),'b'.repeat(64),'d'.repeat(64),identityId]);
      await session.query("INSERT INTO crm_import_source_mappings(tenant_id,source_system,entity_type,external_key,target_subject_id,source_row_hash,target_version,last_batch_id) VALUES($1,'legacy','people','row-1',$2,$3,1,$4)",[tenant,subject,'c'.repeat(64),batch]);
    });
    await tenantPool.withTransaction(tenantA,async session=>{
      await session.query("INSERT INTO crm_saved_reports(tenant_id,report_id,name,dataset,definition,owner_identity_id) VALUES($1,$2,'Pipeline report','opportunities',$3::jsonb,$4)",[tenantA,reportId,JSON.stringify({dataset:'opportunities',columns:['name']}),identityId]);
      await session.query("UPDATE crm_import_batches SET status='committed',inserted_count=1,committed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND batch_id=$2",[tenantA,batchA]);
    });
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query("INSERT INTO crm_import_batches(tenant_id,batch_id,idempotency_key,source_system,entity_type,source_sha256,mapping_sha256,preview_sha256,byte_count,row_count,valid_count,invalid_count,actor_identity_id,expires_at) VALUES($1,$2,$3,'legacy','people',$4,$5,$6,100,0,0,0,$7,now()+interval '1 hour')",[tenantA,randomUUID(),key,'d'.repeat(64),'b'.repeat(64),'e'.repeat(64),identityId])),PERSISTENCE_CODES.CONFLICT,'tenant import idempotency');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query("UPDATE crm_import_batches SET inserted_count=0 WHERE tenant_id=$1 AND batch_id=$2",[tenantA,batchA])),PERSISTENCE_CODES.INVALID,'committed import mutation');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,async session=>{
      const organizationSubject=randomUUID();
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'organization','Wrong import subtype')",[tenantA,organizationSubject]);
      await session.query("INSERT INTO organizations(tenant_id,party_id,legal_name) VALUES($1,$2,'Wrong import subtype')",[tenantA,organizationSubject]);
      await session.query("INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id) VALUES($1,$2,'party',$2)",[tenantA,organizationSubject]);
      await session.query("INSERT INTO crm_import_source_mappings(tenant_id,source_system,entity_type,external_key,target_subject_id,source_row_hash,target_version,last_batch_id) VALUES($1,'legacy-org','people','org-1',$2,$3,1,$4)",[tenantA,organizationSubject,'f'.repeat(64),batchA]);
    }),PERSISTENCE_CODES.INVALID,'organization subject used for people import mapping');
    await expectFailure(()=>tenantPool.withTransaction(tenantA,session=>session.query('DELETE FROM crm_saved_reports WHERE tenant_id=$1 AND report_id=$2',[tenantA,reportId])),PERSISTENCE_CODES.ISOLATION,'saved report delete privilege');
    const csv='external_key,display_name,first_name,last_name\r\nservice-1,Service Import,Service,Verifier\r\n',serviceKey='foundation-service-import';
    const importService=createCrmImportService({tenantPool,moduleService:{authorize:async()=>({allowed:true})}});
    const preview=await importService.previewPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,idempotencyKey:serviceKey,sourceSystem:'legacy',csv});
    const committed=await importService.commitPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,batchId:preview.batchId,expectedVersion:preview.version,expectedSourceSha256:preview.sourceSha256,idempotencyKey:serviceKey,sourceSystem:'legacy',csv});
    const replay=await importService.commitPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,batchId:preview.batchId,expectedVersion:preview.version,expectedSourceSha256:preview.sourceSha256,idempotencyKey:serviceKey,sourceSystem:'legacy',csv});
    assert(committed.status==='committed'&&committed.insertedCount===1&&replay.insertedCount===1,'preview/commit/replay did not preserve one canonical import result');
    const staleCsv=csv.replace('Service Import','Previewed Update'),staleKey='foundation-service-import-stale';
    const stalePreview=await importService.previewPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,idempotencyKey:staleKey,sourceSystem:'legacy',csv:staleCsv});
    assert(stalePreview.updatedCount===1&&stalePreview.insertedCount===0,'preview did not reconcile the existing mapped person as an update');
    const mappedTarget=await tenantPool.withTenantSession(tenantA,session=>session.query("SELECT target_subject_id FROM crm_import_source_mappings WHERE source_system='legacy' AND external_key='service-1'"));
    await tenantPool.withTransaction(tenantA,session=>session.query("UPDATE parties SET display_name='Manual concurrent edit',version=version+1 WHERE tenant_id=$1 AND party_id=$2",[tenantA,mappedTarget.rows[0].target_subject_id]));
    await expectFailure(()=>importService.commitPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,batchId:stalePreview.batchId,expectedVersion:stalePreview.version,expectedSourceSha256:stalePreview.sourceSha256,idempotencyKey:staleKey,sourceSystem:'legacy',csv:staleCsv}),PERSISTENCE_CODES.CONFLICT,'stale import preview after canonical target change');
    const staleState=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT b.status,p.display_name FROM crm_import_batches b CROSS JOIN parties p WHERE b.batch_id=$1 AND p.party_id=$2',[stalePreview.batchId,mappedTarget.rows[0].target_subject_id]));
    assert(staleState.rows[0]?.status==='previewed'&&staleState.rows[0]?.display_name==='Manual concurrent edit','stale preview overwrote the canonical target or committed its batch');
    await expectFailure(()=>importService.previewPeople({tenantId:tenantA,actorRole:'staff',actorIdentityId:identityId,idempotencyKey:serviceKey,sourceSystem:'legacy',csv:csv.replace('Service Import','Changed Import')}),PERSISTENCE_CODES.CONFLICT,'conflicting import replay');
    const own=await tenantPool.withTenantSession(tenantA,session=>session.query('SELECT batch_id FROM crm_import_batches WHERE idempotency_key=$1',[key]));
    assert(own.rowCount===1&&own.rows[0].batch_id===batchA,'tenant-scoped import idempotency returned another tenant batch');
    await expectFailure(()=>controlPool.withAdminSession(session=>session.query('SELECT COUNT(*) FROM crm_saved_reports')),PERSISTENCE_CODES.ISOLATION,'control-role saved report read');
    return 'schema=18, tenant-idempotency=isolated, stale-preview=refused, committed=immutable, person-mapping=enforced, delete=refused, control=refused';
  });

  await tenantPool.withTransaction(tenantA,session=>session.query("INSERT INTO wimblo_platform.tenant_modules(tenant_id,module_key,state) VALUES($1,'core','enabled')",[tenantA]));
  await tenantPool.withTransaction(tenantB,session=>session.query("INSERT INTO wimblo_platform.tenant_modules(tenant_id,module_key,state) VALUES($1,'core','enabled')",[tenantB]));

  await runStep('representative CRM capacity stays inside measured query and pool bounds',async()=>{
    const evidence=await runRepresentativeCrmCapacity({tenantPool,tenantId:tenantA,operations:40,concurrency:4,poolMax:2});
    assert(evidence.operations===40&&evidence.errors===0,'representative CRM workload did not complete cleanly');
    assert(evidence.actualQueries===40&&evidence.queriesPerOperation===1,'representative CRM workload exceeded its query budget');
    assert(evidence.maxConcurrentQueries<=2&&evidence.maxConcurrentOperations<=2,'representative CRM workload exceeded its pool/concurrency bound');
    return `workload=${evidence.workload}, operations=${evidence.operations}, errors=${evidence.errors}, elapsed=${evidence.elapsedMs}ms, pool-max=${evidence.poolMax}, max-concurrent-queries=${evidence.maxConcurrentQueries}, queries=${evidence.actualQueries}, queries-per-operation=${evidence.queriesPerOperation}`;
  });

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
    const stale=[a[0],b[0]].sort((left,right)=>left.jobId.localeCompare(right.jobId))[0];clockMs+=1_001;
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
    await controlPool.withAdminSession(session=>session.query('INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT (identity_id) DO NOTHING',[identityId,'foundation@example.invalid','Foundation verifier','not-a-real-login-hash']));
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
  process.stderr.write(redactCertificationDiagnostic(`FOUNDATION VERIFICATION FAILED: ${error.message}\n`,REDACTION_ENV));
  process.exitCode=1;
}).finally(cleanup);
