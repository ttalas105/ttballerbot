import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../src/input.js';
const id = '6rqhFgbbKwnb9MLmUQDhG6';

test('Spotify share links, localized links, and URIs parse consistently', () => {
  for (const input of [`https://open.spotify.com/track/${id}?si=ignored`, `https://open.spotify.com/intl-de/track/${id}`, `spotify:track:${id}`, `<https://open.spotify.com/track/${id}>`]) {
    assert.deepEqual(parseInput(input), { kind: 'spotify', type: 'track', id });
  }
  assert.equal(parseInput(`https://open.spotify.com/playlist/${id}`).kind, 'spotify');
  assert.equal(parseInput(`https://open.spotify.com/album/${id}`).kind, 'spotify');
});

test('YouTube links are canonicalized and playlist/tracking parameters removed', () => {
  for (const input of ['https://youtu.be/BaW_jenozKc?t=3', 'https://music.youtube.com/watch?v=BaW_jenozKc&list=anything', 'https://www.youtube.com/shorts/BaW_jenozKc']) {
    assert.deepEqual(parseInput(input), { kind: 'youtube', url: 'https://www.youtube.com/watch?v=BaW_jenozKc' });
  }
});

test('untrusted URLs and protocols never become server-side fetches', () => {
  for (const input of ['file:///etc/passwd', 'http://localhost/a', 'https://127.0.0.1/test', 'https://open.spotify.com.evil.test/track/' + id,
    'https://user:password@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com:444/watch?v=BaW_jenozKc', 'https://youtube.com/playlist?list=1', 'spotify:episode:' + id]) {
    assert.throws(() => parseInput(input), input);
  }
});

test('song names remain plain search queries', () => {
  assert.deepEqual(parseInput('  An artist - a song  '), { kind: 'search', query: 'An artist - a song' });
  assert.throws(() => parseInput(''));
  assert.throws(() => parseInput('x'.repeat(501)));
});
