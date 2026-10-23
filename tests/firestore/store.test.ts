import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createFirestoreStore } from '../../src/auth/server/firestore-store';
import { deriveKeyRing } from '../../src/auth/server/keys';
import { createAdapterFactory, createSealedCollection } from '../../src/auth/server/store';

const uri = `firestore://demo-zendesk-mcp/(default)/test_${randomUUID().replaceAll('-', '')}`;
const a = createFirestoreStore(uri);
const b = createFirestoreStore(uri);
const ring = deriveKeyRing(Buffer.alloc(32, 9).toString('base64'));
afterAll(async () => {
  await a.close();
  await b.close();
});

describe('shared Firestore authorization state', () => {
  it('shares records, enforces expiry without TTL deletion, and deletes', async () => {
    await a.set('value', 'encrypted', 60000);
    expect(await b.get('value')).toBe('encrypted');
    await a.set('expired', 'old', -1);
    expect(await b.get('expired')).toBeUndefined();
    await b.delete('value');
    expect(await a.get('value')).toBeUndefined();
  });
  it('serializes read-modify-write across independent clients', async () => {
    await a.set('counter', '0');
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? a : b).transaction(async (tx) => {
          const value = Number(await tx.get('counter'));
          await tx.set('counter', String(value + 1));
        }),
      ),
    );
    expect(await a.get('counter')).toBe('6');
  });
  it('shares short-lived OIDC records and consumes a code only once', async () => {
    const left = createAdapterFactory({ persistent: a }, ring)('AuthorizationCode');
    const right = createAdapterFactory({ persistent: b }, ring)('AuthorizationCode');
    await left.upsert('code', { grantId: 'grant', exp: Math.floor(Date.now() / 1000) + 60 }, 60);
    expect(await right.find('code')).toHaveProperty('grantId', 'grant');
    const attempts = await Promise.allSettled([left.consume('code'), right.consume('code')]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await right.find('code')).toBeUndefined();
  });
  it('takes encrypted pending state only once across instances', async () => {
    const left = createSealedCollection<string>(a, 'Pending', ring);
    const right = createSealedCollection<string>(b, 'Pending', ring);
    await left.set('login', 'private-verifier', 60);
    const results = await Promise.all([left.take('login'), right.take('login')]);
    expect(results.filter((value) => value === 'private-verifier')).toHaveLength(1);
  });
  it('revokes a grant without losing concurrent index updates', async () => {
    const left = createAdapterFactory({ persistent: a }, ring)('RefreshToken');
    const right = createAdapterFactory({ persistent: b }, ring)('RefreshToken');
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        (i % 2 ? left : right).upsert(`refresh-${i}`, { grantId: 'revoked' }, 60),
      ),
    );
    await left.revokeByGrantId('revoked');
    for (let i = 0; i < 5; i++) expect(await right.find(`refresh-${i}`)).toBeUndefined();
  });
});
