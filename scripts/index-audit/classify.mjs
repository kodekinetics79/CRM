// Plan classification for the index audit, shared by audit.mjs (at capture time) and
// report.mjs (re-run without re-reading plans).
export function classify(plannable,{tableRows,collectionRows}){
// A statement is ranked only when application code issues it; statements issued only by
// test files are counted separately. Rows touched are the rows the plan must visit at
// buyer scale: the whole table for a SCAN that is not stopped early by an ordered LIMIT,
// the whole collection for a records SEARCH keyed only on collection.
const growing=new Set(['records','audit']);
for(const s of plannable){
 const scans=[],plan=s.sqlitePlan||[];
 const sorted=plan.some(l=>/USE TEMP B-TREE FOR (ORDER BY|RIGHT PART OF ORDER BY)/.test(l));
 const bounded=/\bORDER\s+BY\b[\s\S]*\bLIMIT\b/i.test(s.sql)&&!sorted&&!/\b(GROUP BY|COUNT\(|SUM\()/i.test(s.sql);
 for(const line of plan){
  let m=/^SCAN (\w+)(?: AS \w+)?(?: USING (?:COVERING )?INDEX (\w+))?/.exec(line);
  if(m){scans.push({table:m[1],kind:bounded?'bounded':'full',index:m[2]||null});continue;}
  m=/^SEARCH (\w+)(?: AS \w+)? USING (?:COVERING )?INDEX (\w+) \((.*)\)$/.exec(line);
  if(m&&m[1]==='records'&&m[3]==='collection=?')scans.push({table:'records',kind:'collection',index:m[2]});
 }
 const literal=/collection\s*=\s*'([A-Za-z]+)'/.exec(s.sql)?.[1];
 const collections=Object.keys(s.collections).length?Object.keys(s.collections):literal?[literal]:[];
 const visit=(x,collection)=>x.kind==='bounded'?0:x.table==='records'&&x.kind==='collection'?(collection?collectionRows[collection]||0:Math.max(0,...collections.map(c=>collectionRows[c]||0))):tableRows[x.table]||0;
 s.scans=scans;
 s.testOnly=Object.keys(s.sites).length>0&&Object.keys(s.sites).every(k=>k.startsWith('tests/'));
 s.rowsTouchedAtScale=scans.reduce((n,x)=>n+visit(x),0);
 s.grows=scans.some(x=>growing.has(x.table)&&x.kind!=='bounded');
 s.writePath=Object.keys(s.sites).some(site=>/\b(validate|create|put)\b/.test(site));
 s.pgScans=(s.pgPlan||[]).filter(l=>/Seq Scan on|Index Scan|Index Only Scan|Bitmap Heap Scan on|Bitmap Index Scan on|Filter:|Index Cond:|Recheck Cond:|Sort Key:/.test(l)).map(l=>l.trim());
 s.pgFullScan=(s.pgPlan||[]).some(l=>/Seq Scan on (records|audit)\b/.test(l));
 // Records reads attributed exactly to call site and collection: executions x collection size.
 s.siteRanking=Object.entries(s.siteCollections).filter(([site])=>!site.startsWith('tests/')).map(([key,executions])=>{const collection=/\[([^\]]+)\]$/.exec(key)[1];const rows=scans.reduce((n,x)=>n+visit(x,collection),0);return {site:key.replace(/ \[[^\]]+\]$/,''),collection,executions,rowsPerExecution:rows,score:executions*rows};}).sort((a,b)=>b.score-a.score);
 s.score=s.testOnly?0:s.executions*s.rowsTouchedAtScale;
}
}
