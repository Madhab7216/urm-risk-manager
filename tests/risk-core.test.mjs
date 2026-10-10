import test from 'node:test';
import assert from 'node:assert/strict';
import {
  URM_RISK_POLICY,
  calculateVolumeCents,
  calculateFixedUsdRiskVolumeCents,
  resolveFixedRiskBudget,
  computeR,
  targetStopR,
  evaluateManagement,
  priceTarget
} from '../risk-core.mjs';

const baseSizing = {
  riskInDepositCurrency: 10,
  stopDistancePips: 20,
  pipValuePerLot: 10,
  lotSizeCents: 10_000_000,
  minVolumeCents: 1_000,
  maxVolumeCents: 100_000_000,
  stepVolumeCents: 1_000
};

const baseFixed = {
  accountCurrency: 'USD',
  accountCurrencyConfirmed: true,
  depositCurrencyPerUsd: 1,
  pipValueVerified: true,
  pipValueSource: 'Demo broker symbol specification verified manually',
  stopDistancePips: 20,
  pipValuePerLot: 10,
  lotSizeCents: 10_000_000,
  minVolumeCents: 1_000,
  maxVolumeCents: 100_000_000,
  stepVolumeCents: 1_000
};

test('policy is frozen and matches the approved v1.0 baseline', () => {
  assert.equal(Object.isFrozen(URM_RISK_POLICY), true);
  assert.equal(URM_RISK_POLICY.targetRiskUsd, 10);
  assert.equal(URM_RISK_POLICY.takeProfitR, 5);
  assert.equal(URM_RISK_POLICY.breakEvenAtR, 1);
  assert.equal(URM_RISK_POLICY.profitLockAtR, 2);
  assert.equal(URM_RISK_POLICY.profitLockToR, 1.7);
  assert.equal(URM_RISK_POLICY.trailingStartsAtR, 3);
  assert.equal(URM_RISK_POLICY.trailingFloorR, 2);
  assert.equal(URM_RISK_POLICY.trailingGapR, 1);
  assert.throws(() => { URM_RISK_POLICY.targetRiskUsd = 99; }, TypeError);
});

test('volume sizing uses fixed budget, step-rounds down and reports estimated risk', () => {
  const result = calculateVolumeCents(baseSizing);
  assert.equal(result.ok, true);
  assert.equal(result.volumeCents, 500_000);
  assert.equal(result.lots, 0.05);
  assert.equal(result.estimatedRisk, 10);
  assert.equal(result.cappedByMax, false);
  const widerStop = calculateVolumeCents({ ...baseSizing, stopDistancePips: 50 });
  assert.equal(widerStop.ok, true);
  assert.equal(widerStop.lots, 0.02);
  const coarserStep = calculateVolumeCents({ ...baseSizing, stepVolumeCents: 5_000 });
  assert.equal(coarserStep.ok, true);
  assert.equal(coarserStep.volumeCents % 5_000, 0);
  assert.ok(coarserStep.estimatedRisk <= 10);
});

test('volume sizing blocks when minimum valid size would exceed budget', () => {
  const result = calculateVolumeCents({ ...baseSizing, minVolumeCents: 600_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BELOW_MINIMUM_VOLUME');
});

test('volume sizing caps above symbol maximum and makes lower risk explicit', () => {
  const result = calculateVolumeCents({ ...baseSizing, maxVolumeCents: 200_000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK_CAPPED_BY_SYMBOL_MAX');
  assert.equal(result.cappedByMax, true);
  assert.equal(result.volumeCents, 200_000);
  assert.ok(result.estimatedRisk < 10);
  assert.ok(result.riskHeadroom > 0);
});

test('volume sizing rejects invalid/non-finite inputs without throwing', () => {
  for (const bad of [
    { ...baseSizing, riskInDepositCurrency: 0 },
    { ...baseSizing, stopDistancePips: -1 },
    { ...baseSizing, pipValuePerLot: 0 },
    { ...baseSizing, lotSizeCents: NaN },
    { ...baseSizing, minVolumeCents: 200_000, maxVolumeCents: 100_000 },
    { ...baseSizing, stepVolumeCents: 0 },
    { ...baseSizing, lotSizeCents: 10_000_000.5 },
    { ...baseSizing, minVolumeCents: 1_000, maxVolumeCents: 4_000, stepVolumeCents: 5_000 },
    null,
    []
  ]) {
    assert.equal(calculateVolumeCents(bad).ok, false);
  }
});

test('USD risk budget is fixed at $10 and requires confirmed account currency', () => {
  const usd = resolveFixedRiskBudget({ accountCurrency: 'usd', accountCurrencyConfirmed: true });
  assert.equal(usd.ok, true);
  assert.equal(usd.targetRiskUsd, 10);
  assert.equal(usd.riskInDepositCurrency, 10);
  assert.equal(usd.depositCurrencyPerUsd, 1);
  assert.equal(resolveFixedRiskBudget({ accountCurrency: 'USD', accountCurrencyConfirmed: false }).code, 'ACCOUNT_CURRENCY_UNCONFIRMED');
  assert.equal(resolveFixedRiskBudget({ accountCurrency: 'USD', accountCurrencyConfirmed: true, depositCurrencyPerUsd: 1.1 }).code, 'USD_RATE_MUST_EQUAL_ONE');
});

test('non-USD risk budget requires verified, fresh, auditable conversion', () => {
  const fx = {
    accountCurrency: 'EUR', accountCurrencyConfirmed: true,
    depositCurrencyPerUsd: 0.92, fxVerified: true,
    fxAgeMs: 30_000, maxFxAgeMs: 60_000, fxSource: 'Broker FX quote'
  };
  const valid = resolveFixedRiskBudget(fx);
  assert.equal(valid.ok, true);
  assert.equal(valid.riskInDepositCurrency, 9.200000000000001);
  assert.equal(resolveFixedRiskBudget({ ...fx, fxVerified: false }).code, 'FX_NOT_VERIFIED');
  assert.equal(resolveFixedRiskBudget({ ...fx, fxAgeMs: 61_000 }).code, 'FX_STALE');
  assert.equal(resolveFixedRiskBudget({ ...fx, fxAgeMs: -1 }).code, 'FX_AGE_INVALID');
  assert.equal(resolveFixedRiskBudget({ ...fx, fxSource: '' }).code, 'FX_SOURCE_MISSING');
  assert.equal(resolveFixedRiskBudget({ ...fx, depositCurrencyPerUsd: 0 }).code, 'FX_RATE_INVALID');
  assert.equal(resolveFixedRiskBudget({ ...fx, maxFxAgeMs: 0 }).code, 'FX_AGE_INVALID');
});

test('fixed-USD sizing wrapper blocks unverified pip value and fixes target at $10', () => {
  assert.equal(calculateFixedUsdRiskVolumeCents({ ...baseFixed, pipValueVerified: false }).code, 'PIP_VALUE_NOT_VERIFIED');
  assert.equal(calculateFixedUsdRiskVolumeCents({ ...baseFixed, pipValueSource: '' }).code, 'PIP_VALUE_SOURCE_MISSING');
  const result = calculateFixedUsdRiskVolumeCents(baseFixed);
  assert.equal(result.ok, true);
  assert.equal(result.targetRiskUsd, 10);
  assert.equal(result.riskInDepositCurrency, 10);
  assert.equal(result.estimatedRisk, 10);
  assert.equal('riskUsd' in result, false);
  const blockedResult = calculateFixedUsdRiskVolumeCents({ ...baseFixed, minVolumeCents: 600_000 });
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.code, 'BELOW_MINIMUM_VOLUME');
});

test('fixed-USD sizing converts to non-USD deposit currency before volume sizing', () => {
  const result = calculateFixedUsdRiskVolumeCents({
    ...baseFixed,
    accountCurrency: 'EUR',
    depositCurrencyPerUsd: 0.92,
    fxVerified: true,
    fxAgeMs: 10_000,
    maxFxAgeMs: 60_000,
    fxSource: 'Broker conversion quote'
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetRiskUsd, 10);
  assert.ok(Math.abs(result.riskInDepositCurrency - 9.2) < 1e-10);
  assert.ok(result.estimatedRisk <= result.riskInDepositCurrency + 1e-9);
  assert.equal(calculateFixedUsdRiskVolumeCents({
    ...baseFixed,
    accountCurrency: 'EUR',
    depositCurrencyPerUsd: 0.92,
    fxVerified: true,
    fxAgeMs: 10_000,
    maxFxAgeMs: 60_000,
    fxSource: 'Broker conversion quote',
    pipValueSource: ''
  }).code, 'PIP_VALUE_SOURCE_MISSING');
});

test('R calculation validates side and the initial stop is on the correct side', () => {
  assert.equal(computeR(100, 99, 101, 'BUY'), 1);
  assert.equal(computeR(100, 101, 98, 'SELL'), 2);
  assert.equal(computeR(100, 101, 101, 'BUY'), null);
  assert.equal(computeR(100, 99, 100, 'SELL'), null);
  assert.equal(computeR(100, 99, 101, 'LONG'), null);
  assert.equal(computeR(0, -1, 10, 'BUY'), null);
  assert.equal(computeR(100, 99, NaN, 'BUY'), null);
});

test('R stop ladder obeys all exact boundaries and 5R TP boundary', () => {
  assert.equal(targetStopR(0.9999), null);
  assert.equal(targetStopR(1), 0);
  assert.equal(targetStopR(1.9999), 0);
  assert.equal(targetStopR(2), 1.7);
  assert.equal(targetStopR(2.9999), 1.7);
  assert.equal(targetStopR(3), 2);
  assert.equal(targetStopR(3.5), 2.5);
  assert.equal(targetStopR(4), 3);
  assert.equal(targetStopR(4.2), 3.2);
  assert.ok(Math.abs(targetStopR(4.9999) - 3.9999) < 1e-10);
  assert.equal(targetStopR(5), null);
  assert.equal(targetStopR(6), null);
  assert.equal(targetStopR(NaN), null);
});

test('management proposes BE and locks at the correct triggers', () => {
  const beforeBE = evaluateManagement({ currentR: 0.999, highestFavourableR: 0, lastConfirmedStopR: -1 });
  assert.equal(beforeBE.action, 'HOLD');
  const be = evaluateManagement({ currentR: 1, highestFavourableR: 0, lastConfirmedStopR: -1 });
  assert.equal(be.action, 'MOVE_SL');
  assert.equal(be.targetStopR, 0);
  assert.equal(be.stage, 'BREAK_EVEN');
  const lock = evaluateManagement({ currentR: 2, highestFavourableR: 1, lastConfirmedStopR: 0 });
  assert.equal(lock.action, 'MOVE_SL');
  assert.equal(lock.targetStopR, 1.7);
  assert.equal(lock.stage, 'PROFIT_LOCK');
  const trail = evaluateManagement({ currentR: 3, highestFavourableR: 2, lastConfirmedStopR: 1.7 });
  assert.equal(trail.action, 'MOVE_SL');
  assert.equal(trail.targetStopR, 2);
  assert.equal(trail.stage, 'TRAILING');
});

test('management handles skipped thresholds in one most-protective decision', () => {
  const jump = evaluateManagement({ currentR: 3.4, highestFavourableR: 0, lastConfirmedStopR: -1 });
  assert.equal(jump.action, 'MOVE_SL');
  assert.ok(Math.abs(jump.targetStopR - 2.4) < 1e-10);
  assert.equal(jump.highestFavourableR, 3.4);
  assert.equal(jump.stage, 'TRAILING');
});

test('management preserves favourable-only high-water stop across pullback', () => {
  const pullback = evaluateManagement({ currentR: 2.5, highestFavourableR: 4.2, lastConfirmedStopR: 3.2 });
  assert.equal(pullback.action, 'RECONCILE_POSITION');
  assert.equal(pullback.code, 'PRICE_AT_OR_BEYOND_CONFIRMED_STOP');
  assert.equal(pullback.targetStopR, null);
  const candidateInvalid = evaluateManagement({ currentR: 2.5, highestFavourableR: 4.2, lastConfirmedStopR: 1.7 });
  assert.equal(candidateInvalid.action, 'RECONCILE_POSITION');
  assert.equal(candidateInvalid.code, 'TARGET_NOT_VALID_BEHIND_MARKET');
  assert.equal(candidateInvalid.blockedTargetStopR, 3.2);
});

test('management never proposes a less protective redundant update', () => {
  const same = evaluateManagement({ currentR: 3.5, highestFavourableR: 3.5, lastConfirmedStopR: 2.5 });
  assert.equal(same.action, 'HOLD');
  assert.equal(same.code, 'NO_MORE_PROTECTIVE_UPDATE');
  const externallyTightened = evaluateManagement({ currentR: 3.5, highestFavourableR: 3.5, lastConfirmedStopR: 2.8 });
  assert.equal(externallyTightened.action, 'HOLD');
  assert.equal(externallyTightened.targetStopR, 2.8);
});

test('management blocks untrusted anchor and reconciles TP boundary', () => {
  const untrusted = evaluateManagement({ currentR: 2, highestFavourableR: 2, lastConfirmedStopR: 0, anchorTrusted: false });
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.action, 'BLOCK');
  assert.equal(untrusted.code, 'ANCHOR_UNTRUSTED');
  const tp = evaluateManagement({ currentR: 5, highestFavourableR: 4.2, lastConfirmedStopR: 3.2 });
  assert.equal(tp.action, 'RECONCILE_TP');
  assert.equal(tp.targetStopR, null);
  assert.equal(tp.highestFavourableR, 5);
  const missedTp = evaluateManagement({ currentR: 4.5, highestFavourableR: 5, lastConfirmedStopR: 3.2 });
  assert.equal(missedTp.action, 'RECONCILE_TP');
  assert.equal(missedTp.code, 'TP_BOUNDARY_REACHED');
  const invalidState = evaluateManagement({ currentR: NaN, highestFavourableR: 0, lastConfirmedStopR: -1 });
  assert.equal(invalidState.ok, false);
});

test('BUY and SELL price targets mirror each other and reject invalid prices', () => {
  assert.equal(priceTarget(100, 2, 'BUY', 5), 110);
  assert.equal(priceTarget(100, 2, 'SELL', 5), 90);
  assert.equal(priceTarget(100, 2, 'BUY', -1), 98);
  assert.equal(priceTarget(0, 2, 'BUY', 5), null);
  assert.equal(priceTarget(100, 0, 'SELL', 5), null);
  assert.equal(priceTarget(100, 2, 'LONG', 5), null);
  assert.equal(priceTarget(1, 2, 'SELL', 5), null);
});

test('deterministic sizing property sweep never exceeds budget when result is approved', () => {
  // Deterministic pseudo-random values make this repeatable without external libraries.
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let i = 0; i < 500; i += 1) {
    const risk = 1 + random() * 99;
    const stopDistancePips = 1 + random() * 500;
    const pipValuePerLot = 0.1 + random() * 50;
    const stepVolumeCents = 100 + Math.floor(random() * 100) * 100;
    const result = calculateVolumeCents({
      riskInDepositCurrency: risk,
      stopDistancePips,
      pipValuePerLot,
      lotSizeCents: 10_000_000,
      minVolumeCents: 100,
      maxVolumeCents: 100_000_000,
      stepVolumeCents
    });
    if (result.ok) {
      assert.ok(result.volumeCents >= 100);
      assert.ok(result.volumeCents <= 100_000_000);
      assert.equal(result.volumeCents % stepVolumeCents, 0);
      assert.ok(result.estimatedRisk <= risk + Math.max(1, risk) * 1e-10);
    }
  }
});

test('confirmed stop level is monotonic through a favourable run and pullback', () => {
  const path = [0.5, 1, 1.4, 2, 2.5, 3, 3.5, 4.2, 4.1, 3.8, 3.3, 2.5];
  let highest = 0;
  let lastConfirmedStop = -1;
  const confirmedStops = [];
  for (const currentR of path) {
    const decision = evaluateManagement({ currentR, highestFavourableR: highest, lastConfirmedStopR: lastConfirmedStop });
    assert.equal(decision.ok, true);
    highest = decision.highestFavourableR;
    if (decision.action === 'MOVE_SL') {
      assert.ok(decision.targetStopR > lastConfirmedStop);
      assert.ok(decision.targetStopR < currentR);
      lastConfirmedStop = decision.targetStopR;
      confirmedStops.push(lastConfirmedStop);
    }
  }
  for (let i = 1; i < confirmedStops.length; i += 1) {
    assert.ok(confirmedStops[i] >= confirmedStops[i - 1]);
  }
  assert.equal(lastConfirmedStop, 3.2);
});
