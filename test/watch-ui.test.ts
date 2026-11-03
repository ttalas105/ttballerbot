import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Execute the real browser controller with a fake capture track; never capture the user's screen. */
function ui() {
  const elements = new Map<string, any>(), intervals: (() => Promise<void> | void)[] = [];
  const requests: { path: string; body: any }[] = [];
  let stopped = false;
  const state = { channel: 'Test', enabled: false, busy: false, interval: 30, mode: 'roast', status: 'Ready', expiresAt: Date.now() + 1800000 };
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', disabled: false, textContent: '', handlers: new Map(),
      addEventListener(name: string, handler: any) { this.handlers.set(name, handler); }, focus() {}, play: async () => {},
      readyState: 2, videoWidth: 1280, videoHeight: 720 });
    return elements.get(id);
  };
  const track = { stop() { stopped = true; }, addEventListener() {} };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,dGVzdA==' };
  runInNewContext(readFileSync('web/watch/app.js', 'utf8'), {
    document: { getElementById: element, createElement: () => canvas },
    navigator: { mediaDevices: { getDisplayMedia: async (options: any) => { assert.equal(options.audio, false); return { getTracks: () => [track], getVideoTracks: () => [track] }; } } },
    setInterval: (callback: () => void) => intervals.push(callback), addEventListener() {}, AbortSignal, Date, console,
    fetch: async (url: string, init: any) => {
      const path = url.replace('/api/', ''), body = init.body ? JSON.parse(init.body) : undefined; requests.push({ path, body });
      if (path === 'settings') Object.assign(state, body);
      return { ok: true, json: async () => path === 'pair' ? { token: 'test-token', ...state } : { ...state } };
    },
  });
  const trigger = (id: string, event: string) => element(id).handlers.get(event)({ preventDefault() {} });
  return { element, trigger, requests, intervals, stopped: () => stopped, state };
}
test('manual-only sharing captures no audio and never auto-submits; React now sends and stop releases capture', async () => {
  const h = ui(); h.element('code').value = '123456'; await h.trigger('pair-form', 'submit');
  h.element('interval').value = '0'; await h.trigger('interval', 'change'); await h.trigger('choose', 'click');
  for (let i = 0; i < 5; i++) await h.intervals[0]!();
  assert.equal(h.requests.filter(r => r.path === 'frames').length, 0);
  await h.trigger('react', 'click'); await new Promise(resolve => setImmediate(resolve));
  const frames = h.requests.filter(r => r.path === 'frames'); assert.equal(frames.length, 1);
  assert.equal(frames[0]!.body.manual, true); assert.equal(frames[0]!.body.frames.length, 2);
  await h.trigger('stop', 'click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.stopped(), true); assert.equal(h.state.enabled, false); assert.equal(h.element('preview').srcObject, null);
});
test('automatic mode submits the first two fresh frames but never builds an upload backlog', async () => {
  const h = ui(); h.element('code').value = '123456'; await h.trigger('pair-form', 'submit'); await h.trigger('choose', 'click');
  await h.intervals[0]!(); await h.intervals[0]!(); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await h.intervals[0]!();
  assert.equal(h.requests.filter(r => r.path === 'frames').length, 1);
});
