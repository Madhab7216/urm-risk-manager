import test from 'node:test';
import assert from 'node:assert/strict';
import {
  URM_EXECUTION_POLICY, EXECUTION_STATE, MAX_TICK_SIZE_EVIDENCE_AGE_MS,
  createClientOrderId, prepareMarketOrderIntent, toSdkMarketOrderParams,
  checkExecutionGate, beginSubmission, markRequestTransportError,
  markExecutionTimeout, applyExecutionEvent, plannedPostFillProtection,
  markProtectionRequestTransportError, restoreExecutionRecord,
  isExecutionStateUnresolved, CTraderExecutionCoordinator
} from '../execution-engine.mjs';

const validPreview = (side = 'BUY') => ({
  ok: true, targetRiskUsd: 10, side,
  entry: side === 'BUY' ? 2000 : 2000,
  stopLoss: side === 'BUY' ? 1990 : 2010,
  volumeCents: 10000,
  takeProfit: side === 'BUY' ? 2050 : 1950,
  estimatedRisk: 10, estimatedRiskUsd: 10,
  executionEnabled: false
});
const validInput = (overrides = {}) => ({
  preview: validPreview('BUY'), symbolId: 101, side: 'BUY',
  entryEstimate: 2000, stopLossReference: 1990, digits: 2, tickSize: 0.25,
  tickSizeVerified: true, tickSizeSource: 'Demo broker symbol specification', tickSizeVerifiedAt: 1_800_000_000_000,
  quoteAgeMs: 100, hostConnected: true, userConfirmed: true, accountKey: 'demo-account-1',
  now: 1_800_000_000_000, randomToken: 'TEST123456',
  ...overrides
});
const gate = (overrides = {}) => ({
  executionEnabled: true, hostConnected: true,
  accountContextVerified: true, activeAccountKey: 'demo-account-1',
  demoAccountConfirmed: true, demoValidationComplete: true,
  userConfirmed: true, previewFresh: true, journalDurable: true, noUnresolvedExecution: true,
  accountType: 'HEDGED', ...overrides
});
const acceptedEvent = (record, eventId = 'e-accepted') => ({
  eventId, executionType: 2,
  order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 1,
    tradeData: { symbolId: record.symbolId, tradeSide: record.side === 'BUY' ? 1 : 2, volume: record.requestedVolumeCents } }
});
const filledEvent = (record, { eventId = 'e-filled', fillPrice = 2000.2, positionId = 7001, volume = record.requestedVolumeCents, side = record.side, symbolId = record.symbolId } = {}) => ({
  eventId, executionType: 3,
  order: { orderId: 5001, clientOrderId: record.clientOrderId, executedVolume: volume,
    tradeData: { symbolId, tradeSide: side === 'BUY' ? 1 : 2, volume } },
  position: { positionId, positionStatus: 1, price: fillPrice,
    stopLoss: side === 'BUY' ? fillPrice - record.estimatedRDistance : fillPrice + record.estimatedRDistance,
    takeProfit: side === 'BUY' ? fillPrice + record.estimatedRDistance * 5 : fillPrice - record.estimatedRDistance * 5,
    tradeData: { symbolId, tradeSide: side === 'BUY' ? 1 : 2, volume } },
  deal: { positionId, filledVolume: volume, executionPrice: fillPrice, symbolId, tradeSide: side === 'BUY' ? 1 : 2 }
});
function partialFilledEvent(record, { eventId = 'partial-valid-1', dealId = 6101, orderId = 5001, positionId = 7001,
  cumulativeVolume = 5000, positionPrice = 2000.2, stopLoss = 1990.2, takeProfit = 2050.2,
  side = record.side, symbolId = record.symbolId, includePosition = true } = {}) {
  const tradeSide = side === 'BUY' ? 1 : 2;
  return {
    eventId, executionType: 11,
    order: { orderId, clientOrderId: record.clientOrderId, orderStatus: 1, executedVolume: cumulativeVolume,
      tradeData: { symbolId, tradeSide, volume: record.requestedVolumeCents } },
    ...(includePosition ? { position: { positionId, positionStatus: 1, price: positionPrice, stopLoss, takeProfit,
      tradeData: { symbolId, tradeSide, volume: cumulativeVolume } } } : {}),
    deal: { dealId, positionId, volume: cumulativeVolume, filledVolume: cumulativeVolume, executionPrice: positionPrice,
      symbolId, tradeSide: tradeSide, dealStatus: 3, dealType: 1 }
  };
}
function positionProtectionAck(record, { eventId = 'partial-protection-ack', stopLoss = 1990.2, takeProfit = 2051.2,
  positionId = 7001, volume = 5000, side = record.side, symbolId = record.symbolId } = {}) {
  return { eventId, executionType: 4,
    order: { orderId: 9001, clientOrderId: 'URM-PROTECTION-ACK' },
    position: { positionId, positionStatus: 1, stopLoss, takeProfit,
      tradeData: { symbolId, tradeSide: side === 'BUY' ? 1 : 2, volume } } };
}

function prepared(overrides = {}) {
  const result = prepareMarketOrderIntent(validInput(overrides));
  assert.equal(result.ok, true, result.reason);
  return result;
}
function toSubmitting(record) {
  const result = beginSubmission(record, gate(), 1_800_000_000_001);
  assert.equal(result.ok, true, result.reason);
  return result.record;
}
function toProtectionPending(record, fillOverrides = {}) {
  const sub = toSubmitting(record);
  const accepted = applyExecutionEvent(sub, acceptedEvent(record), 1_800_000_000_010);
  const filled = applyExecutionEvent(accepted.record, filledEvent(record, fillOverrides), 1_800_000_000_020);
  assert.equal(filled.ok, true);
  assert.equal(filled.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING, filled.record.errorMessage);
  return filled;
}

test('client order IDs use URM prefix, are bounded to cTrader 50-character maximum', () => {
  const a = createClientOrderId({ now: 1000, random: 'AABBCCDD' });
  const b = createClientOrderId({ now: 1000, random: 'EEFF0011' });
  assert.match(a, /^URM-[a-z0-9]+-[A-Za-z0-9]+$/);
  assert.notEqual(a, b);
  assert.ok(a.length <= URM_EXECUTION_POLICY.clientOrderIdMaxLength);
});

test('market order intent includes protocol relative SL/TP and unique clientOrderId', () => {
  const result = prepared();
  assert.equal(result.request.orderType, 'MARKET');
  assert.equal(result.request.tradeSide, 'BUY');
  assert.equal(result.request.volume, 10000);
  assert.equal(result.request.relativeStopLoss, 1_000_000); // 10.00 price units × 100000
  assert.equal(result.request.relativeTakeProfit, 5_000_000); // 50.00 price units × 100000
  assert.equal(result.request.clientOrderId, result.record.clientOrderId);
  assert.match(result.request.label, /^URM1\|ID=URM-[A-Za-z0-9-]+\|SL=1990\.00$/);
  assert.equal(result.record.positionLabel, result.request.label);
});

test('intent blocks absent approval, host connection, user confirmation, stale quote and invalid volume', () => {
  assert.equal(prepareMarketOrderIntent(validInput({ hostConnected: false })).code, 'HOST_DISCONNECTED');
  assert.equal(prepareMarketOrderIntent(validInput({ accountKey: '' })).code, 'ACCOUNT_CONTEXT_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ userConfirmed: false })).code, 'USER_CONFIRMATION_REQUIRED');
  assert.equal(prepareMarketOrderIntent(validInput({ quoteAgeMs: 10001 })).code, 'QUOTE_STALE');
  assert.equal(prepareMarketOrderIntent(validInput({ preview: { ...validPreview(), volumeCents: 0 } })).code, 'VOLUME_INVALID');
  assert.equal(prepareMarketOrderIntent(validInput({ preview: { ...validPreview(), targetRiskUsd: 11 } })).code, 'RISK_PREVIEW_NOT_APPROVED');
});

test('intent blocks preview mismatch and incorrect BUY/SELL structural SL direction', () => {
  assert.equal(prepareMarketOrderIntent(validInput({ entryEstimate: 2000.5 })).code, 'PREVIEW_MISMATCH');
  assert.equal(prepareMarketOrderIntent(validInput({ stopLossReference: 2010, preview: { ...validPreview('BUY'), stopLoss: 2010 } })).code, 'STOP_DIRECTION_INVALID');
  const sell = prepareMarketOrderIntent(validInput({
    preview: validPreview('SELL'), side: 'SELL', entryEstimate: 2000,
    stopLossReference: 2010, symbolId: 102, randomToken: 'SELLTEST',
  }));
  assert.equal(sell.ok, true, sell.reason);
  assert.equal(sell.request.relativeStopLoss, 1_000_000);
  assert.equal(sell.request.relativeTakeProfit, 5_000_000);
});


test('order intent requires fresh, sourced tick-size evidence and rejects off-grid prices', () => {
  assert.equal(prepareMarketOrderIntent(validInput({ tickSize: undefined })).code, 'SYMBOL_TICK_SIZE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSize: 0 })).code, 'SYMBOL_TICK_SIZE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSizeVerified: false })).code, 'SYMBOL_TICK_SIZE_EVIDENCE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSizeSource: '' })).code, 'SYMBOL_TICK_SIZE_EVIDENCE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSizeVerifiedAt: 1_800_000_000_000 - MAX_TICK_SIZE_EVIDENCE_AGE_MS - 1 })).code, 'SYMBOL_TICK_SIZE_EVIDENCE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSizeVerifiedAt: 1_800_000_000_001 })).code, 'SYMBOL_TICK_SIZE_EVIDENCE_UNVERIFIED');
  assert.equal(prepareMarketOrderIntent(validInput({ stopLossReference: 1990.1, preview: { ...validPreview(), stopLoss: 1990.1 } })).code, 'STOP_OFF_TICK_GRID');
  assert.equal(prepareMarketOrderIntent(validInput({ entryEstimate: 2000.1, preview: { ...validPreview(), entry: 2000.1 } })).code, 'ENTRY_OFF_TICK_GRID');
  assert.equal(prepareMarketOrderIntent(validInput({ tickSize: 0.005 })).code, 'SYMBOL_GRID_METADATA_INCONSISTENT');
  assert.equal(prepareMarketOrderIntent(validInput({ stopLossReference: 1990.001, preview: { ...validPreview(), stopLoss: 1990.001 } })).code, 'STOP_PRICE_PRECISION_MISMATCH');
  assert.equal(prepared({ tickSize: 0.25 }).ok, true);
});

test('intent rejects a relative protection distance that the protocol scale cannot represent exactly', () => {
  const entry = 1.234567;
  const sl = 1.234561;
  const result = prepareMarketOrderIntent(validInput({
    digits: 6,
    tickSize: 0.000001,
    entryEstimate: entry,
    stopLossReference: sl,
    preview: { ...validPreview('BUY'), entry, stopLoss: sl, takeProfit: entry + ((entry - sl) * 5) }
  }));
  assert.equal(result.code, 'RELATIVE_PROTECTION_DISTANCE_INVALID');
});

test('SDK request maps enums and does not synthesize defaults for missing SDK enums', () => {
  const { request } = prepared();
  const mapped = toSdkMarketOrderParams(request, { ProtoOrderType: { MARKET: 1 }, ProtoTradeSide: { BUY: 1, SELL: 2 } });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.params.orderType, 1);
  assert.equal(mapped.params.tradeSide, 1);
  assert.equal(toSdkMarketOrderParams(request, {}).code, 'SDK_ENUMS_UNAVAILABLE');
});

test('limited-risk account requires verified and explicitly requested guaranteed SL for the full lifecycle', () => {
  assert.equal(prepareMarketOrderIntent(validInput({ limitedRiskAccount: true })).code, 'GUARANTEED_SL_REQUIREMENT_UNMET');
  assert.equal(prepareMarketOrderIntent(validInput({ guaranteedStopLossRequested: true, guaranteedStopLossSupported: false })).code, 'GUARANTEED_SL_UNSUPPORTED');
  const preparedGsl = prepareMarketOrderIntent(validInput({ limitedRiskAccount: true, guaranteedStopLossSupported: true, guaranteedStopLossRequested: true }));
  assert.equal(preparedGsl.ok, true, preparedGsl.reason);
  assert.equal(preparedGsl.request.guaranteedStopLoss, true);
  const mapped = toSdkMarketOrderParams(preparedGsl.request, mockServerInterfaces);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.params.guaranteedStopLoss, true);
  const pending = toProtectionPending(preparedGsl.record).record;
  assert.equal(plannedPostFillProtection(pending).params.guaranteedStopLoss, true);
});

test('execution release gate defaults closed and blocks until every gate is true', () => {
  assert.equal(checkExecutionGate({}).code, 'EXECUTION_FEATURE_DISABLED');
  assert.equal(checkExecutionGate(gate({ accountContextVerified: false })).code, 'ACCOUNT_CONTEXT_UNVERIFIED');
  assert.equal(checkExecutionGate(gate({ activeAccountKey: '' })).code, 'ACCOUNT_CONTEXT_UNVERIFIED');
  assert.equal(checkExecutionGate(gate({ demoAccountConfirmed: false })).code, 'DEMO_ACCOUNT_NOT_CONFIRMED');
  assert.equal(checkExecutionGate(gate({ demoValidationComplete: false })).code, 'DEMO_VALIDATION_INCOMPLETE');
  assert.equal(checkExecutionGate(gate({ journalDurable: false })).code, 'EXECUTION_LEDGER_NOT_DURABLE');
  assert.equal(checkExecutionGate(gate({ noUnresolvedExecution: false })).code, 'UNRESOLVED_EXECUTION_EXISTS');
  assert.equal(checkExecutionGate(gate({ accountType: 'SPREAD_BETTING' })).code, 'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(checkExecutionGate(gate({ limitedRiskAccount: true, guaranteedStopLossSupported: false })).code, 'GUARANTEED_SL_REQUIREMENT_UNMET');
  assert.equal(checkExecutionGate(gate({ limitedRiskAccount: true, guaranteedStopLossSupported: true, guaranteedStopLossRequestEnabled: false })).code, 'GUARANTEED_SL_REQUEST_NOT_CONFIGURED');
  assert.equal(checkExecutionGate(gate({ limitedRiskAccount: true, guaranteedStopLossSupported: true, guaranteedStopLossRequestEnabled: true })).ok, true);
  assert.equal(checkExecutionGate(gate()).ok, true);
});

test('unknown and NETTED account types are blocked unless isolation evidence is explicit', () => {
  assert.equal(checkExecutionGate(gate({ accountType: undefined })).code, 'ACCOUNT_TYPE_UNVERIFIED');
  assert.equal(checkExecutionGate(gate({ accountType: 1 })).code, 'NETTED_ACCOUNT_ISOLATION_UNVERIFIED');
  assert.equal(checkExecutionGate(gate({ accountType: 'NETTED' })).code, 'NETTED_ACCOUNT_ISOLATION_UNVERIFIED');
  assert.equal(checkExecutionGate(gate({ accountType: 'NETTED', nettingIsolationAdapterVerified: true, preexistingExposureReconciled: true })).ok, true);
  assert.equal(checkExecutionGate(gate({ accountType: 0 })).ok, true, 'protocol account type 0 is HEDGED');
});

test('submission begins only once and an accepted event is not treated as a fill', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  assert.equal(sub.state, EXECUTION_STATE.SUBMITTING);
  assert.equal(beginSubmission(sub, gate()).code, 'INVALID_SUBMISSION_STATE');
  const accepted = applyExecutionEvent(sub, acceptedEvent(record));
  assert.equal(accepted.record.state, EXECUTION_STATE.ACCEPTED);
  assert.equal(accepted.record.positionId, null);
  assert.equal(accepted.record.protectionConfirmed, false);
  assert.equal(accepted.record.unresolved, true);
});

test('unrelated events are ignored; matching is never done by symbol/side/price alone', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const unrelated = { eventId: 'noise', executionType: 3, order: { orderId: 4, clientOrderId: 'OTHER-123', tradeData: { symbolId: record.symbolId } } };
  const result = applyExecutionEvent(sub, unrelated);
  assert.equal(result.matched, false);
  assert.equal(result.record.state, EXECUTION_STATE.SUBMITTING);
});

test('filled BUY recomputes R from actual fill and requests structural SL plus actual-fill 5R TP', () => {
  const { record } = prepared();
  const filled = toProtectionPending(record, { fillPrice: 2000.2 });
  assert.equal(filled.record.positionId, '7001');
  assert.equal(filled.record.fillPrice, 2000.2);
  assert.ok(Math.abs(filled.record.actualRDistance - 10.2) < 1e-9);
  assert.equal(filled.record.expectedAbsoluteStopLoss, 1990);
  assert.equal(filled.record.expectedAbsoluteTakeProfit, 2051.2);
  assert.equal(filled.actions[0].type, 'MODIFY_POSITION_PROTECTION');
  const plan = plannedPostFillProtection(filled.record);
  assert.deepEqual(plan.params, { positionId: 7001, stopLoss: 1990, takeProfit: 2051.2 });
});

test('filled SELL recomputes actual R and 5R TP correctly after slippage', () => {
  const input = validInput({
    preview: validPreview('SELL'), side: 'SELL', stopLossReference: 2010,
    entryEstimate: 2000, symbolId: 102, randomToken: 'SELLTEST'
  });
  const { record } = prepareMarketOrderIntent(input);
  const sub = toSubmitting(record);
  const accepted = applyExecutionEvent(sub, acceptedEvent(record));
  const filled = applyExecutionEvent(accepted.record, filledEvent(record, { fillPrice: 1999.8, side: 'SELL', symbolId: 102, positionId: 7002 }));
  assert.equal(filled.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(filled.record.expectedAbsoluteStopLoss, 2010);
  assert.ok(Math.abs(filled.record.actualRDistance - 10.2) < 1e-9);
  assert.equal(filled.record.expectedAbsoluteTakeProfit, 1948.8);
});

test('fill at or beyond structural SL fails closed for manual intervention', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const accepted = applyExecutionEvent(sub, acceptedEvent(record));
  const filled = applyExecutionEvent(accepted.record, filledEvent(record, { fillPrice: 1989.9 }));
  assert.equal(filled.record.state, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION);
  assert.equal(filled.record.errorCode, 'STRUCTURAL_SL_CROSSED_BY_FILL');
  assert.equal(filled.actions[0].type, 'MANUAL_RECONCILIATION_REQUIRED');
});

test('fill missing position ID or execution price is never called protected', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const event = { eventId: 'no-position', executionType: 3, order: { orderId: 5001, clientOrderId: record.clientOrderId } };
  const result = applyExecutionEvent(sub, event);
  assert.equal(result.record.state, EXECUTION_STATE.FILL_REQUIRES_RECONCILIATION);
  assert.equal(result.record.protectionConfirmed, false);
});

test('wrong symbol or side in a correlated fill requires manual intervention', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const wrongSide = applyExecutionEvent(sub, filledEvent(record, { side: 'SELL' }));
  assert.equal(wrongSide.record.errorCode, 'FILL_SIDE_MISMATCH');
  const sub2 = toSubmitting(prepared({ randomToken: 'WRONGSYMBOL' }).record);
  const wrongSymbol = applyExecutionEvent(sub2, filledEvent(sub2, { symbolId: 999 }));
  assert.equal(wrongSymbol.record.errorCode, 'FILL_SYMBOL_MISMATCH');
});

test('confirmed ORDER_REPLACED with exact server SL/TP marks position protected', () => {
  const { record } = prepared();
  const pending = toProtectionPending(record).record;
  const result = applyExecutionEvent(pending, {
    eventId: 'protection-ok', executionType: 4,
    order: { orderId: 9001, clientOrderId: 'URM-SERVER-PROTECTION' },
    position: { positionId: 7001, positionStatus: 1, stopLoss: 1990, takeProfit: 2051.2,
      tradeData: { symbolId: 101, tradeSide: 1, volume: 10000 } }
  });
  assert.equal(result.matched, true, 'position ID must correlate the protective child order');
  assert.equal(result.record.state, EXECUTION_STATE.PROTECTED);
  assert.equal(result.record.protectionConfirmed, true);
  assert.equal(result.record.unresolved, false);
});

test('missing or mismatched server protection values never mark position protected', () => {
  const { record } = prepared();
  const pending = toProtectionPending(record).record;
  const missing = applyExecutionEvent(pending, { eventId: 'protection-missing', executionType: 4, position: { positionId: 7001 } });
  assert.equal(missing.record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
  const pending2 = toProtectionPending(prepared({ randomToken: 'MISMATCHTEST' }).record).record;
  const mismatch = applyExecutionEvent(pending2, { eventId: 'protection-mismatch', executionType: 4, position: { positionId: 7001,
    positionStatus: 1, stopLoss: 1990, takeProfit: 2050, tradeData: { symbolId: 101, tradeSide: 1, volume: 10000 } } });
  assert.equal(mismatch.record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
  assert.equal(mismatch.record.errorCode, 'PROTECTION_VALUE_MISMATCH');
});

test('duplicate eventId is idempotent and cannot issue protection update twice', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const fill = filledEvent(record);
  const first = applyExecutionEvent(sub, fill);
  const again = applyExecutionEvent(first.record, fill);
  assert.equal(first.actions.filter(a => a.type === 'MODIFY_POSITION_PROTECTION').length, 1);
  assert.equal(again.duplicate, true);
  assert.equal(again.actions.length, 0);
});

test('late acceptance event cannot regress post-fill protection state', () => {
  const { record } = prepared();
  const pending = toProtectionPending(record).record;
  const late = applyExecutionEvent(pending, acceptedEvent(record, 'late-acceptance'));
  assert.equal(late.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(late.ignoredAsStale, true);
});

test('partial fill blocks retry and new orders until remaining order is reconciled', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const partial = applyExecutionEvent(sub, { eventId: 'partial', executionType: 11, order: { orderId: 5001, clientOrderId: record.clientOrderId, executedVolume: 5000 } });
  assert.equal(partial.record.state, EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION);
  assert.equal(partial.record.unresolved, true);
  assert.equal(isExecutionStateUnresolved(partial.record.state), true);
  assert.equal(beginSubmission(record, gate({ noUnresolvedExecution: false })).code, 'UNRESOLVED_EXECUTION_EXISTS');
  assert.equal(beginSubmission(record, gate({ activeAccountKey: 'different-account' })).code, 'ACCOUNT_CONTEXT_MISMATCH');
});

test('valid partial fill snapshot immediately plans SL/TP protection and keeps remainder unresolved', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const result = applyExecutionEvent(sub, partialFilledEvent(record), 1_800_000_000_030);
  assert.equal(result.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(result.record.partialFillObserved, true);
  assert.equal(result.record.orderFullyExecuted, false);
  assert.equal(result.record.remainingOrderOpen, true);
  assert.equal(result.record.positionId, '7001');
  assert.equal(result.record.filledVolumeCents, 5000);
  assert.ok(Math.abs(result.record.estimatedRiskUsdAtFill - 5.1) < 1e-9);
  assert.ok(Math.abs(result.record.projectedRiskUsdAtRequestedVolume - 10.2) < 1e-9);
  assert.equal(result.record.fillRiskBudgetExceeded, true);
  const modification = result.actions.find(a => a.type === 'MODIFY_POSITION_PROTECTION');
  assert.deepEqual(modification.params, { positionId: 7001, stopLoss: 1990.2, takeProfit: 2051.2 });
  assert.ok(result.actions.some(a => a.code === 'PROJECTED_PRICE_RISK_OVER_TARGET'));
  assert.ok(result.actions.some(a => a.code === 'PROTECTION_TARGET_CHANGED_DURING_INFLIGHT_UPDATE') === false);
  assert.equal(result.record.protectionConfirmed, false);
  assert.equal(result.record.unresolved, true);
});

test('partial fill with no server-side SL/TP triggers critical alert plus immediate protection request', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const event = partialFilledEvent(record, { stopLoss: NaN, takeProfit: NaN });
  const result = applyExecutionEvent(sub, event);
  assert.equal(result.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.ok(result.actions.some(a => a.code === 'PARTIAL_POSITION_PROTECTION_NOT_CONFIRMED' && a.severity === 'CRITICAL'));
  assert.ok(result.actions.some(a => a.type === 'MODIFY_POSITION_PROTECTION'));
  assert.equal(result.record.protectionConfirmed, false);
});

test('partial fill without a complete open-position snapshot remains blocked and does not send an SLTP request', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const result = applyExecutionEvent(sub, partialFilledEvent(record, { includePosition: false }));
  assert.equal(result.record.state, EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION);
  assert.equal(result.record.protectionConfirmed, false);
  assert.equal(result.record.unresolved, true);
  assert.equal(result.actions.some(a => a.type === 'MODIFY_POSITION_PROTECTION'), false);
});

test('partial fill rejects closed, mismatched and inconsistent cumulative position snapshots', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const closed = partialFilledEvent(record);
  closed.position.positionStatus = 2;
  assert.equal(applyExecutionEvent(sub, closed).record.errorCode, 'PARTIAL_POSITION_NOT_CONFIRMED_OPEN');
  const wrongSymbol = partialFilledEvent(record, { symbolId: 999, dealId: 6102, eventId: 'wrong-symbol-partial' });
  assert.equal(applyExecutionEvent(sub, wrongSymbol).record.errorCode, 'FILL_SYMBOL_MISMATCH');
  const inconsistent = partialFilledEvent(record, { cumulativeVolume: 5000, dealId: 6103, eventId: 'volume-mismatch' });
  inconsistent.position.tradeData.volume = 4000;
  assert.equal(applyExecutionEvent(sub, inconsistent).record.errorCode, 'POSITION_ORDER_VOLUME_MISMATCH');
});

test('partial protection acknowledgement confirms the open partial position but does not clear remaining-order risk', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const partial = applyExecutionEvent(sub, partialFilledEvent(record));
  const ack = applyExecutionEvent(partial.record, positionProtectionAck(record), 1_800_000_000_040);
  assert.equal(ack.record.state, EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING);
  assert.equal(ack.record.protectionConfirmed, true);
  assert.equal(ack.record.unresolved, true);
  assert.equal(ack.record.remainingOrderOpen, true);
  assert.ok(ack.actions.some(a => a.type === 'PARTIAL_POSITION_PROTECTED_REMAINDER_PENDING'));
  assert.equal(isExecutionStateUnresolved(ack.record.state), true);
});

test('a second partial fill arriving during an in-flight protection change is queued and applied sequentially', () => {
  const { record } = prepared();
  let current = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  assert.equal(current.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  const second = partialFilledEvent(record, { eventId: 'partial-valid-2', dealId: 6102,
    cumulativeVolume: 7000, positionPrice: 2000.3, stopLoss: 1990.2, takeProfit: 2051.2 });
  current = applyExecutionEvent(current.record, second, 1_800_000_000_050);
  assert.equal(current.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(current.record.expectedAbsoluteTakeProfit, 2051.8);
  assert.equal(current.record.pendingProtectionRefresh, true);
  assert.equal(current.actions.filter(a => a.type === 'MODIFY_POSITION_PROTECTION').length, 0,
    'do not submit overlapping protection changes');

  const firstAck = applyExecutionEvent(current.record, positionProtectionAck(record, {
    eventId: 'ack-old-target', stopLoss: 1990.2, takeProfit: 2051.2, volume: 7000
  }), 1_800_000_000_060);
  assert.equal(firstAck.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(firstAck.record.pendingProtectionRefresh, false);
  assert.equal(firstAck.actions.filter(a => a.type === 'MODIFY_POSITION_PROTECTION').length, 1);
  assert.equal(firstAck.actions.find(a => a.type === 'MODIFY_POSITION_PROTECTION').params.takeProfit, 2051.8);

  const secondAck = applyExecutionEvent(firstAck.record, positionProtectionAck(record, {
    eventId: 'ack-new-target', stopLoss: 1990.2, takeProfit: 2051.8, volume: 7000
  }), 1_800_000_000_070);
  assert.equal(secondAck.record.state, EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING);
  assert.equal(secondAck.record.protectionConfirmed, true);
  assert.equal(secondAck.record.unresolved, true);
});

test('stale protection acknowledgement volume cannot confirm the latest partial position', () => {
  const { record } = prepared();
  let current = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const second = partialFilledEvent(record, { eventId: 'partial-newer-volume', dealId: 6110,
    cumulativeVolume: 7000, positionPrice: 2000.3, stopLoss: 1990.2, takeProfit: 2051.2 });
  current = applyExecutionEvent(current.record, second);
  const staleAck = applyExecutionEvent(current.record, positionProtectionAck(record, {
    eventId: 'ack-stale-position-volume', volume: 5000, stopLoss: 1990.2, takeProfit: 2051.2
  }));
  assert.equal(staleAck.record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
  assert.equal(staleAck.record.errorCode, 'PARTIAL_PROTECTION_ACK_VOLUME_STALE');
  assert.equal(staleAck.record.protectionConfirmed, false);
  assert.equal(staleAck.record.unresolved, true);
  assert.equal(staleAck.actions.some(a => a.type === 'MODIFY_POSITION_PROTECTION'), false,
    'a stale ack must not trigger blind retry');
});

test('new partial fill after unknown protection outcome does not blindly retry the SLTP request', () => {
  const { record } = prepared();
  const first = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const failed = markProtectionRequestTransportError(first.record, new Error('ack lost'));
  assert.equal(failed.record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
  const later = applyExecutionEvent(failed.record, partialFilledEvent(record, {
    eventId: 'partial-after-unknown-protection', dealId: 6111, cumulativeVolume: 7000, positionPrice: 2000.3
  }));
  assert.equal(later.record.state, EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION);
  assert.equal(later.record.errorCode, 'PRIOR_PROTECTION_OUTCOME_UNRESOLVED');
  assert.equal(later.actions.some(a => a.type === 'MODIFY_POSITION_PROTECTION'), false);
});

test('final ORDER_FILLED after partials updates the final VWAP target and only then resolves the order', () => {
  const { record } = prepared();
  let current = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  current = applyExecutionEvent(current.record, positionProtectionAck(record));
  assert.equal(current.record.state, EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING);
  const final = filledEvent(record, { eventId: 'final-after-partial', fillPrice: 2000.4, volume: 10000 });
  final.position.stopLoss = 1990.2;
  final.position.takeProfit = 2051.8;
  const finalResult = applyExecutionEvent(current.record, final, 1_800_000_000_080);
  assert.equal(finalResult.record.orderFullyExecuted, true);
  assert.equal(finalResult.record.remainingOrderOpen, false);
  assert.equal(finalResult.record.expectedAbsoluteTakeProfit, 2052.4);
  assert.equal(finalResult.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(finalResult.actions.filter(a => a.type === 'MODIFY_POSITION_PROTECTION').length, 1);
  const finalAck = applyExecutionEvent(finalResult.record, positionProtectionAck(record, {
    eventId: 'final-protection-ack', stopLoss: 1990.2, takeProfit: 2052.4, volume: 10000
  }), 1_800_000_000_090);
  assert.equal(finalAck.record.state, EXECUTION_STATE.PROTECTED);
  assert.equal(finalAck.record.protectionConfirmed, true);
  assert.equal(finalAck.record.unresolved, false);
});

test('duplicate deal ID cannot generate a second partial protection change when event ID changes', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const event = partialFilledEvent(record, { eventId: 'partial-deal-first', dealId: 6500 });
  const first = applyExecutionEvent(sub, event);
  const repeated = partialFilledEvent(record, { eventId: 'partial-deal-redelivery', dealId: 6500 });
  const duplicate = applyExecutionEvent(first.record, repeated);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.actions.length, 0);
});

test('late older partial snapshot cannot regress cumulative execution volume', () => {
  const { record } = prepared();
  let current = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const second = applyExecutionEvent(current.record, partialFilledEvent(record, { eventId: 'partial-7000', dealId: 6502,
    cumulativeVolume: 7000, positionPrice: 2000.3, stopLoss: 1990.2, takeProfit: 2051.2 }));
  const stale = applyExecutionEvent(second.record, partialFilledEvent(record, { eventId: 'partial-old-6000', dealId: 6501,
    cumulativeVolume: 6000, positionPrice: 2000.25, stopLoss: 1990.2, takeProfit: 2051.2 }));
  assert.equal(stale.ignoredAsStale, true);
  assert.equal(stale.record.lastObservedExecutedVolumeCents, 7000);
});

test('transport error and timeout lead to unknown outcome, never safe retry', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const unknown = markRequestTransportError(sub, new Error('socket closed'));
  assert.equal(unknown.record.state, EXECUTION_STATE.OUTCOME_UNKNOWN);
  assert.equal(unknown.record.unresolved, true);
  const noRetry = beginSubmission(unknown.record, gate());
  assert.equal(noRetry.code, 'INVALID_SUBMISSION_STATE');
  const timeout = markExecutionTimeout(sub);
  assert.equal(timeout.record.state, EXECUTION_STATE.RECONCILIATION_REQUIRED);
});

test('protection transport error/timeout is not reported as protected', () => {
  const { record } = prepared();
  const pending = toProtectionPending(record).record;
  assert.equal(markProtectionRequestTransportError(pending, new Error('timeout')).record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
  assert.equal(markExecutionTimeout(pending).record.state, EXECUTION_STATE.PROTECTION_UNCONFIRMED);
});

test('restart restores active/previously protected positions to mandatory reconciliation', () => {
  const { record } = prepared();
  const restored = restoreExecutionRecord({ ...record, state: EXECUTION_STATE.PROTECTED, protectionConfirmed: true }, 1_800_000_000_001, 'demo-account-1');
  assert.equal(restored.record.state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(restored.record.protectionConfirmed, false);
  assert.equal(restored.record.unresolved, true);
  assert.equal(restoreExecutionRecord({ ...record, state: EXECUTION_STATE.PROTECTED }).code, 'RESTORE_ACCOUNT_UNVERIFIED');
  assert.equal(restoreExecutionRecord({ ...record, state: EXECUTION_STATE.PROTECTED }, 1_800_000_000_001, 'another-account').code, 'RESTORE_ACCOUNT_MISMATCH');
  const rejected = restoreExecutionRecord({ ...record, state: EXECUTION_STATE.REJECTED }, 1_800_000_000_001, 'demo-account-1');
  assert.equal(rejected.record.state, EXECUTION_STATE.REJECTED);
  assert.equal(restoreExecutionRecord({ ...record, state: EXECUTION_STATE.REJECTED }, 1_800_000_000_001, 'another-account').code, 'RESTORE_ACCOUNT_MISMATCH');
});

test('accepted/rejected lifecycle is correlated without matching other symbols', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const rejected = applyExecutionEvent(sub, { eventId: 'rejected', executionType: 7, errorCode: 'MARKET_CLOSED', order: { orderId: 5001, clientOrderId: record.clientOrderId } });
  assert.equal(rejected.record.state, EXECUTION_STATE.REJECTED);
  assert.equal(rejected.record.unresolved, false);
});


function fakeObservable(run) {
  return {
    pipe(operator) { return typeof operator === 'function' ? operator(this) : this; },
    subscribe(observer) {
      try { run(observer); } catch (error) { observer.error?.(error); }
      return { unsubscribe() {} };
    }
  };
}
const identityTake = () => source => source;
const mockServerInterfaces = {
  ProtoOrderType: { MARKET: 1 },
  ProtoTradeSide: { BUY: 1, SELL: 2 }
};
function coordinatorFixture({ persist = () => true, gates = gate(), sdkOverrides = {}, activeAccountKeyProviderOverride = null, onRecordOverride = null } = {}) {
  const apiCalls = { create: [], modify: [], cancel: [] };
  let coordinator = null;
  const sdk = {
    createNewOrder: (adapter, params) => {
      apiCalls.create.push({ adapter, params });
      return fakeObservable(observer => {
        observer.next({ eventId: 'mock-accepted', executionType: 2,
          order: { orderId: 5001, clientOrderId: params.clientOrderId,
            tradeData: { symbolId: params.symbolId, tradeSide: params.tradeSide, volume: params.volume } } });
        observer.complete?.();
      });
    },
    modifyOrderProtection: (adapter, params) => {
      apiCalls.modify.push({ adapter, params });
      return fakeObservable(observer => {
        const currentRecord = coordinator?.snapshot().find(row => String(row.positionId) === String(params.positionId));
        const currentVolume = currentRecord?.filledVolumeCents ?? 10000;
        observer.next({ eventId: `mock-protection-ack-${apiCalls.modify.length}`, executionType: 4,
          order: { orderId: 9001 + apiCalls.modify.length, clientOrderId: 'PROTECTION-CHILD' },
          position: { positionId: params.positionId, positionStatus: 1, stopLoss: params.stopLoss, takeProfit: params.takeProfit,
            tradeData: { symbolId: 101, tradeSide: 1, volume: currentVolume } } });
        observer.complete?.();
      });
    },
    cancelOrder: (adapter, params) => {
      apiCalls.cancel.push({ adapter, params });
      return fakeObservable(observer => {
        const latestProtection = apiCalls.modify.at(-1)?.params;
        const cancelRecord = coordinator?.getRecord(String(params.originalClientOrderId));
        const expectedVolume = Number(cancelRecord?.lastObservedExecutedVolumeCents ?? cancelRecord?.filledVolumeCents ?? 0);
        observer.next({ eventId: `mock-cancel-${params.clientOrderId}`, executionType: 5,
          order: { orderId: params.orderId, clientOrderId: params.originalClientOrderId,
            orderStatus: 5, executedVolume: expectedVolume },
          ...(latestProtection && expectedVolume > 0 ? { position: { positionId: latestProtection.positionId,
            positionStatus: 1, stopLoss: latestProtection.stopLoss, takeProfit: latestProtection.takeProfit,
            tradeData: { symbolId: 101, tradeSide: 1, volume: expectedVolume } } } : {}) });
        observer.complete?.();
      });
    },
    ...sdkOverrides
  };
  const c = new CTraderExecutionCoordinator({ adapter: { id: 'fake-host' }, sdk,
    ServerInterfaces: mockServerInterfaces, take: identityTake,
    gateProvider: () => gates, activeAccountKeyProvider: activeAccountKeyProviderOverride ?? (() => gates?.accountContextVerified === true ? gates.activeAccountKey : null),
    onRecord: onRecordOverride ?? (() => {}), persistSnapshot: persist, now: (() => { let n = 1800000000000; return () => ++n; })() });
  coordinator = c;
  return { c, apiCalls };
}

test('coordinator never sends an order when persistence is absent or not durable', () => {
  let calls = 0;
  const fixture = coordinatorFixture({ persist: () => false, sdkOverrides: { createNewOrder: () => { calls++; return fakeObservable(() => {}); } } });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  const result = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXECUTION_LEDGER_NOT_DURABLE');
  assert.equal(calls, 0);
});

test('coordinator only sends after every gate and durable SUBMITTING snapshot pass', () => {
  let calls = 0;
  const fixture = coordinatorFixture({ gates: gate({ executionEnabled: false }), sdkOverrides: { createNewOrder: () => { calls++; return fakeObservable(() => {}); } } });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  const result = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXECUTION_FEATURE_DISABLED');
  assert.equal(calls, 0);
});

test('coordinator does not call SDK if persisting SUBMITTING fails after prepared intent was persisted', () => {
  let persistCalls = 0;
  let orderCalls = 0;
  const fixture = coordinatorFixture({ persist: () => ++persistCalls <= 2, sdkOverrides: { createNewOrder: () => { orderCalls++; return fakeObservable(() => {}); } } });
  const preparedRecord = fixture.c.prepare(validInput()); // persist #1
  assert.equal(preparedRecord.ok, true);
  const result = fixture.c.submit(preparedRecord.record.clientOrderId); // preflight persist #2, SUBMITTING persist #3 fails
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXECUTION_LEDGER_NOT_DURABLE');
  assert.equal(result.requestSent, false);
  assert.equal(orderCalls, 0);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.PREPARED);
});

test('coordinator mock flow keeps ACCEPTED distinct, then requires position protection confirmation', () => {
  const fixture = coordinatorFixture();
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true, preparedRecord.reason);
  const sub = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(sub.ok, true);
  assert.equal(fixture.apiCalls.create.length, 1);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.ACCEPTED);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).protectionConfirmed, false);

  const fill = filledEvent(preparedRecord.record, { fillPrice: 2000, positionId: 7001 });
  const routed = fixture.c.onExecutionEvent(fill);
  assert.equal(routed.matched, true);
  assert.equal(fixture.apiCalls.modify.length, 1);
  assert.deepEqual(fixture.apiCalls.modify[0].params, { positionId: 7001, stopLoss: 1990, takeProfit: 2050 });
  const done = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(done.state, EXECUTION_STATE.PROTECTED);
  assert.equal(done.protectionConfirmed, true);
  assert.equal(done.lastConfirmedStopLoss, 1990);
  assert.equal(done.lastConfirmedTakeProfit, 2050);
  assert.equal(fixture.c.hasUnresolvedRecords(), false);
});

test('partial fill creates one bounded cancellation intent for the unfilled remainder', () => {
  const { record } = prepared();
  const result = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const cancel = result.actions.find(action => action.type === 'CANCEL_REMAINDER_ORDER');
  assert.ok(cancel);
  assert.equal(cancel.params.orderId, 5001);
  assert.equal(cancel.params.originalClientOrderId, record.clientOrderId);
  assert.equal(cancel.params.clientOrderId, 'URM-CAN-5001');
  assert.equal(cancel.params.expectedExecutedVolumeCents, 5000);
  assert.equal(result.record.remainderCancelStatus, 'REQUEST_PLANNED');
  assert.equal(result.record.remainingOrderOpen, true);
});

test('partial fill event without position snapshot still plans one order-remainder cancellation', () => {
  const { record } = prepared();
  const result = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record, { includePosition: false }));
  assert.equal(result.record.state, EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION);
  assert.ok(result.actions.some(action => action.type === 'CANCEL_REMAINDER_ORDER'));
  assert.equal(result.actions.some(action => action.type === 'MODIFY_POSITION_PROTECTION'), false);
});

test('confirmed cancellation only resolves when cumulative volume and current open position protection match', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const protectedPartial = applyExecutionEvent(partial.record, positionProtectionAck(record));
  assert.equal(protectedPartial.record.protectionConfirmed, true);
  const cancelled = applyExecutionEvent(protectedPartial.record, {
    eventId: 'remainder-cancelled', executionType: 5,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 5000 },
    position: { positionId: 7001, positionStatus: 1, stopLoss: 1990.2, takeProfit: 2051.2,
      tradeData: { symbolId: 101, tradeSide: 1, volume: 5000 } }
  });
  assert.equal(cancelled.record.remainderCancelStatus, 'CANCELLED');
  assert.equal(cancelled.record.cancelVolumeReconciled, true);
  assert.equal(cancelled.record.remainingOrderOpen, false);
  assert.equal(cancelled.record.state, EXECUTION_STATE.PROTECTED);
  assert.equal(cancelled.record.unresolved, false);
});

test('cancellation volume race is not treated as safe terminal state', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const event = {
    eventId: 'cancel-volume-race', executionType: 5,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 7000 },
    position: { positionId: 7001, positionStatus: 1, stopLoss: 1990.2, takeProfit: 2051.8,
      tradeData: { symbolId: 101, tradeSide: 1, volume: 7000 } }
  };
  const cancelled = applyExecutionEvent(partial.record, event);
  assert.equal(cancelled.record.remainderCancelStatus, 'CANCELLED_VOLUME_MISMATCH');
  assert.equal(cancelled.record.remainingOrderOpen, false);
  assert.equal(cancelled.record.state, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION);
  assert.equal(cancelled.record.unresolved, true);
});

test('a new fill event after confirmed cancellation is quarantined for manual reconciliation', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const protectedPartial = applyExecutionEvent(partial.record, positionProtectionAck(record));
  const cancelled = applyExecutionEvent(protectedPartial.record, {
    eventId: 'cancel-confirmed-before-late-fill', executionType: 5,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 5000 },
    position: { positionId: 7001, positionStatus: 1, stopLoss: 1990.2, takeProfit: 2051.2,
      tradeData: { symbolId: 101, tradeSide: 1, volume: 5000 } }
  });
  assert.equal(cancelled.record.state, EXECUTION_STATE.PROTECTED);
  const lateFill = applyExecutionEvent(cancelled.record, partialFilledEvent(record, {
    eventId: 'late-partial-after-cancel', dealId: 6102, cumulativeVolume: 7000,
    positionPrice: 2000.3, stopLoss: 1990.2, takeProfit: 2051.8
  }));
  assert.equal(lateFill.record.state, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION);
  assert.equal(lateFill.record.errorCode, 'FILL_EVENT_AFTER_CANCEL_CONFIRMATION');
  assert.equal(lateFill.record.unresolved, true);
  assert.equal(lateFill.actions.some(action => action.type === 'MODIFY_POSITION_PROTECTION'), false);
});

test('cancel rejection leaves the remainder open and never creates an automatic retry', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const protectedPartial = applyExecutionEvent(partial.record, positionProtectionAck(record));
  const rejected = applyExecutionEvent(protectedPartial.record, {
    eventId: 'cancel-rejected', executionType: 8,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, executedVolume: 5000 }
  });
  assert.equal(rejected.record.remainderCancelStatus, 'CANCEL_REJECTED');
  assert.equal(rejected.record.remainingOrderOpen, true);
  assert.equal(rejected.record.unresolved, true);
  assert.equal(rejected.actions.some(action => action.type === 'CANCEL_REMAINDER_ORDER'), false);
});

test('a late cancel-rejected event after full fill cannot regress final protection state', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const full = applyExecutionEvent(partial.record, filledEvent(record, { eventId: 'full-after-partial', volume: 10000 }));
  assert.equal(full.record.orderFullyExecuted, true);
  const cancelRejected = applyExecutionEvent(full.record, {
    eventId: 'late-cancel-rejected', executionType: 8,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, executedVolume: 10000 }
  });
  assert.equal(cancelRejected.record.orderFullyExecuted, true);
  assert.equal(cancelRejected.record.remainingOrderOpen, false);
  assert.equal(cancelRejected.record.remainderCancelStatus, 'SUPERSEDED_BY_FILL');
  assert.equal(cancelRejected.record.unresolved, true); // protection is still in flight in this test
});

test('cancel acknowledgement can arrive before protection acknowledgement without releasing early', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const cancelledFirst = applyExecutionEvent(partial.record, {
    eventId: 'cancel-before-protection-ack', executionType: 5,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 5000 }
  });
  assert.equal(cancelledFirst.record.remainderCancelStatus, 'CANCELLED');
  assert.equal(cancelledFirst.record.remainingOrderOpen, false);
  assert.equal(cancelledFirst.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.equal(cancelledFirst.record.unresolved, true);
  const protectionAck = applyExecutionEvent(cancelledFirst.record, positionProtectionAck(record));
  assert.equal(protectionAck.record.state, EXECUTION_STATE.PROTECTED);
  assert.equal(protectionAck.record.protectionConfirmed, true);
  assert.equal(protectionAck.record.unresolved, false);
});

test('a second partial fill does not generate a duplicate remainder-cancel request', () => {
  const { record } = prepared();
  const first = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  assert.equal(first.record.remainderCancelStatus, 'REQUEST_PLANNED');
  const secondEvent = partialFilledEvent(record, { eventId: 'second-partial-after-cancel-planned', dealId: 6102,
    cumulativeVolume: 7000, positionPrice: 2000.3, stopLoss: 1990.2, takeProfit: 2051.2 });
  const second = applyExecutionEvent(first.record, secondEvent);
  assert.equal(second.actions.some(action => action.type === 'CANCEL_REMAINDER_ORDER'), false);
});

test('cancellation event matched only by client ID but lacking exact order ID cannot confirm cancellation', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const protectedPartial = applyExecutionEvent(partial.record, positionProtectionAck(record));
  const cancelled = applyExecutionEvent(protectedPartial.record, {
    eventId: 'cancel-ack-no-order-id', executionType: 5,
    order: { clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 5000 },
    position: { positionId: 7001, positionStatus: 1, stopLoss: 1990.2, takeProfit: 2051.2,
      tradeData: { symbolId: 101, tradeSide: 1, volume: 5000 } }
  });
  assert.equal(cancelled.record.remainderCancelStatus, 'CANCEL_IDENTITY_MISMATCH');
  assert.equal(cancelled.record.remainingOrderOpen, true);
  assert.equal(cancelled.record.state, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION);
  assert.equal(cancelled.record.unresolved, true);
});

test('cancellation terminal event without an authoritative current position does not clear unresolved state', () => {
  const { record } = prepared();
  const partial = applyExecutionEvent(toSubmitting(record), partialFilledEvent(record));
  const protectedPartial = applyExecutionEvent(partial.record, positionProtectionAck(record));
  const cancelNoSnapshot = applyExecutionEvent(protectedPartial.record, {
    eventId: 'cancel-no-position-snapshot', executionType: 5,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, orderStatus: 5, executedVolume: 5000 }
  });
  assert.equal(cancelNoSnapshot.record.remainderCancelStatus, 'CANCELLED');
  assert.equal(cancelNoSnapshot.record.remainingOrderOpen, false);
  assert.equal(cancelNoSnapshot.record.state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(cancelNoSnapshot.record.unresolved, true);
});

test('coordinator protects the partial position and cancels/reconciles the unfilled remainder', () => {
  const gates = gate();
  const fixture = coordinatorFixture({ gates });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  const submit = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(submit.requestStarted, true);
  const eventResult = fixture.c.onExecutionEvent(partialFilledEvent(preparedRecord.record));
  assert.equal(eventResult.matched, true);
  assert.equal(fixture.apiCalls.modify.length, 1);
  assert.equal(fixture.apiCalls.modify[0].params.stopLoss, 1990.2);
  assert.equal(fixture.apiCalls.modify[0].params.takeProfit, 2051.2);
  assert.equal(fixture.apiCalls.cancel.length, 1);
  assert.deepEqual(fixture.apiCalls.cancel[0].params, {
    orderId: 5001, originalClientOrderId: preparedRecord.record.clientOrderId,
    clientOrderId: 'URM-CAN-5001'
  });
  const liveRecord = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(liveRecord.state, EXECUTION_STATE.PROTECTED);
  assert.equal(liveRecord.protectionConfirmed, true);
  assert.equal(liveRecord.remainderCancelStatus, 'CANCELLED');
  assert.equal(liveRecord.remainingOrderOpen, false);
  assert.equal(liveRecord.orderFullyExecuted, false);
  assert.equal(liveRecord.unresolved, false);
  assert.equal(fixture.c.hasUnresolvedRecords(), false);
});

test('risk-reducing cancel gets one attempt if journal fails during an already-live partial fill, but durable submission stays blocked', () => {
  let persistenceCalls = 0;
  let cancelCalls = 0;
  const fixture = coordinatorFixture({
    persist: () => { persistenceCalls += 1; return persistenceCalls <= 6; },
    sdkOverrides: {
      cancelOrder: (adapter, params) => {
        cancelCalls += 1;
        const current = fixture.c.getRecord(String(params.originalClientOrderId));
        const target = fixture.apiCalls.modify.at(-1)?.params;
        return fakeObservable(observer => {
          observer.next({ eventId: 'cancel-after-persist-failure', executionType: 5,
            order: { orderId: params.orderId, clientOrderId: params.originalClientOrderId,
              orderStatus: 5, executedVolume: current?.lastObservedExecutedVolumeCents },
            ...(target ? { position: { positionId: current.positionId, positionStatus: 1,
              stopLoss: target.stopLoss, takeProfit: target.takeProfit,
              tradeData: { symbolId: 101, tradeSide: 1, volume: current.filledVolumeCents } } } : {}) });
          observer.complete?.();
        });
      }
    }
  });
  const preparedRecord = fixture.c.prepare(validInput());
  fixture.c.submit(preparedRecord.record.clientOrderId);
  fixture.c.onExecutionEvent(partialFilledEvent(preparedRecord.record));
  const saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(cancelCalls, 1);
  assert.equal(saved.cancelRequestDurabilityWarning, true);
  assert.equal(saved.remainderCancelStatus, 'CANCELLED');
  assert.equal(fixture.c.persistenceHealthy, false);
  const next = fixture.c.prepare(validInput({ randomToken: 'DURABILITY-GATE' }));
  assert.equal(next.ok, true);
  const submit = fixture.c.submit(next.record.clientOrderId);
  assert.equal(submit.code, 'EXECUTION_LEDGER_NOT_DURABLE');
  assert.equal(fixture.apiCalls.create.length, 1);
});

test('coordinator cancel rejection stays unresolved and duplicate partial events do not retry', () => {
  let cancelCalls = 0;
  const fixture = coordinatorFixture({ sdkOverrides: {
    cancelOrder: (adapter, params) => {
      cancelCalls += 1;
      return fakeObservable(observer => {
        observer.next({ eventId: 'cancel-rejected-once', executionType: 8,
          order: { orderId: params.orderId, clientOrderId: params.originalClientOrderId, executedVolume: 5000 } });
        observer.complete?.();
      });
    }
  }});
  const preparedRecord = fixture.c.prepare(validInput());
  fixture.c.submit(preparedRecord.record.clientOrderId);
  const partial = partialFilledEvent(preparedRecord.record);
  fixture.c.onExecutionEvent(partial);
  let saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(cancelCalls, 1);
  assert.equal(saved.remainderCancelStatus, 'CANCEL_REJECTED');
  assert.equal(saved.remainingOrderOpen, true);
  assert.equal(saved.unresolved, true);
  assert.equal(fixture.c.hasUnresolvedRecords(), true);
  fixture.c.onExecutionEvent(partial); // repeated event must not retry
  saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(cancelCalls, 1);
  assert.equal(saved.remainderCancelStatus, 'CANCEL_REJECTED');
  assert.equal(fixture.c.prepare(validInput({ randomToken: 'SHOULD-STAY-BLOCKED' })).code, 'UNRESOLVED_EXECUTION_EXISTS');
});

test('coordinator cancel transport failure is unknown, one-shot and unresolved', () => {
  let cancelCalls = 0;
  const fixture = coordinatorFixture({ sdkOverrides: {
    cancelOrder: () => { cancelCalls += 1; return fakeObservable(observer => observer.error(new Error('cancel response lost'))); }
  }});
  const preparedRecord = fixture.c.prepare(validInput());
  fixture.c.submit(preparedRecord.record.clientOrderId);
  const partial = partialFilledEvent(preparedRecord.record);
  fixture.c.onExecutionEvent(partial);
  let saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(cancelCalls, 1);
  assert.equal(saved.remainderCancelStatus, 'UNKNOWN');
  assert.equal(saved.remainingOrderOpen, true);
  assert.equal(saved.unresolved, true);
  assert.equal(fixture.c.hasUnresolvedRecords(), true);
  fixture.c.onExecutionEvent(partial); // no automatic retry
  saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(cancelCalls, 1);
  assert.equal(saved.remainderCancelStatus, 'UNKNOWN');
});

test('missing SDK cancelOrder method leaves the partial remainder explicitly blocked', () => {
  const fixture = coordinatorFixture({ sdkOverrides: { cancelOrder: undefined } });
  const preparedRecord = fixture.c.prepare(validInput());
  fixture.c.submit(preparedRecord.record.clientOrderId);
  fixture.c.onExecutionEvent(partialFilledEvent(preparedRecord.record));
  const saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(saved.remainderCancelStatus, 'UNAVAILABLE');
  assert.equal(saved.remainingOrderOpen, true);
  assert.equal(saved.unresolved, true);
  assert.equal(fixture.c.hasUnresolvedRecords(), true);
});

test('coordinator treats transport errors as unknown and never retries automatically', () => {
  let orderCalls = 0;
  const fixture = coordinatorFixture({ sdkOverrides: { createNewOrder: () => {
    orderCalls++;
    return fakeObservable(observer => observer.error(new Error('connection reset')));
  } } });
  const preparedRecord = fixture.c.prepare(validInput());
  const submitted = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(submitted.ok, true);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.OUTCOME_UNKNOWN);
  assert.equal(fixture.c.submit(preparedRecord.record.clientOrderId).ok, false);
  assert.equal(orderCalls, 1);
});

test('coordinator records a correlated SDK validation error as rejected, not an unknown fill', () => {
  const fixture = coordinatorFixture({ sdkOverrides: { createNewOrder: () => fakeObservable(observer => {
    observer.next({ payloadType: 138, errorCode: 'MARKET_CLOSED', description: 'Market is closed.' });
    observer.complete?.();
  }) } });
  const preparedRecord = fixture.c.prepare(validInput());
  const submitted = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(submitted.ok, true);
  const saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(saved.state, EXECUTION_STATE.REJECTED);
  assert.equal(saved.errorCode, 'MARKET_CLOSED');
  assert.equal(saved.unresolved, false);
});

test('post-fill slippage is measured against USD 10 target and emits a separate risk warning', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const fill = applyExecutionEvent(sub, filledEvent(record, { fillPrice: 2001, positionId: 7003 }));
  assert.equal(fill.record.state, EXECUTION_STATE.PROTECTION_UPDATE_PENDING);
  assert.ok(Math.abs(fill.record.estimatedRiskUsdAtFill - 11) < 1e-9);
  assert.equal(fill.record.fillRiskBudgetExceeded, true);
  assert.equal(fill.actions.some(a => a.code === 'ACTUAL_FILL_RISK_OVER_TARGET'), true);
  assert.equal(fill.actions.some(a => a.type === 'MODIFY_POSITION_PROTECTION'), true);
});

test('coordinator forwards risk alerts to its configured action handler', () => {
  const received = [];
  const fixture = coordinatorFixture({});
  fixture.c.onAction = action => received.push(action);
  const preparedRecord = fixture.c.prepare(validInput());
  fixture.c.submit(preparedRecord.record.clientOrderId);
  fixture.c.onExecutionEvent(filledEvent(preparedRecord.record, { fillPrice: 2001, positionId: 7004 }));
  assert.equal(received.some(action => action.code === 'ACTUAL_FILL_RISK_OVER_TARGET'), true);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.PROTECTED);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).fillRiskBudgetExceeded, true);
});


test('active saved records without verified current account are quarantined and block execution', () => {
  const fixture = coordinatorFixture({ gates: gate({ accountContextVerified: false, activeAccountKey: '' }) });
  const { record } = prepared();
  const restored = fixture.c.restore([{ ...record, state: EXECUTION_STATE.PROTECTED, protectionConfirmed: true }]);
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredCount, 0);
  assert.equal(restored.quarantinedCount, 1);
  assert.equal(fixture.c.getQuarantinedRecords().length, 1);
  assert.equal(fixture.c.hasUnresolvedRecords(), true);
  assert.equal(fixture.c.prepare(validInput({ randomToken: 'NEXTTRADE' })).code, 'UNRESOLVED_EXECUTION_EXISTS');
});

test('account-mismatched saved records never enter the active ledger', () => {
  const fixture = coordinatorFixture({ gates: gate({ activeAccountKey: 'different-account' }) });
  const { record } = prepared();
  const restored = fixture.c.restore([{ ...record, state: EXECUTION_STATE.OUTCOME_UNKNOWN }]);
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredCount, 0);
  assert.equal(restored.quarantinedCount, 1);
  assert.equal(fixture.c.getRecord(record.clientOrderId), null);
  assert.equal(fixture.c.getQuarantinedRecords()[0].errorCode, 'RESTORE_ACCOUNT_MISMATCH');
});

test('restore counts are scoped to the current call, not prior quarantined records', () => {
  const fixture = coordinatorFixture({ gates: gate({ accountContextVerified: false, activeAccountKey: '' }) });
  const { record } = prepared();
  const first = fixture.c.restore([{ ...record, clientOrderId: 'restore-one', state: EXECUTION_STATE.OUTCOME_UNKNOWN }]);
  assert.equal(first.quarantinedCount, 1);
  const second = fixture.c.restore([{ ...record, clientOrderId: 'restore-two', state: EXECUTION_STATE.OUTCOME_UNKNOWN }]);
  assert.equal(second.quarantinedCount, 1);
  assert.equal(second.restoredCount, 0);
  assert.equal(fixture.c.getQuarantinedRecords().length, 2);
});


test('restore writes one complete snapshot only after all same-account records are loaded', () => {
  const persistedSnapshots = [];
  const fixture = coordinatorFixture({ persist: snapshot => { persistedSnapshots.push(snapshot); return true; } });
  const { record: first } = prepared({ randomToken: 'RESTORE001' });
  const { record: second } = prepared({ randomToken: 'RESTORE002' });
  const result = fixture.c.restore([
    { ...first, state: EXECUTION_STATE.PROTECTED },
    { ...second, state: EXECUTION_STATE.PROTECTED }
  ]);
  assert.equal(result.restoredCount, 2);
  assert.equal(result.quarantinedCount, 0);
  assert.equal(result.journalPersisted, true);
  assert.equal(persistedSnapshots.length, 1, 'must not persist progressively partial snapshots');
  assert.equal(persistedSnapshots[0].length, 2);
  assert.ok(persistedSnapshots.every(snapshot => snapshot.every(row => row.state === EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED)));
});

test('restore never overwrites a journal when account-mismatched or ambiguous rows are quarantined', () => {
  let persistCalls = 0;
  const fixture = coordinatorFixture({ persist: () => { persistCalls += 1; return true; }, gates: gate({ activeAccountKey: 'demo-account-1' }) });
  const { record } = prepared({ randomToken: 'QUARANTINE' });
  const result = fixture.c.restore([
    { ...record, clientOrderId: 'same-id', accountKey: 'demo-account-1', state: EXECUTION_STATE.OUTCOME_UNKNOWN },
    { ...record, clientOrderId: 'same-id', accountKey: 'demo-account-1', state: EXECUTION_STATE.PROTECTED }
  ]);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.quarantinedCount, 2);
  assert.equal(fixture.c.getRecord('same-id'), null);
  assert.equal(fixture.c.hasUnresolvedRecords(), true);
  assert.equal(result.journalPersisted, null);
  assert.equal(persistCalls, 0, 'journal is left untouched while ambiguous rows are quarantined');
});

test('repeat restore does not overwrite a newer in-memory record with stale saved state', () => {
  const persistedSnapshots = [];
  const fixture = coordinatorFixture({ persist: snapshot => { persistedSnapshots.push(snapshot); return true; } });
  const { record } = prepared({ randomToken: 'IDEMPOTENT' });
  const initial = fixture.c.restore([{ ...record, state: EXECUTION_STATE.PROTECTED }]);
  assert.equal(initial.restoredCount, 1);
  const current = fixture.c.getRecord(record.clientOrderId);
  const before = current.updatedAt;
  const again = fixture.c.restore([{ ...record, state: EXECUTION_STATE.SUBMITTING, updatedAt: 1 }]);
  assert.equal(fixture.c.getRecord(record.clientOrderId).state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(fixture.c.getRecord(record.clientOrderId).updatedAt, before);
  assert.equal(again.restoredCount, 0);
});


test('coordinator preparation requires the active verified account to match the preview account', () => {
  const fixture = coordinatorFixture();
  assert.equal(fixture.c.prepare(validInput({ accountKey: 'wrong-account' })).code, 'ACCOUNT_CONTEXT_MISMATCH');
  assert.equal(fixture.c.prepare(validInput()).ok, true);
});

test('account switch after preview blocks submission before journal or SDK write', () => {
  const gates = gate();
  let persistCalls = 0;
  let orderCalls = 0;
  const fixture = coordinatorFixture({ gates, persist: () => { persistCalls += 1; return true; }, sdkOverrides: { createNewOrder: () => { orderCalls += 1; return fakeObservable(() => {}); } } });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true, preparedRecord.reason);
  const preSwitchPersistCalls = persistCalls;
  gates.activeAccountKey = 'account-switched';
  const result = fixture.c.submit(preparedRecord.record.clientOrderId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COORDINATOR_ACCOUNT_SCOPE_CHANGED');
  assert.equal(persistCalls, preSwitchPersistCalls, 'must not persist an old-account journal into the switched context');
  assert.equal(orderCalls, 0);
});

test('account switch before an execution event quarantines active records without cross-account writes or SDK calls', () => {
  const gates = gate();
  let writes = 0;
  let modifyCalls = 0;
  let cancelCalls = 0;
  const fixture = coordinatorFixture({ gates, persist: () => { writes += 1; return true; }, sdkOverrides: {
    modifyOrderProtection: () => { modifyCalls += 1; return fakeObservable(() => {}); },
    cancelOrder: () => { cancelCalls += 1; return fakeObservable(() => {}); }
  } });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  fixture.c.submit(preparedRecord.record.clientOrderId);
  const writesBeforeSwitch = writes;
  gates.activeAccountKey = 'other-demo-account';
  const result = fixture.c.onExecutionEvent(partialFilledEvent(fixture.c.getRecord(preparedRecord.record.clientOrderId)));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXECUTION_EVENT_ACCOUNT_SCOPE_CHANGED');
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).accountScopeMismatch, true);
  assert.equal(writes, writesBeforeSwitch, 'the old account journal must not be written through a new-account adapter');
  assert.equal(modifyCalls, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(fixture.c.persistenceHealthy, false);
});

test('account switch during event publication blocks subsequent protection and remainder-cancel SDK calls', () => {
  const gates = gate();
  let writes = 0;
  let writesAtSwitch = null;
  let modifyCalls = 0;
  let cancelCalls = 0;
  const fixture = coordinatorFixture({ gates, persist: () => { writes += 1; return true; },
    onRecordOverride: record => {
      if (record.partialFillObserved === true && gates.activeAccountKey === 'demo-account-1') {
        writesAtSwitch = writes;
        gates.activeAccountKey = 'other-demo-account';
      }
    },
    sdkOverrides: {
      modifyOrderProtection: () => { modifyCalls += 1; return fakeObservable(() => {}); },
      cancelOrder: () => { cancelCalls += 1; return fakeObservable(() => {}); }
    }
  });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  fixture.c.submit(preparedRecord.record.clientOrderId);
  const result = fixture.c.onExecutionEvent(partialFilledEvent(fixture.c.getRecord(preparedRecord.record.clientOrderId)));
  assert.equal(result.ok, true);
  assert.equal(writesAtSwitch, writes, 'no persistence adapter call may occur after account scope changes');
  assert.equal(modifyCalls, 0, 'protection operation must be blocked if scope changes before SDK dispatch');
  assert.equal(cancelCalls, 0, 'remainder cancel must be blocked if scope changes before SDK dispatch');
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(fixture.c.getRecord(preparedRecord.record.clientOrderId).accountScopeMismatch, true);
  assert.equal(fixture.c.persistenceHealthy, false);
});

test('late protection and cancel responses after an account switch are ignored without cross-account persistence', () => {
  const gates = gate();
  let writes = 0;
  let protectionObserver = null;
  let cancelObserver = null;
  const fixture = coordinatorFixture({ gates, persist: () => { writes += 1; return true; }, sdkOverrides: {
    modifyOrderProtection: () => fakeObservable(observer => { protectionObserver = observer; }),
    cancelOrder: () => fakeObservable(observer => { cancelObserver = observer; })
  } });
  const preparedRecord = fixture.c.prepare(validInput());
  assert.equal(preparedRecord.ok, true);
  fixture.c.submit(preparedRecord.record.clientOrderId);
  fixture.c.onExecutionEvent(partialFilledEvent(fixture.c.getRecord(preparedRecord.record.clientOrderId)));
  assert.equal(typeof protectionObserver?.next, 'function');
  assert.equal(typeof cancelObserver?.next, 'function');
  const writesBeforeSwitch = writes;
  gates.activeAccountKey = 'other-demo-account';
  protectionObserver.next(positionProtectionAck(fixture.c.getRecord(preparedRecord.record.clientOrderId)));
  cancelObserver.next({ eventId: 'late-cancel-after-account-switch', executionType: 5,
    order: { orderId: 5001, clientOrderId: preparedRecord.record.clientOrderId, orderStatus: 5,
      executedVolume: 5000 } });
  assert.equal(writes, writesBeforeSwitch, 'late SDK callbacks must not write through the switched account adapter');
  const saved = fixture.c.getRecord(preparedRecord.record.clientOrderId);
  assert.equal(saved.state, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED);
  assert.equal(saved.accountScopeMismatch, true);
  assert.equal(saved.protectionConfirmed, false);
  assert.equal(fixture.c.persistenceHealthy, false);
});

test('restore into an already-bound coordinator refuses a different active account', () => {
  const gates = gate();
  const fixture = coordinatorFixture({ gates });
  assert.equal(fixture.c.restore([]).ok, true);
  gates.activeAccountKey = 'different-account';
  const result = fixture.c.restore([]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESTORE_ACTIVE_ACCOUNT_CHANGED');
});


test('late rejection after fill cannot clear unresolved protection state when position ID is absent from the event', () => {
  const { record } = prepared();
  const pending = toProtectionPending(record).record;
  const lateReject = applyExecutionEvent(pending, {
    eventId: 'late-reject-without-position', executionType: 7, errorCode: 'ORDER_REJECTED',
    order: { orderId: 5001, clientOrderId: record.clientOrderId }
  });
  assert.equal(lateReject.record.state, EXECUTION_STATE.PROTECTION_FAILED);
  assert.equal(lateReject.record.unresolved, true);
  assert.equal(lateReject.record.protectionConfirmed, false);
  assert.equal(lateReject.actions[0].severity, 'CRITICAL');
});

test('rejection after a partial fill remains unresolved and never becomes safely rejected', () => {
  const { record } = prepared();
  const sub = toSubmitting(record);
  const partial = applyExecutionEvent(sub, { eventId: 'partial-then-reject', executionType: 11,
    order: { orderId: 5001, clientOrderId: record.clientOrderId, executedVolume: 5000 } });
  const rejectedRemainder = applyExecutionEvent(partial.record, { eventId: 'reject-remainder', executionType: 7,
    errorCode: 'REMAINDER_REJECTED', order: { orderId: 5001, clientOrderId: record.clientOrderId } });
  assert.equal(rejectedRemainder.record.state, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION);
  assert.equal(rejectedRemainder.record.unresolved, true);
  assert.notEqual(rejectedRemainder.record.state, EXECUTION_STATE.REJECTED);
});


test('restore rejects malformed or overlength clientOrderId values', () => {
  assert.equal(restoreExecutionRecord({ clientOrderId: 123, accountKey: 'demo-account-1', state: EXECUTION_STATE.REJECTED }, 1, 'demo-account-1').code, 'RESTORE_RECORD_INVALID');
  assert.equal(restoreExecutionRecord({ clientOrderId: 'URM-' + 'x'.repeat(60), accountKey: 'demo-account-1', state: EXECUTION_STATE.REJECTED }, 1, 'demo-account-1').code, 'RESTORE_RECORD_INVALID');
  assert.equal(restoreExecutionRecord({ clientOrderId: 'URM-', accountKey: 'demo-account-1', state: EXECUTION_STATE.REJECTED }, 1, 'demo-account-1').code, 'RESTORE_RECORD_INVALID');
});
