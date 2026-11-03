import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FishVoice } from '../src/voice/fish.js';
import { Speech } from '../src/voice/speech.js';

const voiceId = '1234567890abcdef1234567890abcdef';
const signal = () => new AbortController().signal;
test('Fish uses the selected private voice, explicit free model, bounded PCM and a shared style-aware cache', async () => {
  const requests: any[] = [];
  const fish = new FishVoice('test-key', voiceId, undefined, async (url, init) => {
    assert.equal(String(url), 'https://api.fish.audio/v1/tts');
    assert.equal((init!.headers as Record<string, string>).model, 's2.1-pro-free');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-key');
    requests.push(JSON.parse(String(init!.body)));
    return new Response(Buffer.alloc(48000), { headers: { 'content-type': 'audio/pcm' } });
  });
  const speech = new Speech('gemini-key', undefined, undefined, undefined, async () => { throw new Error('No Gemini TTS fallback'); }, fish);
  assert.equal((await speech.speak('Yoooooo cuzo.', signal(), 'conversation')).length, 48000);
  await speech.speak('Yoooooo cuzo.', signal(), 'conversation');
  await speech.speak('Yoooooo cuzo.', signal(), 'entrance');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reference_id, voiceId); assert.equal(requests[0].sample_rate, 24000);
  assert.equal(requests[0].format, 'pcm'); assert.equal(requests[0].text, 'Yoooooo cuzo.');
  assert.equal(requests[1].text, '[excited] Yoooooo cuzo.');
  assert.match(speech.voiceDisclosure, /Fish/);
});

test('Fish rejects billing/rate errors without retry, fallback or provider-body leakage', async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    const fish = new FishVoice('secret-key', voiceId, undefined, async () => {
      calls++; return new Response('private provider detail and secret-key', { status });
    });
    await assert.rejects(fish.speak('hello', signal(), 'conversation'), error => {
      assert.equal((error as {code:string}).code, `FISH_HTTP_${status}`);
      assert.doesNotMatch(String(error), /private provider|secret-key/); return true;
    });
    assert.equal(calls, 1);
  }
  assert.throws(() => new FishVoice('', voiceId), /together/);
  assert.throws(() => new FishVoice('key', ''), /together/);
  assert.throws(() => new FishVoice('key', voiceId, 'typo-would-be-paid'), /invalid/);
});

test('Fish rejects oversized, incomplete and unexpected response formats', async () => {
  for (const [data, type] of [[Buffer.alloc(1200002), 'audio/pcm'], [Buffer.alloc(3), 'audio/pcm'],
    [Buffer.alloc(0), 'audio/pcm'], [Buffer.from('{"error":"private"}'), 'application/json']] as const) {
    const fish = new FishVoice('key', voiceId, undefined, async () => new Response(data, { headers: { 'content-type': type } }));
    await assert.rejects(fish.speak('hello', signal(), 'conversation'), /too long|incomplete|unexpected/);
  }
});

test('Fish cancellation interrupts streaming and does not become a network error', async () => {
  const controller = new AbortController();
  const reason = new Error('User stopped response');
  const fish = new FishVoice('key', voiceId, undefined, async (_url, init) => {
    const stream = new ReadableStream<Uint8Array>({ start(target) {
      init!.signal!.addEventListener('abort', () => target.error(init!.signal!.reason), { once: true });
      target.enqueue(new Uint8Array(20)); queueMicrotask(() => controller.abort(reason));
    } });
    return new Response(stream, { headers: { 'content-type': 'audio/pcm' } });
  });
  await assert.rejects(fish.speak('hello', controller.signal, 'conversation'), error => error === reason);
});
