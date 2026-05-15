import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:18787';
let child;

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/live`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Server did not start in time');
}

test.before(async () => {
  child = spawn('node', ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '18787',
      HOST: '127.0.0.1',
      ANIMEPAHE_PROXY_BASE: 'http://127.0.0.1:3030/api'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});

  await waitForServer();
});

test.after(async () => {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 5000);
  });
});

test('GET /api/live returns liveness payload', async () => {
  const res = await fetch(`${BASE}/api/live`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSec, 'number');
});

test('GET /api/health returns health shape with cache metadata', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.ok([200, 503].includes(res.status));
  const body = await res.json();
  assert.equal(typeof body.live, 'boolean');
  assert.equal(typeof body.ready, 'boolean');
  assert.equal(typeof body.providers?.jikan, 'boolean');
  assert.equal(typeof body.providers?.animepaheProxy, 'boolean');
  assert.equal(typeof body.cache?.size, 'number');
  assert.equal(typeof body.cache?.maxSize, 'number');
  assert.equal(typeof body.cache?.ttlMs, 'number');
});

test('GET /api/ready returns readiness payload', async () => {
  const res = await fetch(`${BASE}/api/ready`);
  assert.ok([200, 503].includes(res.status));
  const body = await res.json();
  assert.equal(typeof body.ready, 'boolean');
  assert.equal(typeof body.providers?.jikan, 'boolean');
  assert.equal(typeof body.providers?.animepaheProxy, 'boolean');
});

test('Invalid ID endpoints return 400', async () => {
  const detailRes = await fetch(`${BASE}/api/anime/abc/detail`);
  assert.equal(detailRes.status, 400);

  const watchRes = await fetch(`${BASE}/api/watch/0?ep=1`);
  assert.equal(watchRes.status, 400);
});

test('Critical routes respond with JSON and expected shape', async () => {
  const homeRes = await fetch(`${BASE}/api/home`);
  assert.equal(homeRes.status, 200);
  const home = await homeRes.json();
  assert.ok(Array.isArray(home.trending));
  assert.ok(Array.isArray(home.latest));
  assert.ok(Array.isArray(home.continueWatching));

  const sampleId = home.trending?.[0]?.id;
  assert.equal(typeof sampleId, 'number');

  const detailRes = await fetch(`${BASE}/api/anime/${sampleId}/detail`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(typeof detail.anime?.title, 'string');
  assert.ok(Array.isArray(detail.episodes));

  const watchRes = await fetch(`${BASE}/api/watch/${sampleId}?ep=1`);
  assert.equal(watchRes.status, 200);
  const watch = await watchRes.json();
  assert.equal(typeof watch.anime?.title, 'string');
  assert.ok(Array.isArray(watch.episodes));
  assert.ok(Array.isArray(watch.streamProvider?.sources));
});
