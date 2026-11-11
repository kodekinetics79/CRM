import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {configureHttpTimeouts,HTTP_TIMEOUT_DEFAULTS} from '../server/httpTimeouts.js';

test('production defaults exceed a typical proxy idle timeout and keep headersTimeout above keepAliveTimeout',()=>{
 const server=createServer();
 assert.equal(server.keepAliveTimeout,5000,'Node default, the value that let an idle socket be cut under a long synchronous block');
 const applied=configureHttpTimeouts(server);
 assert.deepEqual(applied,{keepAliveTimeout:65_000,headersTimeout:66_000});
 assert.equal(server.keepAliveTimeout,HTTP_TIMEOUT_DEFAULTS.keepAliveTimeout);
 assert.equal(server.headersTimeout,HTTP_TIMEOUT_DEFAULTS.headersTimeout);
 assert.ok(server.keepAliveTimeout>60_000,'must outlast a 60 s proxy upstream idle timeout');
 assert.ok(server.headersTimeout>server.keepAliveTimeout);
});

test('an unsafe or inverted configuration is refused rather than applied',()=>{
 const server=createServer();
 assert.throws(()=>configureHttpTimeouts(server,{keepAliveTimeout:65_000,headersTimeout:65_000}),/headersTimeout must exceed keepAliveTimeout/);
 assert.throws(()=>configureHttpTimeouts(server,{keepAliveTimeout:0}),/positive integer/);
 assert.throws(()=>configureHttpTimeouts(server,{headersTimeout:1.5}),/positive integer/);
 assert.throws(()=>configureHttpTimeouts(null),/HTTP server is required/);
 assert.equal(server.keepAliveTimeout,5000,'a refused configuration must leave the server unchanged');
});

test('an idle keep-alive socket survives an event-loop block longer than Node’s default timeout',async t=>{
 // A scaled-down replica of the measured failure: a client keeps a socket idle while the
 // server's loop is blocked past the keep-alive timeout, then reuses it.
 const server=createServer((req,res)=>res.end('ok'));
 configureHttpTimeouts(server,{keepAliveTimeout:1500,headersTimeout:1600});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/`;
 assert.equal(await (await fetch(url)).text(),'ok');
 const until=Date.now()+900;while(Date.now()<until){}   // synchronous block shorter than the configured timeout
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(await (await fetch(url)).text(),'ok','the reused idle socket must still be open');
});
