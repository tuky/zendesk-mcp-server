import { createHash } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { readEnv } from '../../utils/env';
import type { RecordStore, TransactionalStore } from './file-store';

interface Document {
  value: string;
  expiresAt?: Timestamp;
}
const COLLECTION = /^[a-zA-Z0-9_-]+$/;
const keyId = (key: string) => createHash('sha256').update(key).digest('hex');
const liveValue = (data: Document | undefined): string | undefined =>
  data && (!data.expiresAt || data.expiresAt.toMillis() > Date.now()) ? data.value : undefined;
const document = (value: string, ttlMs?: number): Document => ({
  value,
  ...(ttlMs === undefined ? {} : { expiresAt: Timestamp.fromMillis(Date.now() + ttlMs) }),
});

/** URI: firestore://PROJECT/DATABASE/COLLECTION. Values are encrypted by the auth layer. */
export const createFirestoreStore = (
  uri: string,
): TransactionalStore & { close(): Promise<void> } => {
  const url = new URL(uri);
  const parts = url.pathname.slice(1).split('/');
  const [databaseId, collectionId] = parts;
  if (
    url.protocol !== 'firestore:' ||
    !url.hostname ||
    parts.length !== 2 ||
    !databaseId ||
    !collectionId ||
    !COLLECTION.test(collectionId) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Expected firestore://PROJECT/DATABASE/COLLECTION.');
  }
  const emulator = readEnv('FIRESTORE_EMULATOR_HOST').value;
  if (emulator && readEnv('NODE_ENV').value === 'production') {
    throw new Error('The Firestore emulator is forbidden in production.');
  }
  const db = new Firestore({ projectId: url.hostname, databaseId, preferRest: !emulator });
  const collection = db.collection(collectionId);
  const ref = (key: string) => collection.doc(keyId(key));
  return {
    shared: true,
    get: async (key) => liveValue((await ref(key).get()).data() as Document | undefined),
    set: async (key, value, ttlMs) => {
      await ref(key).set(document(value, ttlMs));
    },
    delete: async (key) => {
      await ref(key).delete();
    },
    transaction: async (operation) =>
      db.runTransaction(async (transaction) => {
        // Buffer writes so an auth operation can read after a logical write while
        // Firestore still receives every database read before its first write.
        const writes = new Map<string, Document | null>();
        const tx: RecordStore = {
          get: async (key) => {
            if (writes.has(key)) return liveValue(writes.get(key) ?? undefined);
            return liveValue((await transaction.get(ref(key))).data() as Document | undefined);
          },
          set: async (key, value, ttlMs) => {
            writes.set(key, document(value, ttlMs));
          },
          delete: async (key) => {
            writes.set(key, null);
          },
        };
        const result = await operation(tx);
        for (const [key, value] of writes) {
          if (value === null) transaction.delete(ref(key));
          else transaction.set(ref(key), value);
        }
        return result;
      }),
    close: () => db.terminate(),
  };
};
