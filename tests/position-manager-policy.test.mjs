import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  URM_POSITION_POLICY,
  buildUrmPositionLabel,
  parseUrmPositionLabel,
  calculatePositionManagementPlan,
  evaluateUrmLabelForPosition
} from '../position-manager-policy.mjs';

const observerSource = readFileSync(new URL('../cbot/URMPositionObserver.cs', import.meta.url), 'utf8');

function plan(overrides = {}) {
  return calculatePositionManagementPlan({
    side: 'BUY', entryPrice: 2000, structuralStopLoss: 1990,
    currentPrice: 2005, peakR: 0.5, existingStopLoss: 1990,
    digits: 2, tickSize: 0.25, tickSizeVerified: true, tickSizeSource: 'test-fixture broker spec',
    tickSizeVerifiedAt: 1_800_000_000_000, now: 1_800_000_000_000, ...overrides
  });
}

test('policy constants match approved URM risk model', () => {
  assert.equal(URM_POSITION_POLICY.breakEvenAtR, 1);
  assert.equal(URM_POSITION_POLICY.lockAtR, 2);
  assert.equal(URM_POSITION_POLICY.lockToR, 1.7);
  assert.equal(URM_POSITION_POLICY.trailingAtR, 3);
  assert.equal(URM_POSITION_POLICY.trailingGapR, 1);
  assert.equal(URM_POSITION_POLICY.takeProfitR, 5);
});

test('URM label encodes and recovers client order ID and structural stop', () => {
  const built = buildUrmPositionLabel({ clientOrderId: 'URM-LO1-ABCDEF123456', structuralStopLoss: 1990.1, digits: 2 });
  assert.equal(built.ok, true);
  assert.equal(built.label, 'URM1|ID=URM-LO1-ABCDEF123456|SL=1990.10');
  assert.ok(built.label.length <= 100);
  assert.deepEqual(parseUrmPositionLabel(built.label), {
    ok: true, schemaVersion: 1, clientOrderId: 'URM-LO1-ABCDEF123456', structuralStopLoss: 1990.1
  });
});

test('label codec rejects invalid IDs, invalid SL, unsupported schema and overlong strings', () => {
  assert.equal(buildUrmPositionLabel({ clientOrderId: 'OTHER-1', structuralStopLoss: 10, digits: 2 }).code, 'LABEL_CLIENT_ID_INVALID');
  assert.equal(buildUrmPositionLabel({ clientOrderId: 'URM-1', structuralStopLoss: 0, digits: 2 }).code, 'LABEL_SL_INVALID');
  assert.equal(buildUrmPositionLabel({ clientOrderId: 'URM-1', structuralStopLoss: 10, digits: 11 }).code, 'LABEL_DIGITS_INVALID');
  assert.equal(parseUrmPositionLabel('URM|SL=10').ok, false);
  assert.equal(parseUrmPositionLabel('URM1|ID=URM-1|SL=NaN').ok, false);
  assert.equal(parseUrmPositionLabel('x'.repeat(101)).code, 'LABEL_INVALID_LENGTH');
});

test('BUY +1R proposes break-even and 5R take profit', () => {
  const r = plan({ currentPrice: 2010, peakR: 1, existingStopLoss: 1990 });
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'BREAK_EVEN');
  assert.equal(r.targetStopLoss, 2000);
  assert.equal(r.targetStopR, 0);
  assert.equal(r.takeProfit, 2050);
});

test('BUY +2R locks +1.7R', () => {
  const r = plan({ currentPrice: 2020, peakR: 2, existingStopLoss: 1990 });
  assert.equal(r.phase, 'LOCK_1_7R');
  assert.equal(r.targetStopLoss, 2017);
  assert.equal(r.targetStopR, 1.7);
});

test('BUY +3R activates trailing with +2R floor', () => {
  const r = plan({ currentPrice: 2030, peakR: 3, existingStopLoss: 2017 });
  assert.equal(r.phase, 'TRAILING');
  assert.equal(r.targetStopLoss, 2020);
  assert.equal(r.targetStopR, 2);
});

test('BUY +3.5R trails to +2.5R', () => {
  const r = plan({ currentPrice: 2035, peakR: 3.5, existingStopLoss: 2020 });
  assert.equal(r.phase, 'TRAILING');
  assert.equal(r.targetStopLoss, 2025);
  assert.equal(r.targetStopR, 2.5);
});

test('trailing retains high-water peak through a pullback', () => {
  const r = plan({ currentPrice: 2028, peakR: 3.5, existingStopLoss: 2025 });
  assert.equal(r.phase, 'TRAILING');
  assert.equal(r.peakR, 3.5);
  assert.equal(r.targetStopLoss, 2025);
  assert.equal(r.action, 'PRESERVE_EXISTING_SL');
});

test('restart heuristic infers trailing floor from an existing +2.5R server SL', () => {
  const r = plan({ currentPrice: 2028, peakR: 0, existingStopLoss: 2025 });
  assert.equal(r.peakR, 3.5);
  assert.equal(r.phase, 'TRAILING');
  assert.equal(r.targetStopLoss, 2025);
});

test('confirmed SL is never moved backwards if it is more protective than new target', () => {
  const r = plan({ currentPrice: 2028, peakR: 2, existingStopLoss: 2025 });
  assert.equal(r.targetStopLoss, 2025);
  assert.equal(r.targetStopR, 2.5);
  assert.equal(r.action, 'PRESERVE_EXISTING_SL');
});

test('SELL +1R mirrors BUY break-even and TP direction', () => {
  const r = plan({ side: 'SELL', entryPrice: 2000, structuralStopLoss: 2010, currentPrice: 1990,
    peakR: 1, existingStopLoss: 2010, digits: 2, tickSize: 0.25 });
  assert.equal(r.phase, 'BREAK_EVEN');
  assert.equal(r.targetStopLoss, 2000);
  assert.equal(r.takeProfit, 1950);
});

test('SELL +2R locks +1.7R with mirrored price direction', () => {
  const r = plan({ side: 'SELL', entryPrice: 2000, structuralStopLoss: 2010, currentPrice: 1980,
    peakR: 2, existingStopLoss: 2010, digits: 2, tickSize: 0.25 });
  assert.equal(r.phase, 'LOCK_1_7R');
  assert.equal(r.targetStopLoss, 1983);
  assert.equal(r.takeProfit, 1950);
});

test('SELL +3.5R trailing mirrors BUY', () => {
  const r = plan({ side: 'SELL', entryPrice: 2000, structuralStopLoss: 2010, currentPrice: 1965,
    peakR: 3.5, existingStopLoss: 1980, digits: 2, tickSize: 0.25 });
  assert.equal(r.phase, 'TRAILING');
  assert.equal(r.targetStopLoss, 1975);
});

test('TP boundary is reconciliation-required, not normal trailing', () => {
  const r = plan({ currentPrice: 2050, peakR: 5, existingStopLoss: 2040 });
  assert.equal(r.phase, 'TP_BOUNDARY_RECONCILIATION_REQUIRED');
  assert.equal(r.action, 'RECONCILE_POSITION_AND_TP');
  assert.equal(r.requiresManualIntervention, true);
});

test('missing current server SL raises a protection warning even when the target math is valid', () => {
  const r = plan({ currentPrice: 2010, peakR: 1, existingStopLoss: null });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'INITIAL_SL_MISSING');
  assert.equal(r.requiresManualIntervention, true);
});

test('target at or through current executable price requires manual reconciliation', () => {
  const r = plan({ currentPrice: 1999, peakR: 1, existingStopLoss: null });
  assert.equal(r.phase, 'STOP_TARGET_CROSSED_BY_MARKET');
  assert.equal(r.requiresManualIntervention, true);
});

test('invalid side, SL direction, tick size evidence and peak values fail closed', () => {
  assert.equal(plan({ side: 'LONG' }).code, 'SIDE_INVALID');
  assert.equal(plan({ structuralStopLoss: 2010 }).code, 'STRUCTURAL_SL_DIRECTION_INVALID');
  assert.equal(plan({ tickSize: 0 }).code, 'SYMBOL_GRID_INVALID');
  assert.equal(plan({ tickSizeVerified: false }).code, 'SYMBOL_GRID_EVIDENCE_UNVERIFIED');
  assert.equal(plan({ tickSizeSource: '' }).code, 'SYMBOL_GRID_EVIDENCE_UNVERIFIED');
  assert.equal(plan({ tickSizeVerifiedAt: 1_799_900_000_000 }).code, 'SYMBOL_GRID_EVIDENCE_UNVERIFIED');
  assert.equal(plan({ tickSizeVerifiedAt: 1_800_000_000_001 }).code, 'SYMBOL_GRID_EVIDENCE_UNVERIFIED');
  assert.equal(plan({ peakR: -1 }).code, 'PEAK_R_INVALID');
});

test('initial BUY stop rounds towards entry to avoid increasing planned price-risk', () => {
  const r = plan({ currentPrice: 1995, peakR: 0, existingStopLoss: null,
    entryPrice: 2000, structuralStopLoss: 1990.1, digits: 2, tickSize: 0.25 });
  assert.equal(r.phase, 'INITIAL_PROTECTION');
  assert.equal(r.targetStopLoss, 1990.25);
});

test('BUY profit-lock stop rounds down to a valid grid point', () => {
  const r = plan({ currentPrice: 2020, peakR: 2, existingStopLoss: 1990,
    entryPrice: 2000, structuralStopLoss: 1990.1, digits: 2, tickSize: 0.25 });
  assert.equal(r.targetStopLoss % 0.25, 0);
});

test('position label is rejected for wrong symbol or structural SL on wrong side of actual fill', () => {
  const label = buildUrmPositionLabel({ clientOrderId: 'URM-1', structuralStopLoss: 1990, digits: 2 }).label;
  assert.equal(evaluateUrmLabelForPosition({ label, positionSymbolName: 'XAUUSD', expectedSymbolName: 'EURUSD', side: 'BUY', entryPrice: 2000 }).code,
    'POSITION_SYMBOL_MISMATCH');
  assert.equal(evaluateUrmLabelForPosition({ label, positionSymbolName: 'XAUUSD', expectedSymbolName: 'XAUUSD', side: 'SELL', entryPrice: 2000 }).code,
    'ANCHOR_INVALID_AFTER_FILL');
  assert.equal(evaluateUrmLabelForPosition({ label, positionSymbolName: 'XAUUSD', expectedSymbolName: 'XAUUSD', side: 'BUY', entryPrice: 2000 }).actualRDistance,
    10);
});


test('C# observer policy constants match approved R ladder and storage keys are bounded', () => {
  assert.match(observerSource, /BreakEvenAtR = 1\.0/);
  assert.match(observerSource, /LockAtR = 2\.0/);
  assert.match(observerSource, /LockToR = 1\.7/);
  assert.match(observerSource, /TrailingAtR = 3\.0/);
  assert.match(observerSource, /TrailingGapR = 1\.0/);
  assert.match(observerSource, /MinimumTrailingLockR = 2\.0/);
  assert.match(observerSource, /TakeProfitR = 5\.0/);
  assert.match(observerSource, /ToBase36\(_startupUserId\)/);
  assert.match(observerSource, /key\.Length > 50/);
});

test('C# observer is read-only, persists account-scoped peak state, and blocks ambiguous restart recovery', () => {
  assert.match(observerSource, /LocalStorage\.GetString\(key, LocalStorageScope\.Type\)/);
  assert.match(observerSource, /LocalStorage\.SetString\(PeakStorageKey\(pair\.Key\)/);
  assert.match(observerSource, /LocalStorage\.Flush\(LocalStorageScope\.Type\)/);
  assert.match(observerSource, /Account\.Number == _startupAccountNumber && Account\.UserId == _startupUserId/);
  assert.match(observerSource, /PEAK_STATE_MISSING/);
  assert.match(observerSource, /Timer\.Start\(1\)/);
  assert.doesNotMatch(observerSource, /\b(?:ModifyPosition|ModifyStopLossPrice|ModifyTakeProfitPrice|ClosePosition|ExecuteMarketOrder|ExecuteMarketRangeOrder|ExecuteLimitOrder|ExecuteStopOrder)\s*\(/);
});
