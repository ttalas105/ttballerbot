import { UserError, VoiceError } from '../model.js';
import { wav } from './capture.js';

/** Dedicated ASR keeps raw audio out of the slower multimodal reasoning path. */
export async function transcribeAudio(pcm: Buffer, names: string[], key: string, model: string,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  signal.throwIfAborted();
  if (pcm.length > 16000 * 2 * 8) throw new VoiceError('Voice request is too long.', 'VOICE_INPUT_TOO_LONG');
  if (!pcm.length || pcm.length % 2) throw new VoiceError('I didn’t catch that. Speak after the chime.', 'VOICE_EMPTY_COMMAND');
  if (!key) throw new UserError('Spoken commands need GEMINI_API_KEY in the host’s .env.');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new VoiceError('The configured transcription model name is invalid.', 'GEMINI_MODEL_CONFIG');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
      signal: deadline,
      body: JSON.stringify({ model, store: false,
        input: [{ type: 'audio', data: wav(pcm).toString('base64'), mime_type: 'audio/wav' }],
        generation_config: { transcription_config: { mode: { type: 'verbatim' }, language_codes: ['en-US'],
          custom_vocabulary: [...new Set(['Rajan', 'J Cole', 'air horn', ...names.slice(0, 20).map(name => name.slice(0, 50))])] } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new VoiceError(response.status === 429 ? 'Gemini’s transcription quota was reached. Try later.'
        : `Gemini transcription is unavailable (HTTP ${response.status}). Try again.`, `GEMINI_ASR_HTTP_${response.status}`);
    }
    if (!response.body) throw invalidResponse();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      deadline.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw invalidResponse();
      chunks.push(value);
    }
    let result: any;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalidResponse(); }
    // Only complete plain text is eligible for action routing. No partial commands.
    if (result?.status !== 'completed' || result.error || !Array.isArray(result.steps)) throw invalidResponse();
    const parts: unknown[] = result.steps.filter((step: any) => step?.type === 'model_output')
      .flatMap((step: any) => Array.isArray(step.content) ? step.content : [null]);
    if (parts.some((part: any) => part?.type !== 'text' || typeof part.text !== 'string')) throw invalidResponse();
    const transcript = (parts as { text: string }[]).map(part => part.text).join('').trim();
    if (transcript.length > 500) throw invalidResponse();
    if (!transcript) throw new VoiceError('I didn’t catch that. Speak after the chime.', 'VOICE_EMPTY_COMMAND');
    return transcript;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof UserError) throw error;
    throw new VoiceError('Transcription took too long or the connection failed. Say “Hey Rajan” to try again.',
      deadline.aborted ? 'GEMINI_ASR_TIMEOUT' : 'GEMINI_ASR_NETWORK');
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

function invalidResponse(): VoiceError {
  return new VoiceError('Rajan couldn’t finish transcribing that request. Try again.', 'GEMINI_ASR_RESPONSE');
}
