import {z} from 'zod';

const opaque=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),prefix=z.string().regex(/^us[1-9][0-9]{0,3}$/),date=z.iso.datetime({offset:true});
const fail=(message)=>{throw Object.assign(new Error(message),{status:502});};
export function marketingConfigFromEnv(env=process.env){
 if(!env.MARKETING_RESPONSES_MODE)return null;
 if(env.NODE_ENV==='production'||env.MARKETING_RESPONSES_MODE!=='TEST_ONLY'||env.MARKETING_RESPONSES_ACCESS!=='READ_ONLY')throw new Error('Marketing responses require nonproduction TEST_ONLY READ_ONLY mode');
 if(!z.uuid().safeParse(env.MARKETING_RESPONSES_TENANT_ID).success)throw new Error('Marketing responses require an explicit test workspace UUID');
 const config={mode:'TEST_ONLY',access:'READ_ONLY',tenantId:env.MARKETING_RESPONSES_TENANT_ID,serverPrefix:env.MAILCHIMP_SERVER_PREFIX,apiKey:env.MAILCHIMP_API_KEY,listId:env.MAILCHIMP_LIST_ID,webhookSecret:env.MAILCHIMP_WEBHOOK_SECRET};validateMarketingConfig(config);return config;
}
export function validateMarketingConfig(config){
 if(!config)return;
 if(process.env.NODE_ENV==='production'||config.mode!=='TEST_ONLY'||config.access!=='READ_ONLY')throw new Error('Marketing responses cannot enable outside nonproduction TEST_ONLY READ_ONLY mode');
 if(!prefix.safeParse(config.serverPrefix).success||!opaque.safeParse(config.listId).success||!(config.adapter&&config.apiKey==='FAKE_QA')&&!new RegExp('^[a-f0-9]{32}-'+config.serverPrefix+'$').test(config.apiKey||'')||typeof config.webhookSecret!=='string'||!/^[\x21-\x7e]{32,512}$/.test(config.webhookSecret))throw new Error('Marketing responses require explicit official server, audience and server-only credentials');
}
export function createMailchimpReadAdapter(config){
 validateMarketingConfig(config);
 async function read(path){let response;try{response=await fetch('https://'+config.serverPrefix+'.api.mailchimp.com/3.0'+path,{method:'GET',headers:{Authorization:'Basic '+Buffer.from('wimblo:'+config.apiKey).toString('base64'),Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('Mailchimp read-only retrieval unavailable');}if(!response.ok){await response.body?.cancel();fail('Mailchimp read-only retrieval rejected');}let length=0;const chunks=[];try{for await(const chunk of response.body){length+=chunk.length;if(length>2097152)fail('Mailchimp response exceeds the supported bound');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Mailchimp bounded response is invalid');}}
 return {getMember:memberId=>{if(!/^[a-f0-9]{32}$/.test(memberId))fail('Invalid canonical member identity');return read('/lists/'+opaque.parse(config.listId)+'/members/'+memberId);},getCampaignReport:campaignId=>read('/reports/'+opaque.parse(campaignId))};
}
export function normalizeMailchimpMember(raw,listId,memberId,canonicalEmail){
 const p=z.object({id:z.string().regex(/^[a-f0-9]{32}$/),email_address:z.email().max(254),list_id:opaque,status:z.enum(['subscribed','unsubscribed','cleaned','pending','transactional']),last_changed:date,unique_email_id:opaque.optional()}).parse(raw);
 if(p.id!==memberId||p.list_id!==listId||p.email_address.toLowerCase()!==canonicalEmail)fail('Mailchimp member did not match the explicit native audience identity');
 return {memberId:p.id,canonicalEmail,callbackMemberId:p.unique_email_id||null,listId:p.list_id,providerStatus:p.status,providerChangedAt:p.last_changed};
}
export function normalizeMailchimpReport(raw,listId,campaignId){
 const count=z.number().int().min(0).max(1e9),p=z.object({id:opaque,list_id:opaque,send_time:date,emails_sent:count,bounces:z.object({hard_bounces:count,soft_bounces:count}),unsubscribed:count,opens:z.object({unique_opens:count}),clicks:z.object({unique_subscriber_clicks:count})}).parse(raw);
 if(p.id!==campaignId||p.list_id!==listId||p.bounces.hard_bounces+p.bounces.soft_bounces>p.emails_sent||p.unsubscribed>p.emails_sent||p.opens.unique_opens>p.emails_sent||p.clicks.unique_subscriber_clicks>p.emails_sent)fail('Mailchimp report source or bounded counts did not reconcile');
 return {campaignId:p.id,listId:p.list_id,providerSentAt:p.send_time,emailsSent:p.emails_sent,hardBounces:p.bounces.hard_bounces,softBounces:p.bounces.soft_bounces,unsubscribed:p.unsubscribed,uniqueOpens:p.opens.unique_opens,uniqueClicks:p.clicks.unique_subscriber_clicks};
}
