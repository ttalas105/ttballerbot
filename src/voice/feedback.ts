import { readFileSync, statSync } from 'node:fs';
import { speechPcm } from './pcm.js';

/** Optional prerecorded failure notice: never needs the failing cloud service. */
export function loadErrorAudio(path: string): Buffer | undefined {
  if (!path) return undefined;
  try {
    if (statSync(path).size > 24000 * 2 * 8 + 65536) throw new Error();
    const pcm = speechPcm(readFileSync(path).toString('base64'), 'audio/wav');
    if (!pcm.length || pcm.length % 2 || pcm.length > 24000 * 2 * 8) throw new Error();
    return pcm;
  } catch {
    console.warn('[voice feedback] Invalid VOICE_ERROR_AUDIO; using the local error tone.');
    return undefined;
  }
}
