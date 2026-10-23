import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createFirestoreStore } from '../../src/auth/server/firestore-store';
import { deriveKeyRing } from '../../src/auth/server/keys';
import { createSharedZendeskGrants } from '../../src/auth/server/shared-grants';
import { createSealedCollection } from '../../src/auth/server/store';

const uri = `firestore://demo-zendesk-mcp/(default)/grants_${randomUUID().replaceAll('-', '')}`;
const a = createFirestoreStore(uri);
const b = createFirestoreStore(uri);
const ring = deriveKeyRing(Buffer.alloc(32, 9).toString('base64'));
const upstream = { subdomain: 'fixture', clientId: 'fixture' };
afterAll(async () => {
  await a.close();
  await b.close();
});
const old = { accessToken: 'old', refreshToken: 'single-use', expiresAt: 1 };
const fresh = { accessToken: 'new', refreshToken: 'rotated', expiresAt: Date.now() + 86400000 };

describe('distributed refresh', () => {
  it('refreshes only once across independent server instances', async () => {
    const refresh = vi.fn(async () => fresh);
    const left = createSharedZendeskGrants({ store: a, ring, upstream, refresh });
    const right = createSharedZendeskGrants({ store: b, ring, upstream, refresh });
    await left.save('concurrent', old);
    expect(
      await Promise.all([left.accessToken('concurrent'), right.accessToken('concurrent')]),
    ).toEqual(['new', 'new']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('does not retry an ambiguous upstream failure', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('response lost after rotation');
    });
    const grants = createSharedZendeskGrants({ store: a, ring, upstream, refresh });
    await grants.save('uncertain', old);
    await expect(grants.accessToken('uncertain')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    await expect(grants.accessToken('uncertain')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('requires sign-in after an abandoned refresh lease expires', async () => {
    const refresh = vi.fn(async () => fresh);
    await createSealedCollection(a, 'ZendeskTokens', ring).set(
      'crashed',
      { ...old, refreshAttempt: { owner: 'dead', until: 1 } },
      60,
    );
    const grants = createSharedZendeskGrants({ store: b, ring, upstream, refresh });
    await expect(grants.accessToken('crashed')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not resurrect a grant revoked during refresh', async () => {
    let release = () => {};
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const left = createSharedZendeskGrants({
      store: a,
      ring,
      upstream,
      refresh: async () => {
        started();
        await hold;
        return fresh;
      },
    });
    const right = createSharedZendeskGrants({ store: b, ring, upstream });
    await left.save('race', old);
    const pending = left.accessToken('race');
    await ready;
    await right.remove('race');
    release();
    await expect(pending).rejects.toHaveProperty('name', 'ZendeskGrantUnavailable');
    expect(await createSealedCollection(a, 'ZendeskTokens', ring).get('race')).toBeUndefined();
  });
});
