import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import * as lib from '../src/lib.js';
import * as categories from '../shared/constituentTypes.js';
import * as jsxRuntime from 'react/jsx-runtime';
import * as client from '../src/api.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const compile=(path,require)=>{const module={exports:{}},source=readFileSync(new URL(path,import.meta.url),'utf8');new Function('require','module','exports',transformSync(source,{loader:'jsx',format:'cjs',...(/import React/.test(source)?{}:{jsx:'automatic'})}).code)(require,module,module.exports);return module.exports;};
const schema=compile('../src/schema.js',()=>lib);
const stubs=new Proxy({},{get:()=>function Stub(){return null;}});
function find(tree,p){if(!tree||typeof tree!=='object')return null;if(p(tree))return tree;for(const c of React.Children.toArray(tree.props?.children)){const r=find(c,p);if(r)return r;}return null;}
const texts=e=>React.Children.toArray(e.props.children).filter(c=>typeof c==='string').join('');
const submit=tree=>find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});
const alertText=tree=>{const a=find(tree,e=>e.props?.role==='alert');return a?JSON.stringify(React.Children.toArray(a.props.children).filter(c=>typeof c==='string')):'';};

// Records what the browser would send: every mutating request's Idempotency-Key, with scripted outcomes.
function network(t,outcomes){const sent=[],original=globalThis.fetch;globalThis.fetch=async(url,init)=>{sent.push({url,method:init.method,key:init.headers['Idempotency-Key'],body:init.body});const next=outcomes.shift()||{status:201,json:{record:{id:'r1'}}};if(next.throw)throw new TypeError(next.throw);return {ok:next.status<400,status:next.status,json:async()=>next.json};};t.after(()=>{globalThis.fetch=original;});return sent;}
function harness(path,resolve,props){let index=0;const state=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef(initial){const i=index++;return state[i]??={current:initial};},useId(){index++;return 'test';}};
 const component=compile(path,id=>id==='react'?mock:id==='react/jsx-runtime'?jsxRuntime:id==='../api'?client:resolve(id)).default;return {props,render(){index=0;return component(props);}};}

test('api sends a fresh key on every mutating call, honours an explicit key and sends none for reads',async t=>{
 const sent=network(t,[{status:200,json:{}},{status:201,json:{}},{status:201,json:{}},{status:200,json:{}},{status:201,json:{}}]);
 await client.api('/workspace');await client.api('/records/gifts',{method:'POST',body:{a:1}});await client.api('/records/gifts',{method:'POST',body:{a:1}});await client.api('/records/gifts/x',{method:'DELETE'});
 assert.equal(sent[0].key,undefined);assert.match(sent[1].key,UUID);assert.match(sent[2].key,UUID);assert.notEqual(sent[1].key,sent[2].key);assert.match(sent[3].key,UUID);
 await client.api('/gifts/import',{method:'POST',body:{rows:[]},idempotencyKey:'caller-chosen'});assert.equal(sent[4].key,'caller-chosen');
});

test('a pending form key reaches only the first mutating request of that save, and server codes surface on errors',async t=>{
 const sent=network(t,[{status:201,json:{}},{status:201,json:{}},{status:422,json:{error:'reused',code:'IDEMPOTENCY_KEY_REUSED'}}]);
 await client.withIdempotencyKey('form-key',async()=>{const first=client.api('/records/gifts',{method:'POST',body:{}});const second=client.api('/records/gifts',{method:'POST',body:{}});await Promise.all([first,second]);});
 assert.equal(sent[0].key,'form-key');assert.notEqual(sent[1].key,'form-key');assert.equal(globalThis[client.PENDING_IDEMPOTENCY_KEY],undefined);
 const error=await client.api('/records/gifts',{method:'POST',body:{}}).catch(e=>e);assert.equal(error.status,422);assert.equal(error.code,'IDEMPOTENCY_KEY_REUSED');
 assert.equal(client.rejectedWithoutEffect(error),false);assert.equal(client.rejectedWithoutEffect({status:400}),true);assert.equal(client.rejectedWithoutEffect({status:409}),false);assert.equal(client.rejectedWithoutEffect(new TypeError('offline')),false);
});

test('GiftForm keeps one key across a double submit and an uncertain retry, and replaces it only after a successful save',async t=>{
 const sent=network(t,[{throw:'connection lost'},{status:409,json:{error:'still running',code:'IDEMPOTENCY_IN_PROGRESS'}},{status:201,json:{record:{id:'g1'}}},{status:201,json:{record:{id:'g2'}}}]);
 let saves=0;const h=harness('../src/components/GiftForm.jsx',id=>id==='../schema'?schema:id==='../lib'?lib:stubs,{data:{designations:[{id:'f1',name:'Fund'}],constituents:[]},settings:{fiscalStartMonth:7},onDirty(){},onCancel(){},onReload(){},
  onSave:async(payload,options)=>{saves++;assert.match(options.idempotencyKey,UUID);return client.api('/records/gifts',{method:'POST',body:payload});}});
 find(h.render(),e=>e.props?.field?.key==='amount').props.onChange('25.00');
 await submit(h.render());assert.match(alertText(h.render()),/could not be confirmed/);assert.doesNotMatch(alertText(h.render()),/has not been saved/);
 await submit(h.render());assert.match(alertText(h.render()),/could not be confirmed/);
 await submit(h.render());
 assert.equal(sent.length,3);assert.equal(sent[1].key,sent[0].key);assert.equal(sent[2].key,sent[0].key,'the retry after an uncertain outcome collapses on the server');
 await submit(h.render());assert.notEqual(sent[3].key,sent[0].key,'a genuinely new gift after a successful save gets a new key');assert.equal(saves,4);
 // Two submissions before the first settles send one request: the form refuses while saving.
 const pending=network(t,[]);const first=submit(h.render());const second=submit(h.render());await Promise.all([first,second]);assert.equal(pending.length,1);
});

test('GiftForm starts a fresh key after a definitive server validation rejection',async t=>{
 const sent=network(t,[{status:400,json:{error:'Invalid input'}},{status:201,json:{record:{id:'g1'}}}]);
 const h=harness('../src/components/GiftForm.jsx',id=>id==='../schema'?schema:id==='../lib'?lib:stubs,{data:{designations:[{id:'f1',name:'Fund'}],constituents:[]},settings:{fiscalStartMonth:7},onDirty(){},onCancel(){},onReload(){},onSave:payload=>client.api('/records/gifts',{method:'POST',body:payload})});
 find(h.render(),e=>e.props?.field?.key==='amount').props.onChange('25.00');
 await submit(h.render());assert.match(alertText(h.render()),/has not been saved/);
 await submit(h.render());assert.equal(sent.length,2);assert.notEqual(sent[1].key,sent[0].key);
});

test('RecordForm pins one key per instance through App-style saves that ignore the second argument',async t=>{
 const sent=network(t,[{throw:'connection lost'},{status:201,json:{record:{id:'c1'}}},{status:201,json:{record:{id:'c2'}}}]);
 const h=harness('../src/components/RecordForm.jsx',id=>id==='../schema'?schema:id==='../lib'?lib:id.includes('constituentTypes')?categories:stubs,{collection:'constituents',data:{constituents:[]},onDirty(){},onCancel(){},onSave:payload=>client.api('/records/constituents',{method:'POST',body:payload})});
 await submit(h.render());assert.match(alertText(h.render()),/could not be confirmed/);
 await submit(h.render());await submit(h.render());
 assert.equal(sent[1].key,sent[0].key);assert.notEqual(sent[2].key,sent[1].key);
});

test('ImportGifts sends one key for a retried import and a new one after success',async t=>{
 const sent=network(t,[{throw:'connection lost'},{status:201,json:{imported:1}}]);const raf=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=()=>0;t.after(()=>{globalThis.requestAnimationFrame=raf;});
 let closed=0;const h=harness('../src/features/ImportGifts.jsx',id=>id==='../schema'?schema:id==='../lib'?lib:stubs,{data:{constituents:[{id:'d1',name:'Donor',email:'donor@example.test'}],designations:[{id:'f1',name:'Fund',accountCode:'F-1'}],campaigns:[],gifts:[]},onClose:()=>closed++,
  onImport:rows=>client.api('/gifts/import',{method:'POST',body:{rows}})});
 find(h.render(),e=>e.type==='textarea').props.onChange({target:{value:'donorEmail,amount,type,method,date,designationCode,campaignName,externalRef\ndonor@example.test,25.00,Cash,Check,2026-09-01,F-1,,'}});
 submit(h.render());
 const importButton=()=>find(h.render(),e=>e.type==='button'&&/^Import 1 gift$/.test(texts(e).trim()));
 await importButton().props.onClick();assert.equal(closed,0);assert.match(JSON.stringify(h.render()),/will not save it twice/);
 await importButton().props.onClick();assert.equal(closed,1);
 assert.equal(sent.length,2);assert.equal(sent[1].key,sent[0].key);assert.equal(sent[0].body,sent[1].body);
 await importButton().props.onClick();assert.notEqual(sent[2].key,sent[0].key);
});
