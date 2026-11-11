#!/usr/bin/env node
// Index audit, step 3: evidence tables for work/index-audit.md from the before/after plan
// files and the buyer-scale benchmarks. Prints Markdown to stdout.
//   node scripts/index-audit/report.mjs work/index-audit-before.json work/index-audit-after.json work/bench-before-sqlite.json work/bench-after-sqlite.json
import {readFileSync} from 'node:fs';

const [beforeFile,afterFile,benchBeforeFile,benchAfterFile]=process.argv.slice(2);
const read=f=>JSON.parse(readFileSync(f,'utf8'));
const before=read(beforeFile),after=read(afterFile),benchBefore=read(benchBeforeFile),benchAfter=read(benchAfterFile);
const cell=s=>String(s).replace(/\|/g,'\\|').replace(/\s+/g,' ');
const code=s=>'`'+cell(s).replace(/`/g,"'")+'`';
const short=(s,n=150)=>{const t=cell(s);return t.length>n?t.slice(0,n-1)+'…':t;};
const num=n=>Number(n).toLocaleString('en-US');
const pgSummary=s=>s.pgError?`error: ${short(s.pgError,80)}`:(s.pgScans||[]).filter(l=>!/^Sort Key/.test(l)).slice(0,3).map(l=>short(l.replace(/\s*\(cost=[^)]*\)/,''),90)).join(' → ');
const out=[];const p=(...l)=>out.push(...l);

p(`Capture: ${before.captureFiles} test processes, ${num(before.distinctStatements)} distinct statements, ${num(before.plannable)} plannable (DML/SELECT), ${num(before.statements.filter(s=>s.testOnly).length)} issued only by test files and excluded from ranking.`,'');
p(`Buyer-scale workspace: ${Object.entries(before.collectionRows).map(([c,n])=>`${c} ${num(n)}`).join(', ')}; audit ${num(before.tableRows.audit)} rows. PostgreSQL ${before.postgres?.version}.`,'');

p('### Ranked: application statements that visit a growing table','',
 '| # | Statement | Executions in capture | Rows visited per execution at buyer scale | SQLite plan | PostgreSQL plan |','|---|---|---|---|---|---|');
before.statements.filter(s=>!s.testOnly&&s.grows&&s.score>0).slice(0,25).forEach((s,i)=>p(`| ${i+1} | ${code(short(s.sql,140))} | ${num(s.executions)} | ${num(s.rowsTouchedAtScale)} | ${cell((s.sqlitePlan||[]).join('; '))} | ${cell(pgSummary(s))} |`));
p('');

const listSql='SELECT data FROM records WHERE collection=? ORDER BY rowid';
const listBefore=before.statements.find(s=>s.sql===listSql),listAfter=after.statements.find(s=>s.sql===listSql);
p('### The whole-collection read, attributed to call site and collection','',
 `\`${listSql}\` — ${num(listBefore.executions)} executions before, ${num(listAfter?.executions||0)} after, across the same ${before.captureFiles} test processes. Line numbers are from the capture before the change.`,'',
 '| # | Call site (callee <- caller), before | Collection | Executions | Rows per execution at buyer scale | Rows visited in capture |','|---|---|---|---|---|---|');
listBefore.siteRanking.slice(0,30).forEach((r,i)=>p(`| ${i+1} | ${code(r.site.replace(/server\//g,''))} | ${r.collection} | ${num(r.executions)} | ${num(r.rowsPerExecution)} | ${num(r.score)} |`));
p('');
// Line numbers move when app.js changes, so before/after is compared by caller file and function.
const caller=site=>{const m=/<- (\S+?):\d+ (\S+)$/.exec(site);return m?`${m[1].replace(/^server\//,'')} ${m[2]}`:site;};
const group=rows=>{const g=new Map();for(const r of rows||[]){const k=caller(r.site)+' ['+r.collection+']';g.set(k,(g.get(k)||0)+r.executions);}return g;};
const gb=group(listBefore.siteRanking),ga=group(listAfter?.siteRanking);
p('| Caller (file, function) | Collection | Executions before | Executions after |','|---|---|---|---|');
for(const [k,v] of [...gb].filter(([k])=>/validate|create/.test(k)).sort((a,b)=>b[1]-a[1])){const m=/^(.*) \[(.*)\]$/.exec(k);p(`| ${code(m[1])} | ${m[2]} | ${num(v)} | ${num(ga.get(k)||0)} |`);}
p('');

p('### PostgreSQL-only full scans (the SQLite plan is bounded or indexed)','','| Statement | Call sites | Executions | SQLite plan | PostgreSQL plan |','|---|---|---|---|---|');
for(const s of before.statements.filter(s=>!s.testOnly&&s.pgFullScan&&!s.grows))p(`| ${code(short(s.sql,120))} | ${cell(Object.keys(s.sites).map(x=>x.replace(/server\//g,'')).slice(0,2).join('; '))} | ${num(s.executions)} | ${cell((s.sqlitePlan||[]).join('; '))} | ${cell((s.pgPlan||[]).map(l=>l.trim().replace(/\s*\(cost=[^)]*\)/,'')).join(' → '))} |`);
p('');

p('### json_extract filters in WHERE issued by application code','','| Statement | Call sites | Executions | Collection rows at buyer scale | SQLite plan |','|---|---|---|---|---|');
for(const s of before.statements.filter(s=>!s.testOnly&&/\bWHERE\b[\s\S]*json_extract|\bWHERE\b[\s\S]*json_type/i.test(s.sql)).sort((a,b)=>b.executions-a.executions)){const c=/collection\s*=\s*'(\w+)'/.exec(s.sql)?.[1]||Object.keys(s.collections)[0]||'';p(`| ${code(short(s.sql,130))} | ${cell(Object.keys(s.sites).map(x=>x.replace(/server\//g,'')).slice(0,2).join('; '))} | ${num(s.executions)} | ${c?`${c} ${num(before.collectionRows[c]||0)}`:'—'} | ${cell((s.sqlitePlan||[]).join('; '))} |`);}
p('');

p('### New statements after the change and their plans','','| Statement | Executions in capture | SQLite plan | PostgreSQL plan |','|---|---|---|---|');
const known=new Set(before.statements.map(s=>s.sql));
for(const s of after.statements.filter(s=>!known.has(s.sql)&&!s.testOnly))p(`| ${code(short(s.sql,170))} | ${num(s.executions)} | ${cell((s.sqlitePlan||[]).join('; '))} | ${cell((s.pgPlan||[]).map(l=>l.trim().replace(/\s*\(cost=[^)]*\)/,'')).join(' → '))} |`);
p('');

p('### Buyer-scale timing on SQLite (HTTP, median of n)','','| Operation | Before | After |','|---|---|---|');
for(const [key,label] of [['manualGiftCreate','Manual gift create (externalRef empty)'],['referencedGiftCreate','Gift create with a source reference'],['pledgeReceiptCreate','Pledge receipt gift create'],['import500','500-row gift import']])p(`| ${label} | ${benchBefore[key].medianMs} ms (n=${benchBefore[key].n}) | ${benchAfter[key].medianMs} ms (n=${benchAfter[key].n}) |`);
p('');
console.log(out.join('\n'));
