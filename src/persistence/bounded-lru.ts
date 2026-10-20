/**
 * A bounded least-recently-used map.
 *
 * The in-memory stores are caches in front of durable JSONL logs, and a cache
 * with no ceiling is a memory leak with extra steps: session ids are
 * client-supplied, so an unauthenticated caller could otherwise grow the map
 * forever. Every read and write refreshes recency, and inserting past the
 * bound evicts the least-recently-used entry. Eviction is never data loss —
 * the JSONL log on disk remains the source of truth — it only means the
 * evicted record must be re-read from disk if an operator asks for it.
 */

export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `BoundedLruCache capacity must be a positive integer, got ${maxEntries}`,
      );
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Reads a value and marks it most-recently-used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Inserts or updates a value; evicts the least-recently-used entry past capacity. */
  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Values in least- to most-recently-used order. */
  values(): V[] {
    return [...this.entries.values()];
  }

  /** Entries in least- to most-recently-used order. */
  entriesList(): [K, V][] {
    return [...this.entries.entries()];
  }

  /**
   * Iterates entries oldest-first. Deleting during iteration is safe (Map
   * semantics), which is what the TTL sweep relies on.
   */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries.entries();
  }
}
