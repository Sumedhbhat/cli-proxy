import { mkdir, readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local');
const version = '8.0.23'; // Published 2026-10-09; satisfies the 14-day policy as of 2026-10-24.
const platforms = { linux: 'linux', darwin: 'darwin' };
const architectures = { x64: 'amd64', arm64: 'aarch64' };
if (!platforms[platform()] || !architectures[arch()]) throw new Error('Automatic setup supports Linux/macOS x64/arm64. Set ENGINE_URL for an existing engine.');
await mkdir(local, { recursive: true, mode: 0o700 });
await mkdir(join(local, 'auth'), { recursive: true, mode: 0o700 });
const release = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}`;
const asset = `CLIProxyAPI_${version}_${platforms[platform()]}_${architectures[arch()]}.tar.gz`;
async function download(url) { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`Download returned HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
let installed = false;
try { installed = (await readFile(join(local, 'engine-version'), 'utf8')).trim() === version; } catch {}
if (!installed) {
  console.log(`Downloading CLIProxyAPI v${version} and verifying its SHA-256 checksum…`);
  const [archive, sums] = await Promise.all([download(`${release}/${asset}`), download(`${release}/checksums.txt`)]);
  const expected = sums.toString().split('\n').find(line => line.trim().endsWith(asset))?.trim().split(/\s+/)[0];
  if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Engine checksum verification failed');
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-install-'));
  try {
    const archivePath = join(dir, 'engine.tar.gz'); await writeFile(archivePath, archive);
    execFileSync('tar', ['-xzf', archivePath, '-C', dir]);
    const { readdir } = await import('node:fs/promises');
    const binary = (await readdir(dir)).find(name => /^(cli-proxy-api|CLIProxyAPI|cliproxyapi)$/.test(name));
    if (!binary) throw new Error('Expected engine binary missing from release archive');
    await writeFile(join(local, 'cli-proxy-api'), await readFile(join(dir, binary)), { mode: 0o700 });
    await chmod(join(local, 'cli-proxy-api'), 0o700);
    await writeFile(join(local, 'engine-version'), version);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
let exists = false; try { await readFile(join(root, '.env')); exists = true; } catch {}
if (!exists) {
  const key = () => randomBytes(32).toString('hex');
  const management = key(), apiKey = key();
  const env = `PORT=8318\nENGINE_URL=http://127.0.0.1:8317\nENGINE_MANAGEMENT_KEY=${management}\nPROXY_API_KEY=${apiKey}\n`;
  await writeFile(join(root, '.env'), env, { mode: 0o600 });
  // Legacy layout is supported by v8 and keeps compatibility with existing instances.
  const config = `host: "127.0.0.1"\nport: 8317\nauth-dir: ${JSON.stringify(join(local, 'auth'))}\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(management)}\n  disable-control-panel: true\napi-keys:\n  - ${JSON.stringify(apiKey)}\nrouting:\n  strategy: fill-first\n  session-affinity: true\n  session-affinity-ttl: 1h\n  session-affinity-rebind-on: quota\nws-auth: true\nrequest-retry: 2\nlogging-to-file: false\nusage-statistics-enabled: false\n`;
  await writeFile(join(local, 'engine.yaml'), config, { mode: 0o600 });
  await writeFile(join(local, 'settings.json'), JSON.stringify({ scheduler: true, intervalSeconds: 60 }), { mode: 0o600 });
}
console.log('Setup complete. Secrets are in .env (owner-readable only). Existing configuration was preserved.');
console.log('Start the engine: npm run engine\nStart the console in another terminal: npm start\nOpen http://127.0.0.1:8318. Dashboard access is controlled by your local machine and Tailscale.');
