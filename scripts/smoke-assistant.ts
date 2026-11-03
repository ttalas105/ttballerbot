import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Speech } from '../src/voice/speech.js';
import { wav } from '../src/voice/capture.js';
import { logError } from '../src/model.js';
import type { ConversationTurn } from '../src/voice/memory.js';

// Explicit development check: uses Gemini quota, never joins Discord or queues music.
// Only authored fixture text/audio is sent. Never print model text or credential values.
const speech = new Speech(config.geminiKey, config.transcriptionModel, config.speechModel, config.announcerVoice);
const people = [{ id: 'fixture', name: 'Jason', aliases: [] }];
const history: ConversationTurn[] = [];
try {
  if (process.argv[2]) {
    const audio = await readFile(process.argv[2]);
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(audio.readUInt32LE(24), 16000); assert.equal(audio.readUInt16LE(22), 1); assert.equal(audio.readUInt16LE(34), 16);
    const offset = audio.indexOf(Buffer.from('data')); assert.ok(offset >= 0);
    const start = Date.now();
    const result = await speech.understand(audio.subarray(offset + 8, offset + 8 + audio.readUInt32LE(offset + 4)), people, 'fixture', [], new AbortController().signal);
    assert.equal(result.intent.kind, process.argv[3] || 'music');
    console.log(JSON.stringify({ fixtureAudio: true, kind: result.intent.kind, ms: Date.now() - start }));
  } else {
    for (const [request, expected] of [['play some J Cole', 'music'], ['announce Tyrone like a wedding', 'wedding'], ['tell me a joke', 'say'], ['tell me another one', 'say']]) {
      const start = Date.now();
      const result = await speech.understand(request!, people, 'fixture', history, new AbortController().signal);
      assert.equal(result.intent.kind, expected);
      if (result.intent.kind === 'music') assert.match(result.intent.query, /j\.?\s*cole/i);
      if (result.intent.kind === 'wedding') assert.match(result.intent.name, /tyrone/i);
      if (result.intent.kind === 'say') {
        assert.ok(result.intent.reply.length > 10);
        assert.notEqual(result.intent.reply, history.at(-1)?.response);
        history.push({ request: request!, response: result.intent.reply });
      }
      console.log(JSON.stringify({ kind: result.intent.kind, ms: Date.now() - start, followup: history.length === 2 }));
    }
    const start = Date.now();
    const pcm = await speech.speak(history[0]!.response, new AbortController().signal, 'conversation');
    await mkdir('.runtime', { recursive: true });
    await writeFile('.runtime/assistant-preview.wav', wav(pcm, 24000));
    console.log(JSON.stringify({ speech: true, ms: Date.now() - start, seconds: pcm.length / 48000 }));
  }
} catch (error) { logError('assistant smoke', error); process.exitCode = 1; }
