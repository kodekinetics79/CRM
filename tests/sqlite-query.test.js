import test from 'node:test';
import assert from 'node:assert/strict';
import {translateQuery,translateExec,translateStatement,numberPlaceholders,translateRowid,translateInsertOrIgnore,translateCatalog,translatePragma,translateBegin,translateJson,jsonPathArgs,splitStatements,stripIndexedBy,translateGlob,translateIsNot,translateNullOrdering,expandSelectStar,translateSqlExpression,translateAliasCase,qualifyConflictUpdate,translateScalarMinMax,SUPPORT_SQL,SqliteQueryError} from '../server/persistence/sqliteQuery.js';

// Every statement below is copied from the running source. The file:line above
// each one is where it is issued today.

test('positional placeholders become $n in order',()=>{
 // server/observability.js:384
 assert.equal(translateQuery('SELECT * FROM legal_holds WHERE id=? AND tenant_id=?'),
  'SELECT * FROM legal_holds WHERE id=$1 AND tenant_id=$2');
 // server/accountStructure.js:176 — parameters spread ahead of the LIMIT
 assert.equal(translateQuery('SELECT * FROM account_structure_history WHERE subject=? AND subject_id=? ORDER BY at DESC,rowid DESC LIMIT ?'),
  'SELECT * FROM account_structure_history WHERE subject=$1 AND subject_id=$2 ORDER BY at DESC NULLS LAST,"__rowid" DESC NULLS LAST LIMIT $3');
 assert.equal(numberPlaceholders('a=? b=?').count,2);
});

test('a ? inside a string literal is not renumbered',()=>{
 assert.equal(translateQuery("SELECT id FROM records WHERE note='what? really?' AND collection=? AND id=?"),
  "SELECT id FROM records WHERE note='what? really?' AND collection=$1 AND id=$2");
 // doubled quotes inside the literal must not end it early
 assert.equal(translateQuery("SELECT ? AS a,'it''s a ? mark' AS b,? AS c"),"SELECT $1 AS a,'it''s a ? mark' AS b,$2 AS c");
 // quoted identifiers and comments are literal too
 assert.equal(translateQuery('SELECT "odd?name" FROM t WHERE x=?'),'SELECT "odd?name" FROM t WHERE x=$1');
 assert.equal(translateQuery('SELECT x FROM t -- is it ?\n WHERE y=?'),'SELECT x FROM t -- is it ?\n WHERE y=$1');
 assert.equal(translateQuery('SELECT x /* ? */ FROM t WHERE y=?'),'SELECT x /* ? */ FROM t WHERE y=$1');
});

test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING',()=>{
 // server/app.js:101
 assert.equal(translateQuery('INSERT OR IGNORE INTO settings VALUES(1,?)'),
  'INSERT INTO settings VALUES(1,$1) ON CONFLICT DO NOTHING');
 // server/reportSchedule.js:23
 assert.equal(translateQuery('INSERT OR IGNORE INTO report_deliveries VALUES(?,?,?,?,?,?,?,?)'),
  'INSERT INTO report_deliveries VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING');
 // server/receipts.js:28 — inside a db.exec() chunk, trailing semicolon kept
 assert.equal(translateExec('INSERT OR IGNORE INTO receipt_number_sequence VALUES(1,0);'),
  'INSERT INTO receipt_number_sequence VALUES(1,0) ON CONFLICT DO NOTHING;');
 assert.throws(()=>translateInsertOrIgnore('INSERT OR REPLACE INTO t VALUES(1)'),SqliteQueryError);
});

test('existing ON CONFLICT … DO UPDATE SET clauses survive untouched',()=>{
 const clauses=[
  // server/persistence/sqliteRepository.js:111
  'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',
  // server/persistence/sqliteRepository.js:189
  'INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  // server/persistence/sqliteRepository.js:197
  'INSERT INTO users(id,name,email,role,password_hash,active,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,password_hash=excluded.password_hash,active=excluded.active,version=excluded.version',
  // server/identity.js:45
  'INSERT INTO households VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,version=excluded.version,updated_at=excluded.updated_at',
  // server/offlineRecoverySchedule.js:38
  'INSERT INTO offline_recovery_schedule VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  // server/offlineRecoverySchedule.js:39
  'INSERT INTO offline_recovery_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  // server/volunteerPortal.js:185
  'INSERT INTO volunteer_reminder_consent VALUES(?,?,?,?,?,?) ON CONFLICT(constituent_id) DO UPDATE SET granted=excluded.granted,source=excluded.source,basis=excluded.basis,version=excluded.version,updated_at=excluded.updated_at',
  // server/volunteerPortal.js:565
  'INSERT INTO volunteer_reminder_config VALUES(?,?,?,?,?,?) ON CONFLICT(shift_id) DO UPDATE SET lead_minutes=excluded.lead_minutes,enabled=excluded.enabled,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by'
 ];
 for(const sql of clauses){
  const out=translateQuery(sql);
  assert.match(out,/ON CONFLICT/,sql);
  assert.match(out,/DO UPDATE SET/,sql);
  assert.match(out,/excluded\./,sql);
  assert.doesNotMatch(out,/DO NOTHING/,sql);
  assert.equal(out,numberPlaceholders(sql).sql,sql);
 }
 // server/publicGiving.js:109,143 already say DO NOTHING and must not gain a second clause
 assert.equal(translateQuery('INSERT INTO public_giving_token_uses VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING'),
  'INSERT INTO public_giving_token_uses VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING');
});

test('json paths are parsed, not pattern-matched',()=>{
 assert.deepEqual(jsonPathArgs("'$.status'").args,["'status'"]);
 assert.deepEqual(jsonPathArgs("'$.recipient.id'").args,["'recipient'","'id'"]);
 assert.deepEqual(jsonPathArgs("'$'").args,[]);
 assert.throws(()=>jsonPathArgs("'$.items[0]'"),SqliteQueryError);
 assert.throws(()=>jsonPathArgs("'$.*'"),SqliteQueryError);
 assert.throws(()=>jsonPathArgs('column'),SqliteQueryError);
});

test('json_extract on a text path becomes sqlite_json_extract',()=>{
 // server/peerFundraising.js:54
 assert.equal(translateQuery("SELECT 1 FROM peer_fundraisers WHERE json_extract(data,'$.status')='Active' AND json_extract(data,'$.campaignId')=? AND json_extract(data,'$.constituentId')=?"),
  "SELECT 1 FROM peer_fundraisers WHERE sqlite_json_extract((data)::jsonb,'status')='Active' AND sqlite_json_extract((data)::jsonb,'campaignId')=$1 AND sqlite_json_extract((data)::jsonb,'constituentId')=$2");
 // server/eventHelperAccess.js:41-42 — qualified column, IS NULL guard
 assert.equal(translateQuery("SELECT json_extract(c.data,'$.name') AS attendee_name FROM records c WHERE json_extract(c.data,'$.mergedInto') IS NULL"),
  "SELECT sqlite_json_extract((c.data)::jsonb,'name') AS attendee_name FROM records c WHERE sqlite_json_extract((c.data)::jsonb,'mergedInto') IS NULL");
 // server/constituentTimeline.js:37 — two paths, one parameter each
 assert.equal(translateQuery("SELECT * FROM gift_financial_corrections WHERE json_extract(before_json,'$.constituentId')=? OR json_extract(after_json,'$.constituentId')=? ORDER BY at,id"),
  "SELECT * FROM gift_financial_corrections WHERE sqlite_json_extract((before_json)::jsonb,'constituentId')=$1 OR sqlite_json_extract((after_json)::jsonb,'constituentId')=$2 ORDER BY at NULLS FIRST,id NULLS FIRST");
});

test('a nested json path keeps both keys',()=>{
 // server/constituentTimeline.js:58 — json_each with a path, then $.recipient.id
 assert.equal(translateQuery("SELECT * FROM correspondence_preparations WHERE EXISTS(SELECT 1 FROM json_each(snapshot,'$.items') i WHERE json_extract(i.value,'$.recipient.id')=?) ORDER BY at,id"),
  "SELECT * FROM correspondence_preparations WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_extract_path((snapshot)::jsonb,'items')) i WHERE sqlite_json_extract((i.value)::jsonb,'recipient','id')=$1) ORDER BY at NULLS FIRST,id NULLS FIRST");
});

test('money paths become numeric so SUM and COALESCE still typecheck',()=>{
 // server/dataQuality.js:92
 assert.equal(translateQuery("SELECT COUNT(*) AS n,COALESCE(SUM(json_extract(data,'$.amount')),0) AS cents FROM records WHERE collection='gifts' AND json_extract(data,'$.date')>=?"),
  "SELECT COUNT(*) AS n,COALESCE(SUM(sqlite_json_number((data)::jsonb,'amount')),0) AS cents FROM records WHERE collection='gifts' AND sqlite_json_extract((data)::jsonb,'date')>=$1");
 // server/accountStructure.js:28 — json_type beside a numeric comparison
 assert.equal(translateQuery("SELECT COUNT(*) AS n FROM records g,json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a WHERE g.collection='gifts' AND (json_type(a.value,'$.amount')<>'integer' OR json_type(a.value,'$.designationId')<>'text' OR json_extract(a.value,'$.amount')<1)"),
  "SELECT COUNT(*) AS n FROM records g,jsonb_array_elements((COALESCE(sqlite_json_extract((g.data)::jsonb,'allocations'),'[]'))::jsonb) a WHERE g.collection='gifts' AND (sqlite_json_type((a.value)::jsonb,'amount')<>'integer' OR sqlite_json_type((a.value)::jsonb,'designationId')<>'text' OR sqlite_json_number((a.value)::jsonb,'amount')<1)");
});

test('json booleans stay integers so Boolean(row.x) still means what it meant',()=>{
 // server/migration.js:458-460 — valid/replayed feed Boolean(); summary feeds JSON.parse()
 assert.equal(translateQuery("SELECT id,json_remove(json_extract(result,'$.summary'),'$.controlTotals') AS summary,json_remove(json_extract(result,'$.reconciliation'),'$.expectedNewControlTotals','$.actualNewControlTotals') AS reconciliation,json_extract(result,'$.valid') AS valid,json_extract(result,'$.replayed') AS replayed FROM import_batches"),
  "SELECT id,(((sqlite_json_extract((result)::jsonb,'summary'))::jsonb - 'controlTotals')::text) AS summary,(((sqlite_json_extract((result)::jsonb,'reconciliation'))::jsonb - 'expectedNewControlTotals' - 'actualNewControlTotals')::text) AS reconciliation,sqlite_json_int((result)::jsonb,'valid') AS valid,sqlite_json_int((result)::jsonb,'replayed') AS replayed FROM import_batches");
 // server/eventOperations.js:39
 assert.equal(translateStatement("UPDATE event_sponsorships SET fulfilled_once=1 WHERE fulfilled_once=0 AND EXISTS(SELECT 1 FROM json_each(event_sponsorships.benefits) WHERE json_extract(value,'$.completed')=1)"),
  "UPDATE event_sponsorships SET fulfilled_once=1 WHERE fulfilled_once=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements((event_sponsorships.benefits)::jsonb) WHERE sqlite_json_int((value)::jsonb,'completed')=1)");
});

test('a predicate used as a value becomes an integer, as SQLite treats it',()=>{
 // server/eventHelperAccess.js:43
 assert.equal(translateQuery("SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.constituentId')=t.constituent_id AND COALESCE(json_extract(r.value,'$.checkedIn'),0)=(t.checked_in_at IS NOT NULL)"),
  "SELECT 1 FROM jsonb_array_elements(($1)::jsonb) r WHERE sqlite_json_extract((r.value)::jsonb,'constituentId')=t.constituent_id AND COALESCE(sqlite_json_int((r.value)::jsonb,'checkedIn'),0)=(CASE WHEN t.checked_in_at IS NOT NULL THEN 1 ELSE 0 END)");
});

test('json_each over a text column and over a bound parameter',()=>{
 // server/financialCorrections.js:28
 assert.equal(translateQuery("SELECT 1 FROM gift_financial_corrections h,json_each(h.before_references) r WHERE json_extract(r.value,'$.collection')=? AND json_extract(r.value,'$.id')=?"),
  "SELECT 1 FROM gift_financial_corrections h,jsonb_array_elements((h.before_references)::jsonb) r WHERE sqlite_json_extract((r.value)::jsonb,'collection')=$1 AND sqlite_json_extract((r.value)::jsonb,'id')=$2");
});

test('json_type answers in SQLite vocabulary and the mergedInto guard keeps both comparisons',()=>{
 // server/marketingResponses.js:36 — '$.mergedInto' is compared to 0 and to '' on one line
 assert.equal(translateStatement("SELECT 1 FROM records WHERE (json_type(data,'$.mergedInto') IS NULL OR json_type(data,'$.mergedInto')='null' OR (json_type(data,'$.mergedInto') IN ('false','integer','real') AND json_extract(data,'$.mergedInto')=0) OR (json_type(data,'$.mergedInto')='text' AND json_extract(data,'$.mergedInto')=''))"),
  "SELECT 1 FROM records WHERE (sqlite_json_type((data)::jsonb,'mergedInto') IS NULL OR sqlite_json_type((data)::jsonb,'mergedInto')='null' OR (sqlite_json_type((data)::jsonb,'mergedInto') IN ('false','integer','real') AND sqlite_json_number((data)::jsonb,'mergedInto')=0) OR (sqlite_json_type((data)::jsonb,'mergedInto')='text' AND sqlite_json_extract((data)::jsonb,'mergedInto')=''))");
 // server/dataQuality.js:88
 assert.equal(translateStatement("SELECT COUNT(*) AS n FROM records WHERE collection='gifts' AND json_type(data,'$.amount')<>'integer'"),
  "SELECT COUNT(*) AS n FROM records WHERE collection='gifts' AND sqlite_json_type((data)::jsonb,'amount')<>'integer'");
});

test('typeof(json_extract(...)), INDEXED BY and GLOB — the unicode email probe',()=>{
 // server/marketingResponses.js:38, all three rules on one statement
 assert.equal(translateQuery("SELECT json_extract(data,'$.email') AS email FROM records INDEXED BY marketing_native_unicode_email WHERE collection='constituents' AND typeof(json_extract(data,'$.email'))='text' AND json_extract(data,'$.email') GLOB '*[^ -~]*'"),
  "SELECT sqlite_json_extract((data)::jsonb,'email') AS email FROM records WHERE collection='constituents' AND sqlite_json_sqltype((data)::jsonb,'email')='text' AND sqlite_json_extract((data)::jsonb,'email') ~ '[^ -~]'");
 assert.equal(stripIndexedBy('SELECT a FROM t INDEXED BY idx WHERE b=1'),'SELECT a FROM t WHERE b=1');
 assert.throws(()=>translateGlob("x GLOB 'a*b*c'"),SqliteQueryError);
 assert.throws(()=>translateGlob("x GLOB ?"),SqliteQueryError);
});

test('IS NOT against an expression becomes IS DISTINCT FROM',()=>{
 // server/accountStructure.js:29
 assert.equal(translateStatement("SELECT COUNT(*) AS n FROM (SELECT json_extract(g.data,'$.amount') AS amount,(SELECT SUM(json_extract(a.value,'$.amount')) FROM json_each(COALESCE(json_extract(g.data,'$.allocations'),'[]')) a) AS allocated FROM records g WHERE g.collection='gifts') WHERE amount IS NOT allocated"),
  "SELECT COUNT(*) AS n FROM (SELECT sqlite_json_number((g.data)::jsonb,'amount') AS amount,(SELECT SUM(sqlite_json_number((a.value)::jsonb,'amount')) FROM jsonb_array_elements((COALESCE(sqlite_json_extract((g.data)::jsonb,'allocations'),'[]'))::jsonb) a) AS allocated FROM records g WHERE g.collection='gifts') WHERE amount IS DISTINCT FROM allocated");
 // IS NOT NULL / IS NOT TRUE are already PostgreSQL and must not be rewritten
 assert.equal(translateIsNot('WHERE a IS NOT NULL AND b IS NOT TRUE AND c IS NOT DISTINCT FROM d'),
  'WHERE a IS NOT NULL AND b IS NOT TRUE AND c IS NOT DISTINCT FROM d');
});

test('ORDER BY rowid follows the DDL layer rowid surrogate',()=>{
 // server/app.js:104 and server/persistence/sqliteRepository.js:73 — insertion
 // order is the only order these statements specify.
 assert.equal(translateQuery('SELECT data FROM records WHERE collection=? ORDER BY rowid'),
  'SELECT data FROM records WHERE collection=$1 ORDER BY "__rowid" NULLS FIRST');
 // server/recurringGiving.js:61, hostedGiving.js:35, mailchimpContactSync.js:70
 assert.equal(translateQuery('SELECT id FROM automation_recovery_markers ORDER BY rowid DESC LIMIT 1'),
  'SELECT id FROM automation_recovery_markers ORDER BY "__rowid" DESC NULLS LAST LIMIT 1');
 // server/tenantAdministration.js:297
 assert.equal(translateQuery("SELECT * FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Approved' ORDER BY decided_at DESC,rowid DESC LIMIT 1"),
  'SELECT * FROM duty_reviews WHERE duty=$1 AND subject_id=$2 AND status=\'Approved\' ORDER BY decided_at DESC NULLS LAST,"__rowid" DESC NULLS LAST LIMIT 1');
 // server/tenantAdministration.js:147
 assert.equal(translateQuery('SELECT * FROM user_invitation_events WHERE invitation_id=? ORDER BY at,rowid'),
  'SELECT * FROM user_invitation_events WHERE invitation_id=$1 ORDER BY at NULLS FIRST,"__rowid" NULLS FIRST');
 // the column name is the DDL layer's option, not a constant of this module
 assert.equal(translateRowid('ORDER BY rowid','seq'),'ORDER BY "seq"');
 // a literal saying "rowid" is data
 assert.equal(translateRowid("SELECT 'rowid' AS label FROM t ORDER BY rowid"),'SELECT \'rowid\' AS label FROM t ORDER BY "__rowid"');
});

test('sqlite_master and sqlite_schema both resolve to the catalog view',()=>{
 // server/reporting.js:282, constituentTimeline.js:18, mailchimpContactSync.js:97
 assert.equal(translateQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"),
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=$1");
 // server/backup.js:24 — the four columns the caller selects
 assert.equal(translateQuery("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name"),
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type NULLS FIRST,name NULLS FIRST");
 // server/backup.js:75 — trigger definition lookup
 assert.equal(translateQuery("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name='document_revision_no_update' AND tbl_name='document_revisions'"),
  "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name='document_revision_no_update' AND tbl_name='document_revisions'");
 // server/persistence/legacySqliteMigration.js:47 and sqliteRepository.js:65
 assert.equal(translateQuery("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"),
  "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name NULLS FIRST");
 // the identifier inside a string literal is data, not a table reference
 assert.equal(translateCatalog("SELECT 'sqlite_master' AS n FROM sqlite_master"),"SELECT 'sqlite_master' AS n FROM sqlite_schema");
 // SUPPORT_SQL is what makes the view exist
 assert.match(SUPPORT_SQL,/DROP VIEW IF EXISTS sqlite_schema;\nCREATE VIEW sqlite_schema AS/);
 assert.match(SUPPORT_SQL,/SELECT 'table'::text AS type, c\.relname AS name, c\.relname AS tbl_name, obj_description\(c\.oid,'pg_class'\) AS sql/);
 // restricted to the current schema through the catalog index, never every workspace
 assert.equal((SUPPORT_SQL.match(/c\.relnamespace=to_regnamespace\(current_schema\(\)\)::oid/g)||[]).length,4);
 assert.doesNotMatch(SUPPORT_SQL,/nspname=current_schema\(\)|relname::text/);
});

test('PRAGMA table_info returns name and type the additive migrations can read',()=>{
 // server/app.js:98,222; platform.js:50,51,52; eventOperations.js:36; backup.js:116
 const sql=translateQuery('PRAGMA table_info(users)');
 assert.match(sql,/AS name\b/);assert.match(sql,/AS type\b/);assert.match(sql,/AS cid\b/);
 assert.match(sql,/AS notnull\b/);assert.match(sql,/AS dflt_value\b/);assert.match(sql,/AS pk\b/);
 assert.match(sql,/c\.relname='users'/);
 assert.match(sql,/ORDER BY a\.attnum/);
 assert.match(sql,/THEN 'TEXT'/);   // backup.js:116 asserts every column type reads TEXT
 assert.match(sql,/THEN 'INTEGER'/);
 // the rowid surrogate is never reported as a column, and cid is renumbered around it
 assert.match(sql,/a\.attname<>'__rowid'/);
 assert.match(sql,/row_number\(\) OVER \(ORDER BY a\.attnum\)-1/);
 assert.equal(translateQuery('PRAGMA table_info(automation_recovery_markers)').includes("'automation_recovery_markers'"),true);
 assert.throws(()=>translatePragma('PRAGMA table_info(users; DROP TABLE users)'),SqliteQueryError);
});

test('PRAGMA integrity_check and quick_check keep their one-row ok contract',()=>{
 // server/backup.js:23 requires exactly one row; productionReadiness.js:31 reads Object.values(row)[0]
 assert.equal(translateQuery('PRAGMA integrity_check'),
  "SELECT CASE WHEN (SELECT count(*) FROM pg_catalog.pg_class)>0 THEN 'ok' ELSE 'unreadable' END AS integrity_check");
 assert.match(translateQuery('PRAGMA quick_check'),/AS quick_check$/);
});

test('connection PRAGMAs become no-ops or their real equivalent',()=>{
 // server/app.js:89
 assert.equal(translateExec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'),
  "SET CONSTRAINTS ALL IMMEDIATE;\nSELECT NULL WHERE false;\nSET lock_timeout = '5000ms';");
 // server/persistence/sqliteRepository.js:64
 assert.equal(translateExec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'),
  "SET CONSTRAINTS ALL IMMEDIATE;\nSET lock_timeout = '5000ms';");
 // tests/communication-workflow-reporting.test.js:80 and :82
 assert.equal(translateExec('PRAGMA foreign_keys=OFF; DROP TRIGGER communication_workflow_execution_no_update'),
  'SET CONSTRAINTS ALL DEFERRED;\nDROP TRIGGER communication_workflow_execution_no_update;');
 assert.equal(translateStatement('PRAGMA foreign_keys=ON'),'SET CONSTRAINTS ALL IMMEDIATE');
 for(const off of ['PRAGMA foreign_keys = off','PRAGMA foreign_keys=0','PRAGMA foreign_keys=false'])assert.equal(translateStatement(off),'SET CONSTRAINTS ALL DEFERRED');
 assert.equal(translateStatement('PRAGMA foreign_keys'),'SELECT NULL WHERE false');
 assert.throws(()=>translatePragma('PRAGMA foreign_keys=maybe'),SqliteQueryError);
 // server/backup.js:22,115
 assert.equal(translateStatement('PRAGMA trusted_schema=OFF'),'SELECT NULL WHERE false');
 assert.equal(translateStatement('PRAGMA journal_mode=DELETE'),'SELECT NULL WHERE false');
 // server/platformRecovery.js:14
 assert.equal(translateStatement('PRAGMA locking_mode=EXCLUSIVE'),'SELECT NULL WHERE false');
 assert.throws(()=>translatePragma('PRAGMA busy_timeout=abc'),SqliteQueryError);
 assert.throws(()=>translatePragma('PRAGMA page_size=4096'),SqliteQueryError);
});

test('BEGIN IMMEDIATE and BEGIN EXCLUSIVE become BEGIN',()=>{
 // server/app.js:109, platform.js:53, mfa.js:28, reportSchedule.js:17,
 // offlineRecoverySchedule.js:35, backup.js:116, sqliteRepository.js:77
 assert.equal(translateQuery('BEGIN IMMEDIATE'),'BEGIN');
 // server/platformRecovery.js:14
 assert.equal(translateStatement('BEGIN EXCLUSIVE'),'BEGIN');
 assert.equal(translateStatement('BEGIN'),'BEGIN');
 assert.equal(translateBegin('BEGIN IMMEDIATE TRANSACTION'),'BEGIN');
 assert.equal(translateStatement('COMMIT'),'COMMIT');
 assert.equal(translateStatement('ROLLBACK'),'ROLLBACK');
 // server/platformRecovery.js:14 issues the whole lock probe as one exec
 assert.equal(translateExec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;'),
  "SET lock_timeout = '100ms';\nSELECT NULL WHERE false;\nBEGIN;\nCOMMIT;");
});

test('VACUUM INTO is refused rather than silently dropped',()=>{
 // server/backup.js:85
 assert.throws(()=>translateQuery('VACUUM INTO ?'),/VACUUM INTO has no PostgreSQL equivalent/);
});

test('statement splitting respects literals and semicolons inside them',()=>{
 assert.deepEqual(splitStatements("SELECT ';' ; SELECT 2").map(s=>s.trim()),["SELECT ';'",'SELECT 2']);
 assert.equal(splitStatements('  ;; ').length,0);
 assert.throws(()=>translateQuery('SELECT 1; SELECT 2'),/more than one statement/);
});

test('unterminated literals fail loudly instead of being renumbered',()=>{
 assert.throws(()=>translateQuery("SELECT 'abc"),SqliteQueryError);
 assert.throws(()=>translateQuery('SELECT "abc'),SqliteQueryError);
 assert.throws(()=>translateQuery('SELECT /* abc'),SqliteQueryError);
});

test('statements the codebase issues unchanged pass through unchanged apart from placeholders',()=>{
 const untouched=[
  // server/accountStructure.js:208
  ['SELECT 1 FROM account_locations WHERE lower(name)=lower(?)','SELECT 1 FROM account_locations WHERE lower(name)=lower($1)'],
  // server/eventHelperAccess.js:25
  ['UPDATE event_helper_assignments SET active=0,version=version+1,updated_at=? WHERE user_id=? AND active=1',
   'UPDATE event_helper_assignments SET active=0,version=version+1,updated_at=$1 WHERE user_id=$2 AND active=1']
 ];
 for(const [input,expected] of untouched)assert.equal(translateQuery(input),expected,input);
});

test('translateJson leaves SQL without json functions alone',()=>{
 const sql="SELECT * FROM users WHERE email IN ('alex@foundation.example','staff@foundation.example')";
 assert.equal(translateJson(sql),sql);
 assert.equal(translateStatement(sql),sql);
});

test('NULL ordering follows SQLite: NULLS FIRST ascending, NULLS LAST descending, at every level',()=>{
 // server/tenantAdministration.js:297 — the separation-of-duties approval in force
 assert.equal(translateQuery("SELECT * FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Approved' ORDER BY decided_at DESC,rowid DESC LIMIT 1"),
  "SELECT * FROM duty_reviews WHERE duty=$1 AND subject_id=$2 AND status='Approved' ORDER BY decided_at DESC NULLS LAST,\"__rowid\" DESC NULLS LAST LIMIT 1");
 // implicit and explicit ASC, several keys, expression keys, COLLATE before the direction
 assert.equal(translateNullOrdering('SELECT a FROM t ORDER BY a,b ASC,lower(c) DESC,CASE WHEN d IS NULL THEN 0 ELSE 1 END,e COLLATE "C" DESC'),
  'SELECT a FROM t ORDER BY a NULLS FIRST,b ASC NULLS FIRST,lower(c) DESC NULLS LAST,CASE WHEN d IS NULL THEN 0 ELSE 1 END NULLS FIRST,e COLLATE "C" DESC NULLS LAST');
 // a key that already says NULLS is never touched; columns named first/last/nulls are just columns
 assert.equal(translateNullOrdering('SELECT 1 FROM t ORDER BY a NULLS LAST,b DESC NULLS FIRST,first,last DESC,nulls'),
  'SELECT 1 FROM t ORDER BY a NULLS LAST,b DESC NULLS FIRST,first NULLS FIRST,last DESC NULLS LAST,nulls NULLS FIRST');
 // subqueries, window functions (frame clause ends the key), ordered aggregates
 assert.equal(translateNullOrdering("SELECT string_agg(a,',' ORDER BY b DESC),row_number() OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),(SELECT x FROM u ORDER BY y LIMIT 1) FROM (SELECT * FROM t ORDER BY a) s GROUP BY a ORDER BY 1 OFFSET 2"),
  "SELECT string_agg(a,',' ORDER BY b DESC NULLS LAST),row_number() OVER (PARTITION BY a ORDER BY b NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),(SELECT x FROM u ORDER BY y NULLS FIRST LIMIT 1) FROM (SELECT * FROM t ORDER BY a NULLS FIRST) s GROUP BY a ORDER BY 1 NULLS FIRST OFFSET 2");
 // literals and comments are data; the insertion lands before a trailing comment
 assert.equal(translateNullOrdering("SELECT 'ORDER BY x' FROM t /* ORDER BY y */ ORDER BY z -- ORDER BY w DESC\n"),
  "SELECT 'ORDER BY x' FROM t /* ORDER BY y */ ORDER BY z NULLS FIRST -- ORDER BY w DESC\n");
 assert.equal(translateNullOrdering('SELECT a FROM t UNION SELECT a FROM u ORDER BY a DESC FOR UPDATE'),'SELECT a FROM t UNION SELECT a FROM u ORDER BY a DESC NULLS LAST FOR UPDATE');
 assert.equal(translateNullOrdering('SELECT a FROM t WHERE b=1'),'SELECT a FROM t WHERE b=1');
 // it is part of every translated statement
 assert.equal(translateExec('SELECT a FROM t ORDER BY a; SELECT b FROM u ORDER BY b DESC'),'SELECT a FROM t ORDER BY a NULLS FIRST;\nSELECT b FROM u ORDER BY b DESC NULLS LAST;');
});

const COLUMNS={duty_reviews:['id','duty','decided_at'],event_ticket_transitions:['id','ticket_id','at'],event_tickets:['id','event_id'],documents:['id','title'],document_revisions:['document_id','revision'],records:['collection','id','data'],t:['a','b'],u:['id','x']};
const columnsOf=name=>COLUMNS[name];

test('SELECT *, t.* and RETURNING * expand to SQLite\'s column order when columnsOf is supplied',()=>{
 // server/tenantAdministration.js:297
 assert.equal(translateQuery("SELECT * FROM duty_reviews WHERE duty=? ORDER BY decided_at DESC,rowid DESC LIMIT 1",{columnsOf}),
  'SELECT duty_reviews."id",duty_reviews."duty",duty_reviews."decided_at" FROM duty_reviews WHERE duty=$1 ORDER BY decided_at DESC NULLS LAST,"__rowid" DESC NULLS LAST LIMIT 1');
 // server/eventOperations.js — alias.* beside explicit columns in a join
 assert.equal(translateQuery('SELECT h.*,t.event_id FROM event_ticket_transitions h JOIN event_tickets t ON t.id=h.ticket_id WHERE h.ticket_id=?',{columnsOf}),
  'SELECT h."id",h."ticket_id",h."at",t.event_id FROM event_ticket_transitions h JOIN event_tickets t ON t.id=h.ticket_id WHERE h.ticket_id=$1');
 // bare * over a join: left table's columns, then the right's
 assert.equal(translateQuery('SELECT * FROM t AS x LEFT JOIN u ON u.id=x.a, records',{columnsOf}),
  'SELECT x."a",x."b",u."id",u."x",records."collection",records."id",records."data" FROM t AS x LEFT JOIN u ON u.id=x.a, records');
 // server/documents.js — COUNT(*) in a correlated subquery is not a star item
 assert.equal(translateQuery('SELECT d.*, (SELECT COUNT(*) FROM document_revisions r WHERE r.document_id=d.id) AS revisions FROM documents d',{columnsOf}),
  'SELECT d."id",d."title", (SELECT COUNT(*) FROM document_revisions r WHERE r.document_id=d.id) AS revisions FROM documents d');
 assert.equal(translateQuery('SELECT COUNT(*) AS n,2*3 AS six FROM t',{columnsOf}),'SELECT COUNT(*) AS n,2*3 AS six FROM t');
 // EXISTS(SELECT * ...) produces no columns and is left alone, even over a table function
 assert.equal(translateQuery("SELECT 1 FROM t WHERE EXISTS(SELECT * FROM u WHERE u.id=t.a) AND NOT EXISTS (SELECT * FROM json_each(t.b))",{columnsOf}),
  "SELECT 1 FROM t WHERE EXISTS(SELECT * FROM u WHERE u.id=t.a) AND NOT EXISTS (SELECT * FROM jsonb_array_elements((t.b)::jsonb))");
 // nested, compound and derived: every SELECT expands against its own FROM; a star over a derived table or CTE is already safe
 assert.equal(translateQuery('SELECT * FROM (SELECT * FROM t) s UNION ALL SELECT * FROM u',{columnsOf}),'SELECT * FROM (SELECT t."a",t."b" FROM t) s UNION ALL SELECT u."id",u."x" FROM u');
 assert.equal(translateQuery('WITH recent AS (SELECT * FROM t) SELECT * FROM recent',{columnsOf}),'WITH recent AS (SELECT t."a",t."b" FROM t) SELECT * FROM recent');
 assert.equal(translateQuery('SELECT DISTINCT * FROM "t"',{columnsOf}),'SELECT DISTINCT "t"."a","t"."b" FROM "t"');
 // RETURNING *
 assert.equal(translateQuery('UPDATE t SET b=? WHERE a=? RETURNING *',{columnsOf}),'UPDATE t SET b=$1 WHERE a=$2 RETURNING t."a",t."b"');
 assert.equal(translateQuery('INSERT INTO t(a,b) VALUES(?,?) RETURNING *',{columnsOf}),'INSERT INTO t(a,b) VALUES($1,$2) RETURNING t."a",t."b"');
 assert.equal(translateQuery('DELETE FROM t WHERE a=? RETURNING a,*',{columnsOf}),'DELETE FROM t WHERE a=$1 RETURNING a,t."a",t."b"');
 // literals and comments are data
 assert.equal(translateQuery("SELECT '*' AS star FROM t -- SELECT * FROM t",{columnsOf}),"SELECT '*' AS star FROM t -- SELECT * FROM t");
 // column names are quoted
 assert.equal(expandSelectStar('SELECT * FROM odd',()=>['select','We"ird']),'SELECT odd."select",odd."We""ird" FROM odd');
});

test('a star that cannot be resolved throws rather than leaking the rowid surrogate',()=>{
 const refuses=(sql,pattern)=>assert.throws(()=>translateQuery(sql,{columnsOf}),e=>e instanceof SqliteQueryError&&pattern.test(e.message),sql);
 refuses('SELECT * FROM unknown_table',/no columns known for table "unknown_table"/);
 refuses('SELECT * FROM t,json_each(t.b)',/table function/);
 refuses('SELECT * FROM t JOIN u USING(id)',/NATURAL or USING/);
 refuses('SELECT * FROM t NATURAL JOIN u',/NATURAL or USING/);
 refuses('SELECT z.* FROM t',/no FROM item named z/);
 refuses('SELECT *',/without a FROM clause/);
 refuses('SELECT * FROM t,(SELECT a FROM u) s',/both a table and a derived table/);
 assert.throws(()=>translateQuery('SELECT * FROM t',{columnsOf:()=>[]}),/no columns known/);
 // without columnsOf nothing changes, so existing callers are unaffected
 assert.equal(translateQuery('SELECT * FROM unknown_table'),'SELECT * FROM unknown_table');
 assert.equal(translateExec('SELECT * FROM t; UPDATE t SET a=1 RETURNING *'),'SELECT * FROM t;\nUPDATE t SET a=1 RETURNING *;');
});

// isNotNull(table,column) -> true only for a column known NOT NULL. Primary keys are.
const NOT_NULL={audit:['id','actor','action','at','details'],duty_reviews:['id','duty','status'],t:['a'],u:['id']};
const known={columnsOf:name=>({...COLUMNS,audit:['id','actor','action','collection','record_id','at','details']})[name],isNotNull:(table,column)=>Boolean(NOT_NULL[table]?.includes(column))};

test('a NULLS clause is omitted only for keys provably NOT NULL',()=>{
 // server/app.js:301 — every admin workspace load; the primary key can be walked backwards
 assert.equal(translateQuery('SELECT * FROM audit ORDER BY id DESC LIMIT 250',known),
  'SELECT audit."id",audit."actor",audit."action",audit."collection",audit."record_id",audit."at",audit."details" FROM audit ORDER BY id DESC LIMIT 250');
 // server/tenantAdministration.js:297 — decided_at is nullable and keeps SQLite's placement; the rowid surrogate is an identity
 assert.equal(translateQuery("SELECT * FROM duty_reviews WHERE duty=? AND subject_id=? AND status='Approved' ORDER BY decided_at DESC,rowid DESC LIMIT 1",known),
  'SELECT duty_reviews."id",duty_reviews."duty",duty_reviews."decided_at" FROM duty_reviews WHERE duty=$1 AND subject_id=$2 AND status=\'Approved\' ORDER BY decided_at DESC NULLS LAST,"__rowid" DESC LIMIT 1');
 const order=(sql,o=known)=>translateNullOrdering(sql,o);
 assert.equal(order('SELECT id FROM audit a ORDER BY a.id,a.collection DESC,"at",record_id'),'SELECT id FROM audit a ORDER BY a.id,a.collection DESC NULLS LAST,"at",record_id NULLS FIRST');
 // unknown nullability stays conservative: expressions, COLLATE, positions, expression aliases, unknown tables and qualifiers
 assert.equal(order('SELECT count(*) AS id,lower(actor) AS actor FROM audit GROUP BY actor ORDER BY id,actor,lower(at),at COLLATE "C",1,z.id,missing'),
  'SELECT count(*) AS id,lower(actor) AS actor FROM audit GROUP BY actor ORDER BY id NULLS FIRST,actor NULLS FIRST,lower(at) NULLS FIRST,at COLLATE "C" NULLS FIRST,1 NULLS FIRST,z.id NULLS FIRST,missing NULLS FIRST');
 // a plain column output keeps its resolution; an alias of a column is not followed
 assert.equal(order('SELECT a.id,actor AS who FROM audit a ORDER BY id DESC,who'),'SELECT a.id,actor AS who FROM audit a ORDER BY id DESC,who NULLS FIRST');
 // the NULL-filled side of an outer join is never trusted, whatever the column declares
 assert.equal(order('SELECT t.a,u.id FROM t LEFT JOIN u ON u.id=t.b ORDER BY u.id,t.a,a'),'SELECT t.a,u.id FROM t LEFT JOIN u ON u.id=t.b ORDER BY u.id NULLS FIRST,t.a,a');
 assert.equal(order('SELECT t.a,u.id FROM t RIGHT JOIN u ON u.id=t.b ORDER BY u.id,t.a'),'SELECT t.a,u.id FROM t RIGHT JOIN u ON u.id=t.b ORDER BY u.id,t.a NULLS FIRST');
 assert.equal(order('SELECT 1 FROM t FULL JOIN u ON u.id=t.b ORDER BY u.id,t.a'),'SELECT 1 FROM t FULL JOIN u ON u.id=t.b ORDER BY u.id NULLS FIRST,t.a NULLS FIRST');
 // unqualified across a join resolves only through columnsOf to exactly one table
 assert.equal(order('SELECT 1 FROM audit JOIN u ON u.id=audit.actor ORDER BY actor,id'),'SELECT 1 FROM audit JOIN u ON u.id=audit.actor ORDER BY actor,id NULLS FIRST');
 assert.equal(order('SELECT 1 FROM audit JOIN u ON u.id=audit.actor ORDER BY actor',{isNotNull:known.isNotNull}),'SELECT 1 FROM audit JOIN u ON u.id=audit.actor ORDER BY actor NULLS FIRST');
 // compound selects order by output columns: conservative
 assert.equal(order('SELECT a FROM t UNION SELECT id FROM u ORDER BY a'),'SELECT a FROM t UNION SELECT id FROM u ORDER BY a NULLS FIRST');
 // window, aggregate and correlated subquery keys resolve against their own SELECT
 assert.equal(order("SELECT a,row_number() OVER (ORDER BY a DESC,b),string_agg(b,',' ORDER BY a),(SELECT x FROM u WHERE u.id=t.a ORDER BY id DESC,x LIMIT 1) FROM t ORDER BY lower(a)"),
  "SELECT a,row_number() OVER (ORDER BY a DESC,b NULLS FIRST),string_agg(b,',' ORDER BY a),(SELECT x FROM u WHERE u.id=t.a ORDER BY id DESC,x NULLS FIRST LIMIT 1) FROM t ORDER BY lower(a) NULLS FIRST");
 // a derived table is not a base table
 assert.equal(order('SELECT id FROM (SELECT id FROM audit) s ORDER BY id DESC'),'SELECT id FROM (SELECT id FROM audit) s ORDER BY id DESC NULLS LAST');
 // isNotNull must say exactly true; without it nothing changes
 assert.equal(order('SELECT id FROM audit ORDER BY id DESC',{isNotNull:()=>1}),'SELECT id FROM audit ORDER BY id DESC NULLS LAST');
 assert.equal(order('SELECT id FROM audit ORDER BY id DESC',{}),'SELECT id FROM audit ORDER BY id DESC NULLS LAST');
 assert.equal(translateQuery('SELECT id FROM audit ORDER BY id DESC'),'SELECT id FROM audit ORDER BY id DESC NULLS LAST');
});

test('translateSqlExpression is the one expression renderer the statement translator uses',()=>{
 const expr="json_extract(data,'$.pledgeId')=? AND typeof(json_extract(data,'$.ref'))='text' AND json_extract(data,'$.amount')>0 AND a IS NOT b AND x GLOB '*[^ -~]*'";
 assert.equal(translateStatement('SELECT 1 FROM records WHERE '+expr),'SELECT 1 FROM records WHERE '+translateSqlExpression(expr));
});

test('case-bearing aliases keep their spelling; everything else still folds',()=>{
 // server/identity.js:54
 assert.equal(translateQuery('SELECT source_id AS sourceId,target_id AS targetId,reason,actor,at FROM identity_aliases ORDER BY at'),
  'SELECT source_id AS "sourceId",target_id AS "targetId",reason,actor,at FROM identity_aliases ORDER BY at NULLS FIRST');
 // references spelled as declared are quoted with it, including through a derived table
 assert.equal(translateAliasCase('SELECT s.bindingId AS bindingId FROM (SELECT a AS bindingId FROM t) s ORDER BY bindingId'),
  'SELECT s."bindingId" AS "bindingId" FROM (SELECT a AS "bindingId" FROM t) s ORDER BY "bindingId"');
 // an all-uppercase alias folds too, so it is kept; a CAST type, a CTE body and a function name are not aliases
 assert.equal(translateAliasCase('WITH Recent AS (SELECT 1) SELECT CAST(x AS INTEGER) AS N,Count(*) FROM Recent'),'WITH Recent AS (SELECT 1) SELECT CAST(x AS INTEGER) AS "N",Count(*) FROM Recent');
 // a case-bearing reference to a real lowercase column is not an alias and is not quoted
 assert.equal(translateAliasCase('SELECT Collection,id AS Id FROM records WHERE ID=? AND id<>?'),'SELECT Collection,id AS "Id" FROM records WHERE ID=? AND id<>?');
 // literals, quoted identifiers and lowercase aliases are untouched
 assert.equal(translateAliasCase(`SELECT 'AS sourceId' AS label,"x" AS "keepMe",a AS lower FROM t`),`SELECT 'AS sourceId' AS label,"x" AS "keepMe",a AS lower FROM t`);
});

test('ON CONFLICT DO UPDATE qualifies target-column references on the right-hand side',()=>{
 // server/observability.js:137 and :236
 assert.equal(translateQuery('INSERT INTO observability_counters VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET count=count+excluded.count,updated_at=excluded.updated_at'),
  'INSERT INTO observability_counters VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,name) DO UPDATE SET count=observability_counters.count+excluded.count,updated_at=excluded.updated_at');
 assert.equal(translateQuery('INSERT INTO observability_heartbeat VALUES(?,?,1) ON CONFLICT(tenant_id) DO UPDATE SET at=excluded.at,writes=writes+1'),
  'INSERT INTO observability_heartbeat VALUES($1,$2,1) ON CONFLICT(tenant_id) DO UPDATE SET at=excluded.at,writes=observability_heartbeat.writes+1');
 // with columnsOf, any target column on the right-hand side or in DO UPDATE WHERE; an alias is honoured; functions are not columns
 assert.equal(qualifyConflictUpdate('INSERT INTO counters AS c VALUES(?,?) ON CONFLICT(id) DO UPDATE SET total=max(total,excluded.total)+bump,note=lower(excluded.note) WHERE c.total<limit_at RETURNING total',{columnsOf:()=>['id','total','bump','note','limit_at']}),
  'INSERT INTO counters AS c VALUES(?,?) ON CONFLICT(id) DO UPDATE SET total=max(c.total,excluded.total)+c.bump,note=lower(excluded.note) WHERE c.total<c.limit_at RETURNING total');
 // DO NOTHING and plain upserts are unchanged
 assert.equal(qualifyConflictUpdate('INSERT INTO t VALUES(?) ON CONFLICT DO NOTHING'),'INSERT INTO t VALUES(?) ON CONFLICT DO NOTHING');
 assert.equal(qualifyConflictUpdate('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),'INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
});

test('scalar MAX/MIN with two or more arguments propagate NULL; the aggregate is untouched',()=>{
 // server/documents.js
 assert.equal(translateQuery('UPDATE documents SET retention_until=MAX(retention_until,?) WHERE id=?'),
  'UPDATE documents SET retention_until=(SELECT CASE WHEN bool_or(v IS NULL) THEN NULL ELSE max(v) END FROM (VALUES (retention_until),($1)) sqlite_max(v)) WHERE id=$2');
 assert.equal(translateScalarMinMax('SELECT MAX(a),min(DISTINCT b),max ( c ) FROM t'),'SELECT MAX(a),min(DISTINCT b),max ( c ) FROM t');
 assert.equal(translateScalarMinMax("SELECT min(a,max(b,'x,y'),?) FROM t"),"SELECT (SELECT CASE WHEN bool_or(v IS NULL) THEN NULL ELSE min(v) END FROM (VALUES (a),((SELECT CASE WHEN bool_or(v IS NULL) THEN NULL ELSE max(v) END FROM (VALUES (b),('x,y')) sqlite_max(v))),(?)) sqlite_min(v)) FROM t");
});

test('json_set renders through the shared expression renderer with SQLite value typing',()=>{
 // tests/hosted-giving-integrity.test.js — array subscripts and numeric literals
 assert.equal(translateSqlExpression("json_set(data,'$.amount',10002,'$.allocations[0].amount',10002)"),
  "sqlite_json_set(sqlite_json_set((data)::text,ARRAY['amount']::text[],to_json(10002)),ARRAY['allocations','[0]','amount']::text[],to_json(10002))");
 // text literal, json('null'), bound parameter, arithmetic over json_extract, a bare json_extract node
 assert.equal(translateSqlExpression("json_set(data,'$.name','it''s','$.parentId',json('null'),'$.mergedInto',?,'$.version',json_extract(data,'$.version')+1,'$.copy',json_extract(data,'$.nested'),'$.gone',NULL)"),
  "sqlite_json_set(sqlite_json_set(sqlite_json_set(sqlite_json_set(sqlite_json_set(sqlite_json_set((data)::text,ARRAY['name']::text[],to_json(('it''s')::text)),ARRAY['parentId']::text[],('null')::json),ARRAY['mergedInto']::text[],to_json((?)::text)),ARRAY['version']::text[],COALESCE(to_json(sqlite_json_number((data)::jsonb,'version')+1),'null'::json)),ARRAY['copy']::text[],COALESCE(((data)::jsonb #> ARRAY['nested']::text[])::json,'null'::json)),ARRAY['gone']::text[],'null'::json)");
 assert.throws(()=>translateSqlExpression("json_set(data,'$.a[*]',1)"),SqliteQueryError);
 assert.throws(()=>translateSqlExpression("json_set(data,'$.a')"),SqliteQueryError);
 assert.throws(()=>translateSqlExpression("json_set(data,?,1)"),SqliteQueryError);
});
