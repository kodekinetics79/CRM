// Statement capture for the index audit. Loaded with --import; never imported by the
// application. Wraps node:sqlite at the prototype so every prepare()/exec() the real
// code issues is observed without touching a single call site, then writes one JSON
// file per process into WIMBLO_SQL_CAPTURE_DIR on exit.
//   WIMBLO_SQL_CAPTURE_DIR=/tmp/cap node --import ./scripts/index-audit/capture-preload.mjs --test tests/api.test.js
import {DatabaseSync,StatementSync} from 'node:sqlite';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

const dir=process.env.WIMBLO_SQL_CAPTURE_DIR;
const runner=process.execArgv.some(a=>a==='--test'||a.startsWith('--test='))&&!process.env.NODE_TEST_CONTEXT;
if(dir&&!runner&&!DatabaseSync.prototype.__wimbloCaptured){
 Error.stackTraceLimit=Math.max(Error.stackTraceLimit,30);
 const statements=new Map();// sql -> {sql,executions,prepares,kind,collections:{},sites:{}}
 const root=new URL('../../',import.meta.url).pathname;
 const site=()=>{
  // First application frame outside node internals, this preload and the persistence seam.
  const lines=String(new Error().stack).split('\n').slice(2);
  // Two application frames, so a helper such as list() is reported with its caller.
  const frames=[];
  for(const line of lines){const m=/\(?(file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/.exec(line.trim());if(!m)continue;const file=m[2];if(file.includes('/node_modules/')||file.includes('/scripts/index-audit/')||file.includes('/server/persistence/'))continue;const fn=/^at (?:async )?([^ ]+) \(/.exec(line.trim())?.[1]||'<anonymous>';frames.push(`${file.startsWith(root)?file.slice(root.length):file}:${m[3]} ${fn}`);if(frames.length===2)break;}
  return frames.join(' <- ')||'unknown';
 };
 const entry=(sql,kind)=>{let e=statements.get(sql);if(!e){e={sql,kind,executions:0,prepares:0,collections:{},sites:{},siteCollections:{}};statements.set(sql,e);}return e;};
 const note=(e,args)=>{
  e.executions++;
  // The first string argument of a records statement names the collection it reads.
  if(/\brecords\b/.test(e.sql)&&/collection\s*=\s*\?/.test(e.sql)&&typeof args[0]==='string')e.collections[args[0]]=(e.collections[args[0]]||0)+1;
  // Every execution is attributed to its call site, and records reads to site and collection.
  const s=site();e.sites[s]=(e.sites[s]||0)+1;
  if(typeof args[0]==='string'&&/collection\s*=\s*\?/.test(e.sql)){const k=`${s} [${args[0]}]`;e.siteCollections[k]=(e.siteCollections[k]||0)+1;}
 };
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.prepare=function(sql,...rest){const s=prepare.call(this,sql,...rest);if(typeof sql==='string')entry(sql,'prepare').prepares++;return s;};
 DatabaseSync.prototype.exec=function(sql,...rest){if(typeof sql==='string')note(entry(sql,'exec'),[]);return exec.call(this,sql,...rest);};
 for(const method of ['get','all','run','iterate']){const original=StatementSync.prototype[method];StatementSync.prototype[method]=function(...args){try{note(entry(this.sourceSQL,'prepare'),args);}catch{}return original.apply(this,args);};}
 Object.defineProperty(DatabaseSync.prototype,'__wimbloCaptured',{value:true});
 process.once('exit',()=>{try{mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`capture-${process.pid}-${randomBytes(4).toString('hex')}.json`),JSON.stringify({pid:process.pid,argv:process.argv.slice(1),statements:[...statements.values()]}));}catch{}});
}
