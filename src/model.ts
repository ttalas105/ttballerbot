export class UserError extends Error { override name = 'UserError'; }

export class PlaybackError extends UserError {
  override name = 'PlaybackError';
  constructor(message: string, readonly code: string) { super(message); }
}

export class VoiceError extends UserError {
  override name = 'VoiceError';
  constructor(message: string, readonly code: string) { super(message); }
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  artists?: string[];
  durationSeconds: number;
  url: string;
  thumbnail?: string;
  source: 'spotify' | 'youtube';
  requestedBy: string;
  playbackUrl?: string;
  playbackTitle?: string;
  playbackDurationSeconds?: number;
}

export interface ImportResult {
  tracks: Track[];
  label: string;
  notice?: string;
}

export function userMessage(error: unknown): string {
  return error instanceof UserError ? error.message : 'Something went wrong. Try again; the host console has the error category.';
}

// Do not print provider errors, subprocess arguments, signed URLs, or tokens.
export function logError(context: string, error: unknown): void {
  const code = (error instanceof PlaybackError || error instanceof VoiceError) && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` ${error.code}` : '';
  console.error(`${new Date().toISOString()} [${context}] ${error instanceof Error ? error.name : 'UnknownError'}${code}`);
}
