import { config } from '../src/config.js';
import { Spotify } from '../src/spotify.js';
import { userMessage } from '../src/model.js';
try {
  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.spotifyRefreshToken }),
  });
  const data = await tokenResponse.json() as { access_token?: string };
  if (!tokenResponse.ok || !data.access_token) throw new Error('Token refresh failed.');
  console.log('PASS: Spotify refresh token works.');
  const headers = { Authorization: `Bearer ${data.access_token}` };
  const profileResponse = await fetch('https://api.spotify.com/v1/me', { headers, signal: AbortSignal.timeout(15000) });
  const playlistsResponse = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', { headers, signal: AbortSignal.timeout(15000) });
  if (!profileResponse.ok || !playlistsResponse.ok) throw new Error('Spotify profile/playlist access failed.');
  const profile = await profileResponse.json() as { id?: string };
  const playlists = await playlistsResponse.json() as { items?: { id: string; owner?: { id: string } }[] };
  const own = playlists.items?.find(playlist => playlist.owner?.id === profile.id);
  if (!own) console.log('Playlist access works, but no owned playlist was found in the first page to test an import.');
  else {
    const spotify = new Spotify({ clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret, refreshToken: config.spotifyRefreshToken, market: config.market, privatePlaylistUsers: ['local-smoke-test'] });
    const result = await spotify.import({ kind: 'spotify', type: 'playlist', id: own.id }, 'local-smoke-test', 5);
    console.log(`PASS: Imported ${result.tracks.length} songs from an owned playlist. No playlist content was posted to Discord.`);
  }
} catch (error) { console.error(userMessage(error)); console.error(`Spotify smoke check failed (${error instanceof Error ? error.name : 'unknown'}).`); process.exitCode = 1; }
