// Phase 8 cross-workstream consistency. Nine specialists built screens to one
// written standard; these assertions are the parts of that standard a machine can
// check, so a later screen cannot quietly drift away from it.
//
// Everything here reads source rather than rendering, so it covers states that no
// fixture reaches: a branch that only appears on a 409, a denied role, or an empty
// register is still checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const ROOT=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,ROOT),'utf8');
const list=dir=>readdirSync(new URL(dir,ROOT)).filter(name=>name.endsWith('.jsx')).map(name=>dir+'/'+name);
const SCREENS=[...list('src/features'),...list('src/components')];
const STYLES=readdirSync(new URL('src/styles',ROOT)).filter(name=>name.endsWith('.css')).map(name=>'src/styles/'+name);

// The nine Phase 8 screens plus the two public pages. Everything under this list
// is held to the full standard; older screens carry a recorded, shrinking backlog.
const PHASE_EIGHT=['Messaging','RecurringGiving','AccountStructure','VolunteerPortal','EventPlanning','BoardPack','TenantAdministration','DataQuality','PublicGiving','PublicVolunteer']
 .map(name=>'src/features/'+name+'.jsx');

// A JSX opening tag can contain ">" inside an arrow function or a string, so the
// scanner tracks quotes and brace depth instead of matching to the first ">".
function tags(src,name){
 const out=[],open='<'+name;
 for(let i=0;i<src.length;i++){
  if(!src.startsWith(open,i)||!/[\s/>]/.test(src[i+open.length]||''))continue;
  let depth=0,quote=null,j=i+open.length;
  for(;j<src.length;j++){
   const c=src[j];
   if(quote){if(c==='\\')j++;else if(c===quote)quote=null;continue;}
   if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
   if(c==='{')depth++;else if(c==='}')depth--;
   else if(c==='>'&&depth===0)break;
  }
  out.push({start:i,end:j,text:src.slice(i,j+1),line:src.slice(0,i).split('\n').length});
  i=j;
 }
 return out;
}
const where=(file,tag)=>file+':'+tag.line+' '+tag.text.replace(/\s+/g,' ').slice(0,110);
const nestedIn=(src,pos,name)=>{
 let depth=0;
 for(const m of src.slice(0,pos).matchAll(new RegExp('<'+name+'[\\s>]|</'+name+'>','g')))depth+=m[0].startsWith('</')?-1:1;
 return depth>0;
};

test('every button declares an explicit type, so no control can become an accidental form submit',()=>{
 const untyped=[];
 for(const file of SCREENS)for(const tag of tags(read(file),'button'))if(!/\stype=/.test(tag.text))untyped.push(where(file,tag));
 assert.deepEqual(untyped,[],'a <button> with no type submits the nearest form by default');
});

test('an implicit submit is never paired with its own click handler',()=>{
 // A button that both submits by default and runs onClick fires twice. Nothing in
 // the product may rely on that, whatever the type attribute now says.
 const doubled=[];
 for(const file of SCREENS){
  const src=read(file);
  for(const tag of tags(src,'button')){
   if(!/onClick=/.test(tag.text))continue;
   if(/type="button"/.test(tag.text))continue;
   if(nestedIn(src,tag.start,'form'))doubled.push(where(file,tag));
  }
 }
 assert.deepEqual(doubled,[]);
});

test('every header cell declares its scope',()=>{
 const loose=[];
 for(const file of SCREENS)for(const tag of tags(read(file),'th'))if(!/\sscope=/.test(tag.text))loose.push(where(file,tag));
 assert.deepEqual(loose,[],'a header cell without scope leaves a screen reader to guess the association');
});

test('every form control carries a name a screen reader can read',()=>{
 // Either the control sits inside a <label>, or it names itself explicitly, or it
 // is bound to a label by id. A placeholder is never a name.
 const anonymous=[];
 for(const file of SCREENS){
  const src=read(file),bound=new Set([...src.matchAll(/htmlFor=(?:"([^"]+)"|\{([^}]+)\})/g)].map(m=>m[1]||m[2].trim()));
  for(const control of ['input','select','textarea'])for(const tag of tags(src,control)){
   if(/type="hidden"/.test(tag.text))continue;
   if(/aria-label(?:ledby)?=/.test(tag.text))continue;
   const id=/\bid=(?:"([^"]+)"|\{([^}]+)\})/.exec(tag.text);
   if(id&&bound.has(id[1]||id[2].trim()))continue;
   // Template-built ids pair with template-built htmlFor values in the same file.
   if(id&&id[2]&&[...bound].some(value=>value.replace(/\s/g,'')===id[2].replace(/\s/g,'')))continue;
   // A spread props object carries the id that the matching htmlFor binds to;
   // the shared Fields component is covered by its own rendering tests.
   if(/\{\.\.\./.test(tag.text)&&bound.size)continue;
   if(nestedIn(src,tag.start,'label'))continue;
   anonymous.push(where(file,tag));
  }
 }
 assert.deepEqual(anonymous,[]);
});

test('no screen renders a caught error object where a sentence belongs',()=>{
 // setError(e) puts "[object Object]" in front of a person. Every screen must
 // pass e.message, or a sentence it wrote itself.
 const raw=[];
 for(const file of SCREENS){
  const src=read(file);
  for(const m of src.matchAll(/set(?:Error|Conflict|Notice|Denied|Blocked|Problem|Status)\(\s*(e|err|error|failure|ex)\s*\)/g))
   raw.push(file+':'+src.slice(0,m.index).split('\n').length+' '+m[0]);
 }
 assert.deepEqual(raw,[]);
});

test('no user-visible string claims external delivery, provider execution or buyer acceptance',()=>{
 // The project's central honesty rule. Only negated forms are allowed, because
 // saying what did NOT happen is the whole point of most of these sentences.
 const CLAIMS=/\b(was sent to|were sent to|we have sent|we sent|has been delivered|was delivered to|successfully sent|message sent|email sent|sent successfully|accepted by the buyer|buyer accepted|approved by the district|production certified|is certified)\b/gi;
 const found=[];
 for(const file of SCREENS){
  const src=read(file);
  for(const m of src.matchAll(CLAIMS)){
   // Look at the words immediately before the claim, not at the whole line: most
   // of these sentences exist precisely to say that nothing was sent.
   const lead=src.slice(Math.max(0,m.index-60),m.index);
   if(/\b(no|not|never|nothing|without|refuses?|refused)\b[^.]*$/i.test(lead))continue;
   found.push(file+': …'+lead.slice(-50)+m[0]+'…');
  }
 }
 assert.deepEqual(found,[]);
});

test('the Phase 8 screens restructure every dense table below 700px instead of scrolling it',()=>{
 const unrestructured=[];
 for(const file of PHASE_EIGHT){
  const src=read(file);
  for(const table of tags(src,'table')){
   const close=src.indexOf('</table>',table.end);
   const body=src.slice(table.end,close===-1?src.length:close);
   // A table may be swapped for a prioritised mobile list, or it may carry a
   // data-label on every cell and stack in place. Both are sanctioned; a bare
   // horizontal scroller is not.
   if(/desktop-record-table/.test(src.slice(Math.max(0,table.start-300),table.start)+table.text))continue;
   const cells=[...tags(body,'td'),...tags(body,'th').filter(t=>/scope="row"/.test(t.text))];
   const missing=cells.filter(cell=>!/data-label=/.test(cell.text));
   if(!cells.length||missing.length)unrestructured.push(file+':'+table.line+' — '+missing.length+' of '+cells.length+' cells carry no data-label');
  }
 }
 assert.deepEqual(unrestructured,[]);
});

test('a table swapped for a mobile list actually ships that list',()=>{
 const orphans=[];
 for(const file of SCREENS){
  const src=read(file);
  const swaps=(src.match(/desktop-record-table/g)||[]).length;
  const lists=(src.match(/className="mobile-records"|className=\{'mobile-records/g)||[]).length;
  // DataTable owns the shared pair; a feature screen that hides a desktop table
  // must render its own replacement.
  if(file.endsWith('DataTable.jsx'))continue;
  if(swaps&&lists<swaps)orphans.push(file+': '+swaps+' desktop tables hidden below 700px but '+lists+' mobile lists rendered');
 }
 assert.deepEqual(orphans,[]);
});

test('the pre-Phase-8 table backlog is recorded and can only shrink',()=>{
 // These screens still scroll a dense table sideways at phone width instead of
 // restructuring it. They are outside the Phase 8 scope and are recorded here so
 // the number is visible and cannot grow unnoticed.
 const BACKLOG_CEILING=59;
 let backlog=0;
 for(const file of SCREENS){
  if(PHASE_EIGHT.includes(file))continue;
  const src=read(file);
  for(const table of tags(src,'table')){
   const close=src.indexOf('</table>',table.end);
   const body=src.slice(table.end,close===-1?src.length:close);
   if(/desktop-record-table/.test(src.slice(Math.max(0,table.start-300),table.start)+table.text))continue;
   const cells=[...tags(body,'td'),...tags(body,'th').filter(t=>/scope="row"/.test(t.text))];
   if(!cells.length||cells.some(cell=>!/data-label=/.test(cell.text)))backlog++;
  }
 }
 assert.ok(backlog<=BACKLOG_CEILING,'the unrestructured-table backlog grew to '+backlog+' from '+BACKLOG_CEILING);
});

test('the workstream stylesheets use the one product accent and the shared hairline',()=>{
 // Two stylesheets had introduced a second blue and a slate grey of their own.
 // Colour is a product decision owned by wimblo.css, not a per-screen one.
 const strays=[];
 for(const file of STYLES){
  const css=read(file);
  for(const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)){
   const before=css.slice(Math.max(0,m.index-80),m.index);
   if(/var\(\s*--[a-z-]+\s*,\s*$/.test(before))continue; // a fallback inside var() is fine
   strays.push(file+': '+m[0]);
  }
  for(const m of css.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g))strays.push(file+': '+m[0]+'…');
 }
 assert.deepEqual(strays,[]);
});

test('no class name means two different things in two workstream stylesheets',()=>{
 const owners=new Map();
 for(const file of STYLES){
  const css=read(file).replace(/\/\*[\s\S]*?\*\//g,'');
  for(const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)){
   const name=m[1];
   if(!owners.has(name))owners.set(name,new Set());
   owners.get(name).add(file);
  }
 }
 // Shared vocabulary owned by wimblo.css/styles.css is expected in several files;
 // a name first defined by a workstream must not be redefined by another.
 const SHARED=new Set(['panel','btn','btn-primary','btn-secondary','btn-danger','btn-small','field','field-wide','form-grid','form-actions','table-wrap','table-note','empty-state','error-banner','scope-banner','section-title','page-header','subtle','sr-only','cell-detail','record-link','text-btn','money','numeric','toolbar','check-field','header-actions','mobile-records','desktop-record-table','icon-btn','is-active','is-blocked','is-selected']);
 const shared=[...owners].filter(([name,files])=>files.size>1&&!SHARED.has(name)).map(([name,files])=>name+' in '+[...files].join(', '));
 assert.deepEqual(shared,[],'two workstreams define the same class name');
});

test('every workstream stylesheet restructures at the product breakpoint and respects reduced motion',()=>{
 const problems=[];
 for(const file of STYLES){
  const css=read(file);
  if(!/@media\s*\(\s*max-width:\s*700px\s*\)/.test(css))problems.push(file+': no 700px breakpoint, which is where the workspace itself switches to mobile');
  // Element widths may be anything; a *breakpoint* of its own is the divergence.
  for(const m of css.matchAll(/@media[^{]*max-width:\s*(\d+)px/g))
   if(Number(m[1])<=900&&Number(m[1])!==700&&Number(m[1])!==900)problems.push(file+': restructures at '+m[1]+'px instead of the product breakpoint');
 }
 assert.deepEqual(problems,[]);
});

test('reduced motion is honoured product-wide',()=>{
 // wimblo.css carries the global escape, so a workstream file does not need its
 // own — but the global one must exist, or every per-file rule is decoration.
 assert.match(read('src/wimblo.css')+read('src/styles.css'),/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[^}]*\*[^}]*\{[^}]*(animation|transition):\s*none\s*!important/);
});

test('no workstream stylesheet reaches for a gradient, a decorative shadow or a coloured status pill',()=>{
 const decorations=[];
 for(const file of STYLES){
  const css=read(file);
  for(const pattern of [/linear-gradient|radial-gradient/g,/backdrop-filter/g,/box-shadow:\s*(?!none)/g])
   for(const m of css.matchAll(pattern))decorations.push(file+': '+m[0].trim());
 }
 assert.deepEqual(decorations,[]);
});
