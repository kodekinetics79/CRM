import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  PERSISTENCE_CODES,
  applicationRoleGrants,
  applyMigrations,
  controlPlaneRoleGrants,
  createPostgresPool,
  createPostgresRepository,
  createTenantBackup,
  restoreTenantBackup,
  verifyRestore
} from '../../server/persistence/index.js';
import {createCrmRepository} from '../../server/production/crmRepository.js';
import {certifyProductionPools} from '../../server/production/startupChecks.js';

const BASE_URL=process.env.WIMBLO_FOUNDATION_VERIFY_PG_URL||'postgres://wimblo_admin:wimblo-foundation@127.0.0.1:57733/wimblo_foundation';

const identifier=value=>{
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(value))throw new Error(`Unsafe test identifier: ${value}`);
  return `"${value}"`;
};

const databaseUrl=(database,user,password)=>{
  const url=new URL(BASE_URL);
  url.pathname=`/${database}`;
  if(user)url.username=user;
  if(password)url.password=password;
  return url.toString();
};

async function disposableDatabase({bypassRls}){
  const parsed=new URL(BASE_URL);
  if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname))throw new Error('Database boundary tests require a loopback PostgreSQL server.');
  const stamp=`${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`.toLowerCase();
  const database=`wimblo_boundary_${stamp}`;
  const ownerRole=`wimblo_owner_${stamp}`;
  const tenantRole=`wimblo_tenant_${stamp}`;
  const controlRole=`wimblo_control_${stamp}`;
  const password='wimblo-local-boundary';
  const admin=createPostgresPool({connectionString:BASE_URL,acquireAttempts:1,connectionTimeoutMs:3_000,applicationName:'wimblo-boundary-admin'});
  const pools=[];
  await admin.withAdminSession(async session=>{
    await session.query(`CREATE ROLE ${identifier(ownerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypassRls?'BYPASSRLS':'NOBYPASSRLS'} PASSWORD '${password}'`);
    await session.query(`CREATE ROLE ${identifier(tenantRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
    await session.query(`CREATE ROLE ${identifier(controlRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
    await session.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(ownerRole)}`);
  });
  const owner=createPostgresPool({connectionString:databaseUrl(database,ownerRole,password),max:2,applicationName:'wimblo-boundary-owner'});
  pools.push(owner);
  return {
    database,ownerRole,tenantRole,controlRole,password,owner,
    makeTenantPool(){const pool=createPostgresPool({connectionString:databaseUrl(database,tenantRole,password),max:2,applicationName:'wimblo-boundary-tenant'});pools.push(pool);return pool;},
    makeControlPool(){const pool=createPostgresPool({connectionString:databaseUrl(database,controlRole,password),max:2,applicationName:'wimblo-boundary-control'});pools.push(pool);return pool;},
    async cleanup(){
      for(const pool of pools.reverse())await pool.end().catch(()=>{});
      await admin.withAdminSession(async session=>{
        await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
        await session.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
        await session.query(`DROP ROLE IF EXISTS ${identifier(tenantRole)}`);
        await session.query(`DROP ROLE IF EXISTS ${identifier(controlRole)}`);
        await session.query(`DROP ROLE IF EXISTS ${identifier(ownerRole)}`);
      });
      await admin.end();
    }
  };
}

test('migration execution refuses a non-bypassing owner before forced-RLS schema is installed',async()=>{
  const fixture=await disposableDatabase({bypassRls:false});
  try{
    await assert.rejects(()=>fixture.owner.withAdminSession(session=>applyMigrations(session)),error=>{
      assert.equal(error.code,PERSISTENCE_CODES.MIGRATION);
      assert.match(error.message,/migration owner/i);
      assert.match(error.message,/BYPASSRLS|superuser/);
      return true;
    });
    const version=await fixture.owner.withAdminSession(session=>session.query('SELECT COALESCE(MAX(version),0)::int AS version FROM wimblo_schema_migrations'));
    assert.ok(version.rows[0].version<5,'forced-RLS migration was applied before the owner preflight refused the role');
  }finally{
    await fixture.cleanup();
  }
});

test('bypassing migration owner upgrades populated schemas while runtime roles remain isolated',async()=>{
  const fixture=await disposableDatabase({bypassRls:true});
  try{
    const closedTenant=randomUUID(),activeTenant=randomUUID(),jobId=randomUUID();
    const actor=randomUUID(),assignee=randomUUID(),inactive=randomUUID(),crossTenantIdentity=randomUUID();
    const partyId=randomUUID(),taskId=randomUUID(),noteId=randomUUID(),objectId=`boundary-${randomUUID()}`;

    await fixture.owner.withAdminSession(session=>applyMigrations(session,{list:MIGRATIONS.slice(0,8)}));
    await fixture.owner.withAdminSession(async session=>{
      await session.query("INSERT INTO tenants(tenant_id,name,residency_profile,database_region,storage_region,status) VALUES($1,'Closing tenant','north-america','us-east-1','us-east-1','exited'),($2,'Active tenant','north-america','us-east-1','us-east-1','active')",[closedTenant,activeTenant]);
      await session.query("INSERT INTO wimblo_platform.durable_jobs(tenant_id,job_id,queue,kind,idempotency_key,payload,state) VALUES($1,$2,'default','boundary.job','boundary-job','{}','dead_lettered')",[closedTenant,jobId]);
      await session.query("INSERT INTO wimblo_platform.dead_letter_jobs(tenant_id,job_id,reason_code,reason_detail) VALUES($1,$2,'BOUNDARY','Boundary test')",[closedTenant,jobId]);
    });

    await fixture.owner.withAdminSession(session=>applyMigrations(session,{list:MIGRATIONS.slice(0,14)}));
    await fixture.owner.withAdminSession(async session=>{
      await session.query("INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash) VALUES($1,'actor@example.invalid','Actor','x'),($2,'assignee@example.invalid','Assignee','x'),($3,'inactive@example.invalid','Inactive','x'),($4,'cross@example.invalid','Cross tenant','x')",[actor,assignee,inactive,crossTenantIdentity]);
      await session.query("INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status) VALUES($1,$2,$3,'owner','active'),($4,$2,$5,'staff','active'),($6,$2,$7,'staff','suspended'),($8,$9,$10,'owner','active')",[randomUUID(),activeTenant,actor,randomUUID(),assignee,randomUUID(),inactive,randomUUID(),closedTenant,crossTenantIdentity]);
      await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Existing customer')",[activeTenant,partyId]);
      await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Existing','Customer')",[activeTenant,partyId]);
    });

    await fixture.owner.withAdminSession(session=>applyMigrations(session));
    assert.equal(SCHEMA_VERSION,18);
    const lifecycle=await fixture.owner.withAdminSession(session=>session.query('SELECT status,lifecycle_version FROM tenants WHERE tenant_id=$1',[closedTenant]));
    assert.deepEqual(lifecycle.rows[0],{status:'closed',lifecycle_version:2});
    const backfill=await fixture.owner.withAdminSession(session=>session.query('SELECT subject_type,party_id::text FROM crm_subjects WHERE tenant_id=$1 AND subject_id=$2',[activeTenant,partyId]));
    assert.deepEqual(backfill.rows[0],{subject_type:'party',party_id:partyId});

    for(const sql of applicationRoleGrants(fixture.tenantRole))await fixture.owner.withAdminSession(session=>session.query(sql));
    for(const sql of controlPlaneRoleGrants(fixture.controlRole))await fixture.owner.withAdminSession(session=>session.query(sql));
    const tenantPool=fixture.makeTenantPool(),controlPool=fixture.makeControlPool();
    const certified=await certifyProductionPools({tenantPool,controlPool});
    assert.equal(certified.schemaVersion,18);

    const state=await controlPool.withAdminSession(session=>session.query('SELECT status,lifecycle_version FROM wimblo_platform.tenant_state($1)',[closedTenant]));
    assert.deepEqual(state.rows[0],{status:'closed',lifecycle_version:2});
    const runnable=await controlPool.withAdminSession(session=>session.query('SELECT tenant_id::text FROM wimblo_platform.runnable_tenant_ids()'));
    assert.deepEqual(runnable.rows,[{tenant_id:activeTenant}]);
    const deadLetters=await controlPool.withAdminSession(session=>session.query('SELECT wimblo_platform.dead_letter_count()::int AS count'));
    assert.equal(deadLetters.rows[0].count,1);

    const membership=async(tenant,identity)=>tenantPool.withTenantSession(activeTenant,session=>session.query('SELECT wimblo_platform.active_membership($1,$2) AS active',[tenant,identity]));
    assert.equal((await membership(activeTenant,actor)).rows[0].active,true);
    assert.equal((await membership(activeTenant,inactive)).rows[0].active,false);
    assert.equal((await membership(closedTenant,crossTenantIdentity)).rows[0].active,false);
    await assert.rejects(()=>tenantPool.withTenantSession(activeTenant,session=>session.query('SELECT identity_id FROM wimblo_platform.memberships')),/permission denied/);

    await tenantPool.withTransaction(activeTenant,session=>session.query("INSERT INTO object_metadata(tenant_id,object_id,revision,object_key,provider,bucket,namespace,region,residency_profile,custody,content_type,size_bytes,sha256,ciphertext_sha256,encryption_algorithm,encryption_key_id,state) VALUES($1,$2,1,$3,'memory','private','crm','us-east-1','north-america','provider-managed-key','application/pdf',10,$4,$4,'AES-256-GCM','boundary','active')",[activeTenant,objectId,`tenants/${activeTenant}/crm/${objectId}`,'a'.repeat(64)]));
    const repository=createCrmRepository({tenantPool});
    const activity=await repository.createActivity({tenantId:activeTenant,subjectId:partyId,actorIdentityId:actor,activityType:'call',summary:'Boundary call'});
    assert.equal(activity.actorIdentityId,actor);
    const task=await repository.createTask({tenantId:activeTenant,taskId,subjectId:partyId,title:'Boundary task',ownerIdentityId:assignee,actorIdentityId:actor});
    assert.equal(task.ownerIdentityId,assignee);
    const note=await repository.createNote({tenantId:activeTenant,noteId,subjectId:partyId,title:'Boundary note',body:'Verified',actorIdentityId:actor});
    assert.equal(note.noteId,noteId);
    const attachment=await repository.linkAttachment({tenantId:activeTenant,subjectId:partyId,objectId,objectRevision:1,fileName:'boundary.pdf',actorIdentityId:actor});
    assert.equal(attachment.actorIdentityId,actor);
    const owned=await repository.changeSubjectOwner({tenantId:activeTenant,subjectId:partyId,newOwnerIdentityId:assignee,expectedVersion:1,actorIdentityId:actor});
    assert.equal(owned.ownerIdentityId,assignee);

    for(const operation of [
      ()=>repository.createActivity({tenantId:activeTenant,subjectId:partyId,actorIdentityId:inactive,activityType:'call',summary:'Inactive actor'}),
      ()=>repository.createTask({tenantId:activeTenant,subjectId:partyId,title:'Cross tenant owner',ownerIdentityId:crossTenantIdentity,actorIdentityId:actor}),
      ()=>repository.changeSubjectOwner({tenantId:activeTenant,subjectId:partyId,newOwnerIdentityId:inactive,expectedVersion:2,actorIdentityId:actor})
    ])await assert.rejects(operation,error=>error.code===PERSISTENCE_CODES.ISOLATION);

    await fixture.owner.withAdminSession(session=>session.query(`GRANT SELECT(identity_id) ON wimblo_platform.memberships TO ${identifier(fixture.tenantRole)}`));
    await assert.rejects(()=>certifyProductionPools({tenantPool,controlPool}),error=>{
      assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
      assert.match(error.message,/memberships/);
      return true;
    });
    await fixture.owner.withAdminSession(session=>session.query(`REVOKE SELECT(identity_id) ON wimblo_platform.memberships FROM ${identifier(fixture.tenantRole)}`));
    await fixture.owner.withAdminSession(session=>session.query(`GRANT MAINTAIN ON wimblo_platform.memberships TO ${identifier(fixture.tenantRole)}`));
    await assert.rejects(()=>certifyProductionPools({tenantPool,controlPool}),error=>{
      assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
      assert.match(error.message,/memberships/);
      return true;
    });
    await fixture.owner.withAdminSession(session=>session.query(`REVOKE MAINTAIN ON wimblo_platform.memberships FROM ${identifier(fixture.tenantRole)}`));
    await fixture.owner.withAdminSession(session=>session.query(`GRANT TRIGGER ON wimblo_platform.memberships TO ${identifier(fixture.tenantRole)}`));
    await assert.rejects(()=>certifyProductionPools({tenantPool,controlPool}),error=>{
      assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
      assert.match(error.message,/memberships/);
      return true;
    });
    await fixture.owner.withAdminSession(session=>session.query(`REVOKE TRIGGER ON wimblo_platform.memberships FROM ${identifier(fixture.tenantRole)}`));
    await fixture.owner.withAdminSession(session=>session.query(`GRANT EXECUTE ON FUNCTION wimblo_platform.tenant_state(uuid) TO ${identifier(fixture.tenantRole)}`));
    await assert.rejects(()=>certifyProductionPools({tenantPool,controlPool}),error=>{
      assert.equal(error.code,PERSISTENCE_CODES.ISOLATION);
      assert.match(error.message,/tenant_state/);
      return true;
    });
  }finally{
    await fixture.cleanup();
  }
});

const CRM_RECOVERY_TABLES=Object.freeze([
 'parties','people','organizations','contact_points','relationships','party_events',
 'pipelines','pipeline_stages','leads','opportunities','opportunity_stage_events',
 'crm_subjects','crm_activities','crm_tasks','crm_task_events','crm_notes','crm_note_revisions','crm_attachment_links','crm_ownership_events',
 'crm_saved_reports','crm_import_batches','crm_import_source_mappings'
]);

test('tenant logical backup restores and verifies every production CRM table',async()=>{
 const source=await disposableDatabase({bypassRls:true}),target=await disposableDatabase({bypassRls:true});
 try{
  await source.owner.withAdminSession(session=>applyMigrations(session));
  await target.owner.withAdminSession(session=>applyMigrations(session));
  for(const sql of applicationRoleGrants(source.tenantRole))await source.owner.withAdminSession(session=>session.query(sql));
  for(const sql of applicationRoleGrants(target.tenantRole))await target.owner.withAdminSession(session=>session.query(sql));
  const sourcePool=source.makeTenantPool(),targetPool=target.makeTenantPool(),tenantId=randomUUID(),partyId=randomUUID(),identityId=randomUUID();
  const pipelineId=randomUUID(),stageId=randomUUID(),leadId=randomUUID(),opportunityId=randomUUID();
  const sourceRepository=await createPostgresRepository({pool:sourcePool,tenantId,tenant:{name:'CRM recovery source'}});
  const targetRepository=await createPostgresRepository({pool:targetPool,tenantId,tenant:{name:'CRM recovery target'}});
  for(const fixture of [source,target])await fixture.owner.withAdminSession(async session=>{
   await session.query("INSERT INTO wimblo_platform.global_identities(identity_id,normalized_email,display_name,password_hash) VALUES($1,$2,'Recovery owner','x')",[identityId,`recovery-${fixture.database}@example.invalid`]);
   await session.query("INSERT INTO wimblo_platform.memberships(membership_id,tenant_id,identity_id,role,status) VALUES($1,$2,$3,'owner','active')",[randomUUID(),tenantId,identityId]);
  });
  await sourcePool.withTransaction(tenantId,async session=>{
   await session.query("INSERT INTO parties(tenant_id,party_id,party_type,display_name) VALUES($1,$2,'person','Recovered customer')",[tenantId,partyId]);
   await session.query("INSERT INTO people(tenant_id,party_id,first_name,last_name) VALUES($1,$2,'Recovered','Customer')",[tenantId,partyId]);
   await session.query("INSERT INTO pipelines(tenant_id,pipeline_id,name,is_default) VALUES($1,$2,'Recovery pipeline',true)",[tenantId,pipelineId]);
   await session.query("INSERT INTO pipeline_stages(tenant_id,stage_id,pipeline_id,name,kind,position,probability) VALUES($1,$2,$3,'Won','won',1,100)",[tenantId,stageId,pipelineId]);
   await session.query("INSERT INTO leads(tenant_id,lead_id,party_id,pipeline_id,stage_id,source,status,owner_identity_id,expected_value_cents,currency,probability,expected_close_date) VALUES($1,$2,$3,$4,$5,'recovery','qualified',$6,12500,'USD',100,'2026-12-01')",[tenantId,leadId,partyId,pipelineId,stageId,identityId]);
   await session.query("INSERT INTO opportunities(tenant_id,opportunity_id,party_id,pipeline_id,stage_id,lead_id,name,amount_cents,currency,probability,expected_close_date,status,owner_identity_id) VALUES($1,$2,$3,$4,$5,$6,'Recovered opportunity',12500,'USD',100,'2026-12-01','won',$7)",[tenantId,opportunityId,partyId,pipelineId,stageId,leadId,identityId]);
   await session.query("UPDATE leads SET status='converted',converted_opportunity_id=$3 WHERE tenant_id=$1 AND lead_id=$2",[tenantId,leadId,opportunityId]);
   await session.query("INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id,owner_identity_id) VALUES($1,$2,'party',$2,$3)",[tenantId,partyId,identityId]);
  });
  const backup=await createTenantBackup({repository:sourceRepository,encryptionKey:'d'.repeat(64),now:()=> '2026-11-11T12:00:00.000Z'});
  assert.ok(backup.manifest.digest.tenantData,'CRM tenant-table digest is missing from the backup manifest');
  for(const table of CRM_RECOVERY_TABLES)assert.ok(Object.hasOwn(backup.manifest.digest.tenantData,table),`${table} is absent from the backup manifest`);
  assert.equal(backup.manifest.digest.tenantData.parties.count,1);
  const restored=await restoreTenantBackup({
   archive:backup.archive,encryptionKey:'d'.repeat(64),expectedTenantId:tenantId,closeTarget:false,
   createTargetRepository:()=>targetRepository
  });
  try{
   assert.equal(restored.verification.verified,true);
   const evidence=await verifyRestore({manifest:backup.manifest,source:sourceRepository,restored:restored.repository});
   assert.equal(evidence.verified,true);
   assert.equal(evidence.tenantData.parties.count,1);
   const rows=await targetPool.withTenantSession(tenantId,session=>session.query('SELECT (SELECT count(*) FROM parties)::int AS parties,(SELECT count(*) FROM people)::int AS people,(SELECT count(*) FROM crm_subjects)::int AS subjects,(SELECT count(*) FROM leads WHERE status=\'converted\')::int AS converted_leads,(SELECT count(*) FROM opportunities WHERE lead_id=$1)::int AS linked_opportunities',[leadId]));
   assert.deepEqual(rows.rows[0],{parties:1,people:1,subjects:1,converted_leads:1,linked_opportunities:1});
  }finally{await restored.repository.close();}
 }finally{
  await Promise.all([source.cleanup(),target.cleanup()]);
 }
});
