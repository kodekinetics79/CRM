import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;};

function harness({ackFailure=false,confirmLocked=false,deferReset=false}={}){
 let index=0,state=[],effects=[],resolveReset;const calls=[],resetResult={recoveryCodes:['ROTATED-RECOVERY-CODE'],recoveryAcknowledgementRequired:true,csrfToken:'new-csrf'},resetPending=deferReset?new Promise(resolve=>{resolveReset=()=>resolve(resetResult);}):null;
 const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useRef(initial){const i=index++;return state[i]??=({current:initial});},useEffect(fn){index++;effects.push(fn);},useMemo(fn){index++;return fn();},lazy(){return()=>null;}};
 const client={synthetic:false,restore:async()=>{throw Object.assign(new Error('signed out'),{status:401});},clear(){},subscribeSession:()=>()=>{},setCsrf(){},async request(path){calls.push(path);if(path==='/auth/login')return {mfaEnrollmentRequired:true,csrfToken:'csrf'};if(path==='/auth/mfa/enroll')return {secret:'ABCDEFGHIJKLMNOP234567',otpauthUrl:'otpauth://setup'};if(path==='/auth/mfa/confirm'){if(confirmLocked)throw Object.assign(new Error('Reproof is required to reset recovery delivery.'),{status:429});return {recoveryCodes:['RECOVERY-CODE-ONE'],recoveryAcknowledgementRequired:true};}if(path==='/auth/mfa/recovery/reset')return resetPending||resetResult;if(path==='/auth/mfa/recovery/ack'){if(ackFailure)throw new Error('Cleanup unavailable');return {ok:true,sessionCleanupConfirmed:true};}throw new Error(path);}};
 const module={exports:{}},source=readFileSync(new URL('../src/production/ProductionApp.jsx',import.meta.url),'utf8'),code=transformSync(source,{loader:'jsx',format:'cjs'}).code;
 const require=id=>id==='react'?mock:id.endsWith('.css')?{}:id==='./productionApi.js'?{__esModule:true,productionApi:client}:{__esModule:true,default:()=>null};
 new Function('require','module','exports',code)(require,module,module.exports);
 const outer=()=>{index=0;effects=[];return module.exports.default({client});};
 const screen=()=>{const shell=outer();return shell.type(shell.props);};
 async function reachConfirm(){outer();effects[0]();await flush();let tree=screen(),inputs=[];const collect=node=>{if(!node||typeof node!=='object')return;if(node.type==='input')inputs.push(node);for(const child of React.Children.toArray(node.props?.children))collect(child);};collect(tree);inputs[0].props.onChange({target:{value:'owner@example.test'}});inputs[1].props.onChange({target:{value:'password'}});tree=screen();await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=screen();await find(tree,node=>node.type==='button').props.onClick();return screen();}
 async function reachRecovery(){let tree=await reachConfirm();find(tree,node=>node.type==='input'&&node.props.autoComplete==='one-time-code').props.onChange({target:{value:'123456'}});tree=screen();await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});return screen();}
 return {reachConfirm,reachRecovery,screen,calls,resolveReset};
}

test('saving recovery codes acknowledges durable delivery before returning to sign-in',async()=>{
 const h=harness(),tree=await h.reachRecovery(),button=find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes('I saved'));
 await button.props.onClick();
 assert.equal(h.calls.at(-1),'/auth/mfa/recovery/ack');
 assert.match(renderToStaticMarkup(h.screen()),/Sign in to Wimblo/);
});

test('failed cleanup keeps the recovery codes visible and reports the truthful state',async()=>{
 const h=harness({ackFailure:true}),tree=await h.reachRecovery(),button=find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes('I saved'));
 await button.props.onClick();
 const html=renderToStaticMarkup(h.screen());
 assert.match(html,/RECOVERY-CODE-ONE/);
 assert.match(html,/Cleanup unavailable/);
});

test('locked pending recovery delivery offers password reproof and shows only newly rotated codes',async()=>{
 const h=harness({confirmLocked:true});let tree=await h.reachConfirm();find(tree,node=>node.type==='input'&&node.props.autoComplete==='one-time-code').props.onChange({target:{value:'123456'}});tree=h.screen();await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=h.screen();
 assert.match(renderToStaticMarkup(tree),/re-enter your password/i);
 find(tree,node=>node.props?.name==='reproofPassword').props.onChange({target:{value:'correct-password'}});tree=h.screen();await find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes('Reset recovery delivery')).props.onClick();
 const html=renderToStaticMarkup(h.screen());assert.match(html,/ROTATED-RECOVERY-CODE/);assert.equal(h.calls.at(-1),'/auth/mfa/recovery/reset');
});

test('sign-in restart cannot race a pending recovery reset or lose the rotated codes',async()=>{
 const h=harness({confirmLocked:true,deferReset:true});let tree=await h.reachConfirm();find(tree,node=>node.type==='input'&&node.props.autoComplete==='one-time-code').props.onChange({target:{value:'123456'}});tree=h.screen();await find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=h.screen();find(tree,node=>node.props?.name==='reproofPassword').props.onChange({target:{value:'correct-password'}});tree=h.screen();const pending=find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes('Reset recovery delivery')).props.onClick();tree=h.screen();
 const restart=find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes('Start sign-in again'));assert.equal(restart.props.disabled,true);restart.props.onClick();assert.match(renderToStaticMarkup(h.screen()),/Reset recovery delivery/);
 h.resolveReset();await pending;assert.match(renderToStaticMarkup(h.screen()),/ROTATED-RECOVERY-CODE/);
});
