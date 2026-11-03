import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentType, MessageFlags } from 'discord.js';
import { MusicQueue } from '../src/queue.js';
import { addSongModal, buildPanel, progressBar, queuePage } from '../src/panel.js';
import { commands } from '../src/commands.js';

type Node = { type: number; components?: Node[]; content?: string; label?: string; disabled?: boolean; custom_id?: string };
const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...flatten(node.components || [])]);
const nodes = (panel: ReturnType<typeof buildPanel>) => flatten(JSON.parse(JSON.stringify(panel.components)) as Node[]);
const content = (panel: ReturnType<typeof buildPanel>) => nodes(panel).flatMap(node => node.content || []).join('\n');

test('rich player and paged queue respect Discord component/content limits with long metadata', () => {
  const queue = new MusicQueue();
  queue.add(Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: '*'.repeat(300), artist: '_'.repeat(300),
    durationSeconds: 240, url: 'https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6', source: 'spotify' as const, requestedBy: '12345' })));
  queue.next();
  for (const panel of [buildPanel({ id: 'example', queue, status: 'playing', elapsed: 15, voiceId: '12345', artworkUrl: 'attachment://player.png' }), queuePage(queue, 1, 'example')]) {
    assert.equal(panel.flags, MessageFlags.IsComponentsV2);
    assert.ok(nodes(panel).length <= 40);
    assert.ok(content(panel).length <= 4000);
    assert.ok(nodes(panel).filter(node => node.type === ComponentType.ActionRow).every(row => row.components!.length <= 5));
    const ids = nodes(panel).flatMap(node => node.custom_id || []);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(panel.allowedMentions.parse, []);
  }
});

test('stopped controls are disabled; paused player exposes Resume; queue navigation is bounded', () => {
  const queue = new MusicQueue();
  const stopped = buildPanel({ id: 'example', queue, status: 'stopped', elapsed: 0 });
  assert.ok(nodes(stopped).filter(node => node.type === ComponentType.Button).every(button => button.disabled));
  const paused = buildPanel({ id: 'example', queue, status: 'paused', elapsed: 0 });
  assert.equal(nodes(paused).find(node => node.custom_id === 'ttb:example:toggle')?.label, 'Resume');
  assert.ok(nodes(queuePage(queue, 1, 'example')).filter(node => node.type === ComponentType.Button).every(button => button.disabled));
});

test('slash commands and add-song modal serialize with required inputs', () => {
  const schemas = commands.map(command => command.toJSON());
  assert.equal(new Set(schemas.map(command => command.name)).size, schemas.length);
  assert.ok(schemas.every(command => command.contexts?.length === 1 && command.contexts[0] === 0));
  assert.equal(schemas.find(command => command.name === 'play')?.options?.[0]?.required, true);
  const modal = addSongModal('example').toJSON();
  assert.equal(modal.custom_id, 'ttadd:example');
  assert.equal(modal.components[0]?.type, ComponentType.Label);
});

test('player duration follows the actual audio version while preserving the Spotify request', () => {
  const queue = new MusicQueue();
  queue.add([{ id: 'meditate', title: 'Meditate (feat. J.I.D.)', artist: 'EARTHGANG, JID', durationSeconds: 278,
    url: 'https://open.spotify.com/track/example', source: 'spotify', requestedBy: '123',
    playbackUrl: 'https://www.youtube.com/watch?v=skw3kUycvpo', playbackTitle: 'EARTHGANG - Meditate ft. J.I.D.', playbackDurationSeconds: 241 }]);
  queue.next();
  const copy = content(buildPanel({ id: 'example', queue, status: 'playing', elapsed: 52 }));
  assert.match(copy, /Meditate/); assert.match(copy, /0:52/); assert.match(copy, /4:01/);
  assert.match(copy, /skw3kUycvpo/);
  assert.equal(progressBar(-10, 100), `●${'─'.repeat(20)}`);
  assert.equal(progressBar(200, 100), `${'━'.repeat(20)}●`);
});
