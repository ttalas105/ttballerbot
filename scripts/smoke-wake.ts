import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { LocalWake } from '../src/voice/wake.js';

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as { readWave(path: string): { samples: Float32Array; sampleRate: number } };
const detector = new LocalWake();
for (const path of process.argv.slice(2)) {
  const wave = sherpa.readWave(path);
  if (wave.sampleRate !== 16000) throw new Error('Use mono 16 kHz WAV files for the wake smoke test.');
  const stream = detector.stream(); let found = false;
  const start = performance.now();
  for (let i = 0; i < wave.samples.length; i += 320) found = detector.accept(stream, wave.samples.slice(i, i + 320)) || found;
  found = detector.accept(stream, new Float32Array(8000)) || found;
  console.log(JSON.stringify({ file: path, detected: found, audioSeconds: wave.samples.length / 16000, processingMs: Math.round(performance.now() - start) }));
}
