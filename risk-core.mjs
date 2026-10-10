/**
 * URM Advanced Risk Core — Stage A
 *
 * Pure calculations only. This module does not connect to cTrader, submit orders,
 * read a live quote, or claim that broker-side protection has been confirmed.
 * Callers must persist the immutable anchor and update confirmed stop state only
 * after the platform reports success and a fresh position reconciliation agrees.
 */

export const URM_RISK_POLICY = Object.freeze({
  schemaVersion: 1,
  policyVersion: 'URM-RM-1.0',
  targetRiskUsd: 10,
  takeProfitR: 5,
  breakEvenAtR: 1,
  profitLockAtR: 2,
  profitLockToR: 1.7,
  trailingStartsAtR: 3,
  trailingFloorR: 2,
  trailingGapR: 1
});

const EPSILON = 1e-10;

function blocked(code, reason, details = {}) {
  return { ok: false, code, reason, ...details };
}

function toFiniteNumber(value) {
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

function isSide(side) {
  return side === 'BUY' || side === 'SELL';
}

/**
 * Resolve the fixed USD 10 budget into the account's deposit currency.
 *
 * For a non-USD account callers must provide an explicitly verified conversion,
 * its age in milliseconds, and an approved maximum age. This function does not
 * choose a freshness threshold on behalf of the product owner.
 */
export function resolveFixedRiskBudget({
  accountCurrency,
  accountCurrencyConfirmed,
  depositCurrencyPerUsd,
  fxVerified = false,
  fxAgeMs,
  maxFxAgeMs,
  fxSource = ''
} = {}) {
  const currency = typeof accountCurrency === 'string' ? accountCurrency.trim().toUpperCase() : '';
  if (accountCurrencyConfirmed !== true || !/^[A-Z]{3}$/.test(currency)) {
    return blocked('ACCOUNT_CURRENCY_UNCONFIRMED', 'Account deposit currency must be confirmed by the platform.');
  }

  if (currency === 'USD') {
    const suppliedRate = depositCurrencyPerUsd == null ? 1 : toFiniteNumber(depositCurrencyPerUsd);
    if (!Number.isFinite(suppliedRate) || Math.abs(suppliedRate - 1) > EPSILON) {
      return blocked('USD_RATE_MUST_EQUAL_ONE', 'For a USD account, the deposit-currency-per-USD rate must be exactly 1.');
    }
    return {
      ok: true,
      targetRiskUsd: URM_RISK_POLICY.targetRiskUsd,
      accountCurrency: currency,
      depositCurrencyPerUsd: 1,
      riskInDepositCurrency: URM_RISK_POLICY.targetRiskUsd,
      fxSource: 'USD_PARITY',
      fxAgeMs: 0
    };
  }

  const rate = toFiniteNumber(depositCurrencyPerUsd);
  const age = toFiniteNumber(fxAgeMs);
  const maxAge = toFiniteNumber(maxFxAgeMs);
  if (fxVerified !== true) {
    return blocked('FX_NOT_VERIFIED', 'Non-USD conversion must be explicitly verified before sizing.');
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return blocked('FX_RATE_INVALID', 'Deposit-currency units per USD must be a finite positive number.');
  }
  if (!Number.isFinite(age) || age < 0 || !Number.isFinite(maxAge) || maxAge <= 0) {
    return blocked('FX_AGE_INVALID', 'A non-negative FX age and a positive approved maximum FX age are required.');
  }
  if (age > maxAge) {
    return blocked('FX_STALE', 'FX conversion is older than the approved maximum age.', { fxAgeMs: age, maxFxAgeMs: maxAge });
  }
  if (typeof fxSource !== 'string' || fxSource.trim() === '') {
    return blocked('FX_SOURCE_MISSING', 'FX conversion source must be recorded for auditability.');
  }

  return {
    ok: true,
    targetRiskUsd: URM_RISK_POLICY.targetRiskUsd,
    accountCurrency: currency,
    depositCurrencyPerUsd: rate,
    riskInDepositCurrency: URM_RISK_POLICY.targetRiskUsd * rate,
    fxSource: fxSource.trim(),
    fxAgeMs: age
  };
}

/**
 * Calculate volume in cTrader protocol cents from a verified deposit-currency
 * risk budget, distance in pips, and broker-verified pip value per lot.
 *
 * Volumes are normalised downward. If the target size exceeds the symbol's
 * maximum, this returns the maximum valid size (with an explicit capped flag)
 * because it results in lower risk than the target. A size below minimum blocks.
 * All volume metadata is expected in integer protocol-cent units.
 */
export function calculateVolumeCents(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return blocked('SIZING_INPUT_INVALID', 'Sizing input must be an object.');
  }

  const risk = toFiniteNumber(input.riskInDepositCurrency);
  const stopPips = toFiniteNumber(input.stopDistancePips);
  const pipValue = toFiniteNumber(input.pipValuePerLot);
  const lotSize = toFiniteNumber(input.lotSizeCents);
  const minVolume = toFiniteNumber(input.minVolumeCents);
  const maxVolume = toFiniteNumber(input.maxVolumeCents);
  const stepVolume = toFiniteNumber(input.stepVolumeCents);

  const numericalInputs = [risk, stopPips, pipValue, lotSize, minVolume, maxVolume, stepVolume];
  if (!numericalInputs.every(Number.isFinite)) {
    return blocked('SIZING_INPUT_NON_FINITE', 'Every sizing input must be a finite number.');
  }
  if (risk <= 0 || stopPips <= 0 || pipValue <= 0 || lotSize <= 0 || minVolume <= 0 ||
      maxVolume < minVolume || stepVolume <= 0) {
    return blocked('SIZING_INPUT_OUT_OF_RANGE', 'Risk, stop distance, pip value and volume rules must be positive and internally consistent.');
  }
  if (![lotSize, minVolume, maxVolume, stepVolume].every(Number.isSafeInteger)) {
    return blocked('VOLUME_METADATA_NOT_INTEGER', 'cTrader protocol-cent volume metadata must be safe integers.');
  }
  const rawLots = risk / (stopPips * pipValue);
  const rawVolumeCents = rawLots * lotSize;
  if (!Number.isFinite(rawLots) || !Number.isFinite(rawVolumeCents) || rawLots <= 0 || rawVolumeCents <= 0) {
    return blocked('SIZING_RESULT_NON_FINITE', 'Calculated position size is not finite and positive.');
  }

  const maxValidVolume = Math.floor(maxVolume / stepVolume) * stepVolume;
  if (maxValidVolume < minVolume) {
    return blocked('NO_VALID_VOLUME', 'Symbol maximum and volume step do not allow a valid volume at or above the minimum.');
  }

  const rawNormalized = Math.floor(rawVolumeCents / stepVolume) * stepVolume;
  const cappedByMax = rawNormalized > maxValidVolume;
  const normalizedVolumeCents = cappedByMax ? maxValidVolume : rawNormalized;

  if (normalizedVolumeCents < minVolume) {
    return blocked(
      'BELOW_MINIMUM_VOLUME',
      'Calculated size is below the symbol minimum; rounding up would exceed the target risk.',
      { rawLots, rawVolumeCents, volumeCents: normalizedVolumeCents }
    );
  }

  const lots = normalizedVolumeCents / lotSize;
  const estimatedRisk = lots * stopPips * pipValue;
  if (!Number.isFinite(estimatedRisk) || estimatedRisk <= 0) {
    return blocked('ESTIMATED_RISK_INVALID', 'Estimated monetary risk is not finite and positive.');
  }
  if (estimatedRisk > risk + Math.max(1, risk) * EPSILON) {
    return blocked('NORMALIZED_RISK_EXCEEDS_BUDGET', 'Normalised volume would exceed the supplied price-risk budget.');
  }

  return {
    ok: true,
    code: cappedByMax ? 'OK_CAPPED_BY_SYMBOL_MAX' : 'OK',
    reason: cappedByMax ? 'Size is capped at the maximum valid symbol volume; estimated price risk is below the target.' : 'Volume normalised downward to the symbol step.',
    rawLots,
    rawVolumeCents,
    volumeCents: normalizedVolumeCents,
    lots,
    estimatedRisk,
    riskBudgetInDepositCurrency: risk,
    riskHeadroom: Math.max(0, risk - estimatedRisk),
    cappedByMax,
    volumeStepCents: stepVolume,
    minVolumeCents: minVolume,
    maxVolumeCents: maxVolume
  };
}

/**
 * Fixed-policy wrapper. There is deliberately no caller-provided risk amount:
 * URM policy v1.0 fixes the target at USD 10. The caller must attest to verified
 * pip-value metadata and provide an auditable source label.
 */
export function calculateFixedUsdRiskVolumeCents({
  accountCurrency,
  accountCurrencyConfirmed,
  depositCurrencyPerUsd,
  fxVerified = false,
  fxAgeMs,
  maxFxAgeMs,
  fxSource = '',
  pipValueVerified = false,
  pipValueSource = '',
  stopDistancePips,
  pipValuePerLot,
  lotSizeCents,
  minVolumeCents,
  maxVolumeCents,
  stepVolumeCents
} = {}) {
  const budget = resolveFixedRiskBudget({
    accountCurrency,
    accountCurrencyConfirmed,
    depositCurrencyPerUsd,
    fxVerified,
    fxAgeMs,
    maxFxAgeMs,
    fxSource
  });
  if (!budget.ok) return budget;

  if (pipValueVerified !== true) {
    return blocked('PIP_VALUE_NOT_VERIFIED', 'Broker-specific pip value per lot must be verified before sizing.');
  }
  if (typeof pipValueSource !== 'string' || pipValueSource.trim() === '') {
    return blocked('PIP_VALUE_SOURCE_MISSING', 'The source used to verify pip value must be recorded.');
  }

  const sizing = calculateVolumeCents({
    riskInDepositCurrency: budget.riskInDepositCurrency,
    stopDistancePips,
    pipValuePerLot,
    lotSizeCents,
    minVolumeCents,
    maxVolumeCents,
    stepVolumeCents
  });
  if (!sizing.ok) return {
    ...budget,
    ...sizing,
    ok: false,
    targetRiskUsd: URM_RISK_POLICY.targetRiskUsd
  };

  return {
    ...budget,
    ...sizing,
    ok: true,
    targetRiskUsd: URM_RISK_POLICY.targetRiskUsd,
    pipValuePerLot: toFiniteNumber(pipValuePerLot),
    pipValueSource: pipValueSource.trim()
  };
}

/**
 * R in price units. `exitPrice` must be BUY Bid or SELL Ask, chosen by the
 * platform adapter. An incorrectly sided initial SL is rejected.
 */
export function computeR(entry, initialStopLoss, exitPrice, side) {
  const e = toFiniteNumber(entry);
  const sl = toFiniteNumber(initialStopLoss);
  const price = toFiniteNumber(exitPrice);
  if (![e, sl, price].every(Number.isFinite) || e <= 0 || sl <= 0 || price <= 0 || !isSide(side)) return null;
  if ((side === 'BUY' && sl >= e) || (side === 'SELL' && sl <= e)) return null;
  const rDistance = Math.abs(e - sl);
  if (!Number.isFinite(rDistance) || rDistance <= 0) return null;
  const sign = side === 'BUY' ? 1 : -1;
  return sign * (price - e) / rDistance;
}

/** Desired stop location in R space, without state mutation. At/above +5R the
 * caller must reconcile the TP/position state rather than create a new trail. */
export function targetStopR(currentR) {
  const r = toFiniteNumber(currentR);
  if (!Number.isFinite(r) || r < URM_RISK_POLICY.breakEvenAtR || r >= URM_RISK_POLICY.takeProfitR) return null;
  if (r >= URM_RISK_POLICY.trailingStartsAtR) {
    return Math.max(URM_RISK_POLICY.trailingFloorR, r - URM_RISK_POLICY.trailingGapR);
  }
  if (r >= URM_RISK_POLICY.profitLockAtR) return URM_RISK_POLICY.profitLockToR;
  return 0;
}

/**
 * Compute a state-aware management decision from an immutable initial-R anchor.
 * `highestFavourableR` and `lastConfirmedStopR` must come from trusted, persisted
 * state reconciled with the broker. This function only proposes a change; it
 * never claims a stop request succeeded.
 */
export function evaluateManagement({
  currentR,
  highestFavourableR = 0,
  lastConfirmedStopR = -1,
  anchorTrusted = true
} = {}) {
  const current = toFiniteNumber(currentR);
  const previousHigh = toFiniteNumber(highestFavourableR);
  const lastStop = toFiniteNumber(lastConfirmedStopR);

  if (anchorTrusted !== true) {
    return blocked('ANCHOR_UNTRUSTED', 'Do not manage a position until the immutable entry/initial-SL/R anchor has been verified.', { action: 'BLOCK' });
  }
  if (![current, previousHigh, lastStop].every(Number.isFinite) || previousHigh < 0) {
    return blocked('MANAGEMENT_STATE_INVALID', 'Current R, highest favourable R and last confirmed stop R must be finite; high-water R cannot be negative.', { action: 'BLOCK' });
  }

  const highWater = Math.max(previousHigh, current, 0);
  const stage = highWater >= URM_RISK_POLICY.trailingStartsAtR
    ? 'TRAILING'
    : highWater >= URM_RISK_POLICY.profitLockAtR
      ? 'PROFIT_LOCK'
      : highWater >= URM_RISK_POLICY.breakEvenAtR
        ? 'BREAK_EVEN'
        : 'INITIAL';

  if (current >= URM_RISK_POLICY.takeProfitR || highWater >= URM_RISK_POLICY.takeProfitR) {
    return {
      ok: true,
      action: 'RECONCILE_TP',
      code: 'TP_BOUNDARY_REACHED',
      reason: 'Current or persisted high-water R has reached +5R; reconcile broker TP/fill/position state instead of proposing a trailing stop.',
      currentR: current,
      highestFavourableR: highWater,
      lastConfirmedStopR: lastStop,
      stage,
      targetStopR: null
    };
  }

  const desired = targetStopR(highWater);
  if (desired === null) {
    return {
      ok: true,
      action: 'HOLD',
      code: 'BE_TRIGGER_NOT_REACHED',
      reason: 'The +1R break-even trigger has not been reached.',
      currentR: current,
      highestFavourableR: highWater,
      lastConfirmedStopR: lastStop,
      stage,
      targetStopR: null
    };
  }

  // In R coordinates, a larger stop R is more protective for both BUY and SELL.
  // If price is at/below the confirmed stop, the position/quote state must be reconciled.
  if (current <= lastStop) {
    return {
      ok: true,
      action: 'RECONCILE_POSITION',
      code: 'PRICE_AT_OR_BEYOND_CONFIRMED_STOP',
      reason: 'Current price is at or beyond the last confirmed stop in R space; reconcile position and fresh quotes. Never loosen the stop.',
      currentR: current,
      highestFavourableR: highWater,
      lastConfirmedStopR: lastStop,
      stage,
      targetStopR: null
    };
  }

  const target = Math.max(desired, lastStop);
  if (target <= lastStop + EPSILON) {
    return {
      ok: true,
      action: 'HOLD',
      code: 'NO_MORE_PROTECTIVE_UPDATE',
      reason: 'The policy target is not more protective than the already confirmed stop.',
      currentR: current,
      highestFavourableR: highWater,
      lastConfirmedStopR: lastStop,
      stage,
      targetStopR: target
    };
  }

  if (target >= current - EPSILON) {
    return {
      ok: true,
      action: 'RECONCILE_POSITION',
      code: 'TARGET_NOT_VALID_BEHIND_MARKET',
      reason: 'The candidate stop is not safely behind current price; do not submit it or relax prior protection.',
      currentR: current,
      highestFavourableR: highWater,
      lastConfirmedStopR: lastStop,
      stage,
      targetStopR: null,
      blockedTargetStopR: target
    };
  }

  return {
    ok: true,
    action: 'MOVE_SL',
    code: 'PROTECTIVE_UPDATE_AVAILABLE',
    reason: 'A more protective policy stop is available; validate tick size, broker distance rules and current quote before submitting.',
    currentR: current,
    highestFavourableR: highWater,
    lastConfirmedStopR: lastStop,
    stage,
    targetStopR: target
  };
}

export function priceTarget(entry, rDistance, side, targetR) {
  const e = toFiniteNumber(entry);
  const distance = toFiniteNumber(rDistance);
  const r = toFiniteNumber(targetR);
  if (!Number.isFinite(e) || !Number.isFinite(distance) || !Number.isFinite(r) ||
      e <= 0 || distance <= 0 || !isSide(side)) return null;
  const sign = side === 'BUY' ? 1 : -1;
  const target = e + sign * distance * r;
  return Number.isFinite(target) && target > 0 ? target : null;
}
