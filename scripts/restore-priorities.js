import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Engine } from '../src/engine.js';
try { process.loadEnvFile('.env'); } catch {}
if (!process.env.ENGINE_MANAGEMENT_KEY) throw new Error('ENGINE_MANAGEMENT_KEY is required');
const dir=resolve(process.env.DATA_DIR || '.local');
const settings=JSON.parse(await readFile(`${dir}/settings.json`,'utf8'));
if(settings.scheduler) throw new Error('Pause the scheduler in the console, then stop the console before restoring priorities.');
const engine=new Engine({url:process.env.ENGINE_URL||'http://127.0.0.1:8317',key:process.env.ENGINE_MANAGEMENT_KEY});
const backup=JSON.parse(await readFile(`${dir}/priorities-backup.json`,'utf8'));
const accounts=await engine.accounts();let restored=0;
for(const item of backup){const account=accounts.find(a=>a.name===item.name);if(account){await engine.patch(account,{priority:item.priority});restored++;}}
console.log(`Restored original priorities for ${restored} credentials. Scheduler remains paused.`);
