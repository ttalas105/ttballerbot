import { VoiceError } from '../model.js';
import { readFileSync, statSync } from 'node:fs';
import { encode } from '@msgpack/msgpack';
import { speechPcm } from './pcm.js';
import { Readable } from 'node:stream';

/** Fish streams a canonical 44-byte WAV header with sentinel lengths until EOF. */
export function fishPcm(audio: Buffer): Buffer {
  if (audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF'
    && audio.toString('ascii', 12, 16) === 'fmt ' && audio.readUInt32LE(16) === 16
    && audio.toString('ascii', 36, 40) === 'data' && audio.readUInt32LE(4) === 0xffffff24 && audio.readUInt32LE(40) === 0xffffff00) {
    audio = Buffer.from(audio);
    audio.writeUInt32LE(audio.length - 8, 4); audio.writeUInt32LE(audio.length - 44, 40);
  }
  const pcm = speechPcm(audio.toString('base64'), 'audio/wav');
  if (!pcm.length || pcm.length % 2 || pcm.length > 24000 * 2 * 25) throw new VoiceError('Fish Audio returned incomplete or overly long speech.', 'FISH_AUDIO_LENGTH');
  return pcm;
}

export interface VoiceReference { audio: Uint8Array; text: string }
interface FishSettings { fishKey: string; fishReferenceId: string; fishReferenceAudio: string; fishReferenceText: string; fishModel: string }

/** Read the host's explicitly configured reference once. Live Discord audio is never used here. */
export function configuredFishVoice(settings: FishSettings): FishVoice | undefined {
  const { fishKey, fishReferenceId, fishReferenceAudio, fishReferenceText, fishModel } = settings;
  if (!fishReferenceId && !fishReferenceAudio && !fishReferenceText) return undefined;
  if (fishReferenceId && (fishReferenceAudio || fishReferenceText)) throw new VoiceError('Choose a Fish voice ID or reference files, not both.', 'FISH_CONFIG');
  if (fishReferenceId) return new FishVoice(fishKey, fishReferenceId, fishModel);
  try {
    if (!fishReferenceAudio || !fishReferenceText || statSync(fishReferenceAudio).size > 3 * 1024 * 1024 || statSync(fishReferenceText).size > 16000) throw new Error();
    return new FishVoice(fishKey, { audio: readFileSync(fishReferenceAudio), text: readFileSync(fishReferenceText, 'utf8').trim() }, fishModel);
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError('The local Fish reference audio/transcript is missing or too large.', 'FISH_REFERENCE_CONFIG');
  }
}

/** Consented reference or private voice ID; never silently changes voice, provider, or price tier. */
export class FishVoice {
  constructor(private readonly key: string, private readonly reference: string | VoiceReference,
    private readonly model = 's2.1-pro-free', private readonly fetcher: typeof fetch = fetch) {
    if (!key || (typeof reference === 'string' ? !/^[a-f0-9]{32}$/i.test(reference)
      : !reference.audio.length || reference.audio.length > 3 * 1024 * 1024 || !reference.text.trim() || reference.text.length > 4000)) {
      throw new VoiceError('Set FISH_API_KEY and a valid private voice ID or reference audio/transcript together.', 'FISH_CONFIG');
    }
    // An unknown model header falls back to a paid model at the provider.
    if (!['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3'].includes(model)) throw new VoiceError('The configured Fish model is invalid.', 'FISH_MODEL_CONFIG');
  }
  get usesReferenceAudio(): boolean { return typeof this.reference !== 'string'; }
  /** Start after 120 ms of PCM is ready instead of buffering the entire utterance. */
  async stream(text: string, signal: AbortSignal): Promise<Readable> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const body = { text: text.slice(0, 120),
        ...(typeof this.reference === 'string' ? { reference_id: this.reference } : { references: [this.reference] }),
        format: 'pcm', sample_rate: 24000, latency: 'low', chunk_length: 100 };
      const response = await this.fetcher('https://api.fish.audio/v1/tts', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': this.usesReferenceAudio ? 'application/msgpack' : 'application/json', model: this.model },
        body: this.usesReferenceAudio ? Buffer.from(encode(body)) : JSON.stringify(body), signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(`Rajan’s voice service is unavailable (HTTP ${response.status}). No fallback was attempted.`, `FISH_HTTP_${response.status}`);
      }
      const type = (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
      if (!response.body || !['application/octet-stream', 'audio/pcm', 'audio/x-pcm'].includes(type)) {
        await response.body?.cancel(); throw new VoiceError('Fish returned an unexpected streaming format.', 'FISH_AUDIO_FORMAT');
      }
      reader = response.body.getReader();
      const source = reader;
      let pending = Buffer.alloc(0), total = 0, done = false;
      const read = async () => {
        requestSignal.throwIfAborted();
        const chunk = await source.read(); done = chunk.done;
        if (chunk.value) {
          total += chunk.value.length;
          if (total > 24000 * 2 * 12) throw new VoiceError('The reaction audio was too long.', 'FISH_AUDIO_LENGTH');
          pending = Buffer.concat([pending, chunk.value]);
        }
      };
      while (pending.length < 5760 && !done) await read();
      if (!pending.length || (done && pending.length % 2)) throw new VoiceError('Fish returned incomplete speech.', 'FISH_AUDIO_LENGTH');
      if (pending.toString('ascii', 0, 4) === 'RIFF') throw new VoiceError('Fish returned a WAV instead of streaming PCM.', 'FISH_AUDIO_FORMAT');
      let input: Readable;
      const abort = () => { void source.cancel().catch(() => {}); input.destroy(); };
      input = Readable.from((async function* () {
        try {
          while (true) {
            requestSignal.throwIfAborted();
            const length = pending.length - pending.length % 2;
            if (length) {
              const stereo = Buffer.alloc(length * 4);
              for (let i = 0; i < length; i += 2) {
                const value = Math.round(pending.readInt16LE(i) * 0.8);
                for (let j = 0; j < 8; j += 2) stereo.writeInt16LE(value, i * 4 + j);
              }
              pending = pending.subarray(length); yield stereo;
            }
            if (done) { if (pending.length) throw new VoiceError('Fish returned an incomplete audio frame.', 'FISH_AUDIO_LENGTH'); break; }
            await read();
          }
        } finally { requestSignal.removeEventListener('abort', abort); await source.cancel().catch(() => {}); source.releaseLock(); }
      })(), { objectMode: false, highWaterMark: 23040 });
      requestSignal.addEventListener('abort', abort, { once: true });
      input.once('close', () => { requestSignal.removeEventListener('abort', abort); void source.cancel().catch(() => {}); });
      if (requestSignal.aborted) { input.destroy(); requestSignal.throwIfAborted(); }
      return input;
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (signal.aborted) throw signal.reason;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('Rajan’s streaming voice was interrupted.', requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_NETWORK');
    }
  }
  async speak(text: string, signal: AbortSignal, style: 'conversation' | 'entrance' | 'wedding'): Promise<Buffer> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(35000)]);
    const delivery = style === 'entrance' ? '[excited] ' : style === 'wedding' ? '[happy] ' : '';
    const body = { text: delivery + text.slice(0, 500),
      ...(typeof this.reference === 'string' ? { reference_id: this.reference } : { references: [this.reference] }),
      format: 'wav', sample_rate: 24000, latency: 'balanced' };
    try {
      const response = await this.fetcher('https://api.fish.audio/v1/tts', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': this.usesReferenceAudio ? 'application/msgpack' : 'application/json', model: this.model },
        body: this.usesReferenceAudio ? Buffer.from(encode(body)) : JSON.stringify(body), signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(response.status === 402 ? 'Fish Audio requires credit for this request. No paid fallback was attempted.'
          : response.status === 429 ? 'Fish Audio is rate limited. Try again shortly.'
          : `Rajan’s voice service is unavailable (HTTP ${response.status}). Try again.`, `FISH_HTTP_${response.status}`);
      }
      const type = (response.headers.get('content-type') || '').split(';')[0]!.trim();
      if (!response.body || !['audio/wav', 'audio/x-wav', 'application/octet-stream'].includes(type.toLowerCase())) {
        await response.body?.cancel();
        throw new VoiceError('Fish Audio returned an unexpected audio format.', 'FISH_AUDIO_FORMAT');
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          requestSignal.throwIfAborted(); length += value.length;
          if (length > 24000 * 2 * 25 + 65536) { await reader.cancel(); throw new VoiceError('Rajan’s reply was too long. Try a shorter request.', 'FISH_AUDIO_LENGTH'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      return fishPcm(Buffer.concat(chunks));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('Rajan’s voice took too long or the connection failed. Try again.', requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_NETWORK');
    }
  }
}
