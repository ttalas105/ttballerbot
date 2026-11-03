import { UserError, type Track } from './model.js';

export class MusicQueue {
  current: Track | undefined;
  readonly upcoming: Track[] = [];
  readonly history: Track[] = [];

  constructor(readonly capacity = 250) {}

  get size(): number { return this.upcoming.length + (this.current ? 1 : 0); }

  add(tracks: Track[]): void {
    if (tracks.length + this.size > this.capacity) {
      throw new UserError(`The queue holds ${this.capacity} songs. There is room for ${this.capacity - this.size} more.`);
    }
    this.upcoming.push(...tracks);
  }

  next(): Track | undefined {
    if (this.current) {
      this.history.push(this.current);
      if (this.history.length > 50) this.history.shift();
    }
    this.current = this.upcoming.shift();
    return this.current;
  }

  previous(): Track {
    const previous = this.history.at(-1);
    if (!previous) {
      if (!this.current) throw new UserError('There is no previous song yet.');
      return this.current; // Back on the first song restarts it.
    }
    // Restoring history also consumes queue capacity.
    if (this.size >= this.capacity) throw new UserError('The queue is full. Remove a queued song before going back.');
    this.history.pop();
    if (this.current) this.upcoming.unshift(this.current);
    this.current = previous;
    return previous;
  }

  remove(position: number): Track {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      throw new UserError('Choose a valid position from the upcoming queue.');
    }
    return this.upcoming.splice(position - 1, 1)[0]!;
  }

  shuffle(random = Math.random): void {
    for (let i = this.upcoming.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.upcoming[i], this.upcoming[j]] = [this.upcoming[j]!, this.upcoming[i]!];
    }
  }

  clear(): void { this.upcoming.length = 0; }
  reset(): void { this.current = undefined; this.upcoming.length = 0; this.history.length = 0; }
}

export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
