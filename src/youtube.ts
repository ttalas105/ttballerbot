import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import { PlaybackError, UserError, type Track } from './model.js';

const exec = promisify(execFile);
export interface Video {
  id?: string; title?: string; uploader?: string; channel?: string; duration?: number;
  thumbnail?: string; url?: string; webpage_url?: string; is_live?: boolean;
  entries?: Video[];
}
export interface PreparedAudio { resource: AudioResource<Track>; dispose: () => void }

export class YouTube {
  constructor(private readonly ytdlp: string, private readonly ffmpeg: string) {}

  private async metadata(input: string, flat: boolean, signal?: AbortSignal): Promise<Video> {
    try {
      const { stdout } = await exec(this.ytdlp, [
        '--ignore-config', '--no-warnings', '--no-playlist', '--dump-single-json',
        '--no-progress', '--skip-download', '--socket-timeout', '15', '--retries', '1',
        '--js-runtimes', `node:${process.execPath}`,
        ...(flat ? ['--flat-playlist'] : ['-f', 'bestaudio/best']), '--', input,
      ], { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal });
      return JSON.parse(stdout) as Video;
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new UserError('yt-dlp is missing. The host should run npm run tools:install.');
      throw new UserError('YouTube could not load this song. It may be restricted, unavailable, or blocked on this network. Try a direct YouTube link; the host can update yt-dlp with npm run tools:install.');
    }
  }

  async lookup(query: string, requestedBy: string): Promise<Track> {
    const data = await this.metadata(query.startsWith('https:') ? query : `ytsearch1:${query}`, true);
    const video = data.entries?.[0] || data;
    if (!video.id || !/^[\w-]{11}$/.test(video.id) || !video.title) throw new UserError('No matching YouTube video was found.');
    if (video.is_live) throw new UserError('Use a song or a recorded video; live streams are not supported.');
    return {
      id: randomUUID(), title: video.title, artist: video.channel || video.uploader || 'YouTube',
      durationSeconds: video.duration || 0, url: `https://www.youtube.com/watch?v=${video.id}`,
      thumbnail: video.thumbnail, source: 'youtube', requestedBy,
    };
  }

  async prepare(track: Track, signal: AbortSignal, startAtSeconds = 0): Promise<PreparedAudio> {
    if (!Number.isFinite(startAtSeconds) || startAtSeconds < 0) throw new UserError('Invalid playback position.');
    let sourceUrl = track.source === 'youtube' ? track.url : track.playbackUrl;
    let title = track.playbackTitle || track.title;
    let duration = track.playbackDurationSeconds;
    if (!sourceUrl) {
      const match = await this.resolveSpotify(track, signal);
      sourceUrl = `https://www.youtube.com/watch?v=${match.id}`;
      title = match.title || track.title;
      duration = match.duration;
    }
    if (!/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(sourceUrl)) throw new UserError('Invalid YouTube playback link.');
    signal.throwIfAborted();
    track.playbackUrl = sourceUrl;
    track.playbackTitle = title;
    track.playbackDurationSeconds = duration;
    // yt-dlp handles YouTube's request headers, challenge signatures and pacing.
    // Piping bytes avoids fragile signed media URLs and never saves a song to disk.
    const downloader = spawn(this.ytdlp, [
      '--ignore-config', '--no-warnings', '--no-playlist', '--no-progress', '--no-part',
      '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3', '--abort-on-unavailable-fragments',
      '--js-runtimes', `node:${process.execPath}`,
      '--match-filter', '!is_live', '-f', 'bestaudio/best', '-o', '-', '--', sourceUrl,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Let the network download ahead instead of keeping its connection blocked on
    // Discord's real-time consumption. This buffer is bounded and never written to disk.
    const compressed = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });
    downloader.stdout.pipe(compressed);
    // Output seeking decodes/discards the prefix of a non-seekable pipe on recovery.
    const inputArgs = ['-i', 'pipe:0', ...(startAtSeconds ? ['-ss', String(startAtSeconds)] : [])];
    const audio = createFfmpegAudio(this.ffmpeg, inputArgs, track, signal, compressed);
    let disposed = false;
    let failureCode = 'YOUTUBE_STREAM';
    let errorTail = '';
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(startupTimer);
      signal.removeEventListener('abort', dispose);
      downloader.stdout.unpipe(compressed);
      compressed.destroy();
      if (downloader.exitCode === null && !downloader.killed) {
        // On Windows the packaged downloader has a child process of its own.
        if (process.platform === 'win32' && downloader.pid) {
          execFile('taskkill.exe', ['/PID', String(downloader.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else downloader.kill();
      }
      audio.dispose();
    };
    const fail = () => { if (!disposed) audio.resource.playStream.destroy(new PlaybackError('YouTube interrupted the audio stream.', failureCode)); };
    downloader.on('error', error => { failureCode = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'YOUTUBE_TOOL_MISSING' : 'YOUTUBE_PROCESS'; fail(); });
    downloader.on('close', code => { if (code !== 0) fail(); });
    downloader.stderr.on('data', (chunk: Buffer) => {
      // Only an allowlisted category leaves this function, never provider URLs or text.
      errorTail = (errorTail + chunk.toString()).slice(-2048);
      failureCode = youtubeFailureCode(errorTail);
    });
    const startupTimer = setTimeout(() => { failureCode = 'YOUTUBE_STARTUP_TIMEOUT'; fail(); dispose(); }, 60_000);
    startupTimer.unref();
    audio.resource.playStream.once('readable', () => clearTimeout(startupTimer));
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) dispose();
    return { resource: audio.resource, dispose };
  }

  async resolveSpotify(track: Track, signal?: AbortSignal): Promise<Video> {
    const artist = primaryArtist(track);
    const title = songTitle(track.title);
    // Featured names used to dominate both search results and the match score.
    // Search the primary artist/song first, and never accept an unrelated top result.
    const queries = [`${artist} ${title} official audio`, `"${artist}" "${title}" audio`];
    for (const query of queries) {
      signal?.throwIfAborted();
      const result = await this.metadata(`ytsearch10:${query}`, true, signal);
      const match = selectSpotifyMatch(result.entries || [], track);
      if (match) return match;
    }
    throw new UserError('No confident YouTube match was found for this song. Try its direct YouTube link.');
  }
}

export function youtubeFailureCode(stderr: string): string {
  if (/\b403\b/.test(stderr)) return 'YOUTUBE_HTTP_403';
  if (/\b429\b/.test(stderr)) return 'YOUTUBE_HTTP_429';
  if (/timed?\s*out|timeout/i.test(stderr)) return 'YOUTUBE_TIMEOUT';
  if (/reset|connection|incomplete|remote.*closed/i.test(stderr)) return 'YOUTUBE_CONNECTION';
  if (/unavailable|private video|removed|not available/i.test(stderr)) return 'YOUTUBE_UNAVAILABLE';
  return 'YOUTUBE_STREAM';
}

function primaryArtist(track: Track): string { return track.artists?.[0] || track.artist.split(',')[0]!.trim(); }

function normalized(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/g, value => value.replace(/\./g, ''))
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function songTitle(title: string): string {
  return title.replace(/[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–—]\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?$/i, '').trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return !!phrase && ` ${text} `.includes(` ${phrase} `);
}

const alternateVersions = [
  /\b(?:remix|mashup|mix)\b/, /\b(?:live|concert)\b/, /\bcover\b/, /\bacoustic\b/,
  /\b(?:instrumental|karaoke)\b/, /\bslowed\b/, /\bsped\s*up\b/, /\bnightcore\b/,
  /\breverb\b/, /\bextended\b/, /\b(?:432|528)\s*hz\b/, /\b8d\b/,
  /\b(?:reaction|review|interview|tutorial|meaning|compilation)\b/,
];

export function matchScore(video: Video, track: Track): number {
  const title = normalized(video.title || '');
  const artist = normalized(primaryArtist(track));
  const channel = normalized(video.channel || video.uploader || '');
  const wanted = normalized(songTitle(track.title));
  // The song title must appear in the video title, not merely in the artist/channel.
  // Whole phrases prevent short titles such as "NEVER" matching "Neverending".
  if (video.is_live || !containsPhrase(title, wanted)
    || (!containsPhrase(title, artist) && !containsPhrase(channel, artist))) return -Infinity;
  const requestedTitle = normalized(track.title);
  if (alternateVersions.some(version => version.test(title) && !version.test(requestedTitle))) return -Infinity;
  const knownDuration = Number.isFinite(video.duration) && (video.duration || 0) > 0 && track.durationSeconds > 0;
  const difference = knownDuration ? Math.abs(track.durationSeconds - video.duration!) : 0;
  if (knownDuration && difference > Math.max(12, Math.min(45, track.durationSeconds * 0.15))) return -Infinity;
  return 100 + (containsPhrase(channel, artist) ? 25 : 0)
    + (/\b(?:official|topic)\b/.test(`${title} ${channel}`) ? 5 : 0)
    - (knownDuration ? difference / 2 : 25);
}

export function selectSpotifyMatch(videos: Video[], track: Track): Video | undefined {
  return videos.filter(video => video.id && /^[\w-]{11}$/.test(video.id))
    .map(video => ({ video, score: matchScore(video, track) }))
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score)[0]?.video;
}

export function createFfmpegAudio(ffmpeg: string, inputArgs: string[], track: Track, signal?: AbortSignal, input?: Readable): PreparedAudio {
  const output = new PassThrough({ highWaterMark: 1024 * 1024 });
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs,
    '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let disposed = false;
  let failureCode = '';
  const fail = () => {
    if (!disposed) output.destroy(new PlaybackError('Audio playback failed. The decoder stopped unexpectedly.', failureCode || 'FFMPEG_DECODE'));
  };
  child.on('error', fail);
  child.stdin.on('error', () => { /* FFmpeg may close stdin after stop or decoder failure. */ });
  if (input) input.pipe(child.stdin); else child.stdin.end();
  child.stderr.on('data', (chunk: Buffer) => {
    // Keep only a status category, never the signed media URL in stderr.
    const code = /(?:HTTP error |Server returned )(\d{3})/.exec(chunk.toString())?.[1];
    if (code) failureCode = `FFMPEG_HTTP_${code}`;
  });
  child.on('close', code => {
    if (disposed) return;
    if (code !== 0) fail(); else output.end();
  });
  // A failing process can close stdout before emitting its exit code.
  child.stdout.pipe(output, { end: false });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    child.stdout.unpipe(output);
    input?.unpipe(child.stdin);
    child.kill();
    output.destroy();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  const resource = createAudioResource(output, { inputType: StreamType.OggOpus, metadata: track });
  return { resource, dispose };
}
