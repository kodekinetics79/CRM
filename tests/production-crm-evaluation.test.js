import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSyntheticEvaluationClient,SYNTHETIC_BASELINE} from '../src/production/syntheticEvaluationClient.js';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function pipelineHarness(){let index=0,state=[],effects=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>state[i]=typeof value==='function'?value(state[i]):value];},useMemo(fn){index++;return fn();},useEffect(fn){index++;effects.push(fn);}};const module={exports:{}},code=transformSync(readFileSync(new URL('../src/production/PipelineBoard.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code;new Function('require','module','exports',code)(()=>mock,module,module.exports);return {render(props){index=0;effects=[];return module.exports.default(props);},effects:()=>effects};}
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const match=find(child,predicate);if(match)return match;}return null;};

test('synthetic evaluation data is deterministic, unmistakable and uses no real customer domains',()=>{
 assert.equal(SYNTHETIC_BASELINE.synthetic,true);
 assert.match(SYNTHETIC_BASELINE.tenant.name,/Synthetic|Evaluation/i);
 const serialized=JSON.stringify(SYNTHETIC_BASELINE);
 assert.match(serialized,/\.example/);
 assert.doesNotMatch(serialized,/@(gmail|outlook|yahoo)\./i);
});

test('synthetic client mutations are resettable to a frozen baseline',async()=>{
 const client=createSyntheticEvaluationClient();
 const before=await client.request('/crm/parties');
 await client.request('/crm/people',{method:'POST',body:{displayName:'Synthetic new contact',firstName:'New',lastName:'Contact'}});
 const changed=await client.request('/crm/parties');
 assert.equal(changed.parties.length,before.parties.length+1);
 await client.reset();
 const reset=await client.request('/crm/parties');
 assert.deepEqual(reset,before);
 assert.equal(client.synthetic,true);
});

test('synthetic stage POST visibly mutates the opportunity before reset restores the baseline',async()=>{
 const client=createSyntheticEvaluationClient(),opportunity=SYNTHETIC_BASELINE.opportunities[0],review=SYNTHETIC_BASELINE.pipelines[0].stages[1];
 await client.request(`/crm/opportunities/${opportunity.opportunityId}/stage`,{method:'POST',body:{stageId:review.stageId,expectedVersion:1}});
 let visible=await client.request('/crm/opportunities?limit=100');
 assert.equal(visible.opportunities[0].stageId,review.stageId);assert.equal(visible.opportunities[0].version,2);
 await client.reset();visible=await client.request('/crm/opportunities?limit=100');
 assert.equal(visible.opportunities[0].stageId,opportunity.stageId);assert.equal(visible.opportunities[0].version,1);
});

test('synthetic saved tasks and notes support bounded lists and exact detail reads',async()=>{
 const client=createSyntheticEvaluationClient(),subjectId=SYNTHETIC_BASELINE.parties[0].partyId,ownerIdentityId=SYNTHETIC_BASELINE.identity.identityId;
 const createdTask=await client.request(`/crm/subjects/${subjectId}/tasks`,{method:'POST',body:{title:'Synthetic follow-up',details:'Private task detail',ownerIdentityId}}),taskList=await client.request(`/crm/subjects/${subjectId}/tasks?limit=50`),taskDetail=await client.request(`/crm/tasks/${createdTask.task.taskId}`);
 assert.equal(taskList.tasks[0].title,'Synthetic follow-up');assert.equal(taskList.tasks[0].details,undefined);assert.equal(taskDetail.task.details,'Private task detail');
 const createdNote=await client.request(`/crm/subjects/${subjectId}/notes`,{method:'POST',body:{title:'Synthetic note',body:'Private note body'}}),noteList=await client.request(`/crm/subjects/${subjectId}/notes?limit=50`),noteDetail=await client.request(`/crm/notes/${createdNote.note.noteId}`);
 assert.equal(noteList.notes[0].title,'Synthetic note');assert.equal(noteList.notes[0].body,undefined);assert.equal(noteDetail.note.body,'Private note body');assert.equal(noteDetail.note.currentRevision,1);
});

test('rendered pipeline shows a stage mutation and a remounted reset clears its visible state',async()=>{
 const client=createSyntheticEvaluationClient(),review=SYNTHETIC_BASELINE.pipelines[0].stages[1],props={client,readOnly:false};let h=pipelineHarness(),tree=h.render(props);h.effects()[0]();await flush();tree=h.render(props);
 let select=find(tree,node=>node.type==='select');select.props.onChange({target:{value:review.stageId}});tree=h.render(props);await find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Move opportunity')).props.onClick();await flush();tree=h.render(props);assert.equal(find(tree,node=>node.type==='select').props.value,review.stageId);assert.match(renderToStaticMarkup(tree),/Synthetic service renewal/);
 await client.reset();h=pipelineHarness();tree=h.render(props);h.effects()[0]();await flush();tree=h.render(props);assert.equal(find(tree,node=>node.type==='select').props.value,SYNTHETIC_BASELINE.opportunities[0].stageId);
});

test('entry mode is build-time only and production source cannot import synthetic fixtures',()=>{
 const main=readFileSync(new URL('../src/main.jsx',import.meta.url),'utf8');
 const production=readFileSync(new URL('../src/production/ProductionApp.jsx',import.meta.url),'utf8');
 assert.match(main,/import\.meta\.env\.VITE_WIMBLO_APP_MODE/);
 assert.doesNotMatch(main,/URLSearchParams|localStorage|sessionStorage/);
 assert.doesNotMatch(production,/syntheticEvaluationClient|SYNTHETIC_BASELINE/);
});
