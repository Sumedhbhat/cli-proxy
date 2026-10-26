import { readFile, writeFile, mkdir, copyFile, chmod, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const home = homedir();
const installation = join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'cli-proxy');
const baseURL = (process.argv[2] || 'http://127.0.0.1:8318').replace(/\/$/, '');
const gateway = new URL(baseURL);
if (!['http:', 'https:'].includes(gateway.protocol)) throw new Error('Expected an HTTP(S) gateway URL');
// The clients send the proxy key as a bearer token; plain HTTP may only stay on this host.
const loopback = gateway.hostname === 'localhost' || gateway.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(gateway.hostname);
if (gateway.protocol === 'http:' && !loopback) throw new Error('Use an https:// gateway URL for a remote gateway');
const deployedEnv = join(installation, '.env');
let envPath = deployedEnv;
try { await access(envPath); } catch { envPath = fileURLToPath(new URL('../.env', import.meta.url)); }
if (!parseEnv(await readFile(envPath, 'utf8')).PROXY_API_KEY) throw new Error('The proxy API key is missing; run setup first');
await mkdir(installation, { recursive: true, mode: 0o700 });
const backup = join(installation, 'client-config-backups', new Date().toISOString().replaceAll(':', '-'));
await mkdir(backup, { recursive: true, mode: 0o700 });

const helper = join(installation, 'client-api-key.cjs');
await writeFile(helper, `#!${process.execPath}\nconst { readFileSync } = require('node:fs');\nconst { parseEnv } = require('node:util');\nconst key = parseEnv(readFileSync(${JSON.stringify(envPath)}, 'utf8')).PROXY_API_KEY;\nif (!key) throw new Error('Proxy API key is missing');\nprocess.stdout.write(key);\n`, { mode: 0o700 });
await chmod(helper, 0o700);

const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
await mkdir(codexHome, { recursive: true });
await mkdir(claudeHome, { recursive: true });
async function readAndBackup(path, name) {
  try { const value = await readFile(path, 'utf8'); await copyFile(path, join(backup, name)); await chmod(join(backup, name), 0o600); return value; }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

const codexPath = join(codexHome, 'config.toml');
let codex = await readAndBackup(codexPath, 'codex-config.toml');
const lines = codex.split('\n');
let skipping = false;
codex = lines.filter(line => {
  if (/^\s*\[/.test(line)) skipping = /^\s*\[model_providers\.cli_proxy(?:\.auth)?\]\s*(?:#.*)?$/.test(line);
  return !skipping;
}).join('\n');
const firstSection = codex.search(/^\s*\[/m);
let root = firstSection < 0 ? codex : codex.slice(0, firstSection);
const sections = firstSection < 0 ? '' : codex.slice(firstSection);
root = /^model_provider\s*=/m.test(root) ? root.replace(/^model_provider\s*=.*$/m, 'model_provider = "cli_proxy"') : `model_provider = "cli_proxy"\n${root}`;
codex = `${root}${sections}\n\n[model_providers.cli_proxy]\nname = "CLI Proxy"\nbase_url = ${JSON.stringify(`${baseURL}/v1`)}\nwire_api = "responses"\nsupports_websockets = true\n\n[model_providers.cli_proxy.auth]\ncommand = ${JSON.stringify(helper)}\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
await writeFile(codexPath, codex, { mode: 0o600 });

const claudePath = join(claudeHome, 'settings.json');
const originalClaude = await readAndBackup(claudePath, 'claude-settings.json');
const claude = originalClaude ? JSON.parse(originalClaude) : {};
claude.env = { ...claude.env, ANTHROPIC_BASE_URL: baseURL };
// The helper supplies both authorization headers; remove conflicting static keys from this settings file.
delete claude.env.ANTHROPIC_AUTH_TOKEN;
delete claude.env.ANTHROPIC_API_KEY;
claude.apiKeyHelper = JSON.stringify(helper);
await writeFile(claudePath, `${JSON.stringify(claude, null, 2)}\n`, { mode: 0o600 });
console.log(`Configured Codex and Claude Code to use ${baseURL}`);
console.log(`Original settings backed up in ${backup}`);
console.log('Credentials are read privately from the proxy installation. Restart existing CLI sessions to apply the new settings.');
