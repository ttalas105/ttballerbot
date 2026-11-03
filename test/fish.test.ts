import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FishVoice, configuredFishVoice, fishPcm } from '../src/voice/fish.js';
import { Speech } from '../src/voice/speech.js';
import { decode } from '@msgpack/msgpack';
import { wav } from '../src/voice/capture.js';

const voiceId = '1234567890abcdef1234567890abcdef';
const signal = () => new AbortController().signal;
test('reference configuration never silently substitutes a voice when files are missing or conflicting', () => {
  const settings = { fishKey: 'key', fishReferenceId: '', fishReferenceAudio: '', fishReferenceText: '', fishModel: 's2.1-pro-free' };
  assert.equal(configuredFishVoice(settings), undefined);
  assert.throws(() => configuredFishVoice({ ...settings, fishReferenceAudio: 'not-present.wav' }), /missing/);
  assert.throws(() => configuredFishVoice({ ...settings, fishReferenceId: voiceId, fishReferenceText: 'reference.txt' }), /not both/);
  assert.throws(() => configuredFishVoice({ ...settings, fishKey: '', fishReferenceId: voiceId }), /together/);
  assert.equal(configuredFishVoice({ ...settings, fishReferenceId: voiceId })?.usesReferenceAudio, false);
});
test('instant cloning sends the exact consented reference as MessagePack on the free model', async () => {
  const reference = { audio: Buffer.from([1, 2, 3, 4]), text: 'The exact reference words.' };
  const fish = new FishVoice('test-key', reference, undefined, async (_url, init) => {
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/msgpack'); assert.equal(headers.model, 's2.1-pro-free');
    const body = decode(init!.body as Uint8Array) as any;
    assert.equal(body.reference_id, undefined); assert.equal(body.references.length, 1);
    assert.deepEqual(Buffer.from(body.references[0].audio), reference.audio);
    assert.equal(body.references[0].text, reference.text); assert.equal(body.text, 'Hello cuzo.');
    return new Response(new Uint8Array(wav(Buffer.alloc(48000), 24000)), { headers: { 'content-type': 'audio/wav' } });
  });
  assert.equal(fish.usesReferenceAudio, true);
  assert.equal((await fish.speak('Hello cuzo.', signal(), 'conversation')).length, 48000);
  assert.throws(() => new FishVoice('key', { audio: Buffer.alloc(0), text: 'hello' }), /together/);
  assert.throws(() => new FishVoice('key', { audio: Buffer.alloc(1), text: '' }), /together/);
  assert.throws(() => new FishVoice('key', { audio: Buffer.alloc(3 * 1024 * 1024 + 1), text: 'hello' }), /together/);
});
test('Fish uses the selected private voice, explicit free model, bounded PCM and a shared style-aware cache', async () => {
  const requests: any[] = [];
  const fish = new FishVoice('test-key', voiceId, undefined, async (url, init) => {
    assert.equal(String(url), 'https://api.fish.audio/v1/tts');
    assert.equal((init!.headers as Record<string, string>).model, 's2.1-pro-free');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-key');
    requests.push(JSON.parse(String(init!.body)));
    return new Response(new Uint8Array(wav(Buffer.alloc(48000), 24000)), { headers: { 'content-type': 'audio/wav' } });
  });
  const speech = new Speech('gemini-key', undefined, undefined, undefined, async () => { throw new Error('No Gemini TTS fallback'); }, fish);
  assert.equal((await speech.speak('Yoooooo cuzo.', signal(), 'conversation')).length, 48000);
  await speech.speak('Yoooooo cuzo.', signal(), 'conversation');
  await speech.speak('Yoooooo cuzo.', signal(), 'entrance');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reference_id, voiceId); assert.equal(requests[0].sample_rate, 24000);
  assert.equal(requests[0].format, 'wav'); assert.equal(requests[0].text, 'Yoooooo cuh soh.');
  assert.equal(requests[1].text, '[excited] Yoooooo cuh soh.');
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
  for (const [data, type] of [[wav(Buffer.alloc(1300000), 24000), 'audio/wav'], [wav(Buffer.alloc(3), 24000), 'audio/wav'],
    [wav(Buffer.alloc(0), 24000), 'audio/wav'], [Buffer.from('{"error":"private"}'), 'application/json']] as const) {
    const fish = new FishVoice('key', voiceId, undefined, async () => new Response(new Uint8Array(data), { headers: { 'content-type': type } }));
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
    return new Response(stream, { headers: { 'content-type': 'audio/wav' } });
  });
  await assert.rejects(fish.speak('hello', controller.signal, 'conversation'), error => error === reason);
});

test('Fish streaming WAV sentinel lengths decode correctly without accepting wrong sample rates or corrupt headers', () => {
  const pcm = Buffer.alloc(48000, 31); const wave = wav(pcm, 24000);
  wave.writeUInt32LE(0xffffff24, 4); wave.writeUInt32LE(0xffffff00, 40);
  assert.deepEqual(fishPcm(wave), pcm);
  assert.equal(wave.readUInt32LE(40), 0xffffff00, 'caller buffer remains unchanged');
  const badRate = Buffer.from(wave); badRate.writeUInt32LE(44100, 24);
  assert.throws(() => fishPcm(badRate), /24 kHz/);
  const corrupt = Buffer.from(wave); corrupt.writeUInt32LE(0xffffff01, 40);
  assert.throws(() => fishPcm(corrupt), /24 kHz/);
});
