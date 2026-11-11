// A workspace server in its own process, so two processes can write to one database at
// the same time. Not a test file. Prints {"port":N} once listening; exits on SIGTERM.
//   WIMBLO_TEST_DB_PATH=/tmp/x/workspace.sqlite node tests/workspace-process.js
// For PostgreSQL, run it with --import ./tests/postgres/harness/preload.mjs.
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const app=createApp({dbPath:process.env.WIMBLO_TEST_DB_PATH,seed:true,reminderWorker:false,workflowWorker:false});
const server=app.listen(0,'127.0.0.1');
await once(server,'listening');
process.stdout.write(JSON.stringify({port:server.address().port})+'\n');
process.once('SIGTERM',()=>server.close(()=>{app.locals.close();process.exit(0);}));
