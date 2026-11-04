import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VoiceConnectionStatus } from '@discordjs/voice';
import type { GuildMember } from 'discord.js';
import { HeyRajan } from '../src/voice/assistant.js';
import { prepareAssistant } from '../src/voice/registry.js';
import type { Speech } from '../src/voice/speech.js';
import type { MusicSession } from '../src/session.js';
import { SerialExecutor } from '../src/queue.js';

function room(t: TestContext) {
  const people = ['1', '2', '3', '4', '5'].map(id => ({ id, displayName: id, user: { bot: false, username: id } }) as GuildMember);
  const streams = new Map<string, PassThrough>(), rejoins: boolean[] = [], messages: { type: string; userId?: string }[] = [];
  const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready as VoiceConnectionStatus }, joinConfig: { selfDeaf: true },
    receiver: { speaking: new EventEmitter(), subscribe(id: string) {
      assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
      const stream = new PassThrough(); streams.set(id, stream); return stream;
    } },
    rejoin(config: { selfDeaf: boolean }) {
      rejoins.push(config.selfDeaf); this.joinConfig = config; this.state.status = VoiceConnectionStatus.Signalling;
      setImmediate(() => { this.state.status = VoiceConnectionStatus.Ready; connection.emit(VoiceConnectionStatus.Ready); }); return true;
    },
  });
  const message = { edit: async () => message };
  const session = { serial: new SerialExecutor(), connection, closed: false, watching: false, id: 'room', queue: { size: 1 },
    voice: { members: new Map(people.map(person => [person.id, person])) }, text: { send: async () => message },
    assertMember() {}, async connect() { assert.equal(connection.state.status, VoiceConnectionStatus.Ready, 'Another opt-in must not reconnect an in-flight voice connection'); },
    stopEffect() {}, close() { this.closed = true; },
  };
  const registry = new Map<string, HeyRajan>(); let creations = 0;
  const create = () => {
    creations++;
    const assistant = new HeyRajan(session as unknown as MusicSession, { configured: true } as Speech);
    Object.assign(assistant, { ready: Promise.resolve(), worker: { postMessage: (message: { type: string; userId?: string }) => messages.push(message), terminate: async () => 0 } });
    t.after(() => assistant.close()); return assistant;
  };
  const enable = (id: string) => {
    const member = people.find(person => person.id === id)!;
    return prepareAssistant(registry, 'guild', session as unknown as MusicSession, member, create, assistant => assistant.enable(member));
  };
  return { enable, create, session, connection, streams, rejoins, messages, people, creations: () => creations };
}

test('simultaneous opt-ins share one assistant and only undeafen the connection once', async t => {
  const h = room(t);
  const [first, second] = await Promise.all([h.enable('1'), h.enable('2')]);
  assert.equal(first, second); assert.equal(h.creations(), 1);
  assert.deepEqual([...first.members.keys()], ['1', '2']);
  assert.deepEqual(h.rejoins, [false]); assert.equal(h.connection.receiver.speaking.listenerCount('end'), 1);
  h.streams.get('1')!.emit('data', Buffer.from([1])); h.streams.get('2')!.emit('data', Buffer.from([2]));
  assert.deepEqual(h.messages.filter(message => message.type === 'audio').map(message => message.userId), ['1', '2']);
  first.remove('1');
  assert.equal(h.streams.get('1')!.destroyed, true); assert.equal(h.streams.get('2')!.destroyed, false);
  assert.equal(second.ended, false); assert.deepEqual(h.rejoins, [false]);
  h.streams.get('2')!.emit('data', Buffer.from([3])); assert.equal(h.messages.at(-1)?.userId, '2');
});

test('each listener expires independently and later opt-ins do not extend earlier consent', async t => {
  const h = room(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const assistant = await h.enable('1'); t.mock.timers.tick(5000); await h.enable('2');
  t.mock.timers.tick(15 * 60000 - 5000);
  assert.deepEqual([...assistant.members.keys()], ['2']); assert.equal(assistant.ended, false);
  t.mock.timers.tick(5000);
  assert.equal(assistant.members.size, 0); assert.equal(assistant.ended, true);
});

test('concurrent enable requests respect the four-person limit without extra workers', async t => {
  const h = room(t);
  const results = await Promise.allSettled(['1', '2', '3', '4', '5'].map(h.enable));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(results[4]?.status, 'rejected'); assert.equal(h.creations(), 1); assert.equal(h.streams.size, 4);
});

test('opting out while the disclosure is pending cannot enable reception afterward', async t => {
  const h = room(t); h.session.watching = true;
  const assistant = h.create(); let resolve!: () => void, calls = 0;
  t.mock.method(assistant, 'publish', async () => { if (++calls === 1) await new Promise<void>(done => { resolve = done; }); });
  const pending = assistant.enable(h.people[0]!);
  const rejected = assert.rejects(pending, /canceled/);
  await new Promise(done => setImmediate(done));
  assistant.remove('1'); resolve(); await rejected;
  assert.equal(h.streams.size, 0); assert.equal(h.messages.some(message => message.type === 'add'), false);
});
