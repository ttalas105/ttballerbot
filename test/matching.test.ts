import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpotifyMatch, type Video } from '../src/youtube.js';
import type { Track } from '../src/model.js';

const meditate: Track = {
  id: 'meditate', title: 'Meditate (feat. J.I.D.)', artist: 'EARTHGANG, JID', artists: ['EARTHGANG', 'JID'],
  durationSeconds: 278, url: 'https://open.spotify.com/track/example', source: 'spotify', requestedBy: '123',
};
// Search results observed when reproducing the reported playlist bug.
const actualResults: Video[] = [
  { id: 'BPNNuiPIYnI', title: 'EARTHGANG - WATERBOYZ (feat. J.I.D, J. Cole) [Official Audio] ft. JID', channel: 'EARTHGANG', duration: 304 },
  { id: 'Xa4tmv_RCjQ', title: 'EARTHGANG - Mediate (Audio)', channel: 'EARTHGANG', duration: 280 },
  { id: 'qngQ-mKN5XM', title: 'JID - D/vision ft. EARTHGANG', channel: 'JID', duration: 252 },
  { id: 'skw3kUycvpo', title: 'EARTHGANG - Meditate ft. J.I.D.', channel: 'EARTHGANG', duration: 241 },
];

test('Meditate never resolves to WATERBOYZ despite shared artists and similar duration', () => {
  assert.equal(selectSpotifyMatch(actualResults, meditate)?.id, 'skw3kUycvpo');
});

test('unrelated search results produce no match instead of an arbitrary first result', () => {
  assert.equal(selectSpotifyMatch(actualResults.slice(0, 3), meditate), undefined);
});

test('matching rejects pitch edits, remixes, live versions, and long compilations', () => {
  const variants = ['(432hz)', '(Remix)', '(Live)', '(slowed + reverb)', '(Instrumental)', '(Official Meaning)'];
  const videos = variants.map(suffix => ({ id: 'ikQLMOYutEU', title: `EARTHGANG - Meditate ${suffix}`, channel: 'EARTHGANG', duration: 278 }));
  videos.push({ id: '9tlI1ksIZt0', title: 'EARTHGANG - Meditate', channel: 'EARTHGANG', duration: 340 });
  assert.equal(selectSpotifyMatch(videos, meditate), undefined);
  assert.equal(selectSpotifyMatch([...videos, actualResults[3]!], meditate)?.id, 'skw3kUycvpo');
});

test('title and primary artist are mandatory even when another artist has the same title', () => {
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'Meditate', channel: 'JID - Topic', duration: 278 }], meditate), undefined);
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'Meditate', channel: 'EARTHGANG - Topic', duration: 278 }], meditate)?.id, 'skw3kUycvpo');
});

test('short titles use whole words, never substrings or words found only in the channel', () => {
  const song = { ...meditate, title: 'NEVER', artist: 'JID', artists: ['JID'], durationSeconds: 242 };
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'JID - Neverending', duration: 242 }], song), undefined);
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'JID - Other Song', channel: 'NEVER', duration: 242 }], song), undefined);
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'J.I.D. - NEVER (Official Audio)', duration: 242 }], song)?.id, 'skw3kUycvpo');
});

test('matching handles punctuation, accents, and artist names containing commas', () => {
  const song = { ...meditate, title: 'September (feat. Beyoncé)', artist: 'Earth, Wind & Fire, Beyoncé', artists: ['Earth, Wind & Fire', 'Beyoncé'], durationSeconds: 215 };
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'Earth - September', duration: 215 }], song), undefined);
  assert.equal(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'Earth, Wind & Fire - September ft. Beyonce', duration: 215 }], song)?.id, 'skw3kUycvpo');
  const accented = { ...song, title: 'Déjà Vu', artist: 'Beyoncé', artists: ['Beyoncé'] };
  assert.ok(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'Beyonce - Deja Vu', duration: 215 }], accented));
});

test('explicitly requested alternate versions remain playable', () => {
  const song = { ...meditate, title: 'Meditate (Remix)' };
  assert.ok(selectSpotifyMatch([{ id: 'skw3kUycvpo', title: 'EARTHGANG - Meditate (Remix)', duration: 278 }], song));
});

test('invalid IDs and live streams cannot be selected even with identical metadata', () => {
  assert.equal(selectSpotifyMatch([
    { id: 'invalid', title: 'EARTHGANG - Meditate', duration: 278 },
    { id: 'skw3kUycvpo', title: 'EARTHGANG - Meditate', duration: 278, is_live: true },
  ], meditate), undefined);
});
