import { createApp } from './app.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evaluator=process.env.EVALUATOR_MODE==='true';
const port=Number(process.env.PORT||(evaluator?4321:4311));
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer between 1 and 65535.');
const host=evaluator?'127.0.0.1':process.env.APP_HOST||'127.0.0.1';
const built=process.env.NODE_ENV==='production'||evaluator;
if(built&&!existsSync(resolve(root,'dist/index.html')))throw new Error('Built frontend missing. Run npm run build before starting the built application.');
const app=createApp({dbPath:process.env.DB_PATH||resolve(root,evaluator?'server/data/evaluator.sqlite':'server/data/foundation.sqlite'),seed:evaluator||process.env.NODE_ENV!=='production'||process.env.ALLOW_DEMO==='true'});
if(built){app.use(express.static(resolve(root,'dist')));app.get('/{*path}',(req,res)=>res.sendFile(resolve(root,'dist/index.html')));}
const server=app.listen(port,host,()=>{console.log(`Kinflect ${evaluator?'local evaluator':'application'}: http://${host}:${port}`);if(evaluator)console.log('Synthetic demo only. Changes persist in the separate evaluator database. Press Ctrl+C to stop.');});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Set PORT to another local port and restart.`:'Unable to start Kinflect: '+error.message);app.locals.close();process.exitCode=1;});
let closing=false;const shutdown=()=>{if(closing)return;closing=true;server.close(()=>{app.locals.close();process.exit(0);});};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
