import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fail=message=>{console.error('Kinflect evaluator: '+message);process.exit(1);};
if(Number(process.versions.node.split('.')[0])<24)fail('Node.js 24 or newer is required. Install it, then try again.');
if(!existsSync(resolve(root,'dist/index.html')))fail('The built app is missing. Run npm run build first, then npm run evaluate.');
if(process.env.NODE_ENV==='production')fail('This local demo cannot run with NODE_ENV=production. Unset NODE_ENV and try again.');
if(process.env.APP_HOST&&!['127.0.0.1','localhost','::1'].includes(process.env.APP_HOST))fail('APP_HOST must be a loopback address. This demo cannot be exposed to the network.');
if(process.env.APP_ORIGIN){let origin;try{origin=new URL(process.env.APP_ORIGIN);}catch{fail('APP_ORIGIN must be a loopback HTTP origin or unset.');}if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.origin!==process.env.APP_ORIGIN)fail('APP_ORIGIN must be a loopback HTTP origin or unset.');}
const port=Number(process.env.PORT||4321);if(!Number.isInteger(port)||port<1||port>65535)fail('PORT must be an integer between 1 and 65535.');
process.env.NODE_ENV='development';process.env.EVALUATOR_MODE='true';process.env.APP_HOST='127.0.0.1';process.env.PORT=String(port);process.env.DB_PATH=process.env.DB_PATH||resolve(root,'server/data/evaluator.sqlite');
try{await import('../server/index.js');}catch(error){fail(error.message);}
