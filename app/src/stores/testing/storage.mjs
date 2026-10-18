// An in-memory stand-in for src/lib/storage.ts (AsyncStorage), answering at once so the persisted
// store hydrates synchronously.

export const memory = new Map();

export const storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value); },
  removeItem: (key) => { memory.delete(key); },
};
