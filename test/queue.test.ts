import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicQueue, SerialExecutor } from '../src/queue.js';
import type { Track } from '../src/model.js';

export const song = (id: string): Track => ({ id, title: id, artist: 'Artist', durationSeconds: 180,
  url: 'https://www.youtube.com/watch?v=BaW_jenozKc', source: 'youtube', requestedBy: '12345' });

test('queue finishes in order and back restores the interrupted song', () => {
  const queue = new MusicQueue();
  queue.add(['a', 'b', 'c'].map(song));
  assert.equal(queue.next()?.id, 'a');
  assert.equal(queue.next()?.id, 'b');
  assert.equal(queue.previous().id, 'a');
  assert.deepEqual(queue.upcoming.map(track => track.id), ['b', 'c']);
  assert.equal(queue.next()?.id, 'b');
  assert.equal(queue.next()?.id, 'c');
  assert.equal(queue.next(), undefined);
  assert.equal(queue.previous().id, 'c');
});

test('back on the first song restarts without duplicating it', () => {
  const queue = new MusicQueue(); queue.add([song('a'), song('b')]); queue.next();
  assert.equal(queue.previous().id, 'a');
  assert.equal(queue.size, 2); assert.equal(queue.history.length, 0);
});

test('capacity rejects the whole addition and includes the current song', () => {
  const queue = new MusicQueue(2); queue.add([song('a')]); queue.next();
  assert.throws(() => queue.add([song('b'), song('c')]), /room for 1/);
  assert.deepEqual(queue.upcoming, []);
});

test('remove validates a one-based position and clear preserves current', () => {
  const queue = new MusicQueue(); queue.add(['a', 'b', 'c'].map(song)); queue.next();
  assert.throws(() => queue.remove(0)); assert.throws(() => queue.remove(1.5));
  assert.equal(queue.remove(2).id, 'c'); queue.clear();
  assert.equal(queue.current?.id, 'a'); assert.equal(queue.size, 1);
  queue.reset(); assert.equal(queue.size, 0); assert.deepEqual(queue.history, []);
});

test('shuffle changes only upcoming songs and preserves every track', () => {
  const queue = new MusicQueue(); queue.add(['a', 'b', 'c', 'd'].map(song)); queue.next();
  queue.shuffle(() => 0);
  assert.equal(queue.current?.id, 'a');
  assert.deepEqual(queue.upcoming.map(track => track.id).sort(), ['b', 'c', 'd']);
});

test('serialized actions stay ordered and recover after an error', async () => {
  const serial = new SerialExecutor(); const order: number[] = [];
  const first = serial.run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); order.push(1); });
  const second = serial.run(() => { order.push(2); throw new Error('expected'); });
  const third = serial.run(() => { order.push(3); });
  await Promise.allSettled([first, second, third]);
  assert.deepEqual(order, [1, 2, 3]);
});
