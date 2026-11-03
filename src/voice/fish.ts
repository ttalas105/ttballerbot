import { VoiceError } from '../model.js';
import { readFileSync, statSync } from 'node:fs';
import { encode } from '@msgpack/msgpack';
import { speechPcm } from './pcm.js';

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
