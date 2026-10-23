import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirestoreStore } from '../../../../src/auth/server/firestore-store';

const fakeFirestore = vi.hoisted(() => {
  interface Reference {
    path: string;
    get(): Promise<{ data(): unknown }>;
    set(value: unknown): Promise<void>;
    delete(): Promise<void>;
  }

  type Write = { kind: 'set'; value: unknown } | { kind: 'delete' };
  interface Transaction {
    get(reference: Reference): Promise<{ data(): unknown }>;
    set(reference: Reference, value: unknown): void;
    delete(reference: Reference): void;
  }

  const data = new Map<string, unknown>();
  const options: { projectId: string; databaseId: string; preferRest: boolean }[] = [];
  const reads: string[] = [];
  const writes: { path: string; kind: Write['kind'] }[] = [];
  const terminate = vi.fn(async () => undefined);

  class FirestoreMock {
    constructor(config: { projectId: string; databaseId: string; preferRest: boolean }) {
      options.push(config);
    }

    collection(name: string) {
      return {
        doc: (id: string): Reference => {
          const path = `${name}/${id}`;
          return {
            path,
            get: async () => ({ data: () => data.get(path) }),
            set: async (value) => {
              data.set(path, value);
            },
            delete: async () => {
              data.delete(path);
            },
          };
        },
      };
    }

    async runTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
      const pending = new Map<string, Write>();
      const transaction: Transaction = {
        get: async (reference) => {
          reads.push(reference.path);
          const write = pending.get(reference.path);
          let value = data.get(reference.path);
          if (write?.kind === 'set') value = write.value;
          else if (write?.kind === 'delete') value = undefined;
          return { data: () => value };
        },
        set: (reference, value) => {
          writes.push({ path: reference.path, kind: 'set' });
          pending.set(reference.path, { kind: 'set', value });
        },
        delete: (reference) => {
          writes.push({ path: reference.path, kind: 'delete' });
          pending.set(reference.path, { kind: 'delete' });
        },
      };
      const result = await operation(transaction);
      for (const [path, write] of pending) {
        if (write.kind === 'delete') data.delete(path);
        else data.set(path, write.value);
      }
      return result;
    }

    terminate = terminate;
  }

  const Timestamp = {
    fromMillis: (value: number) => ({ toMillis: () => value }),
  };

  return { data, options, reads, writes, terminate, FirestoreMock, Timestamp };
});

vi.mock('@google-cloud/firestore', () => ({
  Firestore: fakeFirestore.FirestoreMock,
  Timestamp: fakeFirestore.Timestamp,
}));

const URI = 'firestore://demo-zendesk-mcp/(default)/oauth';
const pathFor = (key: string) => `oauth/${createHash('sha256').update(key).digest('hex')}`;

describe('createFirestoreStore', () => {
  beforeEach(() => {
    fakeFirestore.data.clear();
    fakeFirestore.options.length = 0;
    fakeFirestore.reads.length = 0;
    fakeFirestore.writes.length = 0;
    fakeFirestore.terminate.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    'file:///tmp/oauth.json',
    'https://demo-zendesk-mcp/(default)/oauth',
    'firestore:///(default)/oauth',
    'firestore://demo-zendesk-mcp/(default)/bad.collection',
    'firestore://demo-zendesk-mcp/(default)/oauth?raw=true',
    'firestore://demo-zendesk-mcp/(default)/oauth/extra',
  ])('rejects unsupported store URI %s', (uri) => {
    expect(() => createFirestoreStore(uri)).toThrow(
      'Expected firestore://PROJECT/DATABASE/COLLECTION.',
    );
  });

  it('refuses the emulator in production', () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createFirestoreStore(URI)).toThrow(
      'The Firestore emulator is forbidden in production.',
    );
    expect(fakeFirestore.options).toHaveLength(0);
  });

  it('selects REST for production and gRPC for the emulator, and closes the client', async () => {
    const production = createFirestoreStore(URI);
    expect(production.shared).toBe(true);
    expect(fakeFirestore.options.at(-1)).toEqual({
      projectId: 'demo-zendesk-mcp',
      databaseId: '(default)',
      preferRest: true,
    });
    await production.close();
    expect(fakeFirestore.terminate).toHaveBeenCalledTimes(1);

    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085');
    const emulator = createFirestoreStore(URI);
    expect(fakeFirestore.options.at(-1)?.preferRest).toBe(false);
    await emulator.close();
    expect(fakeFirestore.terminate).toHaveBeenCalledTimes(2);
  });

  it('hashes keys and enforces expiry before the TTL service deletes documents', async () => {
    const store = createFirestoreStore(URI);
    await store.set('private-key', 'value', 1000);
    await store.set('permanent', 'kept');

    const expiring = fakeFirestore.data.get(pathFor('private-key')) as {
      value: string;
      expiresAt: { toMillis(): number };
    };
    expect(expiring.value).toBe('value');
    expect(expiring.expiresAt.toMillis()).toBe(1_700_000_001_000);
    expect(fakeFirestore.data.get(pathFor('permanent'))).toEqual({ value: 'kept' });
    expect(await store.get('private-key')).toBe('value');
    await store.set('deleted', 'temporary');
    await store.delete('deleted');
    expect(await store.get('deleted')).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(await store.get('private-key')).toBeUndefined();

    await store.close();
  });

  it('buffers transaction writes until reads finish and supports read-after-write', async () => {
    const store = createFirestoreStore(URI);
    await store.set('read-first', 'before');

    const result = await store.transaction(async (transaction) => {
      expect(await transaction.get('read-first')).toBe('before');
      await transaction.set('read-first', 'after');
      expect(await transaction.get('read-first')).toBe('after');
      await transaction.set('new', 'created');
      await transaction.delete('read-first');
      expect(await transaction.get('read-first')).toBeUndefined();
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(fakeFirestore.reads).toEqual([pathFor('read-first')]);
    expect(fakeFirestore.writes).toEqual([
      { path: pathFor('read-first'), kind: 'delete' },
      { path: pathFor('new'), kind: 'set' },
    ]);
    expect(await store.get('read-first')).toBeUndefined();
    expect(await store.get('new')).toBe('created');

    await store.close();
  });
});
