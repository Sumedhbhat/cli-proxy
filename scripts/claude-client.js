#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { restoreProxyReset } from '../src/claude-compat.js';

const args = process.argv.slice(2);
const streaming = args.some((a, i) => a === '--output-format=stream-json' || a === '--output-format' && args[i + 1] === 'stream-json');
const child = spawn(process.env.CLI_PROXY_CLAUDE_BINARY || join(homedir(), '.local/bin/claude'), args, { stdio: ['inherit', streaming ? 'pipe' : 'inherit', 'inherit'] });
if (streaming) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const convert = line => {
    try { const frame = JSON.parse(line); const restored = restoreProxyReset(frame); return restored === frame ? line : JSON.stringify(restored); }
    catch { return line; }
  };
  child.stdout.pipe(new Transform({
    transform(chunk, encoding, done) {
      pending += decoder.write(chunk);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        this.push(convert(pending.slice(0, index)) + '\n');
        pending = pending.slice(index + 1);
      }
      done();
    },
    flush(done) { pending += decoder.end(); if (pending) this.push(convert(pending)); done(); },
  })).pipe(process.stdout);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1; });
