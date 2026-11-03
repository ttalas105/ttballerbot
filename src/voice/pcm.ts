import { VoiceError } from '../model.js';

/** Gemini can return raw PCM or a WAV with provenance chunks after its audio data. */
export function speechPcm(data: string, mimeType: string): Buffer {
  const invalid = () => new VoiceError('Gemini didn’t return usable 24 kHz speech audio. Try again.', 'VOICE_NO_AUDIO');
  const bytes = Buffer.from(data, 'base64');
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('audio/l16')) {
    if (/rate=\d+/.test(mime) && !/rate=24000\b/.test(mime)) throw invalid();
    return bytes;
  }
  if (!/^audio\/(?:x-)?wav(?:;|$)/.test(mime) || bytes.length < 44
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  let validFormat = false, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const begin = offset + 8, end = begin + size;
    if (end > bytes.length) throw invalid();
    if (id === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(begin) !== 1 || bytes.readUInt16LE(begin + 2) !== 1
        || bytes.readUInt32LE(begin + 4) !== 24000 || bytes.readUInt16LE(begin + 14) !== 16) throw invalid();
      validFormat = true;
    } else if (id === 'data') {
      if (pcm) throw invalid();
      pcm = bytes.subarray(begin, end);
    }
    offset = end + (size % 2);
  }
  if (!validFormat || !pcm) throw invalid();
  return pcm;
}
