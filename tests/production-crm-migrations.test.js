import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  planMigrations,
  applicationRoleGrants,
  controlPlaneRoleGrants,
  TENANT_TABLES
} from '../server/persistence/index.js';

const CRM_TABLES=Object.freeze([
  'parties',
  'people',
  'organizations',
  'contact_points',
  'relationships',
  'party_events'
]);

test('canonical CRM migration 13 appends without rewriting the certified foundation',()=>{
  assert.equal(SCHEMA_VERSION,13);
  assert.deepEqual(MIGRATIONS.map(entry=>entry.version),[
    1,2,3,4,5,6,7,8,9,10,11,12,13
  ]);
  const certified=MIGRATIONS.slice(0,12);
  const plan=planMigrations(certified.map(({version,name,checksum})=>({version,name,checksum})));
  assert.equal(plan.currentVersion,12);
  assert.equal(plan.targetVersion,13);
  assert.deepEqual(plan.pending.map(entry=>entry.version),[13]);
});

test('migration 13 defines typed party subtypes, normalized contacts and composite tenant links',()=>{
  const sql=MIGRATIONS.find(entry=>entry.version===13)?.statements.join('\n')??'';
  assert.match(sql,/CREATE TABLE parties\(/);
  assert.match(sql,/party_type text NOT NULL CHECK \(party_type IN \('person','organization'\)\)/);
  assert.match(sql,/CREATE TABLE people\(/);
  assert.match(sql,/CREATE TABLE organizations\(/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, party_id\) REFERENCES parties\(tenant_id, party_id\)/);
  assert.match(sql,/CREATE TABLE contact_points\(/);
  assert.match(sql,/UNIQUE \(tenant_id, type, normalized_value\)/);
  assert.match(sql,/CREATE TABLE relationships\(/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, from_party_id\) REFERENCES parties\(tenant_id, party_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, to_party_id\) REFERENCES parties\(tenant_id, party_id\)/);
  assert.match(sql,/CHECK \(from_party_id <> to_party_id\)/);
  assert.match(sql,/CREATE TABLE party_events\(/);
  assert.match(sql,/party_event_no_update/);
  assert.match(sql,/party_event_no_delete/);
  assert.match(sql,/wimblo_party_subtype_matches/);
});

test('every CRM table is tenant-owned, forced-RLS and indexed for core lookups',()=>{
  const sql=MIGRATIONS.find(entry=>entry.version===13)?.statements.join('\n')??'';
  for(const table of CRM_TABLES){
    assert.ok(TENANT_TABLES.includes(table),`${table} must be a tenant business table`);
    assert.match(sql,new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql,new RegExp(`CREATE POLICY ${table}_tenant_isolation`));
  }
  assert.match(sql,/CREATE INDEX parties_tenant_name ON parties\(tenant_id, display_name, party_id\)/);
  assert.match(sql,/CREATE INDEX contact_points_tenant_normalized ON contact_points\(tenant_id, type, normalized_value\)/);
  assert.match(sql,/CREATE INDEX contact_points_party ON contact_points\(tenant_id, party_id, type, is_primary DESC\)/);
  assert.match(sql,/CREATE INDEX relationships_from ON relationships\(tenant_id, from_party_id, status\)/);
  assert.match(sql,/CREATE INDEX relationships_to ON relationships\(tenant_id, to_party_id, status\)/);
});

test('application and control roles receive distinct least-privilege CRM access',()=>{
  const tenant=applicationRoleGrants('wimblo_app');
  const control=controlPlaneRoleGrants('wimblo_control');
  for(const table of CRM_TABLES){
    assert.ok(tenant.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO wimblo_app`),table);
    assert.ok(control.includes(`REVOKE ALL PRIVILEGES ON ${table} FROM wimblo_control`),table);
    assert.equal(control.some(sql=>sql.startsWith('GRANT SELECT, INSERT, UPDATE, DELETE')&&sql.includes(table)),false,table);
  }
  assert.equal([...tenant,...control].some(sql=>/GRANT ALL|SUPERUSER|BYPASSRLS/.test(sql)),false);
});

test('prior migration checksums remain immutable',()=>{
  const previous=MIGRATIONS.slice(0,12).map(entry=>entry.checksum);
  assert.equal(previous.length,12);
  assert.equal(new Set(previous).size,12);
  assert.match(previous[0],/^[a-f0-9]{64}$/);
  assert.match(previous[11],/^[a-f0-9]{64}$/);
});
