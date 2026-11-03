import { UserError } from '../model.js';

export const watchModes = ['roast', 'hype', 'commentary'] as const;
export type WatchMode = typeof watchModes[number];
export interface ScreenReaction { react: boolean; event: string; reply: string }

/** Inline JPEGs only: never turn a supplied URL into a server-side fetch. */
export function validateFrames(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > 3) throw new UserError('Send one to three recent frames.');
  return input.map(value => {
    if (typeof value !== 'string' || value.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new UserError('Invalid or oversized screenshot.');
    const image = Buffer.from(value, 'base64');
    if (image.length < 32 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) throw new UserError('Share JPEG screenshots only.');
    return value;
  });
}
