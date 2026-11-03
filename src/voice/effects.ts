/** Original synthesized effects. Raw signed 16-bit, 48 kHz stereo for Discord. */
export function effectPcm(kind: 'chime' | 'error' | 'thinking' | 'dramatic' | 'airhorn' | 'entrance' | 'wedding' | 'speech', speech?: Buffer): Buffer {
  const duration = kind === 'error' ? 0.55 : kind === 'thinking' ? 2.4 : kind === 'chime' ? 0.28 : kind === 'airhorn' ? 1.4 : kind === 'dramatic' ? 15
    : Math.min(28, (kind === 'speech' ? 0.2 : 2) + (speech?.length || 0) / 48000);
  const count = Math.ceil(duration * 48000); const out = Buffer.alloc(count * 4);
  let noise = 777, previousNoise = 0;
  for (let i = 0; i < count; i++) {
    const t = i / 48000; let sample = 0;
    const end = Math.min(1, (duration - t) / 0.2), fade = Math.min(1, t / 0.02) * end;
    if (kind === 'thinking') {
      // A quiet two-note pulse, with silence between pulses and at the loop seam.
      const note = t < 0.22 ? t : t >= 0.3 && t < 0.52 ? t - 0.3 : -1;
      if (note >= 0) {
        const envelope = Math.sin(Math.PI * note / 0.22) ** 2;
        const frequency = t < 0.22 ? 523.25 : 659.25;
        sample = (Math.sin(2 * Math.PI * frequency * note) + 0.15 * Math.sin(4 * Math.PI * frequency * note)) * 0.035 * envelope;
      }
    } else if (kind === 'error') {
      if (t < 0.2 || t > 0.3) sample = Math.sin(2 * Math.PI * (t < 0.2 ? 440 : 330) * t) * 0.12 * fade;
    } else if (kind === 'chime') sample = Math.sin(2 * Math.PI * (t < 0.12 ? 660 : 990) * t) * 0.12 * fade;
    else if (kind === 'airhorn') {
      const gate = t < 0.3 || (t > 0.42 && t < 0.72) || t > 0.84;
      if (gate) sample = (Math.sin(2 * Math.PI * 233 * t) + 0.5 * Math.sin(2 * Math.PI * 311 * t)
        + 0.2 * Math.sin(2 * Math.PI * 466 * t)) * 0.14 * fade;
    } else if (kind === 'speech' || kind === 'wedding') {
      if (kind === 'wedding') {
        sample = [261.63, 329.63, 392].reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * t), 0) * 0.012 * fade;
        sample += Math.sin(2 * Math.PI * 1046.5 * t) * 0.06 * Math.exp(-t * 4);
      }
      const spokenIndex = Math.floor((t - (kind === 'speech' ? 0.05 : 1.2)) * 24000) * 2;
      if (speech && spokenIndex >= 0 && spokenIndex + 1 < speech.length) sample += speech.readInt16LE(spokenIndex) / 32768 * 0.8;
    } else {
      const beat = t % (kind === 'entrance' ? 0.5 : 0.8);
      const pulse = Math.exp(-beat * 12);
      sample = Math.sin(2 * Math.PI * 55 * t) * 0.1 * pulse;
      sample += [110, 130.81, 164.81].reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * t), 0) * 0.018 * (0.6 + 0.4 * Math.sin(t * 2));
      noise = (Math.imul(noise, 1664525) + 1013904223) | 0;
      previousNoise = previousNoise * 0.92 + (noise / 2147483648) * 0.08;
      sample += previousNoise * 0.3 * Math.exp(-Math.max(0, t - 0.1) * 1.4);
      const spokenIndex = Math.floor((t - 1.2) * 24000) * 2;
      if (speech && spokenIndex >= 0 && spokenIndex + 1 < speech.length) sample = sample * 0.5 + speech.readInt16LE(spokenIndex) / 32768 * 0.8;
      sample *= fade;
    }
    const value = Math.round(Math.max(-0.85, Math.min(0.85, sample)) * 32767);
    out.writeInt16LE(value, i * 4); out.writeInt16LE(value, i * 4 + 2);
  }
  return out;
}
