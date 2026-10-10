/**
 * URM Stage F — manual evidence integrity.
 * These helpers bind a user's attestation to the exact account, symbol, value,
 * and source. They do NOT independently verify the broker/source itself.
 */
export const MAX_MANUAL_PIP_VALUE_AGE_MS = 15 * 60 * 1000;
export const MAX_MANUAL_FX_AGE_MS = 15 * 60 * 1000;
export const MAX_MANUAL_COMMISSION_AGE_MS = 24 * 60 * 60 * 1000;

function numeric(value) {
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function validContext(accountKey, symbolId) {
  return typeof accountKey === 'string' && accountKey.trim().length > 0 &&
    (symbolId === null || symbolId === undefined || (Number.isSafeInteger(Number(symbolId)) && Number(symbolId) >= 0));
}

export function createManualEvidence({
  kind, accountKey, symbolId, value, source, nowMs = Date.now(), observedAgeMs = 0
} = {}) {
  const permitted = new Set(['pip-value', 'fx-rate', 'commission']);
  if (!permitted.has(kind)) return { ok: false, code: 'EVIDENCE_KIND_INVALID' };
  if (!validContext(accountKey, symbolId)) return { ok: false, code: 'EVIDENCE_CONTEXT_INVALID' };
  if (kind !== 'fx-rate' && (symbolId === null || symbolId === undefined)) {
    return { ok: false, code: 'EVIDENCE_SYMBOL_REQUIRED' };
  }
  const v = numeric(value);
  const src = clean(source);
  const age = numeric(observedAgeMs);
  if (!Number.isFinite(v) || v < 0 || (kind !== 'commission' && v <= 0)) {
    return { ok: false, code: 'EVIDENCE_VALUE_INVALID' };
  }
  if (!src) return { ok: false, code: 'EVIDENCE_SOURCE_MISSING' };
  if (!Number.isFinite(nowMs) || nowMs <= 0 || !Number.isFinite(age) || age < 0) {
    return { ok: false, code: 'EVIDENCE_TIME_INVALID' };
  }
  const observedAtMs = nowMs - age;
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > nowMs) {
    return { ok: false, code: 'EVIDENCE_OBSERVATION_TIME_INVALID' };
  }
  return {
    ok: true,
    evidence: Object.freeze({
      schema: 'urm-manual-evidence/v1', kind, accountKey: accountKey.trim(),
      symbolId: symbolId === null || symbolId === undefined ? null : Number(symbolId),
      value: v, source: src, attestedAtMs: nowMs, observedAtMs
    })
  };
}

export function validateManualEvidence({
  evidence, kind, accountKey, symbolId, value, source, nowMs = Date.now(), maxAgeMs
} = {}) {
  if (!evidence || evidence.schema !== 'urm-manual-evidence/v1') return { ok: false, code: 'EVIDENCE_MISSING' };
  if (evidence.kind !== kind) return { ok: false, code: 'EVIDENCE_KIND_MISMATCH' };
  if (!validContext(accountKey, symbolId) || evidence.accountKey !== clean(accountKey)) {
    return { ok: false, code: 'EVIDENCE_ACCOUNT_MISMATCH' };
  }
  const expectedSymbol = symbolId === null || symbolId === undefined ? null : Number(symbolId);
  if (evidence.symbolId !== expectedSymbol) return { ok: false, code: 'EVIDENCE_SYMBOL_MISMATCH' };
  const v = numeric(value);
  if (!Number.isFinite(v) || evidence.value !== v) return { ok: false, code: 'EVIDENCE_VALUE_CHANGED' };
  if (evidence.source !== clean(source) || !clean(source)) return { ok: false, code: 'EVIDENCE_SOURCE_CHANGED' };
  if (!Number.isFinite(nowMs) || !Number.isFinite(evidence.attestedAtMs) ||
      !Number.isFinite(evidence.observedAtMs) || evidence.attestedAtMs > nowMs || evidence.observedAtMs > nowMs ||
      evidence.observedAtMs > evidence.attestedAtMs) {
    return { ok: false, code: 'EVIDENCE_TIME_INVALID' };
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return { ok: false, code: 'EVIDENCE_MAX_AGE_INVALID' };
  const ageMs = nowMs - evidence.observedAtMs;
  const attestationAgeMs = nowMs - evidence.attestedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs || attestationAgeMs > maxAgeMs) {
    return { ok: false, code: 'EVIDENCE_STALE', ageMs, attestationAgeMs, maxAgeMs };
  }
  return { ok: true, ageMs, attestationAgeMs, source: evidence.source, value: evidence.value };
}

export function makeAccountContextKey({ brokerName, login, accountType, isLimitedRisk, currency } = {}) {
  const broker = clean(brokerName).toLowerCase();
  const cur = clean(currency).toUpperCase();
  const log = numeric(login);
  const type = numeric(accountType);
  if (!broker || !Number.isSafeInteger(log) || log <= 0 || ![0, 1, 2].includes(type) ||
      typeof isLimitedRisk !== 'boolean' || !/^[A-Z]{3}$/.test(cur)) return null;
  return [broker, String(log), String(type), isLimitedRisk ? 'limited' : 'standard', cur].join('|');
}

export function evaluateAccountSupport(profile) {
  if (!profile || profile.verified !== true || !profile.key) {
    return { ok: false, code: 'ACCOUNT_PROFILE_UNVERIFIED', reason: 'Broker, login, account type, limited-risk flag and deposit currency must all be confirmed.' };
  }
  if (profile.accountType !== 0) {
    const names = { 1: 'NETTED', 2: 'SPREAD_BETTING' };
    return { ok: false, code: 'ACCOUNT_TYPE_UNSUPPORTED', reason: `${names[profile.accountType] ?? 'UNKNOWN'} account model is not supported by this preview.` };
  }
  if (profile.isLimitedRisk === true) {
    return { ok: false, code: 'LIMITED_RISK_ACCOUNT_UNSUPPORTED', reason: 'Limited-risk accounts require Guaranteed Stop Loss handling, which this preview does not implement.' };
  }
  return { ok: true, code: 'ACCOUNT_PROFILE_SUPPORTED' };
}
