import type {
  RecordStore,
  StoredEntry,
  TransactionalStore,
} from '../../../../src/auth/server/file-store';

export const createTransactionalRecordStore = (
  entries: Map<string, StoredEntry> = new Map(),
): { store: TransactionalStore; entries: Map<string, StoredEntry> } => {
  let tail = Promise.resolve();
  const read = (key: string): string | undefined => {
    const entry = entries.get(key);
    return entry && (entry.exp === undefined || entry.exp > Date.now()) ? entry.v : undefined;
  };
  const write = (value: string, ttlMs?: number): StoredEntry =>
    ttlMs === undefined ? { v: value } : { v: value, exp: Date.now() + ttlMs };
  const store: TransactionalStore = {
    shared: true,
    get: async (key) => read(key),
    set: async (key, value, ttlMs) => {
      entries.set(key, write(value, ttlMs));
    },
    delete: async (key) => {
      entries.delete(key);
    },
    transaction: async <T>(operation: (transaction: RecordStore) => Promise<T>): Promise<T> => {
      const previous = tail;
      let release: () => void = () => undefined;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const pending = new Map<string, StoredEntry | null>();
        const transaction: RecordStore = {
          get: async (key) => {
            if (pending.has(key)) {
              const entry = pending.get(key);
              return entry ? entry.v : undefined;
            }
            return read(key);
          },
          set: async (key, value, ttlMs) => {
            pending.set(key, write(value, ttlMs));
          },
          delete: async (key) => {
            pending.set(key, null);
          },
        };
        const result = await operation(transaction);
        for (const [key, entry] of pending) {
          if (entry === null) entries.delete(key);
          else entries.set(key, entry);
        }
        return result;
      } finally {
        release();
      }
    },
  };
  return { store, entries };
};
