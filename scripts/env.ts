import { readFileSync, writeFileSync } from 'node:fs';

export function saveEnv(values: Record<string, string>): void {
  let content = readFileSync('.env', 'utf8');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_]+$/.test(key) || /[\r\n"\\]/.test(value)) throw new Error('Invalid environment value.');
    const line = `${key}="${value}"`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync('.env', content, { mode: 0o600 });
}
