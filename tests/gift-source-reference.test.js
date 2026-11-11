// Gift source-reference uniqueness is enforced by a unique partial expression index
// (server/recordLookups.js), not by a JavaScript scan. The same scenarios run against
// PostgreSQL in tests/postgres/gift-source-reference-postgres.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openWorkspace,manualGiftsAllSucceed,duplicatesAreRefusedByTheDatabase,onlyIdenticalStringReferencesConflict,voidedGiftsKeepTheirReference,existingDuplicatesRefuseToOpen,concurrentCreatesCannotBothSucceed} from './gift-source-reference-scenarios.js';
import {GIFT_SOURCE_REFERENCE_INDEX} from '../server/recordLookups.js';

async function directory(t){const dir=await mkdtemp(join(tmpdir(),'wimblo-gift-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('several manual gifts with the real empty reference all succeed, by record create and by import',async t=>{
 const f=await openWorkspace(t,join(await directory(t),'workspace.sqlite'));
 await manualGiftsAllSucceed(f);
});

test('a duplicate source reference is refused with the preserved 409 on create, import and financial correction',async t=>{
 const f=await openWorkspace(t,join(await directory(t),'workspace.sqlite'));
 await duplicatesAreRefusedByTheDatabase(f);
});

test('only byte-identical non-empty string references conflict, exactly as the removed scan compared them',async t=>{
 const f=await openWorkspace(t,join(await directory(t),'workspace.sqlite'));
 await onlyIdenticalStringReferencesConflict(f);
});

test('a voided gift keeps its reference and the refusal points at financial correction',async t=>{
 const f=await openWorkspace(t,join(await directory(t),'workspace.sqlite'));
 await voidedGiftsKeepTheirReference(f);
});

test('a workspace that already holds duplicate references refuses to open, naming the gifts and changing none',async t=>{
 existingDuplicatesRefuseToOpen(join(await directory(t),'workspace.sqlite'));
});

test('the unique index is the partial expression index the scan was replaced by',async t=>{
 const f=await openWorkspace(t,join(await directory(t),'workspace.sqlite'));
 const {sql}=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(GIFT_SOURCE_REFERENCE_INDEX);
 assert.equal(sql,"CREATE UNIQUE INDEX records_gift_source_reference ON records(json_extract(data,'$.externalRef')) WHERE collection='gifts' AND typeof(json_extract(data,'$.externalRef'))='text' AND json_extract(data,'$.externalRef')<>''");
 // validate() no longer loads the gift collection to check a reference.
 const statements=[];const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{statements.push(sql);return prepare(sql);};
 try{assert.equal((await f.create(f.gift({externalRef:'NO-SCAN-1'}))).status,201);}finally{delete f.db.prepare;}
 assert.ok(!statements.some(s=>/collection=\? ORDER BY rowid/.test(s)),statements.join('\n'));
});

test('on one database file a second writer cannot insert a reference another uncommitted writer holds',async t=>{
 const dir=await directory(t),path=join(dir,'workspace.sqlite');
 const f=await openWorkspace(t,path);
 const gift=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' LIMIT 1").get().data);
 const a=new DatabaseSync(path),b=new DatabaseSync(path);t.after(()=>{a.close();b.close();});
 b.exec('PRAGMA busy_timeout=0');
 const insert=(db,id)=>db.prepare('INSERT INTO records VALUES(?,?,?)').run('gifts',id,JSON.stringify({...gift,id,externalRef:'INTERLEAVED-1'}));
 a.exec('BEGIN IMMEDIATE');insert(a,'writer-a');
 assert.throws(()=>b.exec('BEGIN IMMEDIATE'),/database is locked/);
 a.exec('COMMIT');
 b.exec('BEGIN IMMEDIATE');
 assert.throws(()=>insert(b,'writer-b'),/UNIQUE constraint failed: index 'records_gift_source_reference'/);
 b.exec('ROLLBACK');
 assert.deepEqual(f.db.prepare("SELECT id FROM records WHERE collection='gifts' AND json_extract(data,'$.externalRef')='INTERLEAVED-1'").all().map(r=>r.id),['writer-a']);
});

test('two server processes creating the same references at the same moment: exactly one succeeds for each',async t=>{
 const result=await concurrentCreatesCannotBothSucceed(t,join(await directory(t),'workspace.sqlite'));
 assert.equal(result.created,result.refs.length);assert.equal(result.refused,result.refs.length);
});
