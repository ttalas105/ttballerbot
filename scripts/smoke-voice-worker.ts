import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';

// Run after npm run build. Pass a 16 kHz mono WAV saying "Hey Baller".
const path = process.argv[2]; if (!path) throw new Error('Pass a mono 16 kHz Hey Baller WAV.');
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const wave = sherpa.readWave(path) as { samples: Float32Array; sampleRate: number };
assert.equal(wave.sampleRate, 16000);
const worker = new Worker(new URL('../src/voice/wake-worker.js', import.meta.url), { workerData: {} });
const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
const events: { type: string; userId?: string; pcm?: Uint8Array }[] = [];
worker.on('message', message => events.push(message));
const send = (userId: string) => {
  for (let offset = 0; offset < wave.samples.length + 8000; offset += 320) {
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, wave.samples[offset + i] || 0)) * 32767), i * 2);
    worker.postMessage({ type: 'audio', userId, packet: encoder.encode(pcm, 320) });
  }
};
try {
  await once(worker, 'message', { signal: AbortSignal.timeout(15000) });
  send('not-opted-in'); await delay(200);
  assert.equal(events.filter(event => event.type === 'wake').length, 0);
  worker.postMessage({ type: 'add', userId: 'tester' }); send('tester'); await delay(500);
  assert.equal(events.filter(event => event.type === 'wake').length, 1);
  worker.postMessage({ type: 'capture', userId: 'tester' }); send('tester'); await delay(1200);
  const command = events.find(event => event.type === 'command'); assert.ok(command?.pcm?.length);
  worker.postMessage({ type: 'remove', userId: 'tester' }); send('tester'); await delay(200);
  assert.equal(events.filter(event => event.type === 'wake').length, 1);
  console.log('PASS: real Opus → worker → wake → bounded capture; unconsented and removed users ignored.');
} finally { encoder.delete(); await worker.terminate(); }
