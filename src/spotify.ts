import { randomUUID } from 'node:crypto';
import { UserError, type ImportResult, type Track } from './model.js';
import { parseInput, type ParsedInput } from './input.js';

interface SpotifyTrack {
  id?: string; name?: string; type?: string; is_local?: boolean;
  artists?: { name: string }[]; duration_ms?: number;
  external_urls?: { spotify?: string };
  album?: { images?: { url: string }[] };
}
interface Page<T> { items?: T[]; next?: string | null; total?: number }
interface PlaylistItem { track?: SpotifyTrack | null; item?: SpotifyTrack | null; is_local?: boolean }
interface SpotifyOptions {
  clientId: string; clientSecret: string; refreshToken: string; market: string;
  fetch?: typeof fetch;
  onRefreshToken?: (token: string) => void;
  privatePlaylistUsers?: string[];
}

export class Spotify {
  private accessToken = '';
  private expiresAt = 0;
  private refreshing?: Promise<string>;
  private readonly request: typeof fetch;
  constructor(private readonly options: SpotifyOptions) { this.request = options.fetch || fetch; }

  allowPrivatePlaylistsFor(discordUserId: string): void {
    this.options.privatePlaylistUsers = [...new Set([...(this.options.privatePlaylistUsers || []), discordUserId])];
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchToken();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.options;
    if (!clientId || !clientSecret) throw new UserError('Spotify is not configured yet. The host needs to set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET. YouTube links and song searches still work.');
    const body = new URLSearchParams(refreshToken
      ? { grant_type: 'refresh_token', refresh_token: refreshToken }
      : { grant_type: 'client_credentials' });
    const response = await this.request('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new UserError('Spotify authentication failed. Check the app credentials, Premium status, or run npm run spotify:login again.');
    const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
    if (!data.access_token) throw new UserError('Spotify did not return an access token.');
    this.accessToken = data.access_token;
    if (data.refresh_token && data.refresh_token !== this.options.refreshToken) {
      this.options.refreshToken = data.refresh_token;
      this.options.onRefreshToken?.(data.refresh_token);
    }
    this.expiresAt = Date.now() + Math.max(1, (data.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    const url = new URL(path, 'https://api.spotify.com/v1/');
    // Pagination URLs are provider data, never an arbitrary destination for credentials.
    if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw new UserError('Spotify returned an invalid pagination link.');
    const response = await this.request(url, {
      headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 && !retried) {
      this.accessToken = '';
      return this.get<T>(path, true);
    }
    if (response.status === 429) {
      const data = await response.json().catch(() => ({})) as { error?: { reason?: string }; reason?: string };
      if ((data.reason || data.error?.reason) === 'QUOTA_EXCEEDED') throw new UserError('The Spotify developer account has used its API quota. Try a YouTube link or song name.');
      const retry = Number(response.headers.get('retry-after')) || 30;
      throw new UserError(`Spotify is rate limiting requests. Try again in ${Math.min(retry, 86400)} seconds.`);
    }
    if (response.status === 403) throw new UserError('Spotify denied access. For playlists, sign in as the owner or a collaborator using npm run spotify:login. Also check the app owner has Premium and the account is allowed in the app dashboard.');
    if (response.status === 404) throw new UserError('Spotify could not find that item, or it is not accessible to the connected account.');
    if (!response.ok) throw new UserError(`Spotify is unavailable (HTTP ${response.status}). Try again later.`);
    return await response.json() as T;
  }

  async expandShortLink(url: string): Promise<ParsedInput> {
    let current = url;
    for (let i = 0; i < 5; i++) {
      const parsed = new URL(current);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['spotify.link', 'open.spotify.com'].includes(parsed.hostname)) {
        throw new UserError('That short link leaves Spotify. Use the full open.spotify.com link instead.');
      }
      if (parsed.hostname === 'open.spotify.com') return parseInput(parsed.href);
      const response = await this.request(parsed, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      current = new URL(location, current).href;
    }
    throw new UserError('Could not expand that Spotify short link. Use the full open.spotify.com link.');
  }

  async import(input: Extract<ParsedInput, { kind: 'spotify' }>, requestedBy: string, limit: number): Promise<ImportResult> {
    const market = encodeURIComponent(this.options.market);
    const tracks: Track[] = [];
    let skipped = 0;
    let truncated = false;
    const add = (item: SpotifyTrack | null | undefined, thumbnail?: string) => {
      if (!item?.id || !item.name || item.is_local || (item.type && item.type !== 'track')) { skipped++; return; }
      tracks.push({
        id: randomUUID(), title: item.name, artist: item.artists?.map(x => x.name).join(', ') || 'Unknown artist',
        artists: item.artists?.map(x => x.name),
        durationSeconds: Math.round((item.duration_ms || 0) / 1000),
        url: `https://open.spotify.com/track/${item.id}`,
        thumbnail: item.album?.images?.[0]?.url || thumbnail,
        source: 'spotify', requestedBy,
      });
    };
    if (input.type === 'track') {
      add(await this.get<SpotifyTrack>(`tracks/${input.id}?market=${market}`));
      if (!tracks.length) throw new UserError('That Spotify track is unavailable.');
      return { tracks, label: tracks[0]!.title };
    }
    let label: string;
    if (input.type === 'album') {
      const album = await this.get<{ name: string; images?: { url: string }[]; tracks: Page<SpotifyTrack> }>(`albums/${input.id}?market=${market}`);
      label = album.name;
      let page: Page<SpotifyTrack> = album.tracks;
      for (let pages = 0; pages < 30; pages++) {
        for (const track of page.items || []) {
          if (tracks.length >= limit) { truncated = true; break; }
          add(track, album.images?.[0]?.url);
        }
        if (!page.next) break;
        if (tracks.length >= limit || pages === 29) { truncated = true; break; }
        page = await this.get<Page<SpotifyTrack>>(page.next);
      }
    } else {
      if (!this.options.refreshToken) throw new UserError('Playlist import needs Spotify sign-in. The host should run npm run spotify:login once using the playlist owner or collaborator account.');
      const playlist = await this.get<{ name: string; public?: boolean; items?: Page<PlaylistItem>; tracks?: Page<PlaylistItem> }>(`playlists/${input.id}?market=${market}`);
      if (playlist.public === false && !this.options.privatePlaylistUsers?.includes(requestedBy)) {
        throw new UserError('Only the bot owner or a host-approved user can import the connected Spotify account’s private playlists. Public playlist links can be requested by everyone in voice.');
      }
      label = playlist.name;
      let page = playlist.items || playlist.tracks;
      if (!page?.items) page = await this.get<Page<PlaylistItem>>(`playlists/${input.id}/items?limit=50&market=${market}`);
      for (let pages = 0; pages < 30; pages++) {
        for (const entry of page.items || []) {
          if (tracks.length >= limit) { truncated = true; break; }
          if (entry.is_local) { skipped++; continue; }
          add(entry.item ?? entry.track);
        }
        if (!page.next) break;
        if (tracks.length >= limit || pages === 29) { truncated = true; break; }
        page = await this.get<Page<PlaylistItem>>(page.next);
      }
    }
    if (!tracks.length) throw new UserError('No accessible songs were found. Local files, podcasts, and removed tracks cannot be imported.');
    const notice = [truncated ? `Imported the first ${tracks.length} songs (queue limit).` : '', skipped ? `Skipped ${skipped} unavailable/local/non-song items.` : ''].filter(Boolean).join(' ');
    return { tracks, label, notice: notice || undefined };
  }
}
