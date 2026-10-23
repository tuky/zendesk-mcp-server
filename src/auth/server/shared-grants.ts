import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecordStore } from './file-store';
import type { KeyRing } from './keys';
import { createSealedCollection } from './store';
import { refreshZendeskTokens, type ZendeskTokenSet, type ZendeskUpstream } from './upstream';
import {
  grantUnavailableError,
  ZENDESK_REFRESH_MARGIN_MS,
  type ZendeskGrants,
} from './zendesk-grant';

type Grant = ZendeskTokenSet & { refreshAttempt?: { owner: string; until: number } };
const TTL = 90 * 86400;
const LEASE_MS = 60_000;
// Stryker disable next-line ConditionalExpression: undefined expiry yields NaN, whose comparison is false.
const needsRefresh = (tokens: Grant, now: number) =>
  tokens.expiresAt !== undefined && tokens.expiresAt - now <= 3600_000 + ZENDESK_REFRESH_MARGIN_MS;

/** A refresh attempt is never taken over: an abandoned attempt may have spent its token. */
export const createSharedZendeskGrants = (options: {
  store: RecordStore;
  ring: KeyRing;
  upstream: ZendeskUpstream;
  refresh?: typeof refreshZendeskTokens;
  now?: () => number;
  wait?: () => Promise<void>;
}): ZendeskGrants => {
  const { store, ring, upstream } = options;
  const transaction = store.transaction;
  if (!transaction) throw new Error('Shared grants require transactions.');
  const now = options.now ?? Date.now;
  const refresh = options.refresh ?? refreshZendeskTokens;
  const wait = options.wait ?? (() => delay(100));
  const records = (tx: RecordStore) => createSealedCollection<Grant>(tx, 'ZendeskTokens', ring);
  const revoked = (tx: RecordStore) => createSealedCollection<boolean>(tx, 'Revoked', ring);
  const existingAttempt = async (tx: RecordStore, id: string, until: number) => {
    if (until > now()) return { kind: 'wait' as const };
    await revoked(tx).set(id, true, TTL);
    await records(tx).delete(id);
    return { kind: 'missing' as const };
  };
  const claimRefresh = (id: string, owner: string) =>
    transaction(async (tx) => {
      const collection = records(tx);
      const tokens = await collection.get(id);
      if (!tokens || (await revoked(tx).get(id))) return { kind: 'missing' as const };
      if (tokens.refreshAttempt) {
        return existingAttempt(tx, id, tokens.refreshAttempt.until);
      }
      if (!needsRefresh(tokens, now())) {
        return { kind: 'cached' as const, token: tokens.accessToken };
      }
      if (!tokens.refreshToken) return { kind: 'missing' as const };
      await collection.set(
        id,
        { ...tokens, refreshAttempt: { owner, until: now() + LEASE_MS } },
        TTL,
      );
      return { kind: 'refresh' as const, token: tokens.refreshToken };
    });
  return {
    save: (id, tokens) =>
      transaction(async (tx) => {
        if (await revoked(tx).get(id)) throw grantUnavailableError();
        await records(tx).set(id, tokens, TTL);
      }),
    remove: (id) =>
      transaction(async (tx) => {
        await revoked(tx).set(id, true, TTL);
        await records(tx).delete(id);
      }),
    accessToken: async (id) => {
      const owner = randomUUID();
      for (let attempt = 0; attempt < 100; attempt++) {
        const claim = await claimRefresh(id, owner);
        if (claim.kind === 'missing') throw grantUnavailableError();
        if (claim.kind === 'cached') return claim.token;
        if (claim.kind === 'wait') {
          await wait();
          continue;
        }
        try {
          // External side effects must never run in a retried Firestore transaction.
          const fresh = await refresh(upstream, claim.token);
          await transaction(async (tx) => {
            const current = await records(tx).get(id);
            if (
              current?.refreshAttempt?.owner !== owner ||
              current.refreshAttempt.until <= now() ||
              (await revoked(tx).get(id))
            ) {
              throw grantUnavailableError();
            }
            await records(tx).set(id, fresh, TTL);
          });
          return fresh.accessToken;
        } catch (cause) {
          // Even a timeout can mean Zendesk rotated the token. Do not retry it.
          await transaction(async (tx) => {
            await revoked(tx).set(id, true, TTL);
            await records(tx).delete(id);
          });
          throw Object.assign(grantUnavailableError(), { cause });
        }
      }
      throw new Error('Token refresh is in progress. Retry shortly.');
    },
  };
};
