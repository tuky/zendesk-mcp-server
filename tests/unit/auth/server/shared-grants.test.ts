import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import { createSharedZendeskGrants } from '../../../../src/auth/server/shared-grants';
import { createSealedCollection } from '../../../../src/auth/server/store';
import { createTransactionalRecordStore } from './transactional-record-store';

const SECRET = Buffer.alloc(32, 9).toString('base64');
const UPSTREAM = { subdomain: 'fixture', clientId: 'fixture' };
const NOW = 1_700_000_000_000;
const EXPIRED = { accessToken: 'old', refreshToken: 'single-use', expiresAt: NOW };
const FRESH = {
  accessToken: 'new',
  refreshToken: 'rotated',
  expiresAt: NOW + 86_400_000,
};
const ring = () => deriveKeyRing(SECRET);
const records = (store: ReturnType<typeof createTransactionalRecordStore>['store']) =>
  createSealedCollection<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshAttempt?: { owner: string; until: number };
  }>(store, 'ZendeskTokens', ring());

afterEach(() => vi.useRealTimers());

describe('createSharedZendeskGrants', () => {
  it('returns a cached token, and rejects missing grants or refresh tokens', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async () => FRESH);
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });
    await grants.save('cached', { accessToken: 'valid' });
    expect(await grants.accessToken('cached')).toBe('valid');
    await expect(grants.accessToken('missing')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );

    await grants.save('without-refresh', { ...EXPIRED, refreshToken: undefined });
    await expect(grants.accessToken('without-refresh')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('waits for an active refresh owner and uses the token it saves', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async () => FRESH);
    const tokenRecords = records(store);
    await tokenRecords.set('active', {
      ...EXPIRED,
      refreshAttempt: { owner: 'owner', until: NOW + 60_000 },
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
      wait: async () => tokenRecords.set('active', { accessToken: 'saved-by-owner' }),
    });

    expect(await grants.accessToken('active')).toBe('saved-by-owner');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('revokes and deletes a grant after an abandoned lease without reusing its token', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async () => FRESH);
    await records(store).set('abandoned', {
      ...EXPIRED,
      refreshAttempt: { owner: 'dead-process', until: NOW - 1 },
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });

    await expect(grants.accessToken('abandoned')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(await records(store).get('abandoned')).toBeUndefined();
    expect(await createSealedCollection<boolean>(store, 'Revoked', ring()).get('abandoned')).toBe(
      true,
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired grant and persists the rotated pair', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async () => FRESH);
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });
    await grants.save('rotate', EXPIRED);

    expect(await grants.accessToken('rotate')).toBe('new');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await records(store).get('rotate')).toEqual(FRESH);
  });

  it('fails closed after an ambiguous refresh failure and rejects future use', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async () => {
      throw new Error('response lost after rotation');
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });
    await grants.save('uncertain', EXPIRED);

    await expect(grants.accessToken('uncertain')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    await expect(grants.accessToken('uncertain')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(await records(store).get('uncertain')).toBeUndefined();
    expect(await createSealedCollection<boolean>(store, 'Revoked', ring()).get('uncertain')).toBe(
      true,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a grant removed while refresh is in flight', async () => {
    const { store } = createTransactionalRecordStore();
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh: async () => {
        await grants.remove('racing');
        return FRESH;
      },
      now: () => NOW,
    });
    await grants.save('racing', EXPIRED);

    await expect(grants.accessToken('racing')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(await records(store).get('racing')).toBeUndefined();
  });

  it('returns a retryable error after the maximum wait for an active owner', async () => {
    const { store } = createTransactionalRecordStore();
    await records(store).set('busy', {
      ...EXPIRED,
      refreshAttempt: { owner: 'owner', until: NOW + 60_000 },
    });
    const wait = vi.fn(async () => undefined);
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh: vi.fn(async () => FRESH),
      now: () => NOW,
      wait,
    });

    await expect(grants.accessToken('busy')).rejects.toThrow(
      'Token refresh is in progress. Retry shortly.',
    );
    expect(wait).toHaveBeenCalledTimes(100);
  });

  it('does not save a grant after it has been revoked', async () => {
    const { store } = createTransactionalRecordStore();
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      now: () => NOW,
    });
    await grants.remove('revoked');

    await expect(grants.save('revoked', FRESH)).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(await records(store).get('revoked')).toBeUndefined();
  });
});
