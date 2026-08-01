/**
 * Bounds how many media stages run at once.
 *
 * The media leg launches Chromium and ffmpeg — comfortably the heaviest thing
 * this server does. Daily caps limit *volume*, but say nothing about how many
 * arrive at the same moment, and a link shared publicly produces bursts rather
 * than a smooth trickle. On a 2GB host, a handful of simultaneous browsers is
 * enough to exhaust memory, and the failure mode is ugly: the OOM killer takes
 * whichever process it likes, so unrelated runs die too.
 *
 * Queueing instead makes a spike slow rather than fatal. The queue itself is
 * bounded, because an unbounded one just relocates the memory problem into
 * pending promises and leaves users waiting on work that will never start.
 */

export class TooBusyError extends Error {
  constructor() {
    super('The server is busy rendering other videos right now. Try again in a few minutes.');
    this.name = 'TooBusyError';
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  /**
   * Wait for a slot. Resolves with the release function — always call it in a
   * `finally`, or a crashed render permanently consumes a slot.
   *
   * Throws {@link TooBusyError} immediately when the queue is full: making the
   * caller wait indefinitely for a slot that may never come is worse than
   * telling them now.
   */
  async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrent && this.waiters.length >= this.maxQueued) {
      throw new TooBusyError();
    }
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;

    let released = false;
    return () => {
      if (released) return; // guard against a double release freeing someone else's slot
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

/**
 * Default of 2 concurrent renders: a t3.small has 2 vCPUs and ~2GB, and one
 * Chromium plus one ffmpeg already saturates that. Raise it only alongside the
 * instance size.
 */
export const mediaSemaphore = new Semaphore(
  Number.parseInt(process.env.MAX_CONCURRENT_RENDERS ?? '2', 10) || 2,
  Number.parseInt(process.env.MAX_QUEUED_RENDERS ?? '10', 10) || 10,
);
