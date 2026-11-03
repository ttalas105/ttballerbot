import { UserError } from './model.js';

export type ParsedInput =
  | { kind: 'spotify'; type: 'track' | 'album' | 'playlist'; id: string }
  | { kind: 'spotify-short'; url: string }
  | { kind: 'youtube'; url: string }
  | { kind: 'search'; query: string };

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim().replace(/^<(.+)>$/, '$1');
  if (!input || input.length > 500) throw new UserError('Enter a song name or a Spotify/YouTube link (up to 500 characters).');
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return { kind: 'spotify', type: uri[1] as 'track' | 'album' | 'playlist', id: uri[2]! };
  if (input.startsWith('spotify:')) throw new UserError('Use a Spotify song, album, or playlist link.');
  if (!/^https?:\/\//i.test(input)) {
    if (/^[a-z][\w+.-]*:/i.test(input)) throw new UserError('Use a song name or an HTTPS Spotify/YouTube link.');
    return { kind: 'search', query: input };
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new UserError('That link is not valid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new UserError('Use an HTTPS Spotify or YouTube link without a custom port.');
  }
  if (url.hostname === 'spotify.link') return { kind: 'spotify-short', url: url.href };
  if (url.hostname === 'open.spotify.com') {
    const match = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    if (!match) throw new UserError('Use a Spotify song, album, or playlist link.');
    return { kind: 'spotify', type: match[1] as 'track' | 'album' | 'playlist', id: match[2]! };
  }
  if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
    const videoId = url.hostname === 'youtu.be' ? url.pathname.slice(1)
      : url.searchParams.get('v') || /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1];
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      throw new UserError('Use a link to one YouTube video. Spotify playlist and album links can queue multiple songs.');
    }
    return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}` };
  }
  throw new UserError('Supported sources: Spotify songs/albums/playlists, YouTube videos, or song names.');
}
