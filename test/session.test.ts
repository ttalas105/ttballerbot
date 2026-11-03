import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioPlayerStatus, NoSubscriberBehavior, createAudioResource, entersState, StreamType, VoiceConnectionStatus, type AudioPlayer, type VoiceConnection } from '@discordjs/voice';
import { ChannelType, type GuildMember, type GuildTextBasedChannel, type VoiceChannel } from 'discord.js';
import { createMusicPlayer, MusicSession, requireVoice } from '../src/session.js';
import { PlaybackError, type Track } from '../src/model.js';
import type { PreparedAudio, YouTube } from '../src/youtube.js';

const track = (id: string): Track => ({ id, title: id, artist: 'Artist', durationSeconds: 100,
  url: 'https://www.youtube.com/watch?v=BaW_jenozKc', source: 'youtube', requestedBy: '123' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const preparations: { track: Track; signal: AbortSignal; startAt: number; resolve: (audio: PreparedAudio) => void; reject: (error: Error) => void }[] = [];
  const youtube = { prepare: (song: Track, signal: AbortSignal, startAt = 0) => new Promise<PreparedAudio>((resolve, reject) => preparations.push({ track: song, signal, startAt, resolve, reject })) } as unknown as YouTube;
  const message = { id: 'message', edit: async () => message };
  const channel = { id: 'text', send: async () => message } as unknown as GuildTextBasedChannel;
  let closures = 0;
  const session = new MusicSession(channel, youtube, 10, 180000, () => closures++);
  return { session, preparations, closures: () => closures };
}

test('effects restore the same music resource and stop cannot resurrect playback', async () => {
  const h = harness();
  const subscriptions: AudioPlayer[] = [];
  h.session.connection = { state: { status: VoiceConnectionStatus.Ready },
    subscribe: (player: AudioPlayer) => { subscriptions.push(player); }, destroy: () => {} } as unknown as VoiceConnection;
  try {
    h.session.add([track('a'), track('b')]);
    await attachAudio(h, 0, 30);
    h.session.status = 'playing';
    const effect = h.session.playEffect(Buffer.alloc(48000 * 4));
    assert.equal(h.session.effectPlaying, true); assert.equal(h.session.status, 'paused');
    h.session.stopEffect(); await effect;
    assert.equal(h.session.status, 'playing'); assert.equal(h.session.queue.current?.id, 'a');
    assert.equal(h.preparations.length, 1); assert.equal(subscriptions.at(-1), h.session.player);
    const nextEffect = h.session.playEffect(Buffer.alloc(48000 * 4));
    h.session.close('stop'); await nextEffect;
    assert.equal(h.session.effectPlaying, false); assert.equal(h.session.status, 'stopped');
    assert.equal(h.session.queue.size, 0);
  } finally { h.session.close('cleanup'); }
});

test('streaming speech cancellation destroys its source and restores music; stream errors are reported', async () => {
  const h = harness();
  h.session.connection = { state: { status: VoiceConnectionStatus.Ready }, subscribe: () => {}, destroy: () => {} } as unknown as VoiceConnection;
  try {
    h.session.add([track('a')]); await attachAudio(h, 0, 10); h.session.status = 'playing';
    const input = new PassThrough(), controller = new AbortController(); input.write(Buffer.alloc(23040));
    const played = h.session.playEffect(input, controller.signal); assert.equal(h.session.status, 'paused');
    controller.abort(); await played; assert.equal(input.destroyed, true); assert.equal(h.session.status, 'playing');
    const failed = new PassThrough(); const pending = h.session.playEffect(failed); const rejected = assert.rejects(pending, /stream failed/);
    failed.destroy(new Error('stream failed')); await rejected; assert.equal(h.session.status, 'playing');
  } finally { h.session.close('cleanup'); }
});
test('an effect does not unpause music that was already paused', async () => {
  const h = harness();
  h.session.connection = { state: { status: VoiceConnectionStatus.Ready }, subscribe: () => {}, destroy: () => {} } as unknown as VoiceConnection;
  try {
    h.session.add([track('a')]); await attachAudio(h, 0, 10);
    h.session.status = 'paused';
    const effect = h.session.playEffect(Buffer.alloc(48000 * 4)); h.session.stopEffect(); await effect;
    assert.equal(h.session.status, 'paused'); assert.equal(h.preparations.length, 1);
  } finally { h.session.close('cleanup'); }
});

test('loop cancellation restores music and an old loop cannot stop its replacement', async () => {
  const h = harness();
  h.session.connection = { state: { status: VoiceConnectionStatus.Ready }, subscribe: () => {}, destroy: () => {} } as unknown as VoiceConnection;
  try {
    h.session.add([track('a'), track('b')]); await attachAudio(h, 0, 10);
    h.session.status = 'playing';
    const canceled = new AbortController();
    const loop = h.session.playEffect(Buffer.alloc(48000 * 4), canceled.signal, { loop: true });
    assert.equal(h.session.status, 'paused'); assert.equal(h.session.effectPlaying, true);
    canceled.abort(); await loop;
    assert.equal(h.session.status, 'playing'); assert.equal(h.session.effectPlaying, false);
    assert.equal(h.session.queue.current?.id, 'a'); assert.equal(h.preparations.length, 1);

    const old = new AbortController();
    const oldLoop = h.session.playEffect(Buffer.alloc(48000 * 4), old.signal, { loop: true });
    const reply = h.session.playEffect(Buffer.alloc(48000 * 4));
    old.abort(); await oldLoop;
    assert.equal(h.session.effectPlaying, true);
    h.session.stopEffect(); await reply;
    assert.equal(h.session.status, 'playing'); assert.equal(h.session.queue.current?.id, 'a');
    await assert.rejects(h.session.playEffect(Buffer.alloc(0), undefined, { loop: true }), /complete stereo/);
  } finally { h.session.close('cleanup'); }
});

test('skip during lookup cancels stale playback; stop cannot resurrect a song', async () => {
  const h = harness();
  try {
    h.session.add([track('a'), track('b')]);
    const first = h.preparations[0]!;
    h.session.control('next');
    assert.equal(first.signal.aborted, true);
    assert.equal(h.session.queue.current?.id, 'b');
    let disposed = 0;
    const stale = createAudioResource(new PassThrough(), { inputType: StreamType.Opus, metadata: track('a') });
    first.resolve({ resource: stale, dispose: () => { disposed++; stale.playStream.destroy(); } });
    await flush(); await flush();
    assert.equal(disposed, 1); assert.equal(h.session.queue.current?.id, 'b');
    h.session.close('test'); h.session.close('again');
    assert.equal(h.preparations[1]!.signal.aborted, true);
    const late = createAudioResource(new PassThrough(), { inputType: StreamType.Opus, metadata: track('b') });
    h.preparations[1]!.resolve({ resource: late, dispose: () => { disposed++; late.playStream.destroy(); } });
    await flush(); await flush();
    assert.equal(disposed, 2); assert.equal(h.session.status, 'stopped');
    assert.equal(h.session.queue.size, 0); assert.equal(h.closures(), 1);
  } finally { h.session.close('cleanup'); }
});

test('brief packet starvation buffers instead of ending the song', { timeout: 5000 }, async () => {
  const packets = new PassThrough({ objectMode: true });
  const resource = createAudioResource(packets, { inputType: StreamType.Opus, metadata: track('buffered') });
  const player = createMusicPlayer(NoSubscriberBehavior.Play);
  try {
    packets.write(Buffer.from([0xf8, 0xff, 0xfe]));
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 1000);
    await delay(350); // The library's 100 ms default would have stopped already.
    assert.equal(player.state.status, AudioPlayerStatus.Playing);
    packets.end(Buffer.from([0xf8, 0xff, 0xfe]));
    await entersState(player, AudioPlayerStatus.Idle, 1000);
    assert.equal(resource.playbackDuration, 40);
  } finally { player.stop(true); packets.destroy(); }
});

async function attachAudio(h: ReturnType<typeof harness>, index: number, playedSeconds: number) {
  const request = h.preparations[index]!;
  const packets = new PassThrough({ objectMode: true });
  const resource = createAudioResource(packets, { inputType: StreamType.Opus, metadata: request.track });
  resource.playbackDuration = playedSeconds * 1000;
  request.resolve({ resource, dispose: () => packets.destroy() });
  await flush(); await flush();
  return { packets, resource };
}

test('network errors resume the same song twice before advancing, without double skips', { timeout: 8000 }, async () => {
  const h = harness();
  try {
    h.session.add([track('a'), track('b'), track('c')]);
    const first = await attachAudio(h, 0, 66);
    first.packets.destroy(new PlaybackError('Interrupted stream', 'YOUTUBE_CONNECTION'));
    await flush(); await flush();
    assert.equal(h.session.queue.current?.id, 'a');
    assert.match(h.session.notice!, /Reconnecting.*1\/2/);
    await delay(1050);
    assert.equal(h.preparations[1]?.track.id, 'a');
    assert.equal(h.preparations[1]?.startAt, 65.75);
    const second = await attachAudio(h, 1, 10);
    second.packets.destroy(new PlaybackError('Interrupted stream', 'YOUTUBE_CONNECTION'));
    await flush(); await flush(); await delay(2050);
    assert.equal(h.preparations[2]?.track.id, 'a');
    assert.equal(h.preparations[2]?.startAt, 75.5);
    const third = await attachAudio(h, 2, 1);
    third.packets.destroy(new PlaybackError('Interrupted stream', 'YOUTUBE_CONNECTION'));
    await flush(); await flush();
    assert.equal(h.session.queue.current?.id, 'b');
    assert.equal(h.preparations.length, 4);
    assert.equal(h.preparations[3]?.startAt, 0);
    assert.match(h.session.notice!, /after 2 retries/);
    assert.deepEqual(h.session.queue.upcoming.map(song => song.id), ['c']);
  } finally { h.session.close('cleanup'); }
});

test('stop and next cancel pending reconnects and cannot restart the old song', { timeout: 5000 }, async () => {
  for (const control of ['stop', 'next']) {
    const h = harness();
    try {
      h.session.add([track('a'), track('b')]);
      const audio = await attachAudio(h, 0, 20);
      audio.packets.destroy(new PlaybackError('Interrupted stream', 'YOUTUBE_CONNECTION'));
      await flush(); await flush();
      h.session.control(control);
      await delay(1100);
      assert.equal(h.preparations.length, control === 'stop' ? 1 : 2);
      assert.equal(h.session.queue.current?.id, control === 'stop' ? undefined : 'b');
      if (control === 'next') assert.equal(h.preparations[1]?.startAt, 0);
    } finally { h.session.close('cleanup'); }
  }
});

test('premature EOF retries; complete audio advances normally', async () => {
  for (const played of [20, 100]) {
    const h = harness();
    try {
      h.session.add([track('a'), track('b')]);
      await attachAudio(h, 0, played);
      // Exercise the real player->Idle event with the simulated played duration.
      h.session.player.stop(true);
      await flush(); await flush();
      assert.equal(h.session.queue.current?.id, played === 20 ? 'a' : 'b');
      if (played === 20) assert.match(h.session.notice!, /Reconnecting/);
    } finally { h.session.close('cleanup'); }
  }
});

test('a failed song advances to the next queued song', async () => {
  const h = harness();
  try {
    h.session.add([track('bad'), track('good')]);
    h.preparations[0]!.reject(new Error('expected'));
    await flush(); await flush();
    assert.equal(h.session.queue.current?.id, 'good');
    assert.equal(h.preparations.length, 2);
    assert.match(h.session.notice!, /Skipped bad/);
  } finally { h.session.close('cleanup'); }
});

test('users outside the bot channel cannot control it; stage channels are rejected', () => {
  const h = harness();
  try {
    h.session.voice = { id: 'voice-a' } as VoiceChannel;
    const member = { voice: { channel: { id: 'voice-b', type: ChannelType.GuildVoice } } } as GuildMember;
    assert.throws(() => h.session.assertMember(member), /bot’s voice channel/);
    assert.throws(() => requireVoice({ voice: { channel: { type: ChannelType.GuildStageVoice } } } as GuildMember), /regular voice/);
  } finally { h.session.close('cleanup'); }
});
