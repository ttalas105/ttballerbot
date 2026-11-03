import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spotify } from '../src/spotify.js';

const id = '6rqhFgbbKwnb9MLmUQDhG6';
const track = (name = 'Song') => ({ id, name, type: 'track', artists: [{ name: 'Artist' }], duration_ms: 180000 });
const response = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers });
function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, refreshToken = 'test-refresh') {
  return new Spotify({ clientId: 'test-client', clientSecret: 'test-secret', refreshToken, market: 'CA',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch });
}

test('imports new playlist item schema, paginates, skips local/removed/podcast entries', async () => {
  const urls: string[] = [];
  const spotify = client(url => {
    urls.push(url);
    if (url.includes('/api/token')) return response({ access_token: 'access', expires_in: 3600 });
    if (url.includes('offset=2')) return response({ items: [{ item: track('Second') }, { item: { ...track(), type: 'episode' } }], next: null });
    return response({ name: 'Playlist', items: { items: [{ item: track('First') }, { item: null }, { item: { ...track(), is_local: true } }], next: 'https://api.spotify.com/v1/playlists/x/items?offset=2' } });
  });
  const result = await spotify.import({ kind: 'spotify', type: 'playlist', id }, 'user', 20);
  assert.deepEqual(result.tracks.map(t => t.title), ['First', 'Second']);
  assert.match(result.notice!, /Skipped 3/);
  assert.equal(urls.filter(url => url.includes('/api/token')).length, 1);
});

test('supports legacy playlist schema and stops paging at the queue limit', async () => {
  let pages = 0;
  const spotify = client(url => {
    if (url.includes('/api/token')) return response({ access_token: 'access' });
    pages++;
    return response({ name: 'Playlist', tracks: { items: [{ track: track('A') }, { track: track('B') }], next: 'https://api.spotify.com/v1/playlists/x/tracks?offset=2' } });
  });
  const result = await spotify.import({ kind: 'spotify', type: 'playlist', id }, 'user', 1);
  assert.equal(pages, 1); assert.equal(result.tracks.length, 1); assert.match(result.notice!, /first 1/);
});

test('requires user sign-in for playlists but supports client credentials for tracks', async () => {
  let grant = '';
  const spotify = client((url, init) => {
    if (url.includes('/api/token')) { grant = String(init?.body); return response({ access_token: 'access' }); }
    return response(track());
  }, '');
  await assert.rejects(spotify.import({ kind: 'spotify', type: 'playlist', id }, 'u', 10), /sign-in/);
  const result = await spotify.import({ kind: 'spotify', type: 'track', id }, 'u', 10);
  assert.equal(result.tracks.length, 1); assert.match(grant, /client_credentials/);
});

test('refreshes once on expired token', async () => {
  let tokens = 0; let requests = 0;
  const spotify = client(url => {
    if (url.includes('/api/token')) { tokens++; return response({ access_token: `access${tokens}` }); }
    requests++; return requests === 1 ? response({}, 401) : response(track());
  });
  await spotify.import({ kind: 'spotify', type: 'track', id }, 'u', 10);
  assert.equal(tokens, 2); assert.equal(requests, 2);
});

test('rate limits and quota errors produce distinct useful responses', async () => {
  for (const [data, pattern] of [[{ error: { reason: 'QUOTA_EXCEEDED' } }, /quota/], [{}, /12 seconds/]] as const) {
    const spotify = client(url => url.includes('/api/token') ? response({ access_token: 'access' }) : response(data, 429, { 'retry-after': '12' }));
    await assert.rejects(spotify.import({ kind: 'spotify', type: 'track', id }, 'u', 10), pattern);
  }
});

test('pagination and short-link redirects cannot leak credentials to another host', async () => {
  const fetched: string[] = [];
  const spotify = client(url => {
    fetched.push(url);
    if (url.includes('/api/token')) return response({ access_token: 'access' });
    if (url.includes('spotify.link')) return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    return response({ name: 'Playlist', items: { items: [{ item: track() }], next: 'https://evil.test/collect' } });
  });
  await assert.rejects(spotify.import({ kind: 'spotify', type: 'playlist', id }, 'u', 10), /pagination/);
  await assert.rejects(spotify.expandShortLink('https://spotify.link/example'), /leaves Spotify/);
  assert.ok(fetched.every(url => !url.includes('evil.test')));
});

test('album tracks retain artwork across pagination', async () => {
  const spotify = client(url => {
    if (url.includes('/api/token')) return response({ access_token: 'access' });
    if (url.includes('offset=1')) return response({ items: [track('B')], next: null });
    return response({ name: 'Album', images: [{ url: 'https://example.com/cover.jpg' }], tracks: { items: [track('A')], next: 'https://api.spotify.com/v1/albums/x/tracks?offset=1' } });
  });
  const result = await spotify.import({ kind: 'spotify', type: 'album', id }, 'u', 10);
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[1]?.thumbnail, 'https://example.com/cover.jpg');
});

test('private playlists are restricted to the connected account’s approved Discord users', async () => {
  const spotify = client(url => url.includes('/api/token') ? response({ access_token: 'access' })
    : response({ name: 'Private playlist', public: false, items: { items: [{ item: track() }], next: null } }));
  await assert.rejects(spotify.import({ kind: 'spotify', type: 'playlist', id }, 'stranger', 5), /private playlists/);
  spotify.allowPrivatePlaylistsFor('owner');
  assert.equal((await spotify.import({ kind: 'spotify', type: 'playlist', id }, 'owner', 5)).tracks.length, 1);
});

test('rotated refresh tokens are persisted through the configured callback', async () => {
  let saved = '';
  const spotify = new Spotify({ clientId: 'id', clientSecret: 'secret', refreshToken: 'old', market: 'CA',
    onRefreshToken: token => { saved = token; },
    fetch: (async (url: string | URL | Request) => String(url).includes('/api/token')
      ? response({ access_token: 'access', refresh_token: 'new' }) : response(track())) as typeof fetch,
  });
  await spotify.import({ kind: 'spotify', type: 'track', id }, 'owner', 1);
  assert.equal(saved, 'new');
});
