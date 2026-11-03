import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../src/voice/speech.js';

const pcm = Buffer.alloc(32000);
const signal = () => new AbortController().signal;
const complete = (text: string) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });

test('transcription never routes incomplete, empty, malformed or oversized output to an action', async () => {
  for (const result of [
    { ...complete('skip'), status: 'in_progress' },
    { ...complete('skip'), error: { message: 'private provider error' } },
    complete(''), complete('x'.repeat(501)), { status: 'completed' },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'tool_call', text: 'skip' }] }] },
    null, '{invalid', 'x'.repeat(65537),
  ]) {
    let calls = 0;
    const speech = new Speech('test-key', undefined, undefined, undefined, async () => {
      calls++;
      return typeof result === 'string' ? new Response(result) : Response.json(result);
    });
    await assert.rejects(speech.understand(pcm, [], '1', [], signal()), /catch|transcribing/);
    assert.equal(calls, 1, 'No chat/action request after invalid transcription');
  }
});

test('canceling transcription prevents the conversation request', async () => {
  const abort = new AbortController(); let calls = 0;
  const speech = new Speech('test-key', undefined, undefined, undefined, async (_url, init) => {
    calls++;
    assert.equal(init?.signal?.aborted, false);
    abort.abort(new Error('user canceled'));
    return Response.json(complete('skip'));
  });
  await assert.rejects(speech.understand(pcm, [], '1', [], abort.signal), /user canceled/);
  assert.equal(calls, 1);
  await assert.rejects(speech.transcribe(pcm, [], abort.signal), /user canceled/);
  assert.equal(calls, 1);
});

test('transcription deadline covers stalled response bodies and a fresh request still succeeds', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 12000); return deadline.signal; });
  let calls = 0;
  const speech = new Speech('test-key', undefined, undefined, undefined, async (_url, init) => {
    if (++calls > 1) return Response.json(complete('air horn'));
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":'));
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      setImmediate(() => deadline.abort(new DOMException('Timed out', 'TimeoutError')));
    } }));
  });
  await assert.rejects(speech.understand(pcm, [], '1', [], signal()), { code: 'GEMINI_ASR_TIMEOUT' });
  assert.equal(calls, 1);
  t.mock.restoreAll();
  assert.equal(await speech.transcribe(pcm, [], signal()), 'air horn');
});

test('transcription quota/access errors do not retry, expose provider bodies, or fall back to another model', async () => {
  for (const status of [403, 429, 503]) {
    let calls = 0;
    const speech = new Speech('test-key', undefined, undefined, undefined, async () => {
      calls++;
      return new Response('private-key-and-provider-details', { status });
    });
    await assert.rejects(speech.understand(pcm, [], '1', [], signal()), error => {
      assert.equal((error as { code: string }).code, `GEMINI_ASR_HTTP_${status}`);
      assert.doesNotMatch(String(error), /private-key/); return true;
    });
    assert.equal(calls, 1);
  }
});
