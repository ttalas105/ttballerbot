import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

export const MODEL_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
export interface WakeStream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Spotter {
  createStream(): WakeStream; isReady(stream: WakeStream): boolean; decode(stream: WakeStream): void;
  getResult(stream: WakeStream): { keyword: string }; reset(stream: WakeStream): void;
}

/** CPU-only keyword spotting; no transcription, files, or network calls. */
export class LocalWake {
  private readonly spotter: Spotter;
  constructor(directory = resolve('models', MODEL_NAME), threshold = 0.3) {
    const model = (part: string) => resolve(directory, `${part}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
    const keywords = resolve('assets/voice/keywords.txt');
    if (![model('encoder'), model('decoder'), model('joiner'), resolve(directory, 'tokens.txt'), keywords].every(existsSync)) {
      throw new Error('Wake model missing. Run npm run voice:install.');
    }
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as { KeywordSpotter: new (config: unknown) => Spotter };
    this.spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder: model('encoder'), decoder: model('decoder'), joiner: model('joiner') },
        tokens: resolve(directory, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
      keywordsFile: keywords, keywordsThreshold: threshold, keywordsScore: 1.5,
      numTrailingBlanks: 2, maxActivePaths: 4,
    });
  }
  stream(): WakeStream { return this.spotter.createStream(); }
  accept(stream: WakeStream, samples: Float32Array): boolean {
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    let detected = false;
    while (this.spotter.isReady(stream)) {
      this.spotter.decode(stream);
      if (this.spotter.getResult(stream).keyword) { detected = true; this.spotter.reset(stream); }
    }
    return detected;
  }
}
