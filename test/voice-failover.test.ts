import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../src/voice/speech.js';

const make = (fetcher: typeof fetch) => new Speech('test-key', 'gemini-3.1-flash-lite', undefined, undefined, fetcher,
  undefined, undefined, undefined, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite');
const signal = () => new AbortController().signal;
const decision = { transcript: 'hello', kind: 'say', reply: 'Hey there.', query: '', name: '' };
const answer = (value = decision, finishReason = 'STOP') => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason }] })}\n\n`);
const primary = (url: string | URL | Request) => String(url).includes('gemini-3.1-flash-lite');

test('a model outage recovers audio and conversation, skips the unhealthy model, and probes it after cooldown', async t => {
  let now = 1000, failures = 1;
  t.mock.method(Date, 'now', () => now);
  const models: boolean[] = [];
  const speech = make(async (url, init) => {
    models.push(primary(url));
    if (primary(url) && failures-- > 0) return new Response('', { status: 503 });
    const body = JSON.parse(String(init?.body));
    if (body.contents[0].parts.some((part: { inlineData?: unknown }) => part.inlineData)) {
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"transcript":"hello"}' }] }, finishReason: 'STOP' }] });
    }
    return answer();
  });
  assert.equal((await speech.understand(Buffer.alloc(32000), [], '1', [], signal())).intent.kind, 'say');
  assert.deepEqual(models, [true, false, false]);
  await speech.understand('hello again', [], '1', [], signal());
  assert.equal(models.at(-1), false);
  now += 60001;
  await speech.understand('hello again', [], '1', [], signal());
  assert.equal(models.at(-1), true);
});

test('a stalled partial response is canceled and the backup shares the original time budget', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const deadline = new AbortController(), budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); return budgets.length === 1 ? deadline.signal : signal(); });
  let calls = 0;
  const speech = make(async (_url, init) => {
    if (++calls === 2) return answer();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"candidates":['));
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      setImmediate(() => { now += 4000; deadline.abort(new DOMException('Deadline', 'TimeoutError')); });
    } }));
  });
  assert.deepEqual((await speech.understand('hello', [], '1', [], signal())).intent, { kind: 'say', reply: 'Hey there.' });
  assert.deepEqual(budgets, [4000, 6000]); assert.equal(calls, 2);
});

test('quotas, authorization errors and invalid or unfinished model output never trigger failover', async () => {
  for (const response of [() => new Response('', { status: 429 }), () => new Response('', { status: 403 }),
    () => new Response('', { status: 400 }), () => answer(decision, 'MAX_TOKENS'),
    () => new Response('data: {broken}\n\n')]) {
    let calls = 0;
    const speech = make(async () => { calls++; return response(); });
    await assert.rejects(speech.understand('hello', [], '1', [], signal()));
    assert.equal(calls, 1);
  }
});

test('opt-out during failure prevents a second request', async () => {
  let calls = 0; const controller = new AbortController();
  const speech = make(async () => { calls++; controller.abort(new Error('opted out')); return new Response('', { status: 503 }); });
  await assert.rejects(speech.understand('hello', [], '1', [], controller.signal), /opted out/);
  assert.equal(calls, 1);
});

test('a wider outage tries at most two models and only one probe while both cool down', async t => {
  t.mock.method(Date, 'now', () => 1000);
  let calls = 0;
  const speech = make(async () => { calls++; return new Response('', { status: 503 }); });
  await assert.rejects(speech.understand('hello', [], '1', [], signal()), { code: 'GEMINI_HTTP_503' });
  assert.equal(calls, 2);
  await assert.rejects(speech.understand('hello', [], '1', [], signal()), { code: 'GEMINI_HTTP_503' });
  assert.equal(calls, 3);
});

test('voice failover cannot be configured to an unapproved higher-tier model', () => {
  assert.throws(() => new Speech('key', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'gemini-pro'),
    { code: 'GEMINI_FALLBACK_CONFIG' });
});
