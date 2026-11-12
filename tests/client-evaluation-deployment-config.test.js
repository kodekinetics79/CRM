import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('client evaluation has an explicit start command and Vercel API proxy',()=>{
 const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 assert.equal(pkg.scripts['start:evaluation'],'NODE_ENV=evaluation node server/index.js');
 const vercel=JSON.parse(readFileSync(resolve(root,'vercel.json'),'utf8'));
 assert.deepEqual(vercel.rewrites,[{source:'/api/:path*',destination:'https://wimblo-crm-evaluator.onrender.com/api/:path*'}]);
 const app=readFileSync(resolve(root,'src/App.jsx'),'utf8');
 assert.match(app,/reset[^<]{0,80}restart/i);
});
