/** Memoizes async loads per key; concurrent gets share one load. */
export class Cache {
  constructor(loader) {
    this.loader = loader;
    this.entries = new Map();
  }

  get(key) {
    if (!this.entries.has(key)) {
      const pending = Promise.resolve()
        .then(() => this.loader(key))
        .catch((err) => {
          this.entries.delete(key);
          throw err;
        });
      this.entries.set(key, pending);
    }
    return this.entries.get(key);
  }
}
