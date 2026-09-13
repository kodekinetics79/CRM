import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {marketingConfigFromEnv,validateMarketingConfig,createMailchimpReadAdapter,normalizeMailchimpMember,normalizeMailchimpReport} from '../server/mailchimp.js';

const config=()=>({mode:'TEST_ONLY',access:'READ_ONLY',serverPrefix:'us1',apiKey:'a'.repeat(32)+'-us1',listId:'list123',webhookSecret:'SYNTHETIC_WEBHOOK_SIGNING_ONLY_QA_2026'});
test('environment enablement requires explicit test workspace and fixed official server credentials; fixture escape is not an environment capability',()=>{
 assert.equal(marketingConfigFromEnv({}),null);
 const env={MARKETING_RESPONSES_MODE:'TEST_ONLY',MARKETING_RESPONSES_ACCESS:'READ_ONLY',MARKETING_RESPONSES_TENANT_ID:randomUUID(),MAILCHIMP_SERVER_PREFIX:'us1',MAILCHIMP_API_KEY:config().apiKey,MAILCHIMP_LIST_ID:'list123',MAILCHIMP_WEBHOOK_SECRET:config().webhookSecret};
 assert.equal(marketingConfigFromEnv(env).tenantId,env.MARKETING_RESPONSES_TENANT_ID);
 for(const change of [{NODE_ENV:'production'},{MARKETING_RESPONSES_ACCESS:'WRITE'},{MARKETING_RESPONSES_TENANT_ID:''},{MAILCHIMP_SERVER_PREFIX:'evil.example'},{MAILCHIMP_API_KEY:'FAKE_QA'},{MAILCHIMP_LIST_ID:'../foreign'},{MAILCHIMP_WEBHOOK_SECRET:'short'}])assert.throws(()=>marketingConfigFromEnv({...env,...change}));
 assert.doesNotThrow(()=>validateMarketingConfig({...config(),apiKey:'FAKE_QA',adapter:{}}));
});

test('native read adapter issues only fixed-host GET, rejects redirects, and bounds both remote body and malformed identity without an actual provider call',async()=>{
 const saved=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response('{"fixture":true}');};
 try{const adapter=createMailchimpReadAdapter(config()),id='b'.repeat(32);assert.deepEqual(await adapter.getMember(id),{fixture:true});await adapter.getCampaignReport('campaign123');assert.equal(calls[0].url,'https://us1.api.mailchimp.com/3.0/lists/list123/members/'+id);assert.equal(calls[1].url,'https://us1.api.mailchimp.com/3.0/reports/campaign123');for(const c of calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');assert.ok(c.options.signal instanceof AbortSignal);assert.equal(c.options.body,undefined);}assert.throws(()=>adapter.getMember('../foreign'));assert.throws(()=>adapter.getCampaignReport('../foreign'));assert.equal(calls.length,2);
 globalThis.fetch=async()=>new Response(new Uint8Array(2097153));await assert.rejects(adapter.getMember(id),/bounded response/);
 globalThis.fetch=async()=>new Response('not json');await assert.rejects(adapter.getMember(id),/bounded response/);
 globalThis.fetch=async()=>new Response('{}',{status:302});await assert.rejects(adapter.getMember(id),/retrieval rejected/);
 }finally{globalThis.fetch=saved;}
});

test('member parser preserves separate canonical API and legacy callback identities and rejects unknown consent states',()=>{
 const id='b'.repeat(32),raw={id,email_address:'Actual@Example.test',list_id:'list123',status:'subscribed',last_changed:'2026-09-01T12:00:00Z',unique_email_id:'opaque1234',unrelated:{private:'discarded'}};
 const n=normalizeMailchimpMember(raw,'list123',id,'actual@example.test');assert.equal(n.memberId,id);assert.equal(n.callbackMemberId,'opaque1234');assert.equal(n.canonicalEmail,'actual@example.test');assert.equal(n.unrelated,undefined);
 for(const change of [{id:'opaque1234'},{list_id:'foreign'},{email_address:'secondary@example.test'},{status:'opted_in'},{last_changed:'2026-09-01 12:00:00'}])assert.throws(()=>normalizeMailchimpMember({...raw,...change},'list123',id,'actual@example.test'));
});

test('report parser preserves replacement totals in exact units and fails inconsistent or fractional provider counts',()=>{
 const raw={id:'campaign123',list_id:'list123',send_time:'2026-09-01T12:00:00Z',emails_sent:100,bounces:{hard_bounces:2,soft_bounces:3},unsubscribed:4,opens:{unique_opens:40},clicks:{unique_subscriber_clicks:10}};
 assert.equal(normalizeMailchimpReport(raw,'list123','campaign123').emailsSent,100);assert.equal(normalizeMailchimpReport({...raw,emails_sent:110},'list123','campaign123').emailsSent,110);
 for(const change of [{list_id:'foreign'},{emails_sent:0},{unsubscribed:101},{opens:{unique_opens:101}},{clicks:{unique_subscriber_clicks:0.5}},{bounces:{hard_bounces:60,soft_bounces:60}}])assert.throws(()=>normalizeMailchimpReport({...raw,...change},'list123','campaign123'));
});
