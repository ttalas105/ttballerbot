import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { config } from '../src/config.js';
import { saveEnv } from './env.js';

// Explicit host-only setup, never invoked by Discord or the conversational model.
try {
  const path = process.argv[2];
  if (!path || !process.argv.includes('--speaker-consented')) throw new Error('Usage: npx tsx scripts/clone-voice.ts <clean-reference.wav> --speaker-consented. Obtain the speaker’s permission first.');
  if (!config.fishKey) throw new Error('Set FISH_API_KEY in the local .env first.');
  if (config.fishReferenceId || config.fishReferenceAudio || config.fishReferenceText) throw new Error('A Fish voice is already configured. Remove its reference settings manually before deliberately replacing it.');
  const extension = extname(path).toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.opus'].includes(extension)) throw new Error('Use an audio-only WAV, MP3, M4A or Opus sample.');
  const file = await stat(resolve(path));
  if (!file.isFile() || file.size > 20 * 1024 * 1024 || file.size < 1000) throw new Error('Use a clean voice sample under 20 MB.');
  const form = new FormData();
  for (const [key, value] of Object.entries({ type: 'tts', title: 'Rajan AI — ttballerbot',
    description: 'Private AI voice for ttballerbot, used with the speaker’s permission.', visibility: 'private',
    train_mode: 'fast', enhance_audio_quality: 'true', generate_sample: 'false' })) form.set(key, value);
  form.append('voices', new Blob([await readFile(path)]), `reference${extension}`);
  const response = await fetch('https://api.fish.audio/model', { method: 'POST',
    headers: { Authorization: `Bearer ${config.fishKey}` }, body: form, signal: AbortSignal.timeout(120000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Fish voice creation failed (HTTP ${response.status}). No provider details logged.`); }
  const result = await response.json() as { _id?: string; state?: string; visibility?: string };
  if (!result._id || !/^[a-f0-9]{32}$/i.test(result._id) || result.visibility !== 'private' || result.state === 'failed') throw new Error('Fish did not confirm a usable private voice. Check your Fish dashboard before retrying.');
  saveEnv({ FISH_REFERENCE_ID: result._id, FISH_SPEECH_MODEL: config.fishModel });
  console.log('Private voice created. Voice ID saved only in .env; restart after testing speech.');
} catch (error) { console.error(error instanceof Error && !/fetch|abort|timeout/i.test(error.message) ? error.message : 'Voice setup failed or timed out. Check the Fish dashboard before retrying.'); process.exitCode = 1; }
