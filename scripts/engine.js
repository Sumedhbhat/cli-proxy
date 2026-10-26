import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../.local/', import.meta.url));
const child = spawn(`${root}cli-proxy-api`, ['-config', `${root}engine.yaml`], { stdio: 'inherit', cwd: root });
child.on('error', e => { console.error(`Engine could not start: ${e.message}. Run npm run setup.`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
