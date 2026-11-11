// Proves the harness preload reaches node:test's per-file subprocess: run it with
//   node --import ./tests/postgres/harness/preload.mjs --test tests/postgres/harness-probe.test.js
// Without the preload it fails, never skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseFactoryInstalled,openDatabase} from '../../server/persistence/openDatabase.js';

test('the PostgreSQL factory is installed inside this test subprocess',()=>{
 const h=globalThis.__wimbloPostgresHarness;
 assert.ok(h,'preload did not run in this process');
 assert.equal(h.pid,process.pid);
 assert.notEqual(process.pid,Number(process.env.WIMBLO_PG_PARENT_PID||0));
 assert.equal(databaseFactoryInstalled(),true);
 const db=openDatabase(':memory:');
 try{assert.match(db.prepare('SELECT version() AS v').get().v,/^PostgreSQL/);assert.match(db.schema,/^wt_/);}finally{db.close();}
 process.stdout.write(`harness-probe pid=${process.pid} ppid=${process.ppid} url=${h.url}\n`);
});
