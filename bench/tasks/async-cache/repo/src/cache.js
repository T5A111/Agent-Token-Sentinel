/** Memoizes async loads per key; concurrent gets share one load. */
export class Cache {
  constructor(loader) {
    this.loader = loader;
    this.entries = new Map();
  }

  get(key) {
    if (!this.entries.has(key)) {
      this.entries.set(key, this.loader(key));
    }
    return this.entries.get(key);
  }
}
