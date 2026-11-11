// Runtime query translation: the SQL this codebase issues through db.prepare(...)
// and db.exec(...), rewritten for PostgreSQL. Every rule below is grounded in a
// real call site, named in the comment above it. Nothing here translates a
// construct the codebase does not actually use.
//
// Scope boundary: schema/DDL translation lives in sqliteDdl.js and the
// synchronous transport in syncPostgres.js. This module is pure — no I/O, no
// database handle — so it is testable without a server.

export class SqliteQueryError extends Error{constructor(message){super(message);this.name='SqliteQueryError';}}
const fail=message=>{throw new SqliteQueryError(message);};

// ---------------------------------------------------------------------------
// Literal-aware scanning. Every pass copies string literals, quoted identifiers
// and comments through verbatim; only code positions are rewritten. This is
// what keeps a '?' inside a quoted string from being renumbered, and what keeps
// '$.path' arguments intact.
// ---------------------------------------------------------------------------
const IDENT=/[A-Za-z0-9_$]/;

// Returns the index just past a literal/comment beginning at i, or -1 if i is code.
export function skipLiteral(sql,i){
 const c=sql[i];
 if(c==="'"||c==='"'){
  for(let j=i+1;j<sql.length;j++){if(sql[j]!==c)continue;if(sql[j+1]===c){j++;continue;}return j+1;}
  fail(c==="'"?'Unterminated string literal':'Unterminated quoted identifier');
 }
 if(c==='-'&&sql[i+1]==='-'){const j=sql.indexOf('\n',i);return j<0?sql.length:j+1;}
 if(c==='/'&&sql[i+1]==='*'){const j=sql.indexOf('*/',i+2);if(j<0)fail('Unterminated block comment');return j+2;}
 return -1;
}

// Walks sql; at each code position calls rule(sql,i) which returns null or
// {text,next}. Literals are emitted unchanged.
function rewrite(sql,rule){
 let out='',i=0;
 while(i<sql.length){
  const lit=skipLiteral(sql,i);
  if(lit>=0){out+=sql.slice(i,lit);i=lit;continue;}
  const hit=rule(sql,i);
  if(hit){out+=hit.text;i=hit.next;continue;}
  out+=sql[i++];
 }
 return out;
}

const boundary=(sql,i)=>i===0||!IDENT.test(sql[i-1]);
const wordAt=(sql,i,word)=>boundary(sql,i)&&sql.slice(i,i+word.length).toLowerCase()===word&&!IDENT.test(sql[i+word.length]??'');
const skipSpace=(sql,i)=>{while(i<sql.length&&/\s/.test(sql[i]))i++;return i;};

// Finds the ')' matching the '(' at open, honouring nesting and literals.
function closeParen(sql,open){
 let depth=0;
 for(let i=open;i<sql.length;i++){
  const lit=skipLiteral(sql,i);
  if(lit>=0){i=lit-1;continue;}
  if(sql[i]==='(')depth++;
  else if(sql[i]===')'&&--depth===0)return i;
 }
 return fail('Unbalanced parentheses in SQL');
}

// Matches `name (` at i (case-insensitive) and returns its argument list.
function matchCall(sql,i,name){
 if(!wordAt(sql,i,name))return null;
 const open=skipSpace(sql,i+name.length);
 if(sql[open]!=='(')return null;
 const close=closeParen(sql,open),inner=sql.slice(open+1,close),args=[];
 let depth=0,start=0;
 for(let k=0;k<inner.length;k++){
  const lit=skipLiteral(inner,k);
  if(lit>=0){k=lit-1;continue;}
  if(inner[k]==='(')depth++;else if(inner[k]===')')depth--;
  else if(inner[k]===','&&depth===0){args.push(inner.slice(start,k));start=k+1;}
 }
 args.push(inner.slice(start));
 return {args:args.map(a=>a.trim()),next:close+1};
}

// ---------------------------------------------------------------------------
// 1. Placeholders.  ? -> $1,$2,…
//    Every db.prepare(...) in the codebase binds positionally. Grounded
//    everywhere; the literal-skipping half matters for e.g.
//    server/backup.js:24 "... name NOT LIKE 'sqlite_autoindex_%' ..." and any
//    parameter text that itself contains a question mark.
// ---------------------------------------------------------------------------
export function numberPlaceholders(sql,start=1){
 let n=start;
 const out=rewrite(sql,(s,i)=>s[i]==='?'?{text:'$'+n++,next:i+1}:null);
 return {sql:out,count:n-start};
}

// ---------------------------------------------------------------------------
// 2. INSERT OR IGNORE -> INSERT … ON CONFLICT DO NOTHING
//    server/app.js:101, server/receipts.js:28, server/reportSchedule.js:23.
//    The 16 existing ON CONFLICT … DO UPDATE SET clauses (offlineRecovery-
//    Schedule.js:38,39; identity.js:45; observability.js:137,236;
//    volunteerPortal.js:185,565; sqliteRepository.js:111,189,197; receipts.js;
//    tributes.js:38; eventHelperAccess.js:25; mfa.js:40,43,44) and the two
//    ON CONFLICT DO NOTHING clauses (publicGiving.js:109,143) are already
//    PostgreSQL-compatible and must survive untouched, excluded.* included.
// ---------------------------------------------------------------------------
export function translateInsertOrIgnore(sql){
 let changed=false;
 const out=rewrite(sql,(s,i)=>{
  if(!wordAt(s,i,'insert'))return null;
  let j=skipSpace(s,i+6);
  if(!wordAt(s,j,'or'))return null;
  const k=skipSpace(s,j+2);
  if(!wordAt(s,k,'ignore'))fail('Unsupported INSERT OR conflict clause: '+s.slice(i,k+12).trim());
  changed=true;
  return {text:'INSERT ',next:skipSpace(s,k+6)};
 });
 if(!changed)return sql;
 const trimmed=out.replace(/\s*;?\s*$/,''),tail=out.slice(trimmed.length);
 if(/on\s+conflict/i.test(trimmed))return out;
 return trimmed+' ON CONFLICT DO NOTHING'+tail;
}

// ---------------------------------------------------------------------------
// 3. JSON.  59 json_extract occurrences in server/, plus json_type, json_each,
//    json_remove and one typeof(json_extract(…)).
//
//    SQLite's json_extract returns a *SQL value*: JSON string -> text, JSON
//    number -> integer/real, JSON true/false -> 1/0, JSON null and a missing
//    path -> NULL, object/array -> the JSON text. PostgreSQL has no single
//    expression with that behaviour, so the path decides the result type and
//    the helper functions in SUPPORT_SQL reproduce SQLite's value semantics.
//
//    Path kinds below are declared, not guessed: each entry names the call
//    site whose consumer forced it.
// ---------------------------------------------------------------------------

// Paths holding exact integer cents. Always numeric so SUM(), COALESCE(…,0)
// and `IS NOT` comparisons against a SUM work.
//  server/dataQuality.js:92   COALESCE(SUM(json_extract(data,'$.amount')),0)
//  server/accountStructure.js:22,29,30  allocation amounts and gift totals
//  server/dataQuality.js:90   json_extract(data,'$.awardedAmount') IS NOT NULL
const NUMBER_PATHS=new Set(['$.amount','$.awardedAmount']);

// Paths holding JSON booleans. SQLite hands JavaScript 1/0, and the callers use
// Boolean(...) or compare to 1 — text '0' would be truthy, which is a silent
// wrong answer, so these become integer.
//  server/migration.js:460    valid:Boolean(row.valid), replayed:Boolean(row.replayed)
//  server/eventOperations.js:39  json_extract(value,'$.completed')=1
//  server/eventHelperAccess.js:43 COALESCE(json_extract(r.value,'$.checkedIn'),0)
const BOOLEAN_PATHS=new Set(['$.valid','$.replayed','$.completed','$.checkedIn']);

const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";

// '$.a.b' -> ["'a'","'b'"]. Only the shapes the codebase uses: a leading $ and
// dotted object keys. Array subscripts and wildcards are rejected rather than
// mistranslated — no call site uses them.
export function jsonPathArgs(literal){
 const raw=literal.trim();
 if(!(raw.startsWith("'")&&raw.endsWith("'")&&raw.length>=2))fail('json path must be a string literal, received: '+literal);
 const path=raw.slice(1,-1).replace(/''/g,"'");
 if(!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path))fail('Unsupported json path: '+path);
 return {path,args:path==='$'?[]:path.slice(2).split('.').map(quote)};
}

const jsonbOf=expr=>'('+expr+')::jsonb';

// json_set paths may also subscript arrays: '$.allocations[0].amount'
// (tests/hosted-giving-integrity.test.js, peer-fundraising-integrity.test.js).
export function jsonSetPath(literal){
 const raw=literal.trim();
 if(!(raw.startsWith("'")&&raw.endsWith("'")&&raw.length>=2))fail('json_set path must be a string literal, received: '+literal);
 const path=raw.slice(1,-1).replace(/''/g,"'");
 if(!/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/.test(path))fail('Unsupported json_set path: '+path);
 return 'ARRAY['+[...path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|(\[[0-9]+\])/g)].map(m=>quote(m[1]??m[2])).join(',')+']::text[]';
}

// The SQL value json_set stores, typed as SQLite types it: a text literal is a JSON
// string, a numeric literal a number, NULL and json('null') JSON null, json(x) the
// parsed JSON, a bare json_extract(...) the node itself (an object stays an object),
// and any other expression by its SQL type (json_extract(...)+1 is a number). A bound
// ? arrives untyped and is stored as a JSON string: SQLite would store a JS number as
// a number, which no SQL-level rewrite can see.
function jsonSetValue(raw){
 const v=raw.trim();
 if(v==='?')return 'to_json((?)::text)';
 if(/^null$/i.test(v))return "'null'::json";
 if(/^'(?:[^']|'')*'$/.test(v))return 'to_json(('+v+')::text)';
 if(/^[-+]?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(v))return 'to_json('+v+')';
 const j=matchCall(v,0,'json');
 if(j&&j.next===v.length){if(j.args.length!==1)fail('json() takes one argument');return '('+translateSqlExpression(j.args[0])+')::json';}
 const x=matchCall(v,0,'json_extract');
 if(x&&x.next===v.length){if(x.args.length!==2)fail('json_extract() takes two arguments');const {args}=jsonPathArgs(x.args[1]);return "COALESCE(("+jsonbOf(translateSqlExpression(x.args[0]))+" #> ARRAY["+args.join(',')+"]::text[])::json,'null'::json)";}
 return "COALESCE(to_json("+translateSqlExpression(v)+"),'null'::json)";
}

function jsonCall(fn,doc,pathLiteral){
 const {args}=jsonPathArgs(pathLiteral);
 return fn+'('+jsonbOf(doc)+(args.length?','+args.join(','):'')+')';
}

// One pass over the JSON functions. Arguments are translated recursively so
// nesting works: server/migration.js:458 wraps json_extract inside json_remove,
// and server/accountStructure.js:28 wraps json_extract inside json_each inside
// COALESCE.
export function translateJson(sql){
 return rewrite(sql,(s,i)=>{
  // typeof(json_extract(x,'$.p')) -> the SQL storage class SQLite would report.
  // server/marketingResponses.js:38 typeof(json_extract(data,'$.email'))='text'
  const t=matchCall(s,i,'typeof');
  if(t){
   if(t.args.length!==1)fail('typeof() takes one argument');
   const nested=matchCall(t.args[0],0,'json_extract');
   if(!nested||nested.next!==t.args[0].length)fail('typeof() is only translated around json_extract(): '+t.args[0]);
   return {text:jsonCall('sqlite_json_sqltype',translateJson(nested.args[0]),nested.args[1]),next:t.next};
  }
  // json_set(doc,path,value[,path,value]...) -> nested sqlite_json_set, which keeps
  // SQLite's key order, minified text result and missing-path rules (SUPPORT_SQL).
  const js=matchCall(s,i,'json_set');
  if(js){
   if(js.args.length<3||js.args.length%2!==1)fail('json_set() takes a document and path/value pairs');
   let doc='('+translateSqlExpression(js.args[0])+')::text';
   for(let k=1;k<js.args.length;k+=2)doc='sqlite_json_set('+doc+','+jsonSetPath(js.args[k])+','+jsonSetValue(js.args[k+1])+')';
   return {text:doc,next:js.next};
  }
  const x=matchCall(s,i,'json_extract');
  if(x){
   if(x.args.length!==2)fail('json_extract() takes two arguments');
   const {path}=jsonPathArgs(x.args[1]),doc=translateJson(x.args[0]);
   const fn=NUMBER_PATHS.has(path)?'sqlite_json_number':BOOLEAN_PATHS.has(path)?'sqlite_json_int':'sqlite_json_extract';
   return {text:jsonCall(fn,doc,x.args[1]),next:x.next};
  }
  // server/dataQuality.js:88-91, accountStructure.js:28, marketingResponses.js:36
  const ty=matchCall(s,i,'json_type');
  if(ty){
   if(ty.args.length!==2)fail('json_type() is only used with an explicit path');
   return {text:jsonCall('sqlite_json_type',translateJson(ty.args[0]),ty.args[1]),next:ty.next};
  }
  // json_each(x) and json_each(x,'$.p') as a FROM-clause row source.
  //  server/accountStructure.js:22,28,29; dataQuality.js:89;
  //  financialCorrections.js:28,29; eventHelperAccess.js:43;
  //  eventOperations.js:39; constituentTimeline.js:58 (two-argument form).
  // jsonb_array_elements names its output column `value`, so both `json_each(x) a`
  // + `a.value` and the unaliased `value` reference keep working unchanged.
  const each=matchCall(s,i,'json_each');
  if(each){
   const doc=translateJson(each.args[0]);
   if(each.args.length===1)return {text:'jsonb_array_elements('+jsonbOf(doc)+')',next:each.next};
   if(each.args.length!==2)fail('json_each() takes one or two arguments');
   const {args}=jsonPathArgs(each.args[1]);
   return {text:'jsonb_array_elements(jsonb_extract_path('+jsonbOf(doc)+(args.length?','+args.join(','):'')+'))',next:each.next};
  }
  // server/migration.js:458,459. The caller does JSON.parse(row.summary), so the
  // result must come back as text, not as a jsonb the pg driver pre-parses.
  const rm=matchCall(s,i,'json_remove');
  if(rm){
   if(rm.args.length<2)fail('json_remove() needs at least one path');
   const doc=jsonbOf(translateJson(rm.args[0]));
   const stripped=rm.args.slice(1).map(p=>{const {args}=jsonPathArgs(p);if(args.length!==1)fail('json_remove() only strips top-level keys here: '+p);return args[0];});
   return {text:'(('+doc+stripped.map(k=>' - '+k).join('')+')::text)',next:rm.next};
  }
  return null;
 });
}

// A json_extract that SQLite would have compared numerically. Path-declared
// kinds already won above; this catches the per-site cases, all of which come
// from server/marketingResponses.js:36, where '$.mergedInto' is compared both
// to 0 and to '' on the same line.
const NUMERIC_WRAPPERS=new Set(['sum','avg','min','max','total','abs','round']);
export function applyNumericContext(sql){
 return rewrite(sql,(s,i)=>{
  if(!wordAt(s,i,'sqlite_json_extract'))return null;
  const open=i+'sqlite_json_extract'.length,close=closeParen(s,open);
  let numeric=false;
  const before=s.slice(0,i).replace(/\s+$/,'');
  if(before.endsWith('(')){const m=/([A-Za-z_][A-Za-z0-9_]*)\s*\($/.exec(before);if(m&&NUMERIC_WRAPPERS.has(m[1].toLowerCase()))numeric=true;}
  if(/(=|<>|!=|<=|>=|<|>|\+|-|\*|\/)\s*$/.test(before)&&/[0-9]\s*$/.test(before.replace(/(=|<>|!=|<=|>=|<|>|\+|-|\*|\/)\s*$/,'')))numeric=true;
  const after=skipSpace(s,close+1),op=/^(<=|>=|<>|!=|=|<|>|\+|-|\*|\/)/.exec(s.slice(after));
  if(op&&/^\s*[0-9]/.test(s.slice(after+op[0].length)))numeric=true;
  return numeric?{text:'sqlite_json_number'+s.slice(open,close+1),next:close+1}:null;
 });
}

// ---------------------------------------------------------------------------
// 4. Catalog.  sqlite_master / sqlite_schema -> the sqlite_schema view in
//    SUPPORT_SQL, which exposes the same type/name/tbl_name/sql columns the
//    callers select.
//      server/backup.js:24 (type,name,tbl_name,sql), :41,:47 (SELECT 1 … type='table')
//      server/backup.js:75 (name,sql for a trigger)
//      server/reporting.js:282, constituentTimeline.js:18, mailchimpContactSync.js:97
//        (SELECT 1 … type='table' AND name=?)
//      server/recurringGiving.js:61, hostedGiving.js:35, marketingResponses.js:39,
//        mailchimpContactSync.js:70, peerFundraising.js:38, receipts.js:63,
//        productionReadiness.js:38,40, platform.js:42, app.js:88
//      server/persistence/legacySqliteMigration.js:47 (SELECT name … type='table')
//      server/persistence/sqliteRepository.js:65 (SELECT name … type='table')
// ---------------------------------------------------------------------------
export function translateCatalog(sql){
 return rewrite(sql,(s,i)=>wordAt(s,i,'sqlite_master')?{text:'sqlite_schema',next:i+13}:null);
}

// ---------------------------------------------------------------------------
// 5. PRAGMA.  25 occurrences in server/.
// ---------------------------------------------------------------------------
const PRAGMA_NOOP=new Set(['journal_mode','synchronous','trusted_schema','locking_mode','cache_size','temp_store','secure_delete','wal_autocheckpoint']);

export function translatePragma(statement){
 const m=/^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([^)]*?)\s*\)|=\s*(.+?))?\s*$/i.exec(statement);
 if(!m)return null;
 const name=m[1].toLowerCase(),arg=(m[2]??m[3]??'').trim();
 // server/backup.js:116 asserts column names and that every type reads 'TEXT';
 // server/app.js:98,222, platform.js:50,51,52 and eventOperations.js:36 use
 // .all().map(c=>c.name) to decide whether to ALTER TABLE ADD COLUMN.
 if(name==='table_info'||name==='table_xinfo'){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg))fail('PRAGMA table_info() needs a plain table name, received: '+arg);
  return TABLE_INFO_SQL.replace('$TABLE$',quote(arg)).replace('$ROWID$',quote(ROWID_COLUMN));
 }
 // tests/communication-workflow-reporting.test.js:80 turns enforcement off and
 // back on. sqliteDdl.js declares every foreign key DEFERRABLE INITIALLY
 // IMMEDIATE, so the nearest PostgreSQL equivalent is deferring them. CAUTION:
 // SET CONSTRAINTS lasts only for the current transaction (outside one it is a
 // WARNING and does nothing) and deferred checks still run at COMMIT, whereas
 // SQLite's pragma is connection-scoped and is itself a no-op INSIDE a
 // transaction. A dangling reference therefore can never be committed this way.
 // A bare `PRAGMA foreign_keys` read stays a no-op.
 if(name==='foreign_keys'&&arg){
  if(/^(on|1|true|yes)$/i.test(arg))return 'SET CONSTRAINTS ALL IMMEDIATE';
  if(/^(off|0|false|no)$/i.test(arg))return 'SET CONSTRAINTS ALL DEFERRED';
  fail('PRAGMA foreign_keys needs ON or OFF, received: '+arg);
 }
 if(name==='foreign_keys')return 'SELECT NULL WHERE false';
 // server/backup.js:23 requires exactly one row whose first value is 'ok';
 // server/productionReadiness.js:31 reads Object.values(row)[0]==='ok'.
 if(name==='integrity_check'||name==='quick_check')return "SELECT CASE WHEN (SELECT count(*) FROM pg_catalog.pg_class)>0 THEN 'ok' ELSE 'unreadable' END AS "+name;
 // server/app.js:89, platform.js:43, sqliteRepository.js:64,
 // offlineRecoverySchedule.js:26, platformRecovery.js:14.
 if(name==='busy_timeout'){
  if(!/^[0-9]+$/.test(arg))fail('PRAGMA busy_timeout needs an integer, received: '+arg);
  return "SET lock_timeout = '"+arg+"ms'";
 }
 if(PRAGMA_NOOP.has(name))return 'SELECT NULL WHERE false';
 return fail('Untranslated PRAGMA: '+statement.trim());
}

// The rowid surrogate is excluded and cid renumbered around it, so the columns
// read exactly as SQLite declared them (backup.js:116 compares the name list).
const TABLE_INFO_SQL=`SELECT (row_number() OVER (ORDER BY a.attnum)-1)::int AS cid,a.attname::text AS name,
 CASE WHEN t.typname IN ('text','varchar','bpchar','char','uuid','name','json','jsonb') THEN 'TEXT'
      WHEN t.typname IN ('int2','int4','int8','bool') THEN 'INTEGER'
      WHEN t.typname IN ('float4','float8') THEN 'REAL'
      WHEN t.typname='numeric' THEN 'NUMERIC'
      WHEN t.typname='bytea' THEN 'BLOB'
      ELSE upper(t.typname) END AS type,
 CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS notnull,
 pg_get_expr(d.adbin,d.adrelid) AS dflt_value,
 CASE WHEN EXISTS(SELECT 1 FROM pg_index x WHERE x.indrelid=a.attrelid AND x.indisprimary AND a.attnum=ANY(x.indkey::int2[])) THEN 1 ELSE 0 END AS pk
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_type t ON t.oid=a.atttypid
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE c.relname=$TABLE$ AND c.relnamespace=current_schema()::regnamespace AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>$ROWID$
 ORDER BY a.attnum`;

// ---------------------------------------------------------------------------
// 6. Transactions.  BEGIN IMMEDIATE / BEGIN EXCLUSIVE -> BEGIN.
//    server/app.js:109, platform.js:53, mfa.js:28, reportSchedule.js:17,
//    offlineRecoverySchedule.js:35, backup.js:116, sqliteRepository.js:77,
//    platformRecovery.js:14 (EXCLUSIVE).
// ---------------------------------------------------------------------------
export function translateBegin(statement){
 const m=/^\s*begin(\s+(immediate|exclusive|deferred))?(\s+transaction)?\s*$/i.exec(statement);
 return m?'BEGIN':null;
}

// ---------------------------------------------------------------------------
// 7. Leftovers found by grepping, each with one call site.
// ---------------------------------------------------------------------------

// INDEXED BY is a SQLite-only planner directive.
// server/marketingResponses.js:38 "FROM records INDEXED BY marketing_native_unicode_email"
export function stripIndexedBy(sql){
 return rewrite(sql,(s,i)=>{
  if(!wordAt(s,i,'indexed'))return null;
  const j=skipSpace(s,i+7);
  if(!wordAt(s,j,'by'))return null;
  const k=skipSpace(s,j+2),m=/^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(k));
  if(!m)fail('INDEXED BY without an index name');
  return {text:'',next:skipSpace(s,k+m[0].length)};
 });
}

// GLOB. One runtime shape exists: '*[^ -~]*', "contains a byte outside printable
// ASCII". server/marketingResponses.js:38 (and the matching partial index at :31).
// Only the leading/trailing-star containment form is translated; anything else
// is refused rather than approximated.
export function translateGlob(sql){
 return rewrite(sql,(s,i)=>{
  if(!wordAt(s,i,'glob'))return null;
  const j=skipSpace(s,i+4),end=skipLiteral(s,j);
  if(s[j]!=="'"||end<0)fail('GLOB is only translated against a literal pattern');
  const pattern=s.slice(j+1,end-1).replace(/''/g,"'");
  if(!(pattern.startsWith('*')&&pattern.endsWith('*')&&!pattern.slice(1,-1).includes('*')&&!pattern.includes('?')))
   fail('Unsupported GLOB pattern: '+pattern);
  return {text:'~ '+quote(pattern.slice(1,-1)),next:end};
 });
}

// rowid. PostgreSQL has none. sqliteDdl.js appends a `__rowid BIGINT GENERATED
// ALWAYS AS IDENTITY` surrogate to every table (DEFAULT_OPTIONS.rowidColumn) and
// every runtime `ORDER BY rowid` has to follow it, otherwise insertion order —
// which is the only order these statements specify — is lost.
//   ORDER BY rowid              server/app.js:104, accountStructure.js:39,
//                               reporting.js:297, sqliteRepository.js:73,240,
//                               marketingResponses.js:67
//   ORDER BY rowid DESC LIMIT 1 server/recurringGiving.js:61, hostedGiving.js:35,
//                               communicationWorkflows.js:39, marketingResponses.js:39,
//                               mailchimpContactSync.js:70, messaging.js:100,451
//   ORDER BY at DESC,rowid DESC server/accountStructure.js:176, dataQuality.js:327,431,
//                               messaging.js:160, taskReminders.js:29,
//                               communicationWorkflows.js:56, volunteerPortal.js:510,633,
//                               eventPlanning.js:271, tenantAdministration.js:297,
//                               recurringGiving.js:232, hostedGiving.js:65
//   ORDER BY at,rowid           server/tenantAdministration.js:147,250
export const ROWID_COLUMN='__rowid';
export function translateRowid(sql,column=ROWID_COLUMN){
 const replacement='"'+column.replaceAll('"','""')+'"';
 return rewrite(sql,(s,i)=>wordAt(s,i,'rowid')?{text:replacement,next:i+5}:null);
}

// SQLite's `x IS NOT y` is null-safe inequality; PostgreSQL spells it
// IS DISTINCT FROM and rejects `IS NOT <expr>` outright.
// server/accountStructure.js:29 "WHERE amount IS NOT allocated"
export function translateIsNot(sql){
 return rewrite(sql,(s,i)=>{
  if(!wordAt(s,i,'is'))return null;
  const j=skipSpace(s,i+2);
  if(!wordAt(s,j,'not'))return null;
  const k=skipSpace(s,j+3);
  if(wordAt(s,k,'null')||wordAt(s,k,'true')||wordAt(s,k,'false')||wordAt(s,k,'distinct')||wordAt(s,k,'unknown'))return null;
  return {text:'IS DISTINCT FROM ',next:k};
 });
}

// SQLite treats a predicate as an integer. server/eventHelperAccess.js:43
// compares COALESCE(json_extract(r.value,'$.checkedIn'),0) to
// (t.checked_in_at IS NOT NULL); PostgreSQL will not compare integer to boolean.
export function translateBooleanOperand(sql){
 return rewrite(sql,(s,i)=>{
  if(s[i]!=='(')return null;
  const close=closeParen(s,i),inner=s.slice(i+1,close);
  if(!/\bis\s+(not\s+)?null\s*$/i.test(inner))return null;
  const before=s.slice(0,i).replace(/\s+$/,'');
  if(!/(=|<>|!=|<=|>=|<|>)$/.test(before))return null;
  return {text:'(CASE WHEN '+inner.trim()+' THEN 1 ELSE 0 END)',next:close+1};
 });
}

// ---------------------------------------------------------------------------
// Token view shared by the clause-level rewrites below. Literals, quoted
// identifiers and comments are single tokens; `depth` is the paren depth the
// token sits at (a paren carries the depth of the level that contains it).
// ---------------------------------------------------------------------------
function tokenize(sql){
 const out=[];let i=0,depth=0;
 while(i<sql.length){
  const c=sql[i],lit=skipLiteral(sql,i);
  if(lit>=0){out.push({k:c==="'"?'str':c==='"'?'qid':'comment',s:i,e:lit,depth,t:sql.slice(i,lit)});i=lit;continue;}
  if(/\s/.test(c)){let j=i;while(j<sql.length&&/\s/.test(sql[j]))j++;i=j;continue;}
  if(IDENT.test(c)){let j=i;while(j<sql.length&&IDENT.test(sql[j]))j++;const t=sql.slice(i,j);out.push({k:'word',s:i,e:j,depth,t,u:t.toUpperCase()});i=j;continue;}
  if(c===')')depth--;
  out.push({k:'punct',s:i,e:i+1,depth,t:c});
  if(c==='(')depth++;
  i++;
 }
 return out.filter(x=>x.k!=='comment');
}
const applyEdits=(sql,edits)=>edits.sort((a,b)=>b.s-a.s).reduce((out,x)=>out.slice(0,x.s)+x.text+out.slice(x.e),sql);
// Index of the token closing the '(' at code[open].
const matching=(code,open)=>{for(let k=open+1;k<code.length;k++)if(code[k].t===')'&&code[k].k==='punct'&&code[k].depth===code[open].depth)return k;return fail('Unbalanced parentheses in SQL');};

// ---------------------------------------------------------------------------
// 8. NULL ordering.  SQLite sorts NULL first ascending and last descending;
//    PostgreSQL does the opposite. Every ORDER BY key that does not already say
//    NULLS FIRST|LAST gains SQLite's placement, at every nesting level: plain
//    queries, subqueries, OVER(... ORDER BY ...) and string_agg(x ORDER BY y).
//    server/tenantAdministration.js:297 "ORDER BY decided_at DESC,rowid DESC
//    LIMIT 1" over a nullable decided_at selects the separation-of-duties
//    approval in force; without this a NULL-timestamp row would win.
// ---------------------------------------------------------------------------
const ORDER_END=new Set(['LIMIT','OFFSET','FETCH','FOR','UNION','INTERSECT','EXCEPT','WINDOW','ROWS','RANGE','GROUPS','RETURNING']);
export function translateNullOrdering(sql,options={}){
 const code=tokenize(sql),edits=[];
 for(let n=0;n+1<code.length;n++){
  if(code[n].u!=='ORDER'||code[n+1].u!=='BY')continue;
  const d=code[n].depth;let start=n+2;
  for(let m=start;;m++){
   const x=code[m];
   const end=!x||x.depth<d||(x.depth===d&&((x.k==='punct'&&(x.t===';'||x.t===','))||(x.k==='word'&&ORDER_END.has(x.u))));
   if(!end)continue;
   const key=code.slice(start,m);
   if(key.length){
    const last=key[key.length-1],before=key[key.length-2];
    const explicit=(last.u==='FIRST'||last.u==='LAST')&&before?.u==='NULLS';
    const using=key.some(k=>k.depth===d&&k.u==='USING');
    if(!explicit&&!using&&!keyNotNull(sql,code,n,key,options))edits.push({s:last.e,e:last.e,text:last.u==='DESC'?' NULLS LAST':' NULLS FIRST'});
   }
   if(x&&x.depth===d&&x.t===','){start=m+1;continue;}
   n=m-1;break;
  }
 }
 return applyEdits(sql,edits);
}

// A NULLS clause is irrelevant on a key that cannot be NULL, and omitting it lets
// PostgreSQL walk a default btree in either direction: server/app.js:301
// "SELECT * FROM audit ORDER BY id DESC LIMIT 250" is then an index scan instead of
// a sort of the whole audit table. True only when the key is provably a NOT NULL
// base-table column: a bare or qualified column (optionally ASC/DESC), resolved to
// exactly one table in the owning SELECT's FROM, not on the NULL-filled side of an
// outer join, not an output alias of an expression, not in a compound SELECT, and
// options.isNotNull(table,column)===true (the rowid surrogate is an identity column,
// so it is NOT NULL by construction). Anything unresolved keeps SQLite's NULLS
// placement: a wrong order is worse than a slow one.
function keyNotNull(sql,code,orderAt,key,options){
 if(typeof options.isNotNull!=='function')return false;
 const toks=['ASC','DESC'].includes(key[key.length-1].u)?key.slice(0,-1):key;
 let qualifier=null,column;
 if(toks.length===1&&isIdent(toks[0]))column=toks[0];
 else if(toks.length===3&&isIdent(toks[0])&&toks[1].t==='.'&&isIdent(toks[2]))[qualifier,,column]=toks;
 else return false;
 // the SELECT this ORDER BY belongs to: leave OVER(...)/aggregate parens outward
 let depth=code[orderAt].depth,owner=-1;
 for(let k=orderAt-1;k>=0;k--){
  const x=code[k];
  if(x.k==='punct'&&x.t==='('&&x.depth<depth){depth=x.depth;continue;}
  if(x.depth===depth&&x.u==='SELECT'){owner=k;break;}
 }
 if(owner<0)return false;
 const compound=x=>['UNION','INTERSECT','EXCEPT'].includes(x.u);
 for(let k=owner-1;k>=0&&!(code[k].k==='punct'&&code[k].t==='('&&code[k].depth<depth);k--)if(code[k].depth===depth&&compound(code[k]))return false;
 let from=-1;
 for(let k=owner+1;k<code.length&&!(code[k].depth<depth);k++){if(code[k].depth!==depth)continue;if(compound(code[k]))return false;if(code[k].u==='FROM'&&from<0)from=k;}
 if(from<0)return false;
 const name=identName(column);
 try{
  // a direct ORDER BY name may mean an output column: follow it only to a plain column
  if(!qualifier&&code[orderAt].depth===depth){
   let p=owner+1;if(code[p]?.u==='DISTINCT'||code[p]?.u==='ALL')p++;
   const outputs=listItems(code,p,depth,x=>x.k==='word'&&LIST_END.has(x.u)).items.filter(item=>{
    const tail=item[item.length-1];if(!isIdent(tail)||identName(tail)!==name)return false;return true;});
   if(outputs.length>1)return false;
   if(outputs.length){
    const item=outputs[0];
    if(item.length===3&&item[1].t==='.')qualifier=item[0];
    else if(item.length!==1)return false;
   }
  }
  const {items:sources}=fromItems(sql,code,from+1,depth,cteNames(code));
  let source;
  if(qualifier)source=sources.find(x=>(x.alias??x.name)===identName(qualifier));
  else if(sources.length===1)source=sources[0];
  else if(typeof options.columnsOf==='function'&&sources.every(x=>x.kind==='table')){
   const holders=sources.filter(x=>(options.columnsOf(x.name)||[]).includes(name)||name===ROWID_COLUMN);
   if(holders.length===1)source=holders[0];
  }
  if(!source||source.kind!=='table'||source.nullable)return false;
  return name===ROWID_COLUMN||options.isNotNull(source.name,name)===true;
 }catch(e){if(e instanceof SqliteQueryError)return false;throw e;}
}

// ---------------------------------------------------------------------------
// 9. SELECT * / t.* / RETURNING *.  PostgreSQL has no hidden columns, so the
//    rowid surrogate would appear in every `SELECT *`: server/backup.js:30
//    hashes `SELECT * FROM <table>` and four tests deep-equal raw snapshots.
//    With columnsOf(table) -> column names in declaration order (surrogate
//    excluded) each star becomes an explicit list in SQLite's output order: FROM
//    items left to right. A star over a derived table or CTE is left alone (its
//    own SELECT is expanded where it is written, so nothing hidden can reach it);
//    a star inside EXISTS(...) is left alone (no columns are produced); COUNT(*)
//    is not a star item. Anything else that cannot be resolved throws.
// ---------------------------------------------------------------------------
const LIST_END=new Set(['FROM','WHERE','GROUP','HAVING','WINDOW','ORDER','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','RETURNING']);
const FROM_END=new Set(['WHERE','GROUP','HAVING','WINDOW','ORDER','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','RETURNING']);
const JOIN_WORDS=new Set(['NATURAL','LEFT','RIGHT','FULL','INNER','CROSS','OUTER','JOIN']);
const NOT_ALIAS=new Set([...FROM_END,...JOIN_WORDS,'ON','USING','AS','SET','VALUES','DEFAULT','SELECT']);
const identName=x=>x.k==='qid'?x.t.slice(1,-1).replace(/""/g,'"'):x.t.toLowerCase();
const isIdent=x=>x&&(x.k==='qid'||(x.k==='word'&&!/^[0-9$]/.test(x.t)));
const quoteColumn=c=>'"'+String(c).replace(/"/g,'""')+'"';

// Items of a comma list at depth d between code[from] and the first stop token.
function listItems(code,from,d,stop){
 const items=[];let cur=[],m=from;
 for(;m<code.length;m++){
  const x=code[m];
  if(x.depth<d||(x.depth===d&&(stop(x)||(x.k==='punct'&&x.t===';'))))break;
  if(x.depth===d&&x.k==='punct'&&x.t===','){items.push(cur);cur=[];continue;}
  cur.push(x);
 }
 if(cur.length)items.push(cur);
 return {items,next:m};
}
const starOf=item=>item.length===1&&item[0].t==='*'&&item[0].k==='punct'?{qualifier:null}:item.length===3&&isIdent(item[0])&&item[1].t==='.'&&item[2].t==='*'&&item[2].k==='punct'?{qualifier:item[0]}:null;

function cteNames(code){
 const names=new Set();
 for(let n=0;n<code.length;n++){
  if(code[n].u!=='WITH')continue;
  let p=n+1;if(code[p]?.u==='RECURSIVE')p++;
  while(isIdent(code[p])){
   const name=code[p];p++;
   if(code[p]?.t==='(')p=matching(code,p)+1;
   if(code[p]?.u!=='AS')break;p++;
   if(code[p]?.u==='NOT')p++;if(code[p]?.u==='MATERIALIZED')p++;
   if(code[p]?.t!=='(')break;
   names.add(identName(name));p=matching(code,p)+1;
   if(code[p]?.t!==',')break;p++;
  }
 }
 return names;
}

// FROM items at depth d from code[from]: [{kind,name,ref}], plus whether any join
// folds columns (NATURAL / USING), which changes what a bare * means in SQLite.
function fromItems(sql,code,from,d,ctes){
 const items=[];let p=from,folds=false,join=[];
 const stop=k=>{const x=code[k];return !x||x.depth<d||(x.depth===d&&((x.k==='punct'&&x.t===';')||(x.k==='word'&&FROM_END.has(x.u))||(x.u==='ON'&&code[k+1]?.u==='CONFLICT')));};
 while(!stop(p)){
  const first=code[p];let item;
  if(first.t==='('&&first.k==='punct'){
   const close=matching(code,p),inner=code[p+1];
   item={kind:inner&&['SELECT','WITH','VALUES'].includes(inner.u)?'derived':'unknown',ref:null,label:'a parenthesised FROM item'};p=close+1;
  }else if(isIdent(first)){
   let last=first;p++;
   while(code[p]?.t==='.'&&isIdent(code[p+1])){last=code[p+1];p+=2;}
   if(code[p]?.t==='('&&code[p].k==='punct'){item={kind:'function',ref:null,label:`table function ${last.t}()`};p=matching(code,p)+1;}
   else{const name=identName(last);item={kind:ctes.has(name)?'derived':'table',name,ref:sql.slice(first.s,last.e),label:`table ${name}`};}
  }else fail('Cannot read FROM clause near: '+first.t);
  if(code[p]?.u==='AS')p++;
  if(isIdent(code[p])&&!(code[p].k==='word'&&NOT_ALIAS.has(code[p].u))){item.alias=identName(code[p]);item.ref=code[p].t;p++;}
  item.join=join;join=[];items.push(item);
  // skip ON/USING conditions up to the next join operator at this depth
  while(!stop(p)){
   const x=code[p];
   if(x.depth===d&&((x.k==='punct'&&x.t===',')||(x.k==='word'&&JOIN_WORDS.has(x.u))))break;
   if(x.depth===d&&x.u==='USING')folds=true;
   p++;
  }
  while(!stop(p)&&code[p].depth===d&&((code[p].k==='punct'&&code[p].t===',')||(code[p].k==='word'&&JOIN_WORDS.has(code[p].u)))){if(code[p].u==='NATURAL')folds=true;join.push(code[p].u||',');const last=code[p].t===','||code[p].u==='JOIN';p++;if(last)break;}
 }
 // the side an outer join can fill with NULLs, whatever its columns declare
 items.forEach((item,i)=>{
  if(item.join.includes('LEFT')||item.join.includes('FULL'))item.nullable=true;
  if(item.join.includes('RIGHT')||item.join.includes('FULL'))for(let j=0;j<i;j++)items[j].nullable=true;
 });
 return {items,folds};
}
// The target of INSERT INTO / UPDATE / DELETE FROM: name [AS alias].
function targetItem(sql,code,p){
 const first=code[p];if(!isIdent(first))fail('Cannot read the RETURNING target table');
 let last=first;p++;
 while(code[p]?.t==='.'&&isIdent(code[p+1])){last=code[p+1];p+=2;}
 const item={kind:'table',name:identName(last),ref:sql.slice(first.s,last.e),label:`table ${identName(last)}`};
 if(code[p]?.u==='AS')p++;
 if(isIdent(code[p])&&!(code[p].k==='word'&&NOT_ALIAS.has(code[p].u))){item.alias=identName(code[p]);item.ref=code[p].t;}
 return item;
}

function expandStarItems(item,star,targets,columnsOf,edits){
 const where=star.qualifier?star.qualifier.t+'.*':'*';
 const resolved=targets.map(target=>{
  if(target.kind==='derived')return null;
  if(target.kind!=='table')fail(`Cannot expand ${where} over ${target.label}: its columns are unknown and SQLite's column set cannot be reproduced`);
  const columns=columnsOf(target.name);
  if(!Array.isArray(columns)||!columns.length)fail(`Cannot expand ${where}: no columns known for table "${target.name}"`);
  return columns.map(c=>target.ref+'.'+quoteColumn(c));
 });
 if(resolved.every(r=>r===null))return;
 if(resolved.some(r=>r===null))fail(`Cannot expand ${where} across both a table and a derived table`);
 edits.push({s:item[0].s,e:item[item.length-1].e,text:resolved.flat().join(',')});
}

export function expandSelectStar(sql,columnsOf){
 if(typeof columnsOf!=='function')return sql;
 const code=tokenize(sql),edits=[],ctes=cteNames(code);
 for(let n=0;n<code.length;n++){
  const head=code[n];
  if(head.u==='SELECT'){
   const d=head.depth;
   if(code[n-1]?.t==='('&&code[n-2]?.u==='EXISTS')continue;
   let p=n+1;if(code[p]?.u==='DISTINCT'||code[p]?.u==='ALL')p++;
   const {items,next}=listItems(code,p,d,x=>x.k==='word'&&LIST_END.has(x.u));
   const stars=items.map(item=>[item,starOf(item)]).filter(([,s])=>s);
   if(!stars.length)continue;
   if(code[next]?.u!=='FROM'||code[next].depth!==d)fail('SELECT * without a FROM clause cannot be expanded');
   const {items:sources,folds}=fromItems(sql,code,next+1,d,ctes);
   for(const [item,star] of stars){
    if(!star.qualifier){
     if(folds)fail('Cannot expand * over a NATURAL or USING join: SQLite folds the shared columns');
     expandStarItems(item,star,sources,columnsOf,edits);continue;
    }
    const q=identName(star.qualifier),target=sources.find(s=>(s.alias??s.name)===q);
    if(!target)fail(`Cannot expand ${star.qualifier.t}.*: no FROM item named ${star.qualifier.t}`);
    expandStarItems(item,star,[target],columnsOf,edits);
   }
  }else if(head.u==='RETURNING'){
   const d=head.depth,verb=code.find(x=>x.depth===d&&['INSERT','UPDATE','DELETE'].includes(x.u));
   if(!verb)fail('RETURNING outside INSERT, UPDATE or DELETE');
   let p=code.indexOf(verb)+1;
   if(code[p]?.u==='OR')p+=2;
   if(verb.u==='INSERT'){if(code[p]?.u!=='INTO')fail('Cannot read INSERT target');p++;}
   if(verb.u==='DELETE'){if(code[p]?.u!=='FROM')fail('Cannot read DELETE target');p++;}
   const target=targetItem(sql,code,p);
   const {items}=listItems(code,n+1,d,()=>false);
   for(const item of items){
    const star=starOf(item);if(!star)continue;
    if(star.qualifier&&identName(star.qualifier)!==(target.alias??target.name))fail(`Cannot expand ${star.qualifier.t}.* in RETURNING: it does not name the target table`);
    expandStarItems(item,star,[target],columnsOf,edits);
   }
  }
 }
 return applyEdits(sql,edits);
}

// ---------------------------------------------------------------------------
// Statement splitting and the public entry points.
// ---------------------------------------------------------------------------
export function splitStatements(sql){
 const parts=[];let start=0;
 for(let i=0;i<sql.length;i++){
  const lit=skipLiteral(sql,i);
  if(lit>=0){i=lit-1;continue;}
  if(sql[i]===';'){parts.push(sql.slice(start,i));start=i+1;}
 }
 parts.push(sql.slice(start));
 return parts.filter(p=>p.trim().length);
}

// VACUUM INTO has no PostgreSQL equivalent. server/backup.js:85 uses it to take
// a consistent file copy; that path needs a different mechanism entirely, so
// refuse loudly instead of silently succeeding.
const refuseVacuum=statement=>{if(/^\s*vacuum\b/i.test(statement))fail('VACUUM INTO has no PostgreSQL equivalent (server/backup.js:85 needs an explicit export path)');};

// The expression-level rewrites, in order. sqliteDdl.js renders index keys, partial
// index predicates, CHECKs and trigger conditions through this same function, so an
// expression index and the lookup it serves can never be spelled differently.
export function translateSqlExpression(sql){
 let out=translateJson(sql);
 out=applyNumericContext(out);
 out=translateGlob(out);
 out=translateBooleanOperand(out);
 out=translateIsNot(out);
 return translateScalarMinMax(out);
}

// SQLite's two-or-more-argument MAX(a,b)/MIN(a,b) is scalar and NULL if ANY argument
// is NULL; PostgreSQL's GREATEST/LEAST ignore NULLs. documents.js:
// "retention_until=MAX(retention_until,?)" must not turn a NULL retention into a date.
// Each argument is written exactly once (so a ? keeps its single placeholder) inside a
// VALUES list; one argument is the ordinary aggregate and is left alone.
export function translateScalarMinMax(sql){
 return rewrite(sql,(s,i)=>{
  for(const fn of ['max','min']){
   const call=matchCall(s,i,fn);
   if(!call||call.args.length<2)continue;
   const args=call.args.map(a=>translateScalarMinMax(a));
   return {text:`(SELECT CASE WHEN bool_or(v IS NULL) THEN NULL ELSE ${fn}(v) END FROM (VALUES ${args.map(a=>'('+a+')').join(',')}) sqlite_${fn}(v))`,next:call.next};
  }
  return null;
 });
}

// ---------------------------------------------------------------------------
// 10. Case-bearing aliases. PostgreSQL folds unquoted identifiers to lowercase, so
//     server/identity.js:54 "SELECT source_id AS sourceId" would hand JavaScript
//     row.sourceid. An alias declared with an uppercase letter is quoted with its
//     declared spelling, together with every reference spelled exactly the same way.
//     Nothing else is quoted: in "id AS Id ... WHERE ID=?" the id and ID are the real
//     lowercase column and must keep folding. CAST(x AS TYPE) is a type, not an alias.
// ---------------------------------------------------------------------------
const NOT_AN_ALIAS=new Set(['SELECT','VALUES','NOT','MATERIALIZED']);
export function translateAliasCase(sql){
 const code=tokenize(sql),aliases=new Set();
 for(let n=1;n<code.length;n++){
  const x=code[n];
  if(code[n-1].u!=='AS'||x.k!=='word'||!/[A-Z]/.test(x.t)||NOT_AN_ALIAS.has(x.u))continue;
  if(code[n+1]?.t==='(')continue;
  // inside CAST( ... AS TYPE )
  let depth=x.depth,cast=false;
  for(let k=n-1;k>=0;k--){if(code[k].t==='('&&code[k].k==='punct'&&code[k].depth<depth){cast=code[k-1]?.u==='CAST';break;}}
  if(cast)continue;
  aliases.add(x.t);
 }
 if(!aliases.size)return sql;
 const edits=code.filter((x,n)=>x.k==='word'&&aliases.has(x.t)&&code[n+1]?.t!=='(').map(x=>({s:x.s,e:x.e,text:quoteColumn(x.t)}));
 return applyEdits(sql,edits);
}

// ---------------------------------------------------------------------------
// 11. ON CONFLICT ... DO UPDATE SET col=col+... PostgreSQL rejects the unqualified
//     `col` on the right-hand side as ambiguous between the target row and EXCLUDED.
//     server/observability.js:137 "count=count+excluded.count", :236 "writes=writes+1".
//     References to target columns in the SET right-hand sides and the DO UPDATE WHERE
//     are qualified with the target table (or its alias). Target columns are the SET
//     list's own columns plus, when columnsOf is supplied, every column of the table.
// ---------------------------------------------------------------------------
export function qualifyConflictUpdate(sql,options={}){
 const code=tokenize(sql),at=code.findIndex((x,n)=>x.u==='DO'&&code[n+1]?.u==='UPDATE'&&code[n+2]?.u==='SET'&&x.depth===0);
 if(at<0)return sql;
 const into=code.findIndex(x=>x.u==='INTO'&&x.depth===0);
 if(into<0||!isIdent(code[into+1]))return sql;
 const target=targetItem(sql,code,into+1),columns=new Set();
 const end=code.findIndex((x,n)=>n>at&&x.depth===0&&(x.u==='RETURNING'||(x.k==='punct'&&x.t===';')));
 const last=end<0?code.length:end;
 const {items}=listItems(code,at+3,0,x=>x.k==='word'&&(x.u==='WHERE'||x.u==='RETURNING'));
 for(const item of items)if(isIdent(item[0])&&item[1]?.t==='=')columns.add(identName(item[0]));
 if(typeof options.columnsOf==='function')for(const c of options.columnsOf(target.name)||[])columns.add(String(c));
 const edits=[];
 let lhs=true;
 for(let n=at+3;n<last;n++){
  const x=code[n];
  if(x.depth===0&&x.k==='punct'&&x.t===','){lhs=true;continue;}
  if(x.depth===0&&x.u==='WHERE'){lhs=false;continue;}
  if(lhs){if(x.depth===0&&x.t==='=')lhs=false;continue;}
  if(!isIdent(x)||!columns.has(identName(x))||code[n-1]?.t==='.'||code[n+1]?.t==='.'||code[n+1]?.t==='(')continue;
  edits.push({s:x.s,e:x.s,text:target.ref+'.'});
 }
 return applyEdits(sql,edits);
}

// options.columnsOf(table) -> column names in declaration order, rowid surrogate
// excluded. When omitted, SELECT * is left as written (previous behaviour).
export function translateStatement(statement,options={}){
 refuseVacuum(statement);
 const begun=translateBegin(statement);if(begun!==null)return begun;
 const pragma=translatePragma(statement);if(pragma!==null)return pragma;
 let out=translateCatalog(statement);
 out=translateRowid(out);
 out=stripIndexedBy(out);
 out=translateSqlExpression(out);
 out=translateAliasCase(out);
 out=qualifyConflictUpdate(out,options);
 out=expandSelectStar(out,options.columnsOf);
 out=translateNullOrdering(out,options);
 out=translateInsertOrIgnore(out);
 return out;
}

// Translate one prepared statement, numbering its placeholders.
export function translateQuery(sql,options={}){
 const translated=splitStatements(sql).map(s=>translateStatement(s,options));
 if(translated.length>1)fail('prepare() received more than one statement');
 return numberPlaceholders(translated[0]??'').sql;
}

// Translate a db.exec(...) string, which may carry several statements.
export function translateExec(sql,options={}){
 let n=1;
 return splitStatements(sql).map(s=>{const r=numberPlaceholders(translateStatement(s,options),n);n+=r.count;return r.sql.trim();}).join(';\n')+';';
}

// ---------------------------------------------------------------------------
// Support objects the dialect depends on. The driver installs these once per
// connection/schema before any translated statement runs.
// ---------------------------------------------------------------------------
export const SUPPORT_SQL=`
CREATE OR REPLACE FUNCTION sqlite_json_extract(doc jsonb, VARIADIC path text[]) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v)
   WHEN 'null' THEN NULL
   WHEN 'string' THEN v #>> '{}'
   WHEN 'boolean' THEN CASE WHEN v = 'true'::jsonb THEN '1' ELSE '0' END
   ELSE v::text END
 FROM (SELECT doc #> path) s(v) $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_number(doc jsonb, VARIADIC path text[]) RETURNS numeric
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v)
   WHEN 'number' THEN (v #>> '{}')::numeric
   WHEN 'boolean' THEN CASE WHEN v = 'true'::jsonb THEN 1 ELSE 0 END
   ELSE NULL END
 FROM (SELECT doc #> path) s(v) $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_int(doc jsonb, VARIADIC path text[]) RETURNS integer
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v)
   WHEN 'number' THEN trunc((v #>> '{}')::numeric)::integer
   WHEN 'boolean' THEN CASE WHEN v = 'true'::jsonb THEN 1 ELSE 0 END
   ELSE NULL END
 FROM (SELECT doc #> path) s(v) $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_type(doc jsonb, VARIADIC path text[]) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v)
   WHEN 'number' THEN CASE WHEN (v #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
   WHEN 'string' THEN 'text'
   WHEN 'boolean' THEN CASE WHEN v = 'true'::jsonb THEN 'true' ELSE 'false' END
   ELSE jsonb_typeof(v) END
 FROM (SELECT doc #> path) s(v) $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_sqltype(doc jsonb, VARIADIC path text[]) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v)
   WHEN 'number' THEN CASE WHEN (v #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
   WHEN 'string' THEN 'text'
   WHEN 'boolean' THEN 'integer'
   WHEN 'null' THEN 'null'
   WHEN 'object' THEN 'text'
   WHEN 'array' THEN 'text'
   ELSE 'null' END
 FROM (SELECT doc #> path) s(v) $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_minify(doc text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT string_agg(m[1],'' ORDER BY o) FROM regexp_matches(doc,'("(?:[^"\\\\]|\\\\.)*"|[^[:space:]"]+)','g') WITH ORDINALITY r(m,o) $fn$;

-- The value a missing path creates, or NULL where SQLite creates nothing: a missing
-- key becomes an object, index [0] a one-element array, any other index nothing.
CREATE OR REPLACE FUNCTION sqlite_json_set_new(path text[], val json) RETURNS json
 LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE k text; sub json;
BEGIN
 IF path IS NULL OR cardinality(path)=0 THEN RETURN val; END IF;
 k:=path[1]; sub:=sqlite_json_set_new(path[2:cardinality(path)],val);
 IF sub IS NULL THEN RETURN NULL; END IF;
 IF k ~ '^\\[[0-9]+\\]$' THEN RETURN CASE WHEN k='[0]' THEN ('['||sub::text||']')::json END; END IF;
 RETURN ('{'||to_json(k)::text||':'||sub::text||'}')::json;
END $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_set_node(node json, path text[], val json) RETURNS json
 LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE k text; rest text[]; kind text; idx int; len int; body text; hit boolean; created json;
BEGIN
 IF path IS NULL OR cardinality(path)=0 THEN RETURN val; END IF;
 k:=path[1]; rest:=path[2:cardinality(path)]; kind:=json_typeof(node);
 IF k ~ '^\\[[0-9]+\\]$' THEN
  IF kind IS DISTINCT FROM 'array' THEN RETURN node; END IF;
  idx:=substr(k,2,length(k)-2)::int; len:=json_array_length(node);
  IF idx>len THEN RETURN node; END IF;
  SELECT string_agg(CASE WHEN o-1=idx THEN sqlite_json_set_node(e,rest,val)::text ELSE e::text END,',' ORDER BY o) INTO body FROM json_array_elements(node) WITH ORDINALITY a(e,o);
  IF idx=len THEN
   created:=sqlite_json_set_new(rest,val);
   IF created IS NULL THEN RETURN node; END IF;
   body:=CASE WHEN body IS NULL THEN created::text ELSE body||','||created::text END;
  END IF;
  RETURN ('['||coalesce(body,'')||']')::json;
 END IF;
 IF kind IS DISTINCT FROM 'object' THEN RETURN node; END IF;
 SELECT string_agg(to_json(key)::text||':'||CASE WHEN key=k THEN sqlite_json_set_node(value,rest,val)::text ELSE value::text END,',' ORDER BY o),coalesce(bool_or(key=k),false) INTO body,hit FROM json_each(node) WITH ORDINALITY e(key,value,o);
 IF NOT hit THEN
  created:=sqlite_json_set_new(rest,val);
  IF created IS NULL THEN RETURN node; END IF;
  body:=CASE WHEN body IS NULL THEN '' ELSE body||',' END||to_json(k)::text||':'||created::text;
 END IF;
 RETURN ('{'||coalesce(body,'')||'}')::json;
END $fn$;

CREATE OR REPLACE FUNCTION sqlite_json_set(doc text, path text[], val json) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN doc IS NULL THEN NULL ELSE sqlite_json_minify(sqlite_json_set_node(doc::json,path,coalesce(val,'null'::json))::text) END $fn$;

-- Only the current schema's objects, reached through the (relname, relnamespace)
-- catalog index: name is type name so name=$1 is an index condition, never a scan of
-- every workspace's catalog, and a workspace cannot see another's object names. sql is
-- the SQLite text sqliteDdl.js records as the object's comment, so re-executing it
-- goes back through the translator; objects created natively fall back to PostgreSQL's
-- own definition. DROP first: an older view with text columns cannot be replaced.
DROP VIEW IF EXISTS sqlite_schema;
CREATE VIEW sqlite_schema AS
 SELECT 'table'::text AS type, c.relname AS name, c.relname AS tbl_name, obj_description(c.oid,'pg_class') AS sql
  FROM pg_class c
  WHERE c.relnamespace=to_regnamespace(current_schema())::oid AND c.relkind IN ('r','p')
 UNION ALL
 SELECT 'view', c.relname, c.relname, pg_get_viewdef(c.oid,true)
  FROM pg_class c
  WHERE c.relnamespace=to_regnamespace(current_schema())::oid AND c.relkind='v' AND c.relname<>'sqlite_schema'
 UNION ALL
 SELECT 'index', c.relname, t.relname, coalesce(obj_description(c.oid,'pg_class'),pg_get_indexdef(c.oid))
  FROM pg_class c JOIN pg_index x ON x.indexrelid=c.oid JOIN pg_class t ON t.oid=x.indrelid
  WHERE c.relnamespace=to_regnamespace(current_schema())::oid AND c.relkind='i'
 UNION ALL
 SELECT 'trigger', g.tgname, c.relname, coalesce(obj_description(g.oid,'pg_trigger'),pg_get_triggerdef(g.oid))
  FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
  WHERE c.relnamespace=to_regnamespace(current_schema())::oid AND NOT g.tgisinternal;
`;
