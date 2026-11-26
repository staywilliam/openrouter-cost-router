#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGateway, httpServer } from './gateway.mjs';
import { fingerprint, openHistory } from './history.mjs';

const PROVIDER = 'openrouter-cost-router';
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const HELP = `Usage
  node cli.mjs codex [Codex arguments]
  node cli.mjs serve [port]

Required environment variable
  OPENROUTER_API_KEY

Optional environment variables
  OPENROUTER_ROUTER_MODEL             Initial model for the Codex launcher
  OPENROUTER_ROUTER_WINDOW            Recent requests sampled per model (default 40)
  OPENROUTER_ROUTER_MAX_CACHE_READ    Maximum cache-read dollars per million tokens
  OPENROUTER_ROUTER_FALLBACK_RATIO    Maximum fallback estimate / best estimate (default 1)
  OPENROUTER_ROUTER_IGNORE            Comma-separated provider or endpoint slugs
  OPENROUTER_ROUTER_DB                Path to the local usage database
`;

function numberEnv(name, fallback, valid) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !valid(value)) throw new Error(`Invalid value for ${name}.`);
  return value;
}

function codexArgs(url, args) {
  const settings = {
    model: process.env.OPENROUTER_ROUTER_MODEL || DEFAULT_MODEL,
    model_provider: PROVIDER,
    [`model_providers.${PROVIDER}.name`]: 'OpenRouter Cost Router',
    [`model_providers.${PROVIDER}.base_url`]: `${url}/v1`,
    [`model_providers.${PROVIDER}.model_catalog_url`]: `${url}/v1/models`,
    [`model_providers.${PROVIDER}.wire_api`]: 'responses',
    [`model_providers.${PROVIDER}.env_key`]: 'OPENROUTER_API_KEY',
    [`model_providers.${PROVIDER}.supports_websockets`]: false,
    'features.api_key_model_discovery': true,
  };
  return [...Object.entries(settings).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`]), ...args];
}

async function runCodex(url, args, apiKey) {
  const child = spawn('codex', codexArgs(url, args), {
    stdio: 'inherit', env: { ...process.env, OPENROUTER_API_KEY: apiKey },
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await once(child, 'exit');
    return code ?? (signal === 'SIGINT' ? 130 : 1);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function waitForShutdown() {
  return new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function main([command = 'codex', ...args]) {
  if (command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (!['codex', 'serve'].includes(command) || command === 'serve' && args.length > 1) {
    throw new Error(HELP);
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY to your OpenRouter inference key before starting.');

  const port = command === 'serve' ? Number(args[0] ?? 17863) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port number.');
  const options = {
    window: numberEnv('OPENROUTER_ROUTER_WINDOW', 40, value => Number.isSafeInteger(value) && value >= 1),
    maxCacheRead: numberEnv('OPENROUTER_ROUTER_MAX_CACHE_READ', undefined, value => value >= 0),
    fallbackRatio: numberEnv('OPENROUTER_ROUTER_FALLBACK_RATIO', 1, value => value >= 1),
    ignore: (process.env.OPENROUTER_ROUTER_IGNORE ?? '').split(',').map(value => value.trim()).filter(Boolean),
  };
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const databasePath = resolve(process.env.OPENROUTER_ROUTER_DB || join(stateRoot, PROVIDER, 'usage.sqlite'));
  const history = openHistory(databasePath, fingerprint(apiKey));
  const server = httpServer(createGateway({ apiKey, history, options }));
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    console.error(`OpenRouter Cost Router listening on ${url}`);
    if (command === 'serve') await waitForShutdown();
    else process.exitCode = await runCodex(url, args, apiKey);
  } finally {
    server.close();
    server.closeAllConnections();
    history.close();
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
