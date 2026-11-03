import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WatchManager, type WatchTarget } from '../src/watch/manager.js';
import { WatchServer } from '../src/watch/server.js';
import { validateFrames, type ScreenReaction } from '../src/watch/frames.js';
import { Speech } from '../src/voice/speech.js';
import { request } from 'node:http';

const jpeg = Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(40), Buffer.from([255, 217])]).toString('base64');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const result: ScreenReaction = { react: true, event: 'Home score increased by two.', reply: 'Finally, a fucking bucket.' };
function harness(t: TestContext) {
  let now = 100000, valid = true, busy = false, stops = 0;
  const calls: { signal: AbortSignal; resolve: (value: ScreenReaction) => void }[] = [];
  const manager = new WatchManager(() => now); t.after(() => manager.close());
  const target: WatchTarget = { guildId: 'guild', userId: 'owner', channelName: 'Test room', valid: () => valid, busy: () => busy,
    react: async (_frames, _mode, _history, _manual, signal) => new Promise(resolve => calls.push({ signal, resolve })), onStop: () => { stops++; } };
  const ticket = manager.create(target), paired = manager.pair(ticket.code);
  manager.configure(paired.token, { enabled: true });
  const submit = (manual = false, frame = jpeg) => manager.submit(paired.token, { frames: [frame], capturedAt: now, manual });
  return { manager, target, ticket, paired, calls, submit, advance: (ms: number) => { now += ms; }, leave: () => { valid = false; }, busy: (v: boolean) => { busy = v; }, stops: () => stops };
}
test('pairing is single-use, per guild, authenticated, expiring and tied to the watcher', t => {
  const h = harness(t);
  assert.throws(() => h.manager.pair(h.ticket.code), /already used/);
  assert.throws(() => h.manager.status(''), /expired/);
  assert.throws(() => h.manager.create(h.target), /already exists/);
  assert.equal(h.manager.status(h.paired.token).channel, 'Test room');
  h.leave(); h.manager.prune(); assert.equal(h.stops(), 1);
  assert.throws(() => h.manager.status(h.paired.token), /expired/);
});
test('a closed companion expires after missed heartbeats and cancels its request', t => {
  const h = harness(t); h.submit(); h.advance(15001); h.manager.prune();
  assert.equal(h.calls[0]?.signal.aborted, true); assert.equal(h.stops(), 1);
});
test('pending reactions never queue; stopped/replaced jobs cannot publish late replies', async t => {
  const h = harness(t); h.submit(); h.submit(true); assert.equal(h.calls.length, 1);
  h.manager.configure(h.paired.token, { mode: 'hype' }); assert.equal(h.calls[0]?.signal.aborted, true);
  h.submit(); h.calls[0]!.resolve(result); await flush();
  assert.equal(h.manager.status(h.paired.token).lastReply, ''); assert.equal(h.manager.status(h.paired.token).busy, true);
  h.manager.configure(h.paired.token, { enabled: false }); h.calls[1]!.resolve(result); await flush();
  assert.equal(h.manager.status(h.paired.token).lastReply, ''); assert.equal(h.manager.status(h.paired.token).enabled, false);
});
test('manual mode, cooldown, busy priority and duplicate frames avoid unnecessary generation', async t => {
  const h = harness(t); h.busy(true); h.submit(); assert.equal(h.calls.length, 0); h.busy(false);
  h.manager.configure(h.paired.token, { interval: 0 }); h.submit(); assert.equal(h.calls.length, 0);
  h.submit(true); h.calls[0]!.resolve(result); await flush(); assert.equal(h.manager.status(h.paired.token).lastReply, result.reply);
  h.submit(true); assert.equal(h.calls.length, 1); h.advance(5000); h.submit(true); assert.equal(h.calls.length, 2);
  h.calls[1]!.resolve(result); await flush(); h.manager.configure(h.paired.token, { interval: 15 });
  h.advance(15000); h.manager.status(h.paired.token); h.submit(); assert.equal(h.calls.length, 2);
  assert.throws(() => h.manager.submit(h.paired.token, { frames: [jpeg], capturedAt: 0 }), /stale/);
});
test('frames are bounded inline JPEGs, never arbitrary URLs', () => {
  assert.deepEqual(validateFrames([jpeg]), [jpeg]);
  for (const value of [[], [jpeg, jpeg, jpeg, jpeg], ['https://private.local'], ['A'.repeat(350001)], ['abcd']]) assert.throws(() => validateFrames(value));
});
test('loopback API blocks foreign origins/hosts and requires pairing before frame upload', async t => {
  const h = harness(t), server = new WatchServer(h.manager); await server.start(0); t.after(() => server.close());
  const home = await fetch(server.url); assert.equal(home.status, 200); assert.match(await home.text(), /Give Rajan/);
  assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await fetch(server.url + '/api/status')).status, 401);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url + '/api/status', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(server.url + '/api/frames', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const headers = { Authorization: `Bearer ${h.paired.token}`, Origin: server.url, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.url + '/api/status', { headers })).status, 200);
  assert.equal((await fetch(server.url + '/api/settings', { method: 'POST', headers, body: '{broken' })).status, 400);
  assert.equal((await fetch(server.url + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ mode: 'hype', interval: 15 }) })).status, 200);
  assert.equal((await fetch(server.url + '/api/stop', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(h.stops(), 1);
});
test('vision requests contain only bounded images/context, accept no commands and skip outage retries', async () => {
  let body: any, calls = 0;
  const speech = new Speech('test', undefined, undefined, undefined, async (_url, init) => {
    body = JSON.parse(String(init!.body));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] })}\n\n`);
  });
  assert.deepEqual(await speech.reactToFrames([jpeg, jpeg], 'roast', [], true, new AbortController().signal), result);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg'); assert.equal(body.contents[0].parts.length, 3);
  assert.equal(body.tools, undefined); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  const down = new Speech('test', undefined, undefined, undefined, async () => { calls++; return new Response('private', { status: 503 }); });
  await assert.rejects(down.reactToFrames([jpeg], 'roast', [], true, new AbortController().signal), /HTTP 503/); assert.equal(calls, 1);
});
