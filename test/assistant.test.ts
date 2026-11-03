import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AudioReceiveStream } from '@discordjs/voice';
import type { MusicSession } from '../src/session.js';
import { SerialExecutor } from '../src/queue.js';
import { HeyBaller } from '../src/voice/assistant.js';
import type { Speech } from '../src/voice/speech.js';
import type { ConversationTurn } from '../src/voice/memory.js';
import type { VoiceDecision } from '../src/voice/intents.js';

function harness(t: TestContext) {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const outputs: Buffer[] = [], controls: string[] = [], plays: { query: string; userId: string; signal: AbortSignal }[] = [];
  const voices: { text: string; style: string }[] = [];
  const requests: { input: string | Buffer; history: ConversationTurn[] }[] = [];
  const workerMessages: { type: string; userId: string }[] = [];
  const message = { edit: async () => message };
  const session = { closed: false, id: 'session', effectPlaying: false, queue: { size: 1 }, serial: new SerialExecutor(),
    text: { send: async () => message }, voice: { members: new Map(['1', '2'].map(id => [id, { id, displayName: id === '1' ? 'Sushi' : 'Jason', user: { username: id, bot: false } }])) },
    assertMember() {}, playEffect: async (pcm: Buffer) => { outputs.push(pcm); }, stopEffect() {},
    control: (action: string) => { controls.push(action); }, close() { this.closed = true; },
  };
  const speech = {
    configured: true,
    understand: async (input: string | Buffer, _people: unknown, _userId: string, history: ConversationTurn[]): Promise<VoiceDecision> => {
      requests.push({ input, history }); return { transcript: String(input), intent: { kind: 'say', reply: history.length ? 'Another joke.' : 'First joke.' } };
    },
    speak: async (text: string, _signal: AbortSignal, style: string): Promise<Buffer> => { voices.push({ text, style }); return Buffer.alloc(48000); },
  };
  const assistant = new HeyBaller(session as unknown as MusicSession, speech as unknown as Speech, {
    play: async (query, userId, signal) => { plays.push({ query, userId, signal }); return 'Queued a song.'; },
  });
  const worker = { postMessage: (message: { type: string; userId: string }) => workerMessages.push(message), terminate: async () => 0 };
  // Inject a worker transport without loading the native wake model in unit tests.
  Object.assign(assistant, { worker });
  t.after(() => assistant.close());
  return { assistant, session, speech, outputs, controls, plays, voices, requests, workerMessages, tick: () => { now += 2100; } };
}

test('reported music/wedding/joke requests work, and a follow-up remembers only its speaker', async t => {
  const h = harness(t);
  await h.assistant.execute('play some j cole', '1');
  assert.equal(h.plays[0]?.query, 'j cole'); assert.equal(h.plays[0]?.userId, '1');
  assert.equal(h.requests.length, 0);
  h.tick(); await h.assistant.execute('announce tyrone like a wedding', '1');
  assert.equal(h.voices[0]?.style, 'wedding'); assert.match(h.voices[0]!.text, /Tyrone/);
  h.tick(); await h.assistant.execute('tell me a joke', '2');
  assert.equal(h.voices[1]?.style, 'conversation'); assert.deepEqual(h.requests[0]?.history, []);
  h.tick(); await h.assistant.execute('tell me another one', '2');
  assert.equal(h.requests[1]?.history.length, 1); assert.equal(h.requests[1]?.history[0]?.response, 'First joke.');
  assert.equal(h.outputs.length, 3);
});

test('player controls reach the existing session and effects can run repeatedly', async t => {
  const h = harness(t);
  h.assistant.members.set('1', { destroy() {} } as AudioReceiveStream);
  for (const input of ['pause the music', 'resume', 'skip', 'back', 'shuffle']) { await h.assistant.execute(input, '1'); h.tick(); }
  assert.deepEqual(h.controls, ['pause', 'resume', 'next', 'back', 'shuffle']);
  await h.assistant.execute('air horn', '1'); h.tick(); await h.assistant.execute('air horn', '1');
  assert.equal(h.outputs.length, 2);
  assert.ok(h.workerMessages.filter(message => message.type === 'cancel').length >= 7);
});

test('cancel during model processing drops the late action and allows the next request', async t => {
  const h = harness(t);
  let finish!: (decision: VoiceDecision) => void;
  h.speech.understand = async () => new Promise(resolve => { finish = resolve; });
  const pending = h.assistant.execute('put something good on for us', '1');
  await assert.rejects(h.assistant.execute('air horn', '2'), /another request/);
  h.assistant.cancel();
  finish({ transcript: 'play some j cole', intent: { kind: 'music', query: 'J Cole' } });
  await pending; assert.equal(h.plays.length, 0); assert.equal(h.outputs.length, 0);
  h.tick(); await h.assistant.execute('air horn', '1'); assert.equal(h.outputs.length, 1);
});

test('failed speech releases the request slot and re-arms wake detection', async t => {
  const h = harness(t);
  h.assistant.members.set('1', { destroy() {} } as AudioReceiveStream);
  h.speech.speak = async () => { throw new Error('simulated failure'); };
  await assert.rejects(h.assistant.execute('tell me a joke', '1'), /simulated failure/);
  assert.ok(h.workerMessages.some(message => message.type === 'cancel' && message.userId === '1'));
  h.tick(); await h.assistant.execute('air horn', '1'); assert.equal(h.outputs.length, 1);
});

test('opting out while speech generates prevents audio, clears context, and preserves another listener', async t => {
  const h = harness(t);
  h.assistant.members.set('1', { destroy() {} } as AudioReceiveStream);
  h.assistant.members.set('2', { destroy() {} } as AudioReceiveStream);
  await h.assistant.execute('tell me a joke', '1');
  h.tick();
  let finish!: (pcm: Buffer) => void;
  const originalSpeak = h.speech.speak;
  h.speech.speak = async () => new Promise(resolve => { finish = resolve; });
  const pending = h.assistant.execute('tell me another one', '1');
  await new Promise(resolve => setImmediate(resolve));
  h.assistant.remove('1'); finish(Buffer.alloc(48000)); await pending;
  assert.equal(h.outputs.length, 1); assert.equal(h.assistant.ended, false);
  h.speech.speak = originalSpeak; h.tick(); await h.assistant.execute('hello', '1');
  assert.deepEqual(h.requests.at(-1)?.history, []);
});

test('leaving voice during understanding prevents a late music request', async t => {
  const h = harness(t);
  let finish!: (decision: VoiceDecision) => void;
  h.speech.understand = async () => new Promise(resolve => { finish = resolve; });
  const pending = h.assistant.execute('put something good on', '1');
  h.session.voice.members.delete('1'); h.assistant.prune();
  finish({ transcript: 'play music', intent: { kind: 'music', query: 'J Cole' } });
  await pending; assert.equal(h.plays.length, 0);
});
