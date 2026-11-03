import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { config } from '../src/config.js';
import { Speech } from '../src/voice/speech.js';
import { entranceLine } from '../src/voice/intents.js';
import { wav } from '../src/voice/capture.js';
import { logError, userMessage } from '../src/model.js';

const speech = new Speech(config.geminiKey, config.transcriptionModel, config.speechModel, config.announcerVoice);
try {
  const signal = AbortSignal.timeout(30000);
  if (process.argv[2]) {
    const file = await readFile(process.argv[2]!);
    // Smoke fixtures are ordinary PCM WAV; locate data instead of assuming a 44-byte header.
    let data: Buffer | undefined;
    for (let offset = 12; offset + 8 <= file.length;) {
      const length = file.readUInt32LE(offset + 4);
      if (file.toString('ascii', offset, offset + 4) === 'data') { data = file.subarray(offset + 8, offset + 8 + length); break; }
      offset += 8 + length + (length % 2);
    }
    if (!data) throw new Error('No WAV audio data.');
    const text = await speech.transcribe(data, ['Jason', 'Sushi'], signal);
    console.log(JSON.stringify({ transcriptionReturned: !!text, recognizedDramaticCommand: /dramatic/i.test(text) }));
  } else {
    const start = Date.now();
    const pcm = await speech.speak(entranceLine('Jason'), signal);
    await mkdir('.runtime', { recursive: true });
    await writeFile('.runtime/announcer-preview.wav', wav(pcm, 24000));
    console.log(JSON.stringify({ speechSeconds: pcm.length / 48000, generationMs: Date.now() - start, preview: '.runtime/announcer-preview.wav' }));
  }
} catch (error) { logError('speech smoke', error); console.error(userMessage(error)); process.exitCode = 1; }
