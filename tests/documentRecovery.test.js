import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentRecoveryAdapter} from '../server/documentRecovery.js';

test('offline document recovery exports only the exact selected tenant reference and complete provider tuple',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE document_revision_storage(document_id TEXT,revision INTEGER,tenant_id TEXT,provider TEXT,bucket TEXT,namespace TEXT,object_key TEXT,object_version TEXT,sha256 TEXT,size INTEGER,created_at TEXT)');
  const values=['doc-1',3,'tenant-1','s3','private-bucket','deployment','scoped-key','version-1','a'.repeat(64),7,'2026-09-13'];db.prepare('INSERT INTO document_revision_storage VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...values);
  const row=db.prepare('SELECT * FROM document_revision_storage').get();let received;
  const objectStorage={scope:{provider:'s3',bucket:'private-bucket',namespace:'deployment'},get:async ref=>{received=ref;return Buffer.from('fixture');}};
  const adapter=createDocumentRecoveryAdapter({db,tenantId:'tenant-1',objectStorage});assert.equal((await adapter.exportStoredRevision(row)).toString(),'fixture');assert.equal(received.documentId,'doc-1');assert.equal(received.revision,3);assert.equal(received.version,'version-1');
  received=null;await assert.rejects(()=>createDocumentRecoveryAdapter({db,tenantId:'other-tenant',objectStorage}).exportStoredRevision(row),/tenant/);assert.equal(received,null);
  await assert.rejects(()=>adapter.exportStoredRevision({...row,object_version:'wrong-version'}),/reference/);assert.equal(received,null);
  objectStorage.get=async()=>{db.prepare('UPDATE document_revision_storage SET object_version=?').run('changed-version');return Buffer.from('fixture');};await assert.rejects(()=>adapter.exportStoredRevision(row),/changed/);
 }finally{db.close();}
});
