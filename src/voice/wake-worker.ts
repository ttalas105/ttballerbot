import { parentPort, workerData } from 'node:worker_threads';
import OpusScript from 'opusscript';
import { LocalWake, type WakeStream } from './wake.js';
import { CommandCapture } from './capture.js';

const port = parentPort!;
const wake = new LocalWake(workerData.directory, workerData.threshold);
const users = new Map<string, { decoder: OpusScript; stream: WakeStream; capture?: CommandCapture; cooldown: number }>();
port.on('message', (message: { type: string; userId: string; packet?: Uint8Array }) => {
  const { userId } = message;
  if (message.type === 'add' && !users.has(userId)) {
    users.set(userId, { decoder: new OpusScript(16000, 1, OpusScript.Application.VOIP), stream: wake.stream(), cooldown: 0 });
  }
  const user = users.get(userId);
  if (!user) return;
  if (message.type === 'remove') { user.capture?.cancel(); user.decoder.delete(); users.delete(userId); return; }
  if (message.type === 'cancel') { user.capture?.cancel(); user.capture = undefined; user.cooldown = Date.now() + 1000; user.stream = wake.stream(); return; }
  if (message.type === 'capture') {
    user.capture?.cancel();
    user.capture = new CommandCapture(pcm => {
      user.capture = undefined; user.stream = wake.stream();
      user.cooldown = Date.now() + 2000;
      port.postMessage({ type: 'command', userId, pcm });
    }); return;
  }
  if (message.type === 'silence') {
    // Discord stops sending packets between utterances. Flush the model's lookahead
    // so a wake phrase followed by a pause can still trigger the ready chime.
    if (!user.capture && Date.now() >= user.cooldown && wake.accept(user.stream, new Float32Array(6400))) {
      user.cooldown = Date.now() + 10000; port.postMessage({ type: 'wake', userId });
    }
    return;
  }
  if (message.type !== 'audio' || !message.packet) return;
  try {
    const pcm = user.decoder.decode(Buffer.from(message.packet));
    if (user.capture) { user.capture.accept(pcm); return; }
    if (Date.now() < user.cooldown) return;
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    if (wake.accept(user.stream, samples)) {
      // Parent plays the ready chime before opening the post-wake command window.
      user.cooldown = Date.now() + 10000;
      port.postMessage({ type: 'wake', userId });
    }
  } catch { port.postMessage({ type: 'decodeError', userId }); }
  finally { port.postMessage({ type: 'ack', userId }); }
});
port.postMessage({ type: 'ready' });
