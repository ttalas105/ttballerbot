import { config } from '../src/config.js';
import { YouTube } from '../src/youtube.js';
import { userMessage } from '../src/model.js';
const youtube = new YouTube(config.ytdlp, config.ffmpeg);
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 90000);
try {
  const track = await youtube.lookup(process.argv[2] || 'YouTube Audio Library Spring In My Step Silent Partner', 'local-smoke-test');
  console.log(`Resolved YouTube video: ${track.title}`);
  const audio = await youtube.prepare(track, abort.signal);
  try {
    let packets = 0;
    for await (const packet of audio.resource.playStream) {
      if (packet.length) packets++;
      if (packets >= 100) break;
    }
    if (packets < 100) throw new Error('Not enough audio was received.');
    console.log('PASS: YouTube -> FFmpeg -> 100 playable Opus packets. No audio was broadcast.');
  } finally { audio.dispose(); }
} catch (error) { console.error(userMessage(error)); console.error(`Failure category: ${error instanceof Error ? error.name : 'unknown'} ${(error as NodeJS.ErrnoException).code || ''}`); process.exitCode = 1; }
finally { clearTimeout(timeout); abort.abort(); }
