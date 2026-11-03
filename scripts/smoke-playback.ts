import { AudioPlayerStatus, NoSubscriberBehavior } from '@discordjs/voice';
import { config } from '../src/config.js';
import { YouTube } from '../src/youtube.js';
import { createMusicPlayer } from '../src/session.js';
import { logError } from '../src/model.js';

// Play locally through Discord's real-time scheduler, with no voice connection.
// A fast packet-drain test does not reproduce slow-consumer network failures.
const youtube = new YouTube(config.ytdlp, config.ffmpeg);
const controller = new AbortController();
const player = createMusicPlayer(NoSubscriberBehavior.Play);
const startAt = Number(process.argv[3] || 0);
let audio: Awaited<ReturnType<YouTube['prepare']>> | undefined;
let progress: NodeJS.Timeout | undefined;
let deadline: NodeJS.Timeout | undefined;
try {
  const track = await youtube.lookup(process.argv[2] || 'https://www.youtube.com/watch?v=FFa-XE0eMqc', 'local-playback-check');
  if (!Number.isFinite(startAt) || startAt < 0 || startAt >= track.durationSeconds) throw new Error('Invalid start position');
  console.log(`Checking full playback: ${track.title}; ${track.durationSeconds}s; start ${startAt}s. Nothing is broadcast.`);
  audio = await youtube.prepare(track, controller.signal, startAt);
  const resource = audio.resource;
  let failure: unknown;
  player.on('error', error => { failure = resource.playStream.errored || error; });
  progress = setInterval(() => console.log(`Playback: ${(startAt + resource.playbackDuration / 1000).toFixed(1)} / ${track.durationSeconds}s (${player.state.status})`), 30_000);
  deadline = setTimeout(() => { failure = new Error('Playback deadline exceeded'); player.stop(true); }, (track.durationSeconds - startAt + 90) * 1000);
  await new Promise<void>(resolve => { player.once(AudioPlayerStatus.Idle, () => resolve()); player.play(resource); });
  if (failure) throw failure;
  const played = startAt + resource.playbackDuration / 1000;
  if (played < track.durationSeconds - Math.max(3, track.durationSeconds * 0.02)) throw new Error(`Premature end at ${played.toFixed(1)}s`);
  console.log(`PASS: reached ${played.toFixed(1)} / ${track.durationSeconds}s at normal playback speed.`);
} catch (error) {
  logError('full playback check', error);
  process.exitCode = 1;
} finally {
  clearInterval(progress); clearTimeout(deadline);
  player.stop(true); audio?.dispose(); controller.abort();
}
