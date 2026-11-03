import { VoiceError } from '../model.js';

/** Private voice ID only; never silently changes voice, provider, or price tier. */
export class FishVoice {
  constructor(private readonly key: string, private readonly referenceId: string,
    private readonly model = 's2.1-pro-free', private readonly fetcher: typeof fetch = fetch) {
    if (!key || !/^[a-f0-9]{32}$/i.test(referenceId)) throw new VoiceError('Set FISH_API_KEY and a valid private FISH_REFERENCE_ID together.', 'FISH_CONFIG');
    // An unknown model header falls back to a paid model at the provider.
    if (!['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3'].includes(model)) throw new VoiceError('The configured Fish model is invalid.', 'FISH_MODEL_CONFIG');
  }
  async speak(text: string, signal: AbortSignal, style: 'conversation' | 'entrance' | 'wedding'): Promise<Buffer> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
    const delivery = style === 'entrance' ? '[excited] ' : style === 'wedding' ? '[happy] ' : '';
    try {
      const response = await this.fetcher('https://api.fish.audio/v1/tts', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', model: this.model },
        body: JSON.stringify({ text: delivery + text.slice(0, 500), reference_id: this.referenceId,
          format: 'pcm', sample_rate: 24000, latency: 'balanced' }), signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(response.status === 402 ? 'Fish Audio requires credit for this request. No paid fallback was attempted.'
          : response.status === 429 ? 'Fish Audio is rate limited. Try again shortly.'
          : `Rajan’s voice service is unavailable (HTTP ${response.status}). Try again.`, `FISH_HTTP_${response.status}`);
      }
      const type = (response.headers.get('content-type') || '').split(';')[0]!.trim();
      if (!response.body || !['audio/pcm', 'audio/l16', 'audio/raw', 'application/octet-stream'].includes(type.toLowerCase())) {
        await response.body?.cancel();
        throw new VoiceError('Fish Audio returned an unexpected audio format.', 'FISH_AUDIO_FORMAT');
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          requestSignal.throwIfAborted(); length += value.length;
          if (length > 24000 * 2 * 25) { await reader.cancel(); throw new VoiceError('Rajan’s reply was too long. Try a shorter request.', 'FISH_AUDIO_LENGTH'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      if (!length || length % 2) throw new VoiceError('Fish Audio returned incomplete speech.', 'FISH_AUDIO_LENGTH');
      return Buffer.concat(chunks);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('Rajan’s voice took too long or the connection failed. Try again.', requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_NETWORK');
    }
  }
}
