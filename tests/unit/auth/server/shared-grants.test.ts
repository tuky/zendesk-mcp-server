import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../../../src/auth/server/file-store';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import { createSharedZendeskGrants } from '../../../../src/auth/server/shared-grants';
import { createSealedCollection } from '../../../../src/auth/server/store';
import { ZENDESK_REFRESH_MARGIN_MS } from '../../../../src/auth/server/zendesk-grant';
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
  it('requires a transactional backend', () => {
    expect(() =>
      createSharedZendeskGrants({
        store: createMemoryStore(),
        ring: ring(),
        upstream: UPSTREAM,
      }),
    ).toThrow('Shared grants require transactions.');
  });

  it('keeps grants for 90 days and refreshes at the access-token safety boundary', async () => {
    vi.useFakeTimers({ now: NOW });
    const { store, entries } = createTransactionalRecordStore();
    const refresh = vi.fn(async (upstream, token) => {
      expect(upstream).toEqual(UPSTREAM);
      expect(token).toBe('single-use');
      return FRESH;
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });
    const boundary = NOW + 3600_000 + ZENDESK_REFRESH_MARGIN_MS;
    await grants.save('boundary', { ...EXPIRED, expiresAt: boundary });
    await grants.save('safe', { accessToken: 'long-lived', expiresAt: boundary + 1 });

    expect([...entries.values()].map(({ exp }) => exp)).toEqual([
      NOW + 90 * 86400 * 1000,
      NOW + 90 * 86400 * 1000,
    ]);
    expect(await grants.accessToken('boundary')).toBe('new');
    expect(await grants.accessToken('safe')).toBe('long-lived');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

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

  it('treats a refresh lease expiring now as abandoned', async () => {
    const { store } = createTransactionalRecordStore();
    await records(store).set('at-deadline', {
      ...EXPIRED,
      refreshAttempt: { owner: 'dead-process', until: NOW },
    });
    const refresh = vi.fn(async () => FRESH);
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });

    await expect(grants.accessToken('at-deadline')).rejects.toHaveProperty(
      'name',
      'ZendeskGrantUnavailable',
    );
    expect(await records(store).get('at-deadline')).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired grant and persists the rotated pair', async () => {
    const { store } = createTransactionalRecordStore();
    const refresh = vi.fn(async (upstream, token) => {
      expect(upstream).toEqual(UPSTREAM);
      expect(token).toBe('single-use');
      return FRESH;
    });
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
    const failure = new Error('response lost after rotation');
    const refresh = vi.fn(async () => {
      throw failure;
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh,
      now: () => NOW,
    });
    await grants.save('uncertain', EXPIRED);

    await expect(grants.accessToken('uncertain')).rejects.toMatchObject({
      name: 'ZendeskGrantUnavailable',
      cause: failure,
    });
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

    await expect(grants.accessToken('racing')).rejects.toMatchObject({
      name: 'ZendeskGrantUnavailable',
      cause: { name: 'ZendeskGrantUnavailable' },
    });
    expect(await records(store).get('racing')).toBeUndefined();
  });

  it('fails closed when another writer replaces or removes the refresh lease', async () => {
    for (const replaceAttempt of [true, false]) {
      const { store } = createTransactionalRecordStore();
      const grants = createSharedZendeskGrants({
        store,
        ring: ring(),
        upstream: UPSTREAM,
        refresh: async () => {
          if (replaceAttempt) {
            await records(store).set('racing-lease', {
              ...EXPIRED,
              refreshAttempt: { owner: 'another-process', until: NOW + 60_000 },
            });
          } else {
            await records(store).set('racing-lease', EXPIRED);
          }
          return FRESH;
        },
        now: () => NOW,
      });
      await grants.save('racing-lease', EXPIRED);

      await expect(grants.accessToken('racing-lease')).rejects.toMatchObject({
        name: 'ZendeskGrantUnavailable',
        cause: { name: 'ZendeskGrantUnavailable' },
      });
      expect(await records(store).get('racing-lease')).toBeUndefined();
      expect(
        await createSealedCollection<boolean>(store, 'Revoked', ring()).get('racing-lease'),
      ).toBe(true);
    }
  });

  it('rejects a refresh that completes at the lease deadline', async () => {
    const { store } = createTransactionalRecordStore();
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      refresh: async () => {
        const current = await records(store).get('deadline');
        await records(store).set('deadline', {
          ...EXPIRED,
          refreshAttempt: {
            owner: current?.refreshAttempt?.owner ?? '',
            until: NOW,
          },
        });
        return FRESH;
      },
      now: () => NOW,
    });
    await grants.save('deadline', EXPIRED);

    await expect(grants.accessToken('deadline')).rejects.toMatchObject({
      name: 'ZendeskGrantUnavailable',
      cause: { name: 'ZendeskGrantUnavailable' },
    });
    expect(await records(store).get('deadline')).toBeUndefined();
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

  it('uses a timer between retries while another owner holds the refresh lease', async () => {
    const { store } = createTransactionalRecordStore();
    await records(store).set('busy-default-wait', {
      ...EXPIRED,
      refreshAttempt: { owner: 'owner', until: NOW + 60_000 },
    });
    const grants = createSharedZendeskGrants({
      store,
      ring: ring(),
      upstream: UPSTREAM,
      now: (() => {
        let reads = 0;
        return () => (reads++ === 0 ? NOW : NOW + 60_000);
      })(),
    });
    const startedAt = Date.now();
    const pending = grants.accessToken('busy-default-wait');
    await expect(pending).rejects.toHaveProperty('name', 'ZendeskGrantUnavailable');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
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
