/**
 * URM Stage F plugin-facing policy adapter.
 * No cTrader SDK calls or order execution occur in this module.
 */
import {
  URM_RISK_POLICY,
  calculateFixedUsdRiskVolumeCents,
  priceTarget
} from './risk-core.mjs';
import {
  MAX_MANUAL_PIP_VALUE_AGE_MS, MAX_MANUAL_FX_AGE_MS, MAX_MANUAL_COMMISSION_AGE_MS,
  validateManualEvidence
} from './evidence-integrity.mjs';

// Manual attestation windows are policy limits, not independent broker verification.
export { MAX_MANUAL_FX_AGE_MS } from './evidence-integrity.mjs';

function fail(code, reason, details = {}) {
  return { ok: false, code, reason, ...details };
}
function n(value) {
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

/**
 * Calculate a preview for the current quote and user-supplied structural SL.
 * The target stays fixed at USD 10 price-risk. Commission is estimated and
 * displayed separately; it never changes volume sizing.
 */
export function calculatePluginPreview(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('PREVIEW_INPUT_INVALID', 'Preview input must be an object.');
  }
  const side = input.side;
  const entry = n(input.entry);
  const stopLoss = n(input.stopLoss);
  const pipPosition = n(input.pipPosition);
  const currency = typeof input.accountCurrency === 'string' ? input.accountCurrency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'UNKNOWN' || input.accountCurrencyConfirmed !== true) {
    return fail('ACCOUNT_CURRENCY_UNCONFIRMED', 'Account deposit currency must be confirmed by the platform.');
  }
  if (side !== 'BUY' && side !== 'SELL') return fail('SIDE_INVALID', 'Side must be BUY or SELL.');
  if (![entry, stopLoss, pipPosition].every(Number.isFinite) || entry <= 0 || stopLoss <= 0 ||
      !Number.isInteger(pipPosition) || pipPosition < 0 || pipPosition > 10) {
    return fail('PRICE_OR_PIP_POSITION_INVALID', 'Entry, stop price and pip position must be valid finite values.');
  }
  if ((side === 'BUY' && stopLoss >= entry) || (side === 'SELL' && stopLoss <= entry)) {
    return fail('STOP_DIRECTION_INVALID', 'BUY requires SL below entry; SELL requires SL above entry.');
  }
  const rDistance = Math.abs(entry - stopLoss);
  const pipSize = Math.pow(10, -pipPosition);
  const stopDistancePips = rDistance / pipSize;
  if (!Number.isFinite(stopDistancePips) || stopDistancePips <= 0) {
    return fail('STOP_DISTANCE_INVALID', 'Stop-loss distance in pips must be positive and finite.');
  }

  const nowMs = Number.isFinite(n(input.nowMs)) ? n(input.nowMs) : Date.now();
  const accountKey = typeof input.accountKey === 'string' ? input.accountKey.trim() : '';
  const symbolId = Number(input.symbolId);
  if (!accountKey || !Number.isSafeInteger(symbolId) || symbolId < 0) {
    return fail('PREVIEW_CONTEXT_UNVERIFIED', 'A verified account context key and exact symbol ID are required.');
  }
  if (input.pipValueVerified !== true) return fail('PIP_VALUE_NOT_VERIFIED', 'Pip value must be explicitly attested for this account, symbol, value and source.');
  const pipEvidence = validateManualEvidence({
    evidence: input.pipValueEvidence, kind: 'pip-value', accountKey, symbolId,
    value: input.pipValuePerLot, source: input.pipValueSource, nowMs,
    maxAgeMs: MAX_MANUAL_PIP_VALUE_AGE_MS
  });
  if (!pipEvidence.ok) {
    return fail(`PIP_EVIDENCE_${pipEvidence.code}`, 'Pip-value attestation is missing, stale or does not match the current account, symbol, value and source.', { evidenceCode: pipEvidence.code });
  }
  const isUsd = currency === 'USD';
  const fxRate = isUsd ? 1 : n(input.depositCurrencyPerUsd);
  let fxAgeMs = 0;
  let fxSource = 'USD_PARITY';
  if (!isUsd) {
    if (input.fxVerified !== true) return fail('FX_NOT_VERIFIED', 'The FX rate must be explicitly attested for this account and currency.');
    const fxEvidence = validateManualEvidence({
      evidence: input.fxEvidence, kind: 'fx-rate', accountKey, symbolId: null,
      value: input.depositCurrencyPerUsd, source: input.fxSource, nowMs,
      maxAgeMs: MAX_MANUAL_FX_AGE_MS
    });
    if (!fxEvidence.ok) {
      return fail(`FX_EVIDENCE_${fxEvidence.code}`, 'FX attestation is missing, stale or does not match the current account, conversion rate and source.', { evidenceCode: fxEvidence.code });
    }
    fxAgeMs = fxEvidence.ageMs;
    fxSource = fxEvidence.source;
  }
  const budget = calculateFixedUsdRiskVolumeCents({
    accountCurrency: currency,
    accountCurrencyConfirmed: input.accountCurrencyConfirmed === true,
    depositCurrencyPerUsd: fxRate,
    fxVerified: true,
    fxAgeMs,
    maxFxAgeMs: MAX_MANUAL_FX_AGE_MS,
    fxSource,
    pipValueVerified: true,
    pipValueSource: pipEvidence.source,
    stopDistancePips,
    pipValuePerLot: input.pipValuePerLot,
    lotSizeCents: input.lotSizeCents,
    minVolumeCents: input.minVolumeCents,
    maxVolumeCents: input.maxVolumeCents,
    stepVolumeCents: input.stepVolumeCents
  });
  if (!budget.ok) return { ...budget, entry, stopLoss, side, stopDistancePips, rDistance };

  const takeProfit = priceTarget(entry, rDistance, side, URM_RISK_POLICY.takeProfitR);
  if (!Number.isFinite(takeProfit)) return fail('TP_CALCULATION_INVALID', 'The 5R target could not be calculated safely.');

  // Round-turn commission estimate is optional and explicitly outside the risk budget.
  let commissionEstimate = null;
  let commissionStatus = 'NOT_VERIFIED';
  let commissionSource = '';
  if (input.commissionVerified === true) {
    const commissionPerLot = n(input.roundTurnCommissionPerLot);
    const source = typeof input.commissionSource === 'string' ? input.commissionSource.trim() : '';
    const commissionEvidence = validateManualEvidence({
      evidence: input.commissionEvidence, kind: 'commission', accountKey, symbolId,
      value: input.roundTurnCommissionPerLot, source, nowMs,
      maxAgeMs: MAX_MANUAL_COMMISSION_AGE_MS
    });
    if (!commissionEvidence.ok || !Number.isFinite(commissionPerLot) || commissionPerLot < 0 || !source) {
      commissionStatus = `VERIFICATION_INCOMPLETE${commissionEvidence.ok ? '' : `:${commissionEvidence.code}`}`;
    } else {
      commissionEstimate = budget.lots * commissionPerLot;
      commissionSource = source;
      commissionStatus = 'ESTIMATED_ROUND_TURN';
    }
  }

  const estimatedRiskUsd = budget.estimatedRisk / budget.depositCurrencyPerUsd;
  return {
    ...budget,
    ok: true,
    side,
    entry,
    stopLoss,
    takeProfit,
    rDistance,
    stopDistancePips,
    estimatedRiskUsd,
    commissionEstimate,
    commissionStatus,
    commissionSource,
    estimatedPriceLossPlusCommission: commissionEstimate == null ? null : budget.estimatedRisk + commissionEstimate,
    commissionIsIncludedInSizing: false,
    maxManualFxAgeMs: MAX_MANUAL_FX_AGE_MS,
    manualEvidence: { pipValueAgeMs: pipEvidence.ageMs, fxAgeMs, commissionStatus },
    executionEnabled: false
  };
}
