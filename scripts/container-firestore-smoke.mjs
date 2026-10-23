#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone Node smoke test, not a Vitest suite.
// Exercise shipped Firestore code without mounting source or node_modules.
// All database traffic stays inside a disposable Docker network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
assert(image, 'usage: node scripts/container-firestore-smoke.mjs <image>');
const emulatorImage = /image:\s*(\S+)/.exec(
  readFileSync(new URL('../compose.firestore.yml', import.meta.url), 'utf8'),
)?.[1];
assert(emulatorImage, 'Missing pinned emulator image');
const suffix = randomUUID().slice(0, 8);
const network = `mcp-smoke-${suffix}`;
const database = `mcp-firestore-${suffix}`;
const app = `mcp-app-${suffix}`;
const secret = randomBytes(32).toString('base64');
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  // Do not echo arguments: they may contain the disposable encryption key.
  assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const remove = (...args) => spawnSync('docker', args, { stdio: 'ignore', timeout: 30000 });
const json = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
};
const ready = async (url) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // Initial container/emulator startup.
    }
    await delay(1000);
  }
  throw new Error('Container readiness timed out');
};
const startApp = (port, base) =>
  docker(
    'run',
    '--detach',
    '--name',
    app,
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--publish',
    `127.0.0.1:${port}:3000`,
    '--env',
    'NODE_ENV=test',
    '--env',
    'FIRESTORE_EMULATOR_HOST=firestore:8085',
    '--env',
    'OAUTH_STORE=firestore://demo-zendesk-mcp/(default)/oauth',
    '--env',
    `OAUTH_MASTER_SECRET=${secret}`,
    '--env',
    'SLA_PUSH=false',
    '--env',
    'SLA_USER_PREFERENCES=false',
    image,
    'smoke-test',
    '--public-url',
    base,
  );
try {
  docker('image', 'inspect', image);
  docker('pull', emulatorImage);
  docker('network', 'create', network);
  docker(
    'run',
    '--detach',
    '--name',
    database,
    '--network',
    network,
    '--network-alias',
    'firestore',
    emulatorImage,
    'gcloud',
    'emulators',
    'firestore',
    'start',
    '--host-port=0.0.0.0:8085',
    '--project=demo-zendesk-mcp',
  );
  startApp(0, 'http://127.0.0.1:3000');
  const binding = JSON.parse(docker('inspect', app))[0].NetworkSettings.Ports['3000/tcp'][0];
  const port = binding.HostPort;
  const base = `http://127.0.0.1:${port}`;
  // Fix the issuer to the host port before writing any authorization state.
  docker('rm', '--force', '--volumes', app);
  startApp(port, base);
  await ready(`${base}/healthz`);
  docker(
    'exec',
    app,
    'node',
    '--input-type=module',
    '-e',
    `
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://firestore:8085')).ok) process.exit(0); } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.exit(1);
  `,
  );
  const registration = await json(`${base}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'container-firestore-fixture',
      redirect_uris: ['http://127.0.0.1:9/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  assert.equal(registration.status, 201, 'DCR must persist through bundled Firestore SDK');
  assert.equal(typeof registration.body.client_id, 'string');

  const documents = JSON.parse(
    docker(
      'exec',
      app,
      'node',
      '--input-type=module',
      '-e',
      `
    const r = await fetch('http://firestore:8085/v1/projects/demo-zendesk-mcp/databases/(default)/documents/oauth');
    if (!r.ok) process.exit(1);
    console.log(await r.text());
  `,
    ),
  ).documents;
  assert(documents?.length > 0, 'Registration must create a Firestore document');
  for (const document of documents) {
    const ciphertext = document.fields.value.stringValue;
    assert.equal(ciphertext.split('.').length, 5, 'Stored values must be compact JWE');
    assert(!ciphertext.includes('container-firestore-fixture'), 'No plaintext client metadata');
    assert.match(document.name.split('/').at(-1), /^[a-f0-9]{64}$/);
  }
  docker('rm', '--force', '--volumes', app);
  startApp(port, base);
  await ready(`${base}/healthz`);
  const auth = new URL(`${base}/auth`);
  auth.search = new URLSearchParams({
    client_id: registration.body.client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    response_type: 'code',
    scope: 'read',
    state: 'fixture',
    resource: `${base}/mcp`,
    code_challenge: randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
  });
  const response = await fetch(auth, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 303, 'Replacement must read the persisted client');
  assert.match(response.headers.get('location') ?? '', /\/interaction\//);
  // Stop at our own login interaction; never contact a real Zendesk tenant.
  console.log('[container-firestore-smoke] encrypted write and replacement read passed');
} catch (error) {
  const logs = spawnSync('docker', ['logs', app], { encoding: 'utf8', timeout: 10000 });
  console.error(logs.stderr || logs.stdout);
  throw error;
} finally {
  remove('rm', '--force', '--volumes', app);
  remove('rm', '--force', '--volumes', database);
  remove('network', 'rm', network);
}
