import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFfmpegAudio, matchScore, youtubeFailureCode } from '../src/youtube.js';
import type { Track } from '../src/model.js';
const track: Track = { id: 'tone', title: 'Test tone', artist: 'Local generator', durationSeconds: 1, url: 'https://www.youtube.com/watch?v=BaW_jenozKc', source: 'youtube', requestedBy: '123' };

test('FFmpeg generates audio that the actual Discord Opus demuxer can read', { timeout: 10000 }, async () => {
  const audio = createFfmpegAudio(process.env.FFMPEG_PATH || 'ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3'], track);
  try {
    let packets = 0;
    for await (const packet of audio.resource.playStream) {
      assert.ok(packet.length > 0); packets++;
    }
    assert.ok(packets >= 10, `Expected Opus packets, received ${packets}`);
  } finally { audio.dispose(); }
});

test('recovery seeking discards only the already-played prefix of piped audio', { timeout: 10000 }, async () => {
  const audio = createFfmpegAudio(process.env.FFMPEG_PATH || 'ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ss', '1'], track);
  try {
    let packets = 0;
    for await (const packet of audio.resource.playStream) { if (packet.length) packets++; }
    assert.ok(packets >= 24 && packets <= 27, `Expected approximately half a second of Opus, got ${packets} packets`);
  } finally { audio.dispose(); }
});

test('provider diagnostics expose only categories, never signed URLs', () => {
  assert.equal(youtubeFailureCode('ConnectionResetError(10054, remote host closed)'), 'YOUTUBE_CONNECTION');
  assert.equal(youtubeFailureCode('HTTP Error 403: https://example.test/audio?token=secret'), 'YOUTUBE_HTTP_403');
  assert.equal(youtubeFailureCode('Read timed out'), 'YOUTUBE_TIMEOUT');
  assert.equal(youtubeFailureCode('something else https://example.test/?token=secret'), 'YOUTUBE_STREAM');
});

test('Spotify matching prefers the right title and duration over a long mix', () => {
  const song = { ...track, title: 'Example song', artist: 'Artist', durationSeconds: 180 };
  const matching = { title: 'Artist - Example song (Official Audio)', duration: 181 };
  const mix = { title: 'Artist - Example song extended remix', duration: 900 };
  assert.ok(matchScore(matching, song) > matchScore(mix, song));
});

test('FFmpeg failure rejects the audio stream instead of looking like a finished song', { timeout: 10000 }, async () => {
  const audio = createFfmpegAudio(process.env.FFMPEG_PATH || 'ffmpeg', ['-f', 'lavfi', '-i', 'not_a_real_filter'], track);
  try {
    await assert.rejects(async () => { for await (const _packet of audio.resource.playStream) { /* drain */ } }, /Audio playback failed/);
  } finally { audio.dispose(); }
});
