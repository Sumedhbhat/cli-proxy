import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the running installation independent of a checkout or a T3 session.
const source = fileURLToPath(new URL('../', import.meta.url));
const destination = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'cli-proxy');
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
const dataDir = join(destination, '.local');
const systemctl = args => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
async function exists(path) { try { await access(path); return true; } catch { return false; } }

if (process.platform !== 'linux') throw new Error('Persistent services require Linux with systemd user services.');
await access(join(source, '.env'));
await access(join(source, '.local/cli-proxy-api'));
execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
// Start this user's service manager at boot, including while the desktop is signed out.
execFileSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'inherit' });
const lingering = execFileSync('loginctl', ['show-user', userInfo().username, '--property=Linger', '--value'], { encoding: 'utf8' }).trim();
if (lingering !== 'yes') throw new Error('Could not enable startup before desktop sign-in');
await mkdir(destination, { recursive: true, mode: 0o700 });
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(unitDir, { recursive: true });

const consoleUnit = join(unitDir, 'cli-proxy-console.service');
const engineUnit = join(unitDir, 'cli-proxy-engine.service');
const updating = await exists(consoleUnit);
if (updating) {
  for (const unit of ['cli-proxy-console.service', 'cli-proxy-engine.service']) {
    let active = false;
    try { execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit]); active = true; } catch {}
    if (active) systemctl(['stop', unit]);
  }
}

if (resolve(source) !== resolve(destination)) {
  for (const path of ['src', 'public', 'scripts', 'docs', 'README.md', 'package.json']) await cp(join(source, path), join(destination, path), { recursive: true });
  // Preserve the deployed credentials and keys when installing a UI update.
  if (!await exists(join(destination, '.env'))) await cp(join(source, '.env'), join(destination, '.env'));
  if (!await exists(join(dataDir, 'engine.yaml'))) {
    const original = await readFile(join(source, '.local/engine.yaml'), 'utf8');
    if (!/^auth-dir:/m.test(original)) throw new Error('Expected legacy auth-dir setting in engine configuration');
    await writeFile(join(dataDir, 'engine.yaml'), original.replace(/^auth-dir:.*$/m, `auth-dir: ${JSON.stringify(join(dataDir, 'auth'))}`), { mode: 0o600 });
    for (const path of ['auth', 'settings.json', 'priorities-backup.json']) {
      if (await exists(join(source, '.local', path))) await cp(join(source, '.local', path), join(dataDir, path), { recursive: true });
    }
  }
  for (const path of ['cli-proxy-api', 'engine-version']) await cp(join(source, '.local', path), join(dataDir, path));
}
await chmod(join(destination, '.env'), 0o600);
await chmod(join(dataDir, 'engine.yaml'), 0o600);
await chmod(join(dataDir, 'cli-proxy-api'), 0o700);

const common = 'Restart=always\nRestartSec=3\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n';
await writeFile(engineUnit, `[Unit]\nDescription=CLI Proxy authentication and inference engine\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${dataDir.replaceAll('%', '%%')}\nExecStart=${quote(join(dataDir, 'cli-proxy-api'))} -config ${quote(join(dataDir, 'engine.yaml'))}\n${common}`);
await writeFile(consoleUnit, `[Unit]\nDescription=CLI Proxy console and quota scheduler\nAfter=cli-proxy-engine.service\nWants=cli-proxy-engine.service\n\n[Service]\nWorkingDirectory=${destination.replaceAll('%', '%%')}\nExecStart=${quote(process.execPath)} ${quote(`--env-file=${join(destination, '.env')}`)} ${quote(join(destination, 'src/server.js'))}\n${common}`);
systemctl(['daemon-reload']);
systemctl(['enable', '--now', 'cli-proxy-engine.service', 'cli-proxy-console.service']);
console.log(`Persistent installation: ${destination}`);
console.log('Services: cli-proxy-engine.service and cli-proxy-console.service');
console.log('Startup before desktop sign-in is enabled (systemd user lingering).');
