// Client-side quota enforcement for the TFI GTFS-Realtime API.
//
// Measured limit: 3 requests per minute, pooled across every GTFS-RT endpoint on a key.
// Exceeding it returns 429 with no Retry-After header and no rate-limit headers at all,
// so there is nothing to react to after the fact. The only reliable approach is not to
// send the request in the first place.
//
// A fixed 25s interval is not sufficient on its own: it peaks at exactly 3 requests inside
// some 60s windows, which is at the limit rather than under it, so any retry or scheduling
// jitter tips it over. This tracks actual send times in a rolling window instead of trusting
// the interval.

const WINDOW_MS = 60_000;

export class Quota {
  /**
   * @param {number} maxPerWindow  Requests permitted per rolling window.
   * @param {number} safetyMargin  Requests held back as headroom for retries.
   */
  constructor(maxPerWindow = 3, safetyMargin = 0) {
    this.limit = Math.max(1, maxPerWindow - safetyMargin);
    this.sent = [];
    this.blockedUntil = 0;
  }

  #prune(now) {
    const cutoff = now - WINDOW_MS;
    while (this.sent.length && this.sent[0] <= cutoff) this.sent.shift();
  }

  /** Milliseconds to wait before a request may be sent. 0 means send now. */
  waitMs(now = Date.now()) {
    if (now < this.blockedUntil) return this.blockedUntil - now;
    this.#prune(now);
    if (this.sent.length < this.limit) return 0;
    // The oldest request in the window has to age out before another may go.
    return this.sent[0] + WINDOW_MS - now + 50;
  }

  /** Record that a request was actually sent. */
  record(now = Date.now()) {
    this.sent.push(now);
  }

  /**
   * Back off after a 429. The server gives no Retry-After, so wait out a full window and
   * then some, with jitter so that two processes recovering together do not resynchronise
   * into the same collision.
   */
  penalise(attempt = 1, now = Date.now()) {
    const base = Math.min(WINDOW_MS * Math.pow(2, attempt - 1), 5 * WINDOW_MS);
    const jitter = Math.random() * 5_000;
    this.blockedUntil = now + base + jitter;
    // A 429 means the server counted requests we may not have; assume the window is full.
    this.sent = new Array(this.limit).fill(now);
    return Math.round((this.blockedUntil - now) / 1000);
  }

  /** Clear the penalty after a success. */
  recover() {
    this.blockedUntil = 0;
  }

  get inWindow() {
    this.#prune(Date.now());
    return this.sent.length;
  }
}
