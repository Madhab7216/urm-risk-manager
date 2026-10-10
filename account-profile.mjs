import { makeAccountContextKey, evaluateAccountSupport } from './evidence-integrity.mjs';

export const MAX_ACCOUNT_SNAPSHOT_AGE_MS = 120_000;
const clean = value => typeof value === 'string' ? value.trim() : '';
const num = value => (typeof value === 'string' && !value.trim()) ? NaN : Number(value);

export function accountCoreFingerprint(trader = {}) {
  const broker = clean(trader.BrokerName ?? trader.brokerName).toLowerCase();
  const login = num(trader.Login ?? trader.login);
  const accountType = num(trader.accountType);
  const isLimitedRisk = trader.isLimitedRisk;
  if (!broker || !Number.isSafeInteger(login) || login <= 0 || ![0, 1, 2].includes(accountType) || typeof isLimitedRisk !== 'boolean') return null;
  return [broker, String(login), String(accountType), isLimitedRisk ? 'limited' : 'standard'].join('|');
}

export function createAccountProfile({ trader, currency, nowMs = Date.now() } = {}) {
  const depositCurrency = clean(currency).toUpperCase();
  const brokerName = clean(trader?.BrokerName ?? trader?.brokerName);
  const login = num(trader?.Login ?? trader?.login);
  const accountType = num(trader?.accountType);
  const isLimitedRisk = trader?.isLimitedRisk;
  if (!/^[A-Z]{3}$/.test(depositCurrency) || !Number.isSafeInteger(login) || login <= 0 || !brokerName ||
      ![0, 1, 2].includes(accountType) || typeof isLimitedRisk !== 'boolean' || !Number.isFinite(nowMs) || nowMs <= 0) {
    return { ok: false, code: 'ACCOUNT_PROFILE_FIELDS_MISSING' };
  }
  const key = makeAccountContextKey({ brokerName, login, accountType, isLimitedRisk, currency: depositCurrency });
  if (!key) return { ok: false, code: 'ACCOUNT_CONTEXT_KEY_INVALID' };
  const profile = {
    verified: true, key, brokerName, login, accountType, isLimitedRisk,
    currency: depositCurrency, verifiedAtMs: nowMs,
    accountTypeName: ({ 0: 'HEDGED', 1: 'NETTED', 2: 'SPREAD_BETTING' })[accountType]
  };
  return { ok: true, profile, support: evaluateAccountSupport(profile) };
}

export function isAccountProfileFresh(profile, nowMs = Date.now(), maxAgeMs = MAX_ACCOUNT_SNAPSHOT_AGE_MS) {
  if (!profile?.verified || !Number.isFinite(profile.verifiedAtMs) || !Number.isFinite(nowMs) ||
      !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || profile.verifiedAtMs > nowMs) return false;
  return nowMs - profile.verifiedAtMs <= maxAgeMs;
}

export function accountSnapshotConsistent({ firstTrader, firstCurrency, secondTrader, secondCurrency } = {}) {
  const firstFingerprint=accountCoreFingerprint(firstTrader);
  const secondFingerprint=accountCoreFingerprint(secondTrader);
  const c1=typeof firstCurrency==='string'?firstCurrency.trim().toUpperCase():'';
  const c2=typeof secondCurrency==='string'?secondCurrency.trim().toUpperCase():'';
  return !!firstFingerprint && firstFingerprint===secondFingerprint && /^[A-Z]{3}$/.test(c1) && c1===c2;
}
