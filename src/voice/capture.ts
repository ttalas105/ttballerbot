/** Bounded post-wake audio only. Silence and timeout are enforced even without packets. */
export class CommandCapture {
  private chunks: Buffer[] = [];
  private samples = 0;
  private voiced = 0;
  private done = false;
  private silence?: NodeJS.Timeout;
  private readonly deadline: NodeJS.Timeout;
  constructor(private readonly complete: (pcm?: Buffer) => void, maxMs = 8000, private readonly silenceMs = 850) {
    this.deadline = setTimeout(() => this.finish(), maxMs);
    this.deadline.unref();
  }
  accept(pcm: Buffer): void {
    if (this.done) return;
    const remaining = Math.max(0, 16000 * 8 - this.samples);
    const chunk = Buffer.from(pcm.subarray(0, remaining * 2));
    this.chunks.push(chunk); this.samples += chunk.length / 2;
    let energy = 0;
    for (let i = 0; i < chunk.length; i += 2) energy += (chunk.readInt16LE(i) / 32768) ** 2;
    if (chunk.length && Math.sqrt(energy / (chunk.length / 2)) > 0.012) {
      this.voiced += chunk.length / 2;
      clearTimeout(this.silence);
      this.silence = setTimeout(() => this.finish(), this.silenceMs); this.silence.unref();
    }
    if (this.samples >= 16000 * 8) this.finish();
  }
  finish(): void {
    if (this.done) return;
    this.done = true; clearTimeout(this.deadline); clearTimeout(this.silence);
    const audio = this.voiced >= 16000 * 0.2 ? Buffer.concat(this.chunks) : undefined;
    this.chunks = []; this.complete(audio);
  }
  cancel(): void { this.done = true; this.chunks = []; clearTimeout(this.deadline); clearTimeout(this.silence); }
}

export function wav(pcm: Buffer, rate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
