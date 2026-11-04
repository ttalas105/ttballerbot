import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../src/voice/speech.js';

const pcm = Buffer.alloc(32000);
const signal = () => new AbortController().signal;
const complete = (text: string) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
const dedicatedSpeech = (fetcher: typeof fetch) => new Speech('test-key', undefined, undefined, undefined, fetcher,
  undefined, undefined, undefined, 'gemini-3.5-transcribe');

function transcriptionResult(value: unknown, finish = 'STOP'): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: finish }] });
}

test('Flash transcription uses bounded stateless audio, then routes exact controls locally', async () => {
  let calls = 0;
  const speech = new Speech('key', undefined, undefined, undefined, async (url, init) => {
    calls++; assert.match(String(url), /gemini-3\.1-flash-lite:generateContent$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.previous_interaction_id, undefined);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(body.generationConfig.maxOutputTokens, 256);
    return transcriptionResult({ transcript: 'skip' });
  });
  assert.deepEqual(await speech.understand(pcm, [], '1', [], signal()), { transcript: 'skip', intent: { kind: 'skip' } });
  assert.equal(calls, 1);
});

test('Flash transcription rejects incomplete or invalid commands before action routing', async () => {
  for (const [value, finish] of [[{ transcript: 'skip' }, 'MAX_TOKENS'], [{ transcript: '' }, 'STOP'],
    [{ transcript: 'x'.repeat(501) }, 'STOP'], [{ transcript: 10 }, 'STOP'], [null, 'STOP']] as const) {
    let calls = 0;
    const speech = new Speech('key', undefined, undefined, undefined, async () => { calls++; return transcriptionResult(value, finish); });
    await assert.rejects(speech.understand(pcm, [], '1', [], signal()));
    assert.equal(calls, 1);
  }
});

test('Flash transcription cancellation and quota errors never start a conversation or retry', async () => {
  const controller = new AbortController(); let calls = 0;
  const speech = new Speech('key', undefined, undefined, undefined, async () => {
    calls++; controller.abort(new Error('opted out')); return transcriptionResult({ transcript: 'skip' });
  });
  await assert.rejects(speech.understand(pcm, [], '1', [], controller.signal), /opted out/);
  assert.equal(calls, 1);
  const limited = new Speech('key', undefined, undefined, undefined, async () => { calls++; return new Response('', { status: 429 }); });
  await assert.rejects(limited.understand(pcm, [], '1', [], signal()), { code: 'GEMINI_HTTP_429' });
  assert.equal(calls, 2);
});

test('exact spoken controls and effects work when the conversation service is unavailable', async () => {
  for (const [text, kind] of [
    ['please pause the music', 'pause'], ['next song', 'skip'], ['resume', 'resume'],
    ['go back', 'back'], ['shuffle the queue', 'shuffle'], ['stop the music', 'stop_music'],
    ['stop', 'stop'], ['play an air horn', 'airhorn'], ['give this conversation a dramatic soundtrack', 'dramatic'],
  ]) {
    let calls = 0;
    const speech = dedicatedSpeech(async (url) => {
      calls++; assert.match(String(url), /\/interactions$/);
      return Response.json(complete(text!));
    });
    const result = await speech.understand(pcm, [], '1', [], signal());
    assert.equal(result.intent.kind, kind); assert.equal(result.transcript, text); assert.equal(calls, 1);
  }
});

test('negation, quotes, questions and argument-bearing spoken requests still use conversation', async () => {
  for (const text of ["don't pause the music", 'he said skip', 'what does pause mean?', '"pause"', "'skip'", '‘stop’',
    'play some J Cole', 'announce Jason like a wedding', 'skip if you think this song sucks',
    'pause the music and then resume', 'play https://internal.invalid/admin']) {
    let calls = 0;
    const speech = dedicatedSpeech(async (url) => {
      calls++;
      if (String(url).endsWith('/interactions')) return Response.json(complete(text));
      return new Response('', { status: 429 });
    });
    await assert.rejects(speech.understand(pcm, [], '1', [], signal()), { code: 'GEMINI_HTTP_429' });
    assert.equal(calls, 2);
  }
});

test('transcription never routes incomplete, empty, malformed or oversized output to an action', async () => {
  for (const result of [
    { ...complete('skip'), status: 'in_progress' },
    { ...complete('skip'), error: { message: 'private provider error' } },
    complete(''), complete('x'.repeat(501)), { status: 'completed' },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'tool_call', text: 'skip' }] }] },
    null, '{invalid', 'x'.repeat(65537),
  ]) {
    let calls = 0;
    const speech = dedicatedSpeech(async () => {
      calls++;
      return typeof result === 'string' ? new Response(result) : Response.json(result);
    });
    await assert.rejects(speech.understand(pcm, [], '1', [], signal()), /catch|transcribing/);
    assert.equal(calls, 1, 'No chat/action request after invalid transcription');
  }
});

test('canceling transcription prevents the conversation request', async () => {
  const abort = new AbortController(); let calls = 0;
  const speech = dedicatedSpeech(async (_url, init) => {
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
  const speech = dedicatedSpeech(async (_url, init) => {
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
    const speech = dedicatedSpeech(async () => {
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
