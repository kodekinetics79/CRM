import {createHash} from 'node:crypto';
import {translateSqlExpression,SUPPORT_SQL,translateStatement as translateRuntimeStatement,numberPlaceholders} from './sqliteQuery.js';

// Pure SQLite -> PostgreSQL DDL translation. No connection, no I/O, no state.
// Stage 2 of NEON-MIGRATION-PLAN.md: schema/DDL only. Statement text in, statement
// text out. Trigger refusal messages are carried through byte-identical because
// tests and users assert them (non-negotiable 3); no float type is ever emitted
// because money is exact integer cents (non-negotiable 4).

const MAX_IDENTIFIER=63;
// PostgreSQL reserved / type-function keywords that cannot be a bare column name.
const RESERVED=new Set('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with'.split(' '));
// SQLite type affinities we accept. REAL/FLOAT/DOUBLE are refused on purpose.
const TYPES={TEXT:()=>'TEXT',CLOB:()=>'TEXT',VARCHAR:()=>'TEXT',INTEGER:o=>o.integerType,INT:o=>o.integerType,BIGINT:o=>o.integerType,BLOB:()=>'BYTEA',NUMERIC:()=>'NUMERIC',DECIMAL:()=>'NUMERIC',BOOLEAN:()=>'BOOLEAN'};
const FLOATY=/^(REAL|FLOAT|DOUBLE|DOUBLE PRECISION)$/i;

// integerType is BIGINT because SQLite INTEGER is 64-bit: int4 caps integer cents
// at $21,474,836.47 while the app validates amounts up to 1e12 cents. The
// synchronous driver decodes int8 to a JS number when it is a safe integer and
// throws rather than lose precision. 0/1 columns still never become BOOLEAN
// (`WHERE active=1`, `Number(body.active)` and `CHECK(active IN (0,1))` depend on
// the integer). `integerType:'INTEGER'` remains available for int4.
// textCollation is applied to every TEXT column that does not declare its own
// collation, so equality, UNIQUE and every ORDER BY inherit SQLite's BINARY
// (byte-order) comparison. Without it PostgreSQL uses the database locale and
// glibc/ICU sort `apple, Banana, Zebra` where SQLite sorts `Banana, Zebra, apple`.
// COLLATE NOCASE columns keep the non-deterministic ICU collation instead.
// rowidColumn is the surrogate for SQLite's rowid: PostgreSQL has none, and
// `ORDER BY rowid` decides the order collections are returned in throughout the
// product. It is appended LAST so that positional `INSERT INTO t VALUES(?,…)`
// keeps working -- PostgreSQL fills the omitted trailing column from its identity.
// deferrableForeignKeys marks every REFERENCES clause DEFERRABLE INITIALLY
// IMMEDIATE: still checked per statement by default, but `SET CONSTRAINTS ALL
// DEFERRED` (the runtime translation of PRAGMA foreign_keys=OFF) can defer it.
export const DEFAULT_OPTIONS={integerType:'BIGINT',textCollation:'C',deferrableForeignKeys:true,rowidColumn:'__rowid',nocaseCollation:'nocase',ifNotExists:true,dollarTag:'wimblo_ddl',errcode:'P0001',addColumnIfNotExists:true};
const opts=o=>({...DEFAULT_OPTIONS,...o});

const sha=(s,n=8)=>createHash('sha256').update(s,'utf8').digest('hex').slice(0,n);
export const quoteLiteral=s=>`'${String(s).replace(/'/g,"''")}'`;
const plain=n=>/^[a-z_][a-z0-9_$]*$/.test(n)&&!RESERVED.has(n);
export const quoteIdentifier=n=>{const b=n.startsWith('"')&&n.endsWith('"')?n.slice(1,-1).replace(/""/g,'"'):n;return plain(b)?b:`"${b.replace(/"/g,'""')}"`;};
const bare=n=>n.startsWith('"')&&n.endsWith('"')?n.slice(1,-1).replace(/""/g,'"'):n;

// Truncate on a UTF-8 byte boundary, never mid-sequence.
function clip(name,bytes){const b=Buffer.from(name,'utf8');if(b.length<=bytes)return name;let end=bytes;while(end>0&&(b[end]&0xc0)===0x80)end--;return b.subarray(0,end).toString('utf8');}

// Deterministic, <=63-byte identifier. `key` distinguishes objects that could
// otherwise collapse onto the same readable prefix.
export function limitIdentifier(name,key=name){
 if(Buffer.byteLength(name,'utf8')<=MAX_IDENTIFIER)return name;
 return `${clip(name,MAX_IDENTIFIER-9)}_${sha(key)}`;
}

// SQLite trigger names are schema-global; PostgreSQL trigger names are per table,
// so two tables may legally carry the same trigger name. The generated function
// name therefore always carries a hash of table+trigger: deterministic, unique per
// trigger, and bounded at 63 bytes without blind truncation.
export function triggerFunctionName(trigger,table){
 const t=bare(trigger),tb=bare(table),h=sha(`${tb}\u0000${t}`);
 return `${clip(`${t}_raise`,MAX_IDENTIFIER-9)}_${h}`;
}

// ---------------------------------------------------------------- lexing

// Split a DDL script into statements. Honours '...' literals (with '' escapes),
// "..." identifiers, -- and /* */ comments, and CREATE TRIGGER ... BEGIN ... END;
// bodies whose internal semicolons do not terminate the statement.
export function splitStatements(sql){
 const out=[];let cur='',i=0,depth=0,trigger=false,body=false;
 const flush=()=>{const t=cur.trim();if(t)out.push(t);cur='';trigger=false;body=false;depth=0;};
 while(i<sql.length){
  const c=sql[i];
  if(c==="'"){let j=i+1;while(j<sql.length){if(sql[j]==="'"){if(sql[j+1]==="'"){j+=2;continue;}break;}j++;}cur+=sql.slice(i,j+1);i=j+1;continue;}
  if(c==='"'){let j=i+1;while(j<sql.length){if(sql[j]==='"'){if(sql[j+1]==='"'){j+=2;continue;}break;}j++;}cur+=sql.slice(i,j+1);i=j+1;continue;}
  if(c==='-'&&sql[i+1]==='-'){const j=sql.indexOf('\n',i);const k=j<0?sql.length:j;cur+=sql.slice(i,k);i=k;continue;}
  if(c==='/'&&sql[i+1]==='*'){const j=sql.indexOf('*/',i+2);const k=j<0?sql.length:j+2;cur+=sql.slice(i,k);i=k;continue;}
  if(/[A-Za-z_]/.test(c)){let j=i;while(j<sql.length&&/[A-Za-z0-9_$]/.test(sql[j]))j++;const w=sql.slice(i,j),u=w.toUpperCase();
   cur+=w;i=j;
   if(!trigger&&u==='TRIGGER'&&/\bCREATE\b[\s\S]*$/i.test(cur)&&/^\s*CREATE\s+(OR\s+REPLACE\s+)?(TEMP|TEMPORARY\s+)?TRIGGER$/i.test(cur.trim()))trigger=true;
   else if(trigger&&(u==='BEGIN'||u==='CASE')){depth++;body=true;}
   else if(trigger&&u==='END'&&depth>0)depth--;
   continue;}
  if(c===';'){if(trigger&&(depth>0||!body)){cur+=c;i++;continue;}cur+=c;i++;flush();continue;}
  cur+=c;i++;
 }
 flush();
 return out.map(s=>s.replace(/;\s*$/,'').trim()).filter(Boolean);
}

// Split on commas that sit at paren depth zero and outside any literal.
function splitTop(s){
 const out=[];let cur='',d=0,i=0;
 while(i<s.length){
  const c=s[i];
  if(c==="'"){let j=i+1;while(j<s.length){if(s[j]==="'"){if(s[j+1]==="'"){j+=2;continue;}break;}j++;}cur+=s.slice(i,j+1);i=j+1;continue;}
  if(c==='"'){let j=i+1;while(j<s.length){if(s[j]==='"'){if(s[j+1]==='"'){j+=2;continue;}break;}j++;}cur+=s.slice(i,j+1);i=j+1;continue;}
  if(c==='(')d++;if(c===')')d--;
  if(c===','&&d===0){out.push(cur.trim());cur='';i++;continue;}
  cur+=c;i++;
 }
 if(cur.trim())out.push(cur.trim());
 return out;
}

// Token walk that leaves string literals and quoted identifiers untouched.
function mapTokens(sql,fn){
 const toks=[];let i=0;
 while(i<sql.length){
  const c=sql[i];
  if(c==="'"||c==='"'){let j=i+1;while(j<sql.length){if(sql[j]===c){if(sql[j+1]===c){j+=2;continue;}break;}j++;}toks.push({lit:true,t:sql.slice(i,j+1)});i=j+1;continue;}
  if(/[A-Za-z_]/.test(c)){let j=i;while(j<sql.length&&/[A-Za-z0-9_$]/.test(sql[j]))j++;toks.push({word:true,t:sql.slice(i,j)});i=j;continue;}
  toks.push({t:c});i++;
 }
 return fn(toks);
}

// ---------------------------------------------------------------- expressions

// SQLite `IS` / `IS NOT` are null-safe equality; PostgreSQL spells that
// `IS NOT DISTINCT FROM` / `IS DISTINCT FROM`. `IS [NOT] NULL` stays as written.
export function translateExpression(expr){
 return mapTokens(expr,toks=>{
  const out=[];
  const nextWord=k=>{let j=k;while(j<toks.length&&!toks[j].word&&!toks[j].lit&&/\s/.test(toks[j].t))j++;return j<toks.length&&toks[j].word?j:-1;};
  for(let i=0;i<toks.length;i++){
   const tk=toks[i];
   if(tk.word&&tk.t.toUpperCase()==='IS'){
    const a=nextWord(i+1),aw=a>=0?toks[a].t.toUpperCase():'';
    if(aw==='NOT'){const b=nextWord(a+1),bw=b>=0?toks[b].t.toUpperCase():'';
     if(bw==='NULL'){out.push('IS NOT NULL');i=b;continue;}
     out.push('IS DISTINCT FROM');i=a;continue;}
    if(aw==='NULL'){out.push('IS NULL');i=a;continue;}
    out.push('IS NOT DISTINCT FROM');continue;
   }
   out.push(tk.t);
  }
  return out.join('');
 });
}

// ------------------------------------------------- SQLite-only functions in DDL

// One renderer for json_extract / json_type / typeof / GLOB / IS NOT, shared with the
// runtime query translator. PostgreSQL uses an expression index only when the query
// expression is the index expression, so an index key or partial-index predicate must
// be spelled exactly as the lookup that should use it: rendering both through
// translateSqlExpression makes that true by construction. The sqlite_json_* helpers
// are IMMUTABLE and ship in SUPPORT_SQL, which preludeStatements() now includes.
const LEFTOVER=/\b(json_extract|json_type|json_array_length|typeof|glob|strftime|julianday|datetime|date|time|unixepoch|printf|iif|likelihood|instr|randomblob)\s*\(/i;

export function translateSqliteFunctions(expr,notes=[]){
 const out=translateSqlExpression(expr);
 if(out!==expr&&/\b(json_|typeof|glob)/i.test(expr))notes.push(`SQLite functions rendered by the shared query renderer: ${expr.slice(0,120)}`);
 const left=LEFTOVER.exec(out);
 if(left)throw new Error(`Untranslated SQLite function "${left[1]}" in DDL expression: ${expr.slice(0,120)}`);
 return out;
}

// ---------------------------------------------------------------- columns

function columnType(raw,o,notes){
 const t=raw.toUpperCase();
 if(FLOATY.test(t))throw new Error(`Refusing to emit a floating-point type for SQLite type "${raw}": money is exact integer cents`);
 const f=TYPES[t];
 if(!f)throw new Error(`Unsupported SQLite column type "${raw}"`);
 const mapped=f(o);
 if(t==='INTEGER'&&mapped.toUpperCase()!=='INTEGER')notes.push(`INTEGER -> ${mapped} (SQLite INTEGER is 64-bit)`);
 return mapped;
}

// One column definition: `name TYPE [constraints...]`.
function translateColumn(def,o,notes){
 const m=/^("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s+([A-Za-z ]+?)(\s|\(|$)([\s\S]*)$/.exec(def);
 if(!m)throw new Error(`Cannot parse column definition: ${def}`);
 const name=quoteIdentifier(m[1]);
 const rest=(m[3]==='('?'(':'')+m[4];
 const declared=m[2].trim();
 // INTEGER PRIMARY KEY AUTOINCREMENT is SQLite's rowid alias -> identity column.
 if(/^INTEGER$/i.test(declared)&&/^PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(rest.trim())){
  const tail=rest.trim().replace(/^PRIMARY\s+KEY\s+AUTOINCREMENT/i,'').trim();
  notes.push(`${bare(m[1])}: INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED BY DEFAULT AS IDENTITY`);
  return `${name} BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY${tail?' '+translateColumnTail(tail,o,notes):''}`;
 }
 if(/\bAUTOINCREMENT\b/i.test(rest))throw new Error(`AUTOINCREMENT outside INTEGER PRIMARY KEY: ${def}`);
 const type=columnType(declared,o,notes);
 // A TEXT column with no collation of its own gets the byte-order collation, so
 // ORDER BY / equality / UNIQUE compare exactly as SQLite BINARY does.
 const collate=type==='TEXT'&&o.textCollation&&!hasCollate(rest)?` COLLATE ${quoteIdentifier(`"${o.textCollation}"`)}`:'';
 return `${name} ${type}${collate}${rest.trim()?' '+translateColumnTail(rest.trim(),o,notes):''}`;
}
const hasCollate=sql=>mapTokens(sql,toks=>toks.some(t=>t.word&&t.t.toUpperCase()==='COLLATE'));

// REFERENCES t(c) [ON DELETE|UPDATE action]... [MATCH x] -> ... DEFERRABLE INITIALLY
// IMMEDIATE, unless the clause already states its deferrability. Literal-aware.
const FK_ACTION=[['CASCADE'],['RESTRICT'],['NO','ACTION'],['SET','NULL'],['SET','DEFAULT']];
export function deferrableReferences(sql){
 return mapTokens(sql,toks=>{
  const out=toks.map(t=>t.t),W=k=>toks[k]&&toks[k].word?toks[k].t.toUpperCase():null;
  const skip=k=>{while(k<toks.length&&!toks[k].word&&!toks[k].lit&&/\s/.test(toks[k].t))k++;return k;};
  for(let i=0;i<toks.length;i++){
   if(W(i)!=='REFERENCES')continue;
   let k=skip(i+1);if(!(toks[k]?.word||toks[k]?.lit))continue;let end=k;
   k=skip(k+1);
   if(toks[k]?.t==='('){let d=0;for(;k<toks.length;k++){if(toks[k].t==='(')d++;else if(toks[k].t===')'&&--d===0)break;}end=k;k=skip(k+1);}
   for(;;){
    if(W(k)==='ON'&&['DELETE','UPDATE'].includes(W(skip(k+1)))){
     const a=skip(skip(k+1)+1),b=skip(a+1),act=FK_ACTION.find(w=>W(a)===w[0]&&(w.length===1||W(b)===w[1]));
     if(!act)throw new Error(`Cannot parse foreign key action: ${sql.slice(0,160)}`);
     end=act.length===1?a:b;k=skip(end+1);continue;}
    if(W(k)==='MATCH'){end=skip(k+1);k=skip(end+1);continue;}
    break;
   }
   const next=W(k);
   if(next==='DEFERRABLE'||next==='INITIALLY'||(next==='NOT'&&W(skip(k+1))==='DEFERRABLE'))continue;
   out[end]+=' DEFERRABLE INITIALLY IMMEDIATE';i=end;
  }
  return out.join('');
 });
}

// Column constraints: NOT NULL / UNIQUE / PRIMARY KEY / DEFAULT / CHECK / REFERENCES
// / COLLATE. Everything except COLLATE NOCASE and IS-comparisons passes through
// unchanged, which is what keeps CHECK(col IN ('A','B')) byte-for-byte.
function translateColumnTail(tail,o,notes){
 // Literal-aware: a DEFAULT 'COLLATE NOCASE' string is data. SQLite's BINARY is
 // byte order, which is PostgreSQL's "C".
 let out=mapTokens(tail,toks=>toks.map((tk,i)=>{
  let j=i-1;while(j>0&&!toks[j].word&&!toks[j].lit&&/\s/.test(toks[j].t))j--;
  if(!tk.word||j===i-1||!toks[j]?.word||toks[j].t.toUpperCase()!=='COLLATE')return tk.t;
  const u=tk.t.toUpperCase();
  if(u==='NOCASE'){notes.push(`COLLATE NOCASE -> COLLATE ${quoteIdentifier(o.nocaseCollation)} (non-deterministic ICU collation; see preludeStatements)`);return quoteIdentifier(o.nocaseCollation);}
  return u==='BINARY'?'"C"':tk.t;
 }).join(''));
 if(o.deferrableForeignKeys)out=deferrableReferences(out);
 return translateSqliteFunctions(translateExpression(out),notes);
}

// SQLite keeps each object's CREATE text in sqlite_schema.sql, normalised to
// "CREATE <KIND> " followed by the source from the object name onward (IF NOT EXISTS
// dropped). The translation records exactly that text as the PostgreSQL object's
// comment, and the sqlite_schema view in sqliteQuery.js reads it back, so a caller that
// saves a definition and re-executes it later (backup.js:75, the integrity tests that
// drop and restore a guard trigger) round-trips through this translator unchanged.
const sqliteText=(sql,head,kind)=>{const src=sql.trim(),m=head.exec(src);return `CREATE ${kind} ${src.slice(m[0].length)}`;};

const TABLE_CONSTRAINT=/^(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)/i;

export function translateCreateTable(sql,options){
 const o=opts(options),notes=[];
 const m=/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\(([\s\S]*)\)\s*((?:WITHOUT\s+ROWID|STRICT)(?:\s*,\s*(?:WITHOUT\s+ROWID|STRICT))*)?$/i.exec(sql.trim());
 if(!m)throw new Error(`Cannot parse CREATE TABLE: ${sql.slice(0,120)}`);
 if(m[4])notes.push(`table option "${m[4].trim()}" dropped (SQLite-only)`);
 const items=splitTop(m[3]);
 const columns=items.filter(p=>!TABLE_CONSTRAINT.test(p)).map(p=>bare((/^("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/.exec(p)||[,''])[1]).toLowerCase());
 const parts=items.map(p=>TABLE_CONSTRAINT.test(p)?translateColumnTail(p,o,notes):translateColumn(p,o,notes));
 // SQLite rowid surrogate. Appended last so positional INSERT ... VALUES(?,…) is
 // unaffected; PostgreSQL supplies the omitted trailing identity value itself.
 if(o.rowidColumn){
  if(columns.includes(o.rowidColumn.toLowerCase()))throw new Error(`Table ${bare(m[2])} already declares a column named ${o.rowidColumn}; choose another rowidColumn`);
  parts.push(`${quoteIdentifier(o.rowidColumn)} BIGINT GENERATED ALWAYS AS IDENTITY`);
  notes.push(`${bare(m[2])}: rowid surrogate ${o.rowidColumn} appended (translate ORDER BY rowid to ORDER BY ${o.rowidColumn})`);
 }
 const exists=m[1]&&o.ifNotExists?'IF NOT EXISTS ':'';
 const comment=`COMMENT ON TABLE ${quoteIdentifier(m[2])} IS ${quoteLiteral(sqliteText(sql,/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,'TABLE'))}`;
 return {kind:'table',name:bare(m[2]),columns,rowidColumn:o.rowidColumn||null,statements:[`CREATE TABLE ${exists}${quoteIdentifier(m[2])}(${parts.join(',')})`,comment],notes};
}

export function translateCreateIndex(sql,options){
 const o=opts(options),notes=[];
 const m=/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s+ON\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\(([\s\S]*?)\)\s*(?:WHERE\s+([\s\S]+))?$/i.exec(sql.trim());
 if(!m)throw new Error(`Cannot parse CREATE INDEX: ${sql.slice(0,120)}`);
 const raw=bare(m[3]),name=limitIdentifier(raw,`${bare(m[4])}\u0000${raw}`);
 if(name!==raw)notes.push(`index ${raw} -> ${name} (63-byte identifier limit)`);
 // PostgreSQL requires an expression index key to be parenthesised.
 const keys=splitTop(m[5]).map(k=>{
  const t=translateColumnTail(k,o,notes).trim();
  const simple=/^("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(\s+COLLATE\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?$/i.exec(t);
  if(simple)return quoteIdentifier(simple[1])+t.slice(simple[1].length);
  notes.push(`expression index key parenthesised: ${t}`);
  return `(${t})`;
 });
 const where=m[6]?` WHERE ${translateColumnTail(m[6].trim(),o,notes)}`:'';
 const exists=m[2]&&o.ifNotExists?'IF NOT EXISTS ':'';
 const comment=`COMMENT ON INDEX ${quoteIdentifier(name)} IS ${quoteLiteral(sqliteText(sql,/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,m[1]?'UNIQUE INDEX':'INDEX'))}`;
 return {kind:'index',name,statements:[`CREATE ${m[1]?'UNIQUE ':''}INDEX ${exists}${quoteIdentifier(name)} ON ${quoteIdentifier(m[4])}(${keys.join(',')})${where}`,comment],notes};
}

const QNAME='(?:(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\\s*\\.\\s*)?(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const TRIGGER_RE=new RegExp(`^CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TRIGGER\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})\\s+(BEFORE|AFTER|INSTEAD\\s+OF)\\s+(DELETE|INSERT|UPDATE(?:\\s+OF\\s+([^]*?))?)\\s+ON\\s+(${QNAME})\\s*(FOR\\s+EACH\\s+ROW\\s+)?(?:WHEN\\s+([\\s\\S]*?)\\s+)?BEGIN\\s+([\\s\\S]*?)\\s*END$`,'i');
const RAISE_RE=/^SELECT\s+RAISE\s*\(\s*(ABORT|FAIL|ROLLBACK)\s*,\s*('(?:[^']|'')*')\s*\)$/i;
const DML_RE=/^(UPDATE|INSERT|DELETE)\b/i;

// schema.name -> {schema,name}. SQLite's main and temp are the current PostgreSQL
// schema, so that qualifier is dropped; any other qualifier is kept.
function qualified(raw){
 const parts=splitQualified(raw);
 const schema=parts.length>1&&!/^(main|temp)$/i.test(bare(parts[0]))?parts[0]:null;
 return {name:bare(parts[parts.length-1]),sql:(schema?quoteIdentifier(schema)+'.':'')+quoteIdentifier(parts[parts.length-1])};
}
function splitQualified(raw){
 const out=[];let cur='',i=0;
 while(i<raw.length){const c=raw[i];
  if(c==='"'){let j=i+1;while(j<raw.length){if(raw[j]==='"'){if(raw[j+1]==='"'){j+=2;continue;}break;}j++;}cur+=raw.slice(i,j+1);i=j+1;continue;}
  if(c==='.'){out.push(cur.trim());cur='';i++;continue;}
  cur+=c;i++;}
 out.push(cur.trim());
 return out;
}

// A trigger becomes a PL/pgSQL function plus the trigger that calls it. The body may be
//  - SELECT RAISE(ABORT|FAIL|ROLLBACK,'message'): RAISE EXCEPTION with the identical
//    message. `RAISE EXCEPTION USING MESSAGE = <literal>` rather than
//    `RAISE EXCEPTION '<literal>'`, so a % or backslash is never a format string;
//  - UPDATE / INSERT / DELETE: rendered by the runtime query translator (json_set,
//    IS NOT, rowid...), with NEW.col / OLD.col left for PL/pgSQL to bind. This is the
//    shape of every fault-injection trigger the integrity tests install.
// Anything else -- another SELECT, RAISE(IGNORE), a bound parameter -- throws by name.
export function translateCreateTrigger(sql,options){
 const o=opts(options),notes=[];
 const m=TRIGGER_RE.exec(sql.trim());
 if(!m)throw new Error(`Cannot parse CREATE TRIGGER: ${sql.slice(0,160)}`);
 const [,ifne,rawNameQ,timing,event,updateCols,tableQ,,when,body]=m;
 const rawName=qualified(rawNameQ).name,target=qualified(tableQ),table=target.name;
 if(/^INSTEAD\s+OF$/i.test(timing))throw new Error(`INSTEAD OF triggers require a view in PostgreSQL: ${rawName}`);
 const stmts=splitStatements(body).map(s=>s.trim());
 if(!stmts.length)throw new Error(`Unsupported trigger body (empty): ${rawName}`);
 const steps=stmts.map(s=>{
  const r=RAISE_RE.exec(s);
  if(r)return {raise:r[2]};
  if(DML_RE.test(s)){
   const text=translateRuntimeStatement(s);
   if(numberPlaceholders(text).count)throw new Error(`Unsupported trigger body (a bound parameter cannot appear in a trigger): ${rawName} -> ${s.slice(0,120)}`);
   return {dml:text};
  }
  throw new Error(`Unsupported trigger body (only SELECT RAISE(...), UPDATE, INSERT and DELETE are translated): ${rawName} -> ${s.slice(0,120)}`);
 });
 const raises=steps.filter(x=>x.raise);
 const message=raises[0]?.raise??null;                // still SQL-quoted, '' escapes intact
 if(raises.length>1)notes.push(`${rawName}: ${raises.length} RAISE statements; first is the one PostgreSQL reaches, as in SQLite`);
 const name=limitIdentifier(rawName,`${table}\u0000${rawName}`);
 if(name!==rawName)notes.push(`trigger ${rawName} -> ${name} (63-byte identifier limit)`);
 const fn=triggerFunctionName(rawName,table,o);
 const cols=updateCols?` OF ${splitTop(updateCols).map(c=>quoteIdentifier(c.trim())).join(',')}`:'';
 const ev=/^UPDATE/i.test(event)?`UPDATE${cols}`:event.toUpperCase();
 const guard=when?translateSqliteFunctions(translateExpression(when),notes):null;
 // PostgreSQL forbids a subquery in a trigger WHEN condition; SQLite allows one.
 // Such a condition moves into the PL/pgSQL body, where it means the same thing.
 const inBody=guard!==null&&/\bSELECT\b/i.test(guard);
 if(inBody)notes.push(`${name}: WHEN condition contains a subquery; evaluated inside the trigger function instead`);
 const raise=msg=>`RAISE EXCEPTION USING ERRCODE=${quoteLiteral(o.errcode)},MESSAGE=${msg};`;
 // a BEFORE trigger lets the row proceed by returning it; an AFTER trigger's result is ignored
 const pass=/^BEFORE$/i.test(timing)?(/^DELETE$/i.test(event)?'OLD':'NEW'):'NULL';
 let fnBody;
 if(steps.every(x=>x.raise))fnBody=inBody?`IF (${guard}) THEN ${raise(message)} END IF; RETURN ${/^DELETE$/i.test(event)?'OLD':'NEW'};`:`${raise(message)} RETURN NULL;`;
 else{
  notes.push(`${name}: ${steps.filter(x=>x.dml).length} data-changing statement(s) run inside the trigger function`);
  const run=steps.map(x=>x.raise?raise(x.raise):`${x.dml};`).join(' ');
  fnBody=inBody?`IF (${guard}) THEN ${run} END IF; RETURN ${pass};`:`${run} RETURN ${pass};`;
 }
 let tag=`$${o.dollarTag}$`;
 if(fnBody.includes(tag))tag=`$${o.dollarTag}_${sha(fnBody)}$`;
 const fnSql=`CREATE OR REPLACE FUNCTION ${quoteIdentifier(fn)}() RETURNS trigger LANGUAGE plpgsql AS ${tag}BEGIN ${fnBody} END${tag}`;
 const cond=inBody||guard===null?'':` WHEN (${guard})`;
 // CREATE OR REPLACE TRIGGER is PostgreSQL's idempotent form of IF NOT EXISTS.
 const create=`CREATE OR REPLACE TRIGGER ${quoteIdentifier(name)} ${timing.toUpperCase().replace(/\s+/g,' ')} ${ev} ON ${target.sql} FOR EACH ROW${cond} EXECUTE FUNCTION ${quoteIdentifier(fn)}()`;
 const comment=`COMMENT ON TRIGGER ${quoteIdentifier(name)} ON ${target.sql} IS ${quoteLiteral(sqliteText(sql,/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,'TRIGGER'))}`;
 if(ifne)notes.push(`${name}: IF NOT EXISTS -> CREATE OR REPLACE TRIGGER`);
 return {kind:'trigger',name,table,function:fn,message:message===null?null:message.slice(1,-1).replace(/''/g,"'"),statements:[fnSql,create,comment],notes};
}

export function translateAlterTable(sql,options){
 const o=opts(options),notes=[];
 const m=/^ALTER\s+TABLE\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s+ADD\s+(?:COLUMN\s+)?([\s\S]+)$/i.exec(sql.trim());
 if(!m)throw new Error(`Only ALTER TABLE ... ADD COLUMN is translated: ${sql.slice(0,120)}`);
 const col=translateColumn(m[2].trim(),o,notes);
 // SQLite rewrites the stored CREATE TABLE text as "...<text before the last )>, <column>)";
 // the table comment follows, once, so sqlite_schema.sql still reads as SQLite's.
 const suffix=', '+m[2].trim(),t=quoteLiteral(quoteIdentifier(m[1]));
 let tag=`$${o.dollarTag}$`;if(suffix.includes(tag))tag=`$${o.dollarTag}_${sha(suffix)}$`;
 const comment=`DO ${tag}DECLARE d text:=obj_description(${t}::regclass,'pg_class'); p int; s text:=${quoteLiteral(suffix)}; BEGIN IF d IS NULL OR strpos(d,')')=0 THEN RETURN; END IF; p:=length(d)-strpos(reverse(d),')')+1; IF right(left(d,p-1),length(s))=s THEN RETURN; END IF; EXECUTE format('COMMENT ON TABLE %s IS %L',${t}::regclass,left(d,p-1)||s||substr(d,p)); END${tag}`;
 return {kind:'alter',name:bare(m[1]),statements:[`ALTER TABLE ${quoteIdentifier(m[1])} ADD COLUMN ${o.addColumnIfNotExists?'IF NOT EXISTS ':''}${col}`,comment],notes};
}

// ---------------------------------------------------------------- dispatch

const KIND=[
 [/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\b/i,translateCreateTable],
 [/^CREATE\s+(UNIQUE\s+)?INDEX\b/i,translateCreateIndex],
 [/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i,translateCreateTrigger],
 [/^ALTER\s+TABLE\b/i,translateAlterTable],
];

export function translateStatement(sql,options){
 const s=sql.trim().replace(/;\s*$/,'').trim();
 if(!s)return {kind:'empty',source:sql,statements:[],notes:[]};
 // PRAGMA is SQLite engine configuration and has no PostgreSQL DDL equivalent.
 if(/^PRAGMA\b/i.test(s))return {kind:'pragma',source:s,statements:[],notes:[`PRAGMA is a no-op on PostgreSQL: ${s}`]};
 for(const [re,fn] of KIND)if(re.test(s))return {...fn(s,options),source:s};
 if(/^(DROP)\b/i.test(s))return {kind:'passthrough',source:s,statements:[s],notes:[]};
 const e=new Error(`Not DDL this layer translates: ${s.slice(0,120)}`);
 e.sqliteDdlUnsupported=true;
 throw e;
}

// Translate a whole script. `strict` rethrows on anything unsupported; otherwise
// unsupported statements are collected and named rather than silently dropped.
export function translateDdl(sql,options){
 const o=opts(options),statements=[],units=[],notes=[],unsupported=[];
 for(const s of splitStatements(sql)){
  try{const u=translateStatement(s,o);units.push(u);statements.push(...u.statements);notes.push(...u.notes);}
  catch(e){if(o.strict)throw e;unsupported.push({source:s,reason:e.message});}
 }
 return {statements,units,notes,unsupported};
}

// Objects the translated schema depends on: the case-insensitive collation behind
// COLLATE NOCASE, and the IMMUTABLE sqlite_json_* helpers that index keys, partial
// index predicates, CHECKs and trigger conditions are rendered with. Idempotent.
export function preludeStatements(options){
 const o=opts(options);
 return [`CREATE COLLATION IF NOT EXISTS ${quoteIdentifier(o.nocaseCollation)} (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,SUPPORT_SQL.trim()];
}
