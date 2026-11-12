const URL_PATTERN=/\b(?:postgres(?:ql)?|https?):\/\/[^\s)\],]+/gi;
const SENSITIVE_KEY=/(?:SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL|PG_URL|ENDPOINT)/i;

export function redactCertificationDiagnostic(value,env=process.env){
 let output=String(value??'').replace(URL_PATTERN,'[redacted configured target]');
 const secrets=new Set();
 for(const [key,raw] of Object.entries(env)){if(!SENSITIVE_KEY.test(key)||typeof raw!=='string'||raw.length<4)continue;secrets.add(raw);try{const parsed=new URL(raw);for(const part of [parsed.username,parsed.password,parsed.pathname.replace(/^\//,''),parsed.host])if(part.length>=4)secrets.add(decodeURIComponent(part));}catch{}}
 for(const secret of [...secrets].sort((a,b)=>b.length-a.length)){output=output.replaceAll(secret,'[redacted]');const encoded=encodeURIComponent(secret);if(encoded!==secret)output=output.replaceAll(encoded,'[redacted]');}
 return output;
}
