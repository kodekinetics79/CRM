import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {reminderUtc,localReminderInput} from '../src/reminderTime.js';
test('reminder local time conversion rejects incomplete and nonexistent calendar values',()=>{for(const value of ['','2026-09-13','2026-02-30T10:00','2026-13-13T10:00','2026-09-13T24:00'])assert.throws(()=>reminderUtc(value));assert.match(localReminderInput(new Date()),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);});
test('reminder local conversion respects daylight changes and rejects the spring clock gap',()=>{const source=`import {reminderUtc} from './src/reminderTime.js';let rejected=false;try{reminderUtc('2026-03-08T02:30')}catch{rejected=true}console.log(JSON.stringify({winter:reminderUtc('2026-01-15T10:00'),summer:reminderUtc('2026-07-15T10:00'),rejected}));`;const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TZ:'America/New_York'},encoding:'utf8'}));assert.deepEqual(result,{winter:'2026-01-15T15:00:00.000Z',summer:'2026-07-15T14:00:00.000Z',rejected:true});});
