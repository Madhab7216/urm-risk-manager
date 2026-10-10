import { buildUrmPositionLabel } from './position-manager-policy.mjs';

/**
 * URM Stage F — execution lifecycle prototype, partial-fill reconciliation, and restart-stable position anchors. Execution remains locked in the UI.
 *
 * Pure state machine and SDK request builders. The exported functions do not
 * submit orders by themselves. A host adapter must explicitly pass the release
 * gate, invoke the documented cTrader SDK method, route resulting events here,
 * and confirm the final position protection from server-reported values.
 */

export const MAX_TICK_SIZE_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export const URM_EXECUTION_POLICY = Object.freeze({
  schemaVersion: 1,
  policyVersion: 'URM-EXEC-1.9',
  targetRiskUsd: 10,
  takeProfitR: 5,
  maxQuoteAgeMs: 10_000,
  relativeDistancePriceScale: 100_000,
  clientOrderIdPrefix: 'URM-',
  clientOrderIdMaxLength: 50,
  minimumPriceToleranceFactor: 0.5
});

export const EXECUTION_STATE = Object.freeze({
  PREPARED: 'PREPARED',
  SUBMITTING: 'SUBMITTING',
  ACCEPTED: 'ACCEPTED',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  PARTIAL_FILL_REQUIRES_RECONCILIATION: 'PARTIAL_FILL_REQUIRES_RECONCILIATION',
  PARTIAL_FILL_PROTECTED_REMAINDER_PENDING: 'PARTIAL_FILL_PROTECTED_REMAINDER_PENDING',
  FILL_REQUIRES_RECONCILIATION: 'FILL_REQUIRES_RECONCILIATION',
  PROTECTION_UPDATE_PENDING: 'PROTECTION_UPDATE_PENDING',
  PROTECTION_UNCONFIRMED: 'PROTECTION_UNCONFIRMED',
  PROTECTION_FAILED: 'PROTECTION_FAILED',
  PROTECTED: 'PROTECTED',
  POSITION_RECONCILIATION_REQUIRED: 'POSITION_RECONCILIATION_REQUIRED',
  REJECTED: 'REJECTED',
  NEEDS_MANUAL_INTERVENTION: 'NEEDS_MANUAL_INTERVENTION',
  CLOSED: 'CLOSED'
});

const PRICE_STATES = new Set([
  EXECUTION_STATE.PREPARED,
  EXECUTION_STATE.SUBMITTING,
  EXECUTION_STATE.ACCEPTED,
  EXECUTION_STATE.OUTCOME_UNKNOWN,
  EXECUTION_STATE.RECONCILIATION_REQUIRED,
  EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION,
  EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING,
  EXECUTION_STATE.FILL_REQUIRES_RECONCILIATION,
  EXECUTION_STATE.PROTECTION_UPDATE_PENDING,
  EXECUTION_STATE.PROTECTION_UNCONFIRMED,
  EXECUTION_STATE.PROTECTION_FAILED,
  EXECUTION_STATE.PROTECTED,
  EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED,
  EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION
]);

const number = value => {
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
};
const isSide = side => side === 'BUY' || side === 'SELL';
const positiveSafeInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
function fail(code, reason, details = {}) { return { ok: false, code, reason, ...details }; }
function roundPrice(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
function closeEnough(a, b, tolerance) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
}
function randomToken() {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  } catch {
    // Correlation identifier only; not an authentication or security token.
    return Math.random().toString(36).slice(2, 18).padEnd(8, '0');
  }
}

export function createClientOrderId({ now = Date.now(), random = randomToken() } = {}) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError('now must be a non-negative finite timestamp');
  const suffix = String(random).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  if (!suffix) throw new TypeError('random suffix must contain at least one alphanumeric character');
  const id = `${URM_EXECUTION_POLICY.clientOrderIdPrefix}${Math.floor(timestamp).toString(36)}-${suffix}`;
  if (id.length > URM_EXECUTION_POLICY.clientOrderIdMaxLength) throw new RangeError('clientOrderId exceeds the cTrader 50-character limit');
  return id;
}

function encodeRelativeDistance(distance) {
  const scaled = distance * URM_EXECUTION_POLICY.relativeDistancePriceScale;
  const encoded = Math.round(scaled);
  // Do not silently quantize a requested distance to the protocol resolution.
  // That could make initial server-side protection differ from the approved plan.
  if (!Number.isFinite(scaled) || !Number.isSafeInteger(encoded) || encoded <= 0 || Math.abs(scaled - encoded) > 1e-6) return null;
  return encoded;
}

/**
 * Prepare a protected market-order intent from a currently valid fixed-$10 risk preview.
 * The broker receives relative SL/TP with the market order, then the coordinator
 * must replace them with the fixed structural SL and fill-anchored 5R TP and
 * confirm the server-reported protection before calling the position protected.
 */
export function prepareMarketOrderIntent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('INTENT_INPUT_INVALID', 'Order-intent input must be an object.');
  }
  const preview = input.preview;
  if (!preview || preview.ok !== true || number(preview.targetRiskUsd) !== URM_EXECUTION_POLICY.targetRiskUsd) {
    return fail('RISK_PREVIEW_NOT_APPROVED', 'A valid fixed-$10 risk preview is required.');
  }
  const accountKey = typeof input.accountKey === 'string' ? input.accountKey.trim() : '';
  if (!accountKey || accountKey.length > 200) return fail('ACCOUNT_CONTEXT_UNVERIFIED', 'A stable, verified active account key is required before an order intent can be prepared. Do not use only a raw account login as a globally unique key.');
  const symbolId = number(input.symbolId);
  const side = input.side;
  const entryEstimate = number(input.entryEstimate);
  const stopLossReference = number(input.stopLossReference);
  const digits = number(input.digits);
  const tickSize = number(input.tickSize);
  const tickSizeVerified = input.tickSizeVerified === true;
  const tickSizeSource = typeof input.tickSizeSource === 'string' ? input.tickSizeSource.trim() : '';
  const tickSizeVerifiedAt = number(input.tickSizeVerifiedAt);
  const quoteAgeMs = number(input.quoteAgeMs);
  const now = number(input.now ?? Date.now());
  const volumeCents = number(preview.volumeCents);

  if (!positiveSafeInt(symbolId)) return fail('SYMBOL_ID_INVALID', 'A positive integer cTrader symbol ID is required.');
  if (!isSide(side)) return fail('SIDE_INVALID', 'Side must be BUY or SELL.');
  if (![entryEstimate, stopLossReference].every(Number.isFinite) || entryEstimate <= 0 || stopLossReference <= 0) {
    return fail('PRICE_INVALID', 'Entry estimate and structural SL must be finite positive prices.');
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) return fail('SYMBOL_DIGITS_INVALID', 'Verified symbol digits from 0 to 10 are required.');
  if (!Number.isFinite(now) || now < 0) return fail('CLOCK_INVALID', 'A valid local timestamp is required.');
  if (!Number.isFinite(tickSize) || tickSize <= 0) return fail('SYMBOL_TICK_SIZE_UNVERIFIED', 'A positive, symbol-specific tick size from a trusted source is required before preparing an order. Do not infer a CFD tick grid from decimal digits alone.');
  if (!tickSizeVerified || tickSizeSource.length < 3 || tickSizeSource.length > 160 ||
      !Number.isFinite(tickSizeVerifiedAt) || tickSizeVerifiedAt <= 0 || tickSizeVerifiedAt > now ||
      (now - tickSizeVerifiedAt) > MAX_TICK_SIZE_EVIDENCE_AGE_MS) {
    return fail('SYMBOL_TICK_SIZE_EVIDENCE_UNVERIFIED', 'Tick size requires explicit verified evidence, a source, and a verification timestamp no older than 24 hours.');
  }
  const decimalStep = 10 ** -digits;
  const gridTolerance = Math.max(1e-10, tickSize * 1e-7);
  const isOnTickGrid = price => {
    const nearest = Math.round(price / tickSize) * tickSize;
    return Number.isFinite(nearest) && Math.abs(price - nearest) <= gridTolerance;
  };
  if (tickSize < decimalStep - 1e-10 || Math.abs((tickSize / decimalStep) - Math.round(tickSize / decimalStep)) > 1e-7) {
    return fail('SYMBOL_GRID_METADATA_INCONSISTENT', 'Verified tick size is inconsistent with the symbol decimal precision. Refresh symbol metadata; do not round automatically.');
  }
  const precisionTolerance = Math.max(1e-9, decimalStep * 1e-6);
  if (Math.abs(entryEstimate - roundPrice(entryEstimate, digits)) > precisionTolerance) {
    return fail('ENTRY_PRICE_PRECISION_MISMATCH', 'The entry estimate has more precision than the verified symbol supports.');
  }
  if (Math.abs(stopLossReference - roundPrice(stopLossReference, digits)) > precisionTolerance) {
    return fail('STOP_PRICE_PRECISION_MISMATCH', 'The structural stop-loss has more precision than the verified symbol supports.');
  }
  if (!isOnTickGrid(entryEstimate)) return fail('ENTRY_OFF_TICK_GRID', 'The entry estimate does not align to the verified symbol tick grid. Refresh the quote/metadata.');
  if (!isOnTickGrid(stopLossReference)) return fail('STOP_OFF_TICK_GRID', 'The structural stop-loss does not align to the verified symbol tick grid. Adjust it to a valid tick before preparing an order.');
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0 || quoteAgeMs > URM_EXECUTION_POLICY.maxQuoteAgeMs) {
    return fail('QUOTE_STALE', 'A fresh quote received within 10 seconds is required.');
  }
  if (input.hostConnected !== true) return fail('HOST_DISCONNECTED', 'cTrader host must be connected before preparing an order.');
  if (input.userConfirmed !== true) return fail('USER_CONFIRMATION_REQUIRED', 'The trader must explicitly confirm the exact order preview.');
  if (!positiveSafeInt(volumeCents)) return fail('VOLUME_INVALID', 'Risk preview must produce positive integer protocol-cent volume.');
  const limitedRiskAccount = input.limitedRiskAccount === true;
  const guaranteedStopLossSupported = input.guaranteedStopLossSupported === true;
  const guaranteedStopLossRequested = input.guaranteedStopLossRequested === true;
  if (limitedRiskAccount && (!guaranteedStopLossSupported || !guaranteedStopLossRequested)) {
    return fail('GUARANTEED_SL_REQUIREMENT_UNMET', 'A limited-risk account requires symbol support and an explicit guaranteed-stop-loss request on both initial and amended protection.');
  }
  if (guaranteedStopLossRequested && !guaranteedStopLossSupported) {
    return fail('GUARANTEED_SL_UNSUPPORTED', 'Guaranteed stop loss cannot be requested unless symbol support has been independently verified.');
  }
  if (!Number.isFinite(number(preview.entry)) || !closeEnough(preview.entry, entryEstimate, 10 ** -digits / 2) ||
      !Number.isFinite(number(preview.stopLoss)) || !closeEnough(preview.stopLoss, stopLossReference, 10 ** -digits / 2) || preview.side !== side) {
    return fail('PREVIEW_MISMATCH', 'The order must use the same side, quote entry and structural SL that were risk-checked. Refresh the preview.');
  }
  if ((side === 'BUY' && stopLossReference >= entryEstimate) || (side === 'SELL' && stopLossReference <= entryEstimate)) {
    return fail('STOP_DIRECTION_INVALID', 'BUY requires SL below entry; SELL requires SL above entry.');
  }

  const normalizedStop = roundPrice(stopLossReference, digits);
  if (!isOnTickGrid(normalizedStop)) return fail('NORMALIZED_STOP_OFF_TICK_GRID', 'Decimal normalization would change the structural SL to an invalid symbol tick. No automatic price-grid coercion is allowed.');
  const rDistanceAtEstimate = Math.abs(entryEstimate - normalizedStop);
  const relativeStopLoss = encodeRelativeDistance(rDistanceAtEstimate);
  const relativeTakeProfit = encodeRelativeDistance(rDistanceAtEstimate * URM_EXECUTION_POLICY.takeProfitR);
  if (!relativeStopLoss || !relativeTakeProfit) {
    return fail('RELATIVE_PROTECTION_DISTANCE_INVALID', 'The relative protection distance cannot be safely encoded for the cTrader protocol.');
  }

  let clientOrderId;
  try {
    clientOrderId = input.clientOrderId ? String(input.clientOrderId) : createClientOrderId({ now, random: input.randomToken ?? randomToken() });
  } catch (error) {
    return fail('CLIENT_ORDER_ID_INVALID', error.message);
  }
  if (clientOrderId.length > URM_EXECUTION_POLICY.clientOrderIdMaxLength ||
      !clientOrderId.startsWith(URM_EXECUTION_POLICY.clientOrderIdPrefix) || !/^[A-Za-z0-9-]+$/.test(clientOrderId)) {
    return fail('CLIENT_ORDER_ID_INVALID', 'clientOrderId must be an alphanumeric URM ID no longer than 50 characters.');
  }

  const positionLabel = buildUrmPositionLabel({
    clientOrderId,
    structuralStopLoss: normalizedStop,
    digits
  });
  if (!positionLabel.ok) return fail(positionLabel.code, positionLabel.reason);

  const request = Object.freeze({
    symbolId,
    orderType: 'MARKET',
    tradeSide: side,
    volume: volumeCents,
    clientOrderId,
    relativeStopLoss,
    relativeTakeProfit,
    guaranteedStopLoss: guaranteedStopLossRequested,
    // cAlgo position observer uses the persisted label to recover the original
    // structural SL anchor after plugin/cBot restart. It does not make a trade safe.
    label: positionLabel.label,
    comment: 'URM1; structural SL anchor in label; initial relative protection; verify server SL/TP after fill'
  });
  const record = {
    schemaVersion: URM_EXECUTION_POLICY.schemaVersion,
    policyVersion: URM_EXECUTION_POLICY.policyVersion,
    clientOrderId,
    positionLabel: positionLabel.label,
    state: EXECUTION_STATE.PREPARED,
    createdAt: now,
    updatedAt: now,
    accountKey,
    symbolId,
    side,
    digits,
    tickSize,
    tickSizeVerified,
    tickSizeSource,
    tickSizeVerifiedAt,
    requestedVolumeCents: volumeCents,
    entryEstimate,
    stopLossReference: normalizedStop,
    estimatedRDistance: rDistanceAtEstimate,
    targetRiskUsd: URM_EXECUTION_POLICY.targetRiskUsd,
    estimatedRiskUsdAtPreview: Number.isFinite(number(preview.estimatedRiskUsd)) && number(preview.estimatedRiskUsd) >= 0
      ? number(preview.estimatedRiskUsd) : null,
    estimatedRiskInAccountCurrencyAtPreview: Number.isFinite(number(preview.estimatedRisk)) && number(preview.estimatedRisk) >= 0
      ? number(preview.estimatedRisk) : null,
    takeProfitR: URM_EXECUTION_POLICY.takeProfitR,
    relativeStopLoss,
    relativeTakeProfit,
    guaranteedStopLoss: guaranteedStopLossRequested,
    orderId: null,
    positionId: null,
    fillPrice: null,
    filledVolumeCents: null,
    expectedAbsoluteStopLoss: null,
    expectedAbsoluteTakeProfit: null,
    lastConfirmedStopLoss: null,
    lastConfirmedTakeProfit: null,
    initialRelativeProtectionRequested: true,
    protectionConfirmed: false,
    seenEventIds: [],
    errorCode: null,
    errorMessage: null,
    unresolved: true
  };
  return { ok: true, request, record };
}

/** Map the pure request to the enum values from the imported cTrader SDK. */
export function toSdkMarketOrderParams(request, ServerInterfaces) {
  if (!request || request.orderType !== 'MARKET' || !ServerInterfaces?.ProtoOrderType || !ServerInterfaces?.ProtoTradeSide) {
    return fail('SDK_ENUMS_UNAVAILABLE', 'Current cTrader SDK order and side enums are required.');
  }
  const orderType = ServerInterfaces.ProtoOrderType.MARKET;
  const tradeSide = ServerInterfaces.ProtoTradeSide[request.tradeSide];
  if (orderType == null || tradeSide == null) return fail('SDK_ENUMS_INVALID', 'The required MARKET/BUY/SELL enum is absent in the loaded SDK.');
  return {
    ok: true,
    params: {
      symbolId: request.symbolId,
      orderType,
      tradeSide,
      volume: request.volume,
      clientOrderId: request.clientOrderId,
      relativeStopLoss: request.relativeStopLoss,
      relativeTakeProfit: request.relativeTakeProfit,
      ...(request.guaranteedStopLoss === true ? { guaranteedStopLoss: true } : {}),
      label: request.label,
      comment: request.comment
    }
  };
}

/** The default is deliberately closed. Every gate must be explicitly true. */
export function checkExecutionGate(gate = {}) {
  const checks = [
    ['executionEnabled', 'EXECUTION_FEATURE_DISABLED', 'Order submission is disabled in this build.'],
    ['hostConnected', 'HOST_DISCONNECTED', 'cTrader host is not connected.'],
    ['accountContextVerified', 'ACCOUNT_CONTEXT_UNVERIFIED', 'The active account context must be verified before submission.'],
    ['demoAccountConfirmed', 'DEMO_ACCOUNT_NOT_CONFIRMED', 'Demo account status has not been independently confirmed.'],
    ['demoValidationComplete', 'DEMO_VALIDATION_INCOMPLETE', 'The cTrader-host Demo validation checklist has not passed.'],
    ['userConfirmed', 'USER_CONFIRMATION_REQUIRED', 'Explicit confirmation of this exact order is required.'],
    ['previewFresh', 'PREVIEW_NOT_FRESH', 'The risk preview is missing or stale.'],
    ['journalDurable', 'EXECUTION_LEDGER_NOT_DURABLE', 'The intent and in-flight state must be durably saved before sending an order.'],
    ['noUnresolvedExecution', 'UNRESOLVED_EXECUTION_EXISTS', 'An earlier order has an unknown or incomplete result; reconcile it before another order.']
  ];
  for (const [key, code, reason] of checks) {
    if (gate[key] !== true) return fail(code, reason, { failedGate: key });
  }
  if (typeof gate.activeAccountKey !== 'string' || !gate.activeAccountKey.trim()) return fail('ACCOUNT_CONTEXT_UNVERIFIED', 'A stable active account key is required for order scoping.');
  const normalizedAccountType = typeof gate.accountType === 'string'
    ? gate.accountType.trim().toUpperCase()
    : ({ 0: 'HEDGED', 1: 'NETTED', 2: 'SPREAD_BETTING' })[Number(gate.accountType)] ?? null;
  if (!normalizedAccountType) return fail('ACCOUNT_TYPE_UNVERIFIED', 'A documented cTrader account type must be verified before execution.');
  if (normalizedAccountType === 'SPREAD_BETTING') return fail('ACCOUNT_TYPE_UNSUPPORTED', 'Spread-betting accounts use stake units; this lot-volume sizing path does not support them yet.');
  if (normalizedAccountType === 'NETTED' && !(gate.nettingIsolationAdapterVerified === true && gate.preexistingExposureReconciled === true)) {
    return fail('NETTED_ACCOUNT_ISOLATION_UNVERIFIED', 'Netted accounts merge same-symbol exposure. This build requires a verified position-isolation adapter and a fresh reconciliation of pre-existing exposure; otherwise execution remains blocked.');
  }
  if (!['HEDGED', 'NETTED'].includes(normalizedAccountType)) return fail('ACCOUNT_TYPE_UNSUPPORTED', 'Unsupported account type for this execution model.');
  if (gate.limitedRiskAccount === true && gate.guaranteedStopLossSupported !== true) {
    return fail('GUARANTEED_SL_REQUIREMENT_UNMET', 'This limited-risk account requires guaranteed SL support verified for the symbol.');
  }
  if (gate.limitedRiskAccount === true && gate.guaranteedStopLossRequestEnabled !== true) {
    return fail('GUARANTEED_SL_REQUEST_NOT_CONFIGURED', 'This deployment has not verified that guaranteed SL is included in both initial and amended protection requests.');
  }
  return { ok: true, code: 'EXECUTION_GATE_PASSED' };
}

export function beginSubmission(record, gate = {}, now = Date.now()) {
  if (!record || record.state !== EXECUTION_STATE.PREPARED) return fail('INVALID_SUBMISSION_STATE', 'Only a PREPARED intent can enter submission.');
  const gateResult = checkExecutionGate(gate);
  if (!gateResult.ok) return gateResult;
  if (!record.accountKey || String(record.accountKey) !== String(gate.activeAccountKey)) return fail('ACCOUNT_CONTEXT_MISMATCH', 'The active cTrader account does not match the account for which this intent was risk-checked. Rebuild the preview.');
  if (gate.noUnresolvedExecution !== true) return fail('UNRESOLVED_EXECUTION_EXISTS', 'Reconcile earlier execution before submitting another order.');
  return { ok: true, record: { ...record, state: EXECUTION_STATE.SUBMITTING, updatedAt: now } };
}

export function markRequestTransportError(record, error, now = Date.now()) {
  if (!record || ![EXECUTION_STATE.SUBMITTING, EXECUTION_STATE.ACCEPTED].includes(record.state)) {
    return fail('INVALID_TRANSPORT_ERROR_STATE', 'Transport errors can only be attached to an in-flight order.');
  }
  // A transport error does not prove the broker did not receive the request.
  return {
    ok: true,
    record: {
      ...record,
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      updatedAt: now,
      errorCode: 'REQUEST_OUTCOME_UNKNOWN',
      errorMessage: String(error?.message ?? error ?? 'SDK request transport failed; broker outcome is unknown.'),
      unresolved: true
    }
  };
}

export function markExecutionTimeout(record, now = Date.now()) {
  if (!record || ![EXECUTION_STATE.SUBMITTING, EXECUTION_STATE.ACCEPTED, EXECUTION_STATE.PROTECTION_UPDATE_PENDING].includes(record.state)) {
    return fail('INVALID_TIMEOUT_STATE', 'Timeout is not valid for the current execution state.');
  }
  const protectionPending = record.state === EXECUTION_STATE.PROTECTION_UPDATE_PENDING;
  return {
    ok: true,
    record: {
      ...record,
      state: protectionPending ? EXECUTION_STATE.PROTECTION_UNCONFIRMED : EXECUTION_STATE.RECONCILIATION_REQUIRED,
      updatedAt: now,
      errorCode: protectionPending ? 'PROTECTION_ACK_TIMEOUT' : 'ORDER_RESULT_TIMEOUT',
      errorMessage: protectionPending
        ? 'Protection modification was not confirmed. Do not assume new SL/TP is active.'
        : 'Order result is unknown. Do not retry; reconcile cTrader orders/positions by clientOrderId and orderId.',
      unresolved: true
    }
  };
}

function parseExecutionType(event) {
  const v = event?.executionType ?? event?.type;
  if (typeof v === 'string') return v.toUpperCase();
  const numeric = Number(v);
  return ({ 2: 'ORDER_ACCEPTED', 3: 'ORDER_FILLED', 4: 'ORDER_REPLACED', 5: 'ORDER_CANCELLED', 6: 'ORDER_EXPIRED', 7: 'ORDER_REJECTED', 8: 'ORDER_CANCEL_REJECTED', 11: 'ORDER_PARTIAL_FILL' })[numeric] ?? 'UNKNOWN';
}
function asId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}
function eventIds(event) {
  const order = event?.order;
  const position = event?.position;
  const deal = event?.deal;
  return {
    clientOrderId: order?.clientOrderId ?? order?.originalClientOrderId ?? event?.clientOrderId ?? null,
    orderId: asId(order?.orderId ?? event?.orderId),
    positionId: asId(position?.positionId ?? order?.positionId ?? deal?.positionId ?? event?.positionId),
    eventId: event?.eventId == null ? null : String(event.eventId)
  };
}
function matchesRecord(record, event) {
  const ids = eventIds(event);
  const sameClientId = ids.clientOrderId != null && String(ids.clientOrderId) === record.clientOrderId;
  const sameOrderId = record.orderId != null && ids.orderId != null && String(record.orderId) === ids.orderId;
  const samePositionId = record.positionId != null && ids.positionId != null && String(record.positionId) === ids.positionId;
  if (sameClientId || sameOrderId) return true;
  // Protection amendments can report an SL/TP child order with its own/no
  // clientOrderId; a matching position ID is the documented association.
  if (['ORDER_REPLACED', 'ORDER_REJECTED'].includes(parseExecutionType(event)) &&
      record.state === EXECUTION_STATE.PROTECTION_UPDATE_PENDING && samePositionId) return true;
  if (ids.clientOrderId != null && String(ids.clientOrderId) !== record.clientOrderId) return false;
  return samePositionId;
}
function sideFromProtocol(value) {
  if (value === 'BUY' || Number(value) === 1) return 'BUY';
  if (value === 'SELL' || Number(value) === 2) return 'SELL';
  return null;
}
function extractEventDetails(event) {
  const order = event?.order ?? {};
  const position = event?.position ?? {};
  const deal = event?.deal ?? {};
  const positionTradeData = position?.tradeData ?? {};
  const orderTradeData = order?.tradeData ?? {};
  const tradeData = event?.position ? positionTradeData : (orderTradeData ?? {});
  return {
    orderId: asId(order.orderId ?? event?.orderId),
    positionId: asId(position.positionId ?? order.positionId ?? deal.positionId ?? event?.positionId),
    dealId: asId(deal.dealId),
    dealPositionId: asId(deal.positionId),
    dealSymbolId: asId(deal.symbolId),
    dealSide: sideFromProtocol(deal.tradeSide),
    fillPrice: number(position.price ?? deal.executionPrice ?? order.executionPrice),
    positionEntryPrice: number(position.price),
    filledVolumeCents: number(order.executedVolume ?? positionTradeData.volume ?? deal.filledVolume ?? null),
    orderExecutedVolumeCents: number(order.executedVolume),
    dealFilledVolumeCents: number(deal.filledVolume),
    positionVolumeCents: number(positionTradeData.volume),
    hasPosition: !!event?.position && typeof event.position === 'object',
    positionStatus: position.positionStatus,
    positionStopLoss: number(position.stopLoss),
    positionTakeProfit: number(position.takeProfit),
    eventSide: sideFromProtocol(tradeData.tradeSide ?? deal.tradeSide),
    eventSymbolId: asId(tradeData.symbolId ?? deal.symbolId),
    serverStopLoss: number(position.stopLoss ?? order.stopLoss),
    serverTakeProfit: number(position.takeProfit ?? order.takeProfit),
    orderStatus: order.orderStatus,
    eventId: event?.eventId == null ? null : String(event.eventId)
  };
}
function seen(record, eventId) { return eventId != null && (record.seenEventIds ?? []).includes(eventId); }
function seenDeal(record, dealId) { return dealId != null && (record.seenDealIds ?? []).includes(dealId); }
function withEvent(record, eventId, dealId = null) {
  const next = { ...record };
  if (eventId != null) {
    const ids = [...(record.seenEventIds ?? []), eventId].slice(-128);
    next.seenEventIds = [...new Set(ids)];
  }
  if (dealId != null) {
    const ids = [...(record.seenDealIds ?? []), dealId].slice(-128);
    next.seenDealIds = [...new Set(ids)];
  }
  return next;
}
function manualState(record, code, message, details = {}) {
  return {
    ok: true,
    record: {
      ...record,
      ...details,
      state: EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION,
      updatedAt: details.updatedAt ?? Date.now(),
      protectionConfirmed: false,
      errorCode: code,
      errorMessage: message,
      unresolved: true
    },
    actions: [{ type: 'MANUAL_RECONCILIATION_REQUIRED', code, message }]
  };
}

function isOpenPositionStatus(value) {
  if (Number(value) === 1) return true;
  if (typeof value === 'string') return ['OPEN', 'POSITION_STATUS_OPEN'].includes(value.trim().toUpperCase());
  return false;
}
function nearlySameProtection(actual, expected, tolerance) {
  return closeEnough(actual, expected, tolerance);
}
function planRemainderCancellation(record, details, now = Date.now()) {
  const updated = { ...record, updatedAt: now };
  if (updated.orderFullyExecuted === true || updated.remainingOrderOpen === false) {
    return { record: updated, actions: [] };
  }
  // A cancel request is never retried automatically after it has been planned,
  // sent, rejected or become uncertain. Reconciliation must decide the next step.
  const status = updated.remainderCancelStatus;
  if (status && status !== 'NOT_REQUESTED') return { record: updated, actions: [] };
  const rawOrderId = details?.orderId ?? updated.orderId;
  const orderId = Number(rawOrderId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    updated.remainderCancelStatus = 'UNAVAILABLE';
    updated.remainingOrderOpen = true;
    updated.errorCode = 'PARTIAL_REMAINDER_ORDER_ID_MISSING';
    updated.errorMessage = 'A partial position exists but the original order ID is unavailable. The remaining order cannot be cancelled safely; reconcile manually.';
    return { record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  const cancelClientOrderId = `URM-CAN-${orderId}`;
  if (cancelClientOrderId.length > URM_EXECUTION_POLICY.clientOrderIdMaxLength) {
    updated.remainderCancelStatus = 'UNAVAILABLE';
    updated.remainingOrderOpen = true;
    updated.errorCode = 'CANCEL_CLIENT_ORDER_ID_INVALID';
    updated.errorMessage = 'A bounded cancellation request ID could not be generated; the remaining order must be reconciled manually.';
    return { record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  updated.orderId = String(orderId);
  updated.remainderCancelStatus = 'REQUEST_PLANNED';
  updated.cancelRequestOrderId = String(orderId);
  updated.cancelRequestClientOrderId = cancelClientOrderId;
  updated.remainingOrderOpen = true;
  return {
    record: updated,
    actions: [{
      type: 'CANCEL_REMAINDER_ORDER',
      params: { orderId, originalClientOrderId: updated.clientOrderId, clientOrderId: cancelClientOrderId,
        expectedExecutedVolumeCents: Number(details?.orderExecutedVolumeCents ?? updated.lastObservedExecutedVolumeCents ?? updated.filledVolumeCents) || null },
      reason: 'A partial fill leaves the original order remainder active. Cancel it once, reconcile the cancellation outcome, and never retry an uncertain cancel automatically.'
    }]
  };
}

function partialSnapshotFailure(record, details, now, code, message, { orderFullyExecuted = false } = {}) {
  let updated = {
    ...record,
    updatedAt: now,
    partialFillObserved: true,
    orderFullyExecuted,
    remainingOrderOpen: !orderFullyExecuted,
    state: EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION,
    protectionConfirmed: false,
    unresolved: true,
    errorCode: code,
    errorMessage: message,
    ...(details.orderId ? { orderId: details.orderId } : {}),
    ...(details.positionId ? { observedPositionId: details.positionId } : {})
  };
  let actions = [];
  if (!orderFullyExecuted) {
    const cancelPlan = planRemainderCancellation(updated, details, now);
    updated = cancelPlan.record;
    actions.push(...cancelPlan.actions);
  }
  actions.push({
    type: 'ALERT', severity: 'CRITICAL', code,
    message: `${message} Do not retry, do not start another trade, and inspect the cTrader position/order status and SL/TP manually.`
  });
  return { ok: true, matched: true, record: updated, actions };
}
function buildPositionProtectionPlan(record, details, { orderFullyExecuted = false } = {}) {
  if (!details.hasPosition) return fail('PARTIAL_POSITION_SNAPSHOT_MISSING', 'The execution event does not include a position snapshot.');
  if (!details.positionId || !isOpenPositionStatus(details.positionStatus)) {
    return fail('PARTIAL_POSITION_NOT_CONFIRMED_OPEN', 'A valid position ID and server-reported OPEN position status are required.');
  }
  if (!Number.isFinite(details.positionEntryPrice) || details.positionEntryPrice <= 0) {
    return fail('PARTIAL_POSITION_VWAP_MISSING', 'The server-reported position VWAP/entry price is required.');
  }
  if (!Number.isSafeInteger(details.positionVolumeCents) || details.positionVolumeCents <= 0) {
    return fail('PARTIAL_POSITION_VOLUME_MISSING', 'The server-reported position volume in protocol cents is required.');
  }
  if (!Number.isSafeInteger(details.orderExecutedVolumeCents) || details.orderExecutedVolumeCents <= 0) {
    return fail('CUMULATIVE_EXECUTED_VOLUME_MISSING', 'The order must report cumulative executed volume.');
  }
  if (details.eventSide && details.eventSide !== record.side) return fail('FILL_SIDE_MISMATCH', 'Position side does not match the approved order intent.');
  if (details.eventSymbolId && details.eventSymbolId !== String(record.symbolId)) return fail('FILL_SYMBOL_MISMATCH', 'Position symbol does not match the approved order intent.');
  if (details.dealPositionId && details.dealPositionId !== details.positionId) return fail('DEAL_POSITION_ID_MISMATCH', 'The deal refers to a different position ID from the position snapshot.');
  if (details.dealSymbolId && details.dealSymbolId !== String(record.symbolId)) return fail('DEAL_SYMBOL_MISMATCH', 'The deal symbol does not match the approved order intent.');
  if (details.dealSide && details.dealSide !== record.side) return fail('DEAL_SIDE_MISMATCH', 'The deal side does not match the approved order intent.');
  if (details.positionVolumeCents > record.requestedVolumeCents || details.orderExecutedVolumeCents > record.requestedVolumeCents) {
    return fail('PARTIAL_VOLUME_EXCEEDS_REQUEST', 'Server-reported executed/position volume exceeds the approved requested volume.');
  }
  if (details.positionVolumeCents !== details.orderExecutedVolumeCents) {
    return fail('POSITION_ORDER_VOLUME_MISMATCH', 'In a supported isolated position, the position volume must agree with this order’s cumulative executed volume.');
  }
  if (orderFullyExecuted && details.orderExecutedVolumeCents !== record.requestedVolumeCents) {
    return fail('FINAL_FILL_VOLUME_MISMATCH', 'ORDER_FILLED did not report the full approved requested volume.');
  }
  if (!orderFullyExecuted && details.orderExecutedVolumeCents >= record.requestedVolumeCents) {
    return fail('PARTIAL_EVENT_VOLUME_INCONSISTENT', 'ORDER_PARTIAL_FILL must report some remaining volume; its cumulative executed volume cannot equal the full request.');
  }
  const structuralSL = roundPrice(record.stopLossReference, record.digits);
  if ((record.side === 'BUY' && structuralSL >= details.positionEntryPrice) ||
      (record.side === 'SELL' && structuralSL <= details.positionEntryPrice)) {
    return fail('STRUCTURAL_SL_CROSSED_BY_FILL', 'The fixed structural SL is no longer on the protective side of the server-reported position VWAP.');
  }
  if (!Number.isFinite(record.estimatedRDistance) || record.estimatedRDistance <= 0 ||
      !Number.isFinite(record.estimatedRiskUsdAtPreview) || record.estimatedRiskUsdAtPreview <= 0) {
    return fail('ORIGINAL_RISK_ANCHOR_INVALID', 'The immutable preview risk anchor is missing or invalid.');
  }
  const tolerance = Math.max(10 ** -record.digits * URM_EXECUTION_POLICY.minimumPriceToleranceFactor, 1e-10);
  const serverSL = Number.isFinite(details.positionStopLoss) && details.positionStopLoss > 0 ? details.positionStopLoss : null;
  const serverTP = Number.isFinite(details.positionTakeProfit) && details.positionTakeProfit > 0 ? details.positionTakeProfit : null;
  // Never loosen an already more-protective server SL while aligning the structural SL.
  const targetSL = serverSL == null ? structuralSL : (record.side === 'BUY'
    ? Math.max(structuralSL, serverSL)
    : Math.min(structuralSL, serverSL));
  const actualRDistance = Math.abs(details.positionEntryPrice - structuralSL);
  const expectedTP = roundPrice(details.positionEntryPrice + (record.side === 'BUY' ? 1 : -1) * actualRDistance * record.takeProfitR, record.digits);
  if (!Number.isFinite(targetSL) || targetSL <= 0 || !Number.isFinite(expectedTP) || expectedTP <= 0) {
    return fail('POSITION_PROTECTION_TARGET_INVALID', 'The absolute SL/TP targets could not be calculated safely.');
  }
  if ((record.side === 'BUY' && targetSL >= expectedTP) || (record.side === 'SELL' && targetSL <= expectedTP)) {
    return fail('POSITION_PROTECTION_TARGETS_CROSS', 'The current protective SL and fill-anchored TP would cross; manual reconciliation is required.');
  }
  const riskAtRequestedVolume = record.estimatedRiskUsdAtPreview * (actualRDistance / record.estimatedRDistance);
  const riskAtCurrentVolume = riskAtRequestedVolume * (details.positionVolumeCents / record.requestedVolumeCents);
  const riskExceeded = riskAtRequestedVolume > record.targetRiskUsd + 0.01;
  const currentProtectionMatches = serverSL != null && serverTP != null &&
    nearlySameProtection(serverSL, targetSL, tolerance) && nearlySameProtection(serverTP, expectedTP, tolerance);
  return {
    ok: true,
    positionId: details.positionId,
    orderId: details.orderId,
    positionEntryPrice: details.positionEntryPrice,
    positionVolumeCents: details.positionVolumeCents,
    cumulativeExecutedVolumeCents: details.orderExecutedVolumeCents,
    structuralSL,
    targetSL,
    targetTP: expectedTP,
    actualRDistance,
    riskAtRequestedVolume,
    riskAtCurrentVolume,
    riskExceeded,
    serverSL,
    serverTP,
    serverProtectionComplete: serverSL != null && serverTP != null,
    currentProtectionMatches,
    tolerance,
    dealId: details.dealId
  };
}
function partialOrFinalFillSnapshot(record, details, now, { orderFullyExecuted = false } = {}) {
  const plan = buildPositionProtectionPlan(record, details, { orderFullyExecuted });
  if (!plan.ok) return partialSnapshotFailure(record, details, now, plan.code, plan.reason, { orderFullyExecuted });

  // Ignore late older partial-fill snapshots so position VWAP/volume cannot regress.
  const previousCumulative = Number(record.lastObservedExecutedVolumeCents ?? 0);
  if (!orderFullyExecuted && previousCumulative > 0 && plan.cumulativeExecutedVolumeCents <= previousCumulative) {
    return { ok: true, matched: true, ignoredAsStale: true, record: { ...record, updatedAt: now }, actions: [] };
  }
  if (!orderFullyExecuted && record.orderFullyExecuted === true) {
    return { ok: true, matched: true, ignoredAsStale: true, record, actions: [] };
  }

  const version = Number(record.protectionTargetVersion ?? 0) + 1;
  let updated = {
    ...record,
    updatedAt: now,
    orderId: plan.orderId ?? record.orderId,
    positionId: plan.positionId,
    fillPrice: plan.positionEntryPrice,
    actualRDistance: plan.actualRDistance,
    filledVolumeCents: plan.positionVolumeCents,
    lastObservedExecutedVolumeCents: plan.cumulativeExecutedVolumeCents,
    partialFillObserved: true,
    orderFullyExecuted,
    remainingOrderOpen: !orderFullyExecuted,
    ...(orderFullyExecuted ? {
      remainderCancelStatus: 'SUPERSEDED_BY_FILL',
      cancelVolumeReconciled: true
    } : {}),
    estimatedRiskUsdAtFill: plan.riskAtCurrentVolume,
    projectedRiskUsdAtRequestedVolume: plan.riskAtRequestedVolume,
    fillRiskBudgetExceeded: plan.riskExceeded,
    riskWarning: plan.riskExceeded
      ? 'Projected price-risk at the originally requested volume exceeds the $10 target after the observed fill/VWAP. The remaining order may increase exposure; inspect immediately.'
      : null,
    expectedAbsoluteStopLoss: plan.targetSL,
    expectedAbsoluteTakeProfit: plan.targetTP,
    protectionTolerance: plan.tolerance,
    protectionTargetVersion: version,
    lastObservedServerStopLoss: plan.serverSL,
    lastObservedServerTakeProfit: plan.serverTP,
    errorCode: null,
    errorMessage: null,
    unresolved: true
  };

  const existingPending = record.state === EXECUTION_STATE.PROTECTION_UPDATE_PENDING && record.inFlightProtection;
  const protectionOutcomeUncertain = [EXECUTION_STATE.PROTECTION_UNCONFIRMED, EXECUTION_STATE.PROTECTION_FAILED,
    EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED].includes(record.state);
  if (protectionOutcomeUncertain && !existingPending) {
    return partialSnapshotFailure(record, details, now, 'PRIOR_PROTECTION_OUTCOME_UNRESOLVED',
      'A prior protection operation failed or has an unknown outcome. A later fill event is not sufficient authority to retry protection automatically.',
      { orderFullyExecuted });
  }
  const actions = [];
  if (plan.riskExceeded && record.riskWarningActive !== true) {
    actions.push({
      type: 'ALERT', severity: 'HIGH', code: 'PROJECTED_PRICE_RISK_OVER_TARGET',
      message: updated.riskWarning,
      estimatedCurrentPositionRiskUsd: plan.riskAtCurrentVolume,
      projectedRiskUsdAtRequestedVolume: plan.riskAtRequestedVolume,
      targetRiskUsd: record.targetRiskUsd
    });
  }
  if (!plan.serverProtectionComplete) {
    actions.push({
      type: 'ALERT', severity: 'CRITICAL', code: 'PARTIAL_POSITION_PROTECTION_NOT_CONFIRMED',
      message: 'The partial/final fill snapshot does not show both valid server-side SL and TP. An immediate protection request may be attempted, but the position is NOT considered protected until cTrader confirms exact server values. Inspect the chart immediately.'
    });
  }

  if (existingPending) {
    const oldTarget = record.inFlightProtection;
    const targetChanged = !nearlySameProtection(oldTarget.stopLoss, plan.targetSL, plan.tolerance) ||
      !nearlySameProtection(oldTarget.takeProfit, plan.targetTP, plan.tolerance);
    Object.assign(updated, {
      state: EXECUTION_STATE.PROTECTION_UPDATE_PENDING,
      inFlightProtection: oldTarget,
      protectionPurpose: orderFullyExecuted ? 'FINAL_FILL' : 'PARTIAL_FILL',
      pendingProtectionRefresh: targetChanged,
      protectionConfirmed: false
    });
    if (targetChanged) actions.push({
      type: 'ALERT', severity: 'HIGH', code: 'PROTECTION_TARGET_CHANGED_DURING_INFLIGHT_UPDATE',
      message: 'A newer fill changed the desired VWAP-based TP while a prior protection request is still in flight. No second request was sent concurrently; the latest target will be applied only after the in-flight response is reconciled.'
    });
    if (plan.riskExceeded) updated.riskWarningActive = true;
    if (!orderFullyExecuted) {
      const cancelPlan = planRemainderCancellation(updated, details, now);
      updated = cancelPlan.record;
      actions.push(...cancelPlan.actions);
    }
    return { ok: true, matched: true, record: updated, actions };
  }

  if (plan.currentProtectionMatches) {
    const remainderTerminal = orderFullyExecuted || (updated.remainingOrderOpen === false &&
      updated.remainderCancelStatus === 'CANCELLED' && updated.cancelVolumeReconciled === true);
    Object.assign(updated, {
      state: remainderTerminal ? EXECUTION_STATE.PROTECTED : EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING,
      lastConfirmedStopLoss: plan.serverSL,
      lastConfirmedTakeProfit: plan.serverTP,
      inFlightProtection: null,
      protectionPurpose: null,
      pendingProtectionRefresh: false,
      protectionConfirmed: true,
      unresolved: !remainderTerminal
    });
    if (!remainderTerminal) actions.push({
      type: 'PARTIAL_POSITION_PROTECTED_REMAINDER_PENDING', severity: 'INFO',
      positionId: Number(plan.positionId), volumeCents: plan.positionVolumeCents,
      message: 'The current partial position protection matches the calculated target, but the order remainder is still unresolved. Do not submit another entry until the order is terminally reconciled.'
    });
    else actions.push({
      type: 'PROTECTION_CONFIRMED', positionId: Number(plan.positionId),
      stopLoss: plan.serverSL, takeProfit: plan.serverTP
    });
  } else {
    Object.assign(updated, {
      state: EXECUTION_STATE.PROTECTION_UPDATE_PENDING,
      inFlightProtection: { stopLoss: plan.targetSL, takeProfit: plan.targetTP, targetVersion: version },
      protectionPurpose: orderFullyExecuted ? 'FINAL_FILL' : 'PARTIAL_FILL',
      pendingProtectionRefresh: false,
      protectionConfirmed: false,
      unresolved: true
    });
    actions.push({
      type: 'MODIFY_POSITION_PROTECTION',
      params: { positionId: Number(plan.positionId), stopLoss: plan.targetSL, takeProfit: plan.targetTP,
        ...(record.guaranteedStopLoss === true ? { guaranteedStopLoss: true } : {}) },
      reason: orderFullyExecuted
        ? 'Final fill snapshot: align absolute structural SL and actual VWAP-anchored 5R TP; require server confirmation.'
        : 'Partial fill snapshot: protect the confirmed open partial position immediately, then reconcile the remaining order separately.'
    });
  }
  if (plan.riskExceeded) updated.riskWarningActive = true;
  if (!orderFullyExecuted) {
    const cancelPlan = planRemainderCancellation(updated, details, now);
    updated = cancelPlan.record;
    actions.push(...cancelPlan.actions);
  }
  return { ok: true, matched: true, record: updated, actions };
}

function handlePartialProtectionAcknowledgement(record, details, now) {
  const updated = { ...record, updatedAt: now };
  if (!details.positionId || String(details.positionId) !== String(updated.positionId) || !details.hasPosition ||
      !isOpenPositionStatus(details.positionStatus) ||
      (details.eventSide && details.eventSide !== updated.side) ||
      (details.eventSymbolId && details.eventSymbolId !== String(updated.symbolId))) {
    updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'PARTIAL_PROTECTION_ACK_POSITION_MISMATCH';
    updated.errorMessage = 'Protection response did not include the exact expected server position. Current protection remains unconfirmed.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  if (!Number.isSafeInteger(details.positionVolumeCents) || details.positionVolumeCents !== updated.filledVolumeCents) {
    updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'PARTIAL_PROTECTION_ACK_VOLUME_STALE';
    updated.errorMessage = 'Protection acknowledgement position volume does not match the latest observed partial/final volume. A stale server snapshot cannot confirm the current position protection.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  if (!Number.isFinite(details.positionStopLoss) || details.positionStopLoss <= 0 ||
      !Number.isFinite(details.positionTakeProfit) || details.positionTakeProfit <= 0) {
    updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'PARTIAL_PROTECTION_ACK_VALUES_MISSING';
    updated.errorMessage = 'Protection response omitted the actual server SL or TP; protection is not confirmed.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  const tol = updated.protectionTolerance ?? 1e-8;
  const inFlight = updated.inFlightProtection ?? {
    stopLoss: updated.expectedAbsoluteStopLoss,
    takeProfit: updated.expectedAbsoluteTakeProfit
  };
  const matchesLatest = nearlySameProtection(details.positionStopLoss, updated.expectedAbsoluteStopLoss, tol) &&
    nearlySameProtection(details.positionTakeProfit, updated.expectedAbsoluteTakeProfit, tol);
  const matchesInFlight = nearlySameProtection(details.positionStopLoss, inFlight.stopLoss, tol) &&
    nearlySameProtection(details.positionTakeProfit, inFlight.takeProfit, tol);
  if (matchesLatest) {
    updated.lastConfirmedStopLoss = details.positionStopLoss;
    updated.lastConfirmedTakeProfit = details.positionTakeProfit;
    updated.inFlightProtection = null;
    updated.protectionPurpose = null;
    updated.pendingProtectionRefresh = false;
    updated.protectionConfirmed = true;
    updated.errorCode = null;
    updated.errorMessage = null;
    const remainderTerminal = updated.orderFullyExecuted === true || (updated.remainingOrderOpen === false &&
      updated.remainderCancelStatus === 'CANCELLED' && updated.cancelVolumeReconciled === true);
    updated.state = remainderTerminal ? EXECUTION_STATE.PROTECTED : EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING;
    updated.unresolved = !remainderTerminal;
    const action = remainderTerminal
      ? { type: 'PROTECTION_CONFIRMED', positionId: Number(updated.positionId), stopLoss: details.positionStopLoss, takeProfit: details.positionTakeProfit }
      : { type: 'PARTIAL_POSITION_PROTECTED_REMAINDER_PENDING', severity: 'INFO', positionId: Number(updated.positionId),
          message: 'The partial position is protected, but the remaining order has not yet been terminally reconciled.' };
    return { ok: true, matched: true, record: updated, actions: [action] };
  }
  if (matchesInFlight && updated.pendingProtectionRefresh === true) {
    updated.lastConfirmedStopLoss = details.positionStopLoss;
    updated.lastConfirmedTakeProfit = details.positionTakeProfit;
    const targetVersion = updated.protectionTargetVersion;
    updated.inFlightProtection = {
      stopLoss: updated.expectedAbsoluteStopLoss,
      takeProfit: updated.expectedAbsoluteTakeProfit,
      targetVersion
    };
    updated.protectionPurpose = updated.orderFullyExecuted === true ? 'FINAL_FILL' : 'PARTIAL_FILL';
    updated.pendingProtectionRefresh = false;
    updated.protectionConfirmed = false;
    updated.state = EXECUTION_STATE.PROTECTION_UPDATE_PENDING;
    updated.unresolved = true;
    return {
      ok: true, matched: true, record: updated,
      actions: [{
        type: 'MODIFY_POSITION_PROTECTION',
        params: { positionId: Number(updated.positionId), stopLoss: updated.expectedAbsoluteStopLoss,
          takeProfit: updated.expectedAbsoluteTakeProfit,
          ...(updated.guaranteedStopLoss === true ? { guaranteedStopLoss: true } : {}) },
        reason: 'The prior protection request was confirmed, but a later fill changed the desired target. Applying the newest target sequentially; no overlapping request was sent.'
      }]
    };
  }
  updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
  updated.protectionConfirmed = false;
  updated.unresolved = true;
  updated.lastObservedServerStopLoss = details.positionStopLoss;
  updated.lastObservedServerTakeProfit = details.positionTakeProfit;
  updated.errorCode = 'PARTIAL_PROTECTION_ACK_MISMATCH';
  updated.errorMessage = 'Server protection matches neither the current target nor the in-flight request. Stop automatic modifications and reconcile manually.';
  return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
}

function unresolvedPartialRemainderState(record) {
  const updated = { ...record, unresolved: true };
  if (updated.partialFillObserved === true && updated.orderFullyExecuted !== true && updated.remainingOrderOpen !== false &&
      updated.state === EXECUTION_STATE.PROTECTED) {
    updated.state = EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING;
  }
  return updated;
}

function applyRemainderCancellationConfirmed(record, details, now) {
  const updated = { ...record, updatedAt: now, remainingOrderOpen: false };
  if (record.orderFullyExecuted === true) {
    updated.remainderCancelStatus = 'SUPERSEDED_BY_FILL';
    updated.cancelVolumeReconciled = true;
    return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
  }
  if (!details.orderId || String(details.orderId) !== String(record.orderId)) {
    updated.remainderCancelStatus = 'CANCEL_IDENTITY_MISMATCH';
    updated.remainingOrderOpen = true;
    updated.cancelVolumeReconciled = false;
    updated.state = EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'CANCEL_ACK_ORDER_ID_MISMATCH';
    updated.errorMessage = 'Cancellation event did not identify the exact original order ID. Do not infer that this order remainder was cancelled.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }

  const observedVolume = Number(record.lastObservedExecutedVolumeCents ?? record.filledVolumeCents);
  const cancelEventVolume = Number(details.orderExecutedVolumeCents);
  if (!Number.isSafeInteger(observedVolume) || observedVolume <= 0 ||
      !Number.isSafeInteger(cancelEventVolume) || cancelEventVolume !== observedVolume) {
    updated.remainderCancelStatus = 'CANCELLED_VOLUME_MISMATCH';
    updated.cancelVolumeReconciled = false;
    updated.state = EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'CANCEL_REMAINDER_VOLUME_MISMATCH';
    updated.errorMessage = 'The cancellation event cumulative executed volume does not match the last protected/observed volume. A fill may have raced the cancel; reconcile the live position and protection manually.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }

  updated.remainderCancelStatus = 'CANCELLED';
  updated.cancelVolumeReconciled = true;
  updated.cancelConfirmedAt = now;
  updated.remainingOrderOpen = false;

  // A cancellation event without a current OPEN position snapshot is not enough
  // to prove the position still exists and retains the expected server protection.
  if (!details.hasPosition || !details.positionId || String(details.positionId) !== String(updated.positionId) ||
      !isOpenPositionStatus(details.positionStatus) ||
      !Number.isSafeInteger(details.positionVolumeCents) || details.positionVolumeCents !== observedVolume ||
      details.eventSide !== updated.side || details.eventSymbolId !== String(updated.symbolId)) {
    if (updated.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING || !updated.inFlightProtection) {
      updated.state = EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED;
    }
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'CANCEL_ACK_POSITION_RECONCILIATION_REQUIRED';
    updated.errorMessage = 'The order remainder is cancelled, but the cancellation event lacks an exact current OPEN position snapshot with matching volume, side and symbol. A separately in-flight protection request may still reconcile it; otherwise use manual position reconciliation before allowing another entry.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }

  const tol = updated.protectionTolerance ?? 1e-8;
  const targetMatches = Number.isFinite(details.positionStopLoss) && Number.isFinite(details.positionTakeProfit) &&
    closeEnough(details.positionStopLoss, updated.expectedAbsoluteStopLoss, tol) &&
    closeEnough(details.positionTakeProfit, updated.expectedAbsoluteTakeProfit, tol);
  const inFlightIsSameTarget = !updated.inFlightProtection ||
    (closeEnough(updated.inFlightProtection.stopLoss, updated.expectedAbsoluteStopLoss, tol) &&
     closeEnough(updated.inFlightProtection.takeProfit, updated.expectedAbsoluteTakeProfit, tol));
  if (targetMatches && inFlightIsSameTarget) {
    updated.lastConfirmedStopLoss = details.positionStopLoss;
    updated.lastConfirmedTakeProfit = details.positionTakeProfit;
    updated.protectionConfirmed = true;
    updated.inFlightProtection = null;
    updated.protectionPurpose = null;
    updated.pendingProtectionRefresh = false;
    updated.state = EXECUTION_STATE.PROTECTED;
    updated.unresolved = false;
    updated.errorCode = null;
    updated.errorMessage = null;
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ORDER_REMAINDER_CANCELLED', severity: 'INFO', positionId: Number(updated.positionId), message: 'The remaining order is cancelled and the current partial position volume plus server-side SL/TP have been reconciled.' }] };
  }

  updated.protectionConfirmed = false;
  updated.unresolved = true;
  if (updated.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING) {
    updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
  }
  updated.errorCode = 'CANCEL_ACK_PROTECTION_NOT_CONFIRMED';
  updated.errorMessage = 'The remainder is cancelled, but current server SL/TP do not match the latest target or a different protection request remains in flight. Do not enable new entries until reconciled.';
  return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
}

function applyRemainderCancellationRejected(record, details, now) {
  const updated = { ...record, updatedAt: now };
  if (record.orderFullyExecuted === true) {
    updated.remainderCancelStatus = 'SUPERSEDED_BY_FILL';
    updated.remainingOrderOpen = false;
    updated.cancelVolumeReconciled = true;
    return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
  }
  if (!details.orderId || String(details.orderId) !== String(record.orderId)) {
    updated.remainderCancelStatus = 'CANCEL_IDENTITY_MISMATCH';
    updated.remainingOrderOpen = true;
    updated.cancelVolumeReconciled = false;
    updated.state = EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION;
    updated.protectionConfirmed = false;
    updated.unresolved = true;
    updated.errorCode = 'CANCEL_REJECT_ORDER_ID_MISMATCH';
    updated.errorMessage = 'Cancellation rejection did not identify the exact original order ID. Keep the remainder unresolved and inspect the live order manually.';
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
  }
  if (record.remainderCancelStatus === 'CANCELLED' && record.cancelVolumeReconciled === true) {
    return { ok: true, matched: true, ignoredAsStale: true, record, actions: [] };
  }
  updated.remainderCancelStatus = 'CANCEL_REJECTED';
  updated.remainingOrderOpen = true;
  updated.cancelVolumeReconciled = false;
  updated.unresolved = true;
  if (updated.protectionConfirmed === true && updated.state === EXECUTION_STATE.PROTECTED) {
    updated.state = EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING;
  }
  updated.errorCode = 'REMAINDER_CANCEL_REJECTED';
  updated.errorMessage = 'cTrader rejected the remainder-cancel request or the order is already being processed. Do not retry automatically; reconcile the remaining order and all position fills.';
  return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage, orderId: details.orderId }] };
}

/**
 * Route a cTrader ProtoExecutionEvent into the matching request record. The
 * event must correlate by exact clientOrderId or an already known order/position
 * ID; matching by symbol, side or price alone is explicitly forbidden.
 */
export function applyExecutionEvent(record, event, now = Date.now()) {
  if (!record || !event || typeof event !== 'object') return fail('EVENT_INPUT_INVALID', 'A record and execution event are required.');
  if (!matchesRecord(record, event)) return { ok: true, matched: false, record, actions: [] };

  const ids = eventIds(event);
  const type = parseExecutionType(event);
  const details = extractEventDetails(event);
  if (seen(record, ids.eventId) || (type === 'ORDER_PARTIAL_FILL' && seenDeal(record, details.dealId))) {
    return { ok: true, matched: true, duplicate: true, record, actions: [] };
  }
  let updated = withEvent({ ...record, updatedAt: now }, ids.eventId, type === 'ORDER_PARTIAL_FILL' ? details.dealId : null);
  if (details.orderId && !updated.orderId) updated.orderId = details.orderId;
  if (details.positionId && !updated.positionId) updated.positionId = details.positionId;

  // Never regress a later state if an earlier ACCEPTED event arrives out of order.
  if (type === 'ORDER_ACCEPTED') {
    if ([EXECUTION_STATE.PROTECTION_UPDATE_PENDING, EXECUTION_STATE.PROTECTED,
      EXECUTION_STATE.PROTECTION_UNCONFIRMED, EXECUTION_STATE.PROTECTION_FAILED,
      EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION, EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION,
      EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING, EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED].includes(updated.state)) {
      return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    }
    if ([EXECUTION_STATE.REJECTED, EXECUTION_STATE.CLOSED].includes(updated.state)) return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    updated.state = EXECUTION_STATE.ACCEPTED;
    updated.unresolved = true;
    return { ok: true, matched: true, record: updated, actions: [] };
  }

  if (type === 'ORDER_REJECTED') {
    if ([EXECUTION_STATE.PROTECTED, EXECUTION_STATE.REJECTED, EXECUTION_STATE.CLOSED,
      EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION].includes(updated.state)) {
      return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    }
    const postFillOrUncertainStates = [
      EXECUTION_STATE.PROTECTION_UPDATE_PENDING,
      EXECUTION_STATE.PROTECTION_UNCONFIRMED,
      EXECUTION_STATE.PROTECTION_FAILED,
      EXECUTION_STATE.PARTIAL_FILL_REQUIRES_RECONCILIATION,
      EXECUTION_STATE.FILL_REQUIRES_RECONCILIATION,
      EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED,
      EXECUTION_STATE.RECONCILIATION_REQUIRED,
      EXECUTION_STATE.OUTCOME_UNKNOWN
    ];
    if (updated.positionId || postFillOrUncertainStates.includes(updated.state)) {
      // Once a fill/position may exist, a late rejection cannot prove that the
      // exposure is gone. Never clear unresolved state or relabel it as safely rejected.
      updated.state = updated.positionId ? EXECUTION_STATE.PROTECTION_FAILED : EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION;
      updated.protectionConfirmed = false;
      updated.errorCode = event.errorCode ?? 'POST_FILL_REJECTION_REQUIRES_RECONCILIATION';
      updated.errorMessage = 'A rejection event arrived after a fill or while order outcome/protection was uncertain. Do not assume the position is closed; reconcile live exposure and server-side SL/TP immediately.';
      updated.unresolved = true;
      return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
    }
    updated.state = EXECUTION_STATE.REJECTED;
    updated.errorCode = event.errorCode ?? 'ORDER_REJECTED';
    updated.errorMessage = event.description ?? 'cTrader reported that this order was rejected.';
    updated.unresolved = false;
    return { ok: true, matched: true, record: updated, actions: [] };
  }

  if (record.partialFillObserved === true && record.remainderCancelStatus === 'CANCELLED' &&
      record.cancelVolumeReconciled === true && record.orderFullyExecuted !== true &&
      ['ORDER_PARTIAL_FILL', 'ORDER_FILLED'].includes(type)) {
    return manualState(updated, 'FILL_EVENT_AFTER_CANCEL_CONFIRMATION',
      'A new fill event arrived after the remaining order had been cancelled and its cumulative volume reconciled. This event ordering contradicts the terminal cancel snapshot; stop automation and reconcile current order, position volume and SL/TP manually.',
      { orderId: details.orderId ?? updated.orderId, positionId: details.positionId ?? updated.positionId,
        fillPrice: details.fillPrice ?? updated.fillPrice, filledVolumeCents: details.filledVolumeCents ?? updated.filledVolumeCents,
        remainderCancelStatus: 'CANCELLED_VOLUME_MISMATCH', cancelVolumeReconciled: false, remainingOrderOpen: false });
  }

  if (type === 'ORDER_PARTIAL_FILL') {
    if (record.orderFullyExecuted === true || [EXECUTION_STATE.PROTECTED, EXECUTION_STATE.CLOSED, EXECUTION_STATE.REJECTED].includes(record.state)) {
      return { ok: true, matched: true, ignoredAsStale: true, record, actions: [] };
    }
    return partialOrFinalFillSnapshot(updated, details, now, { orderFullyExecuted: false });
  }

  if (type === 'ORDER_FILLED' && record.partialFillObserved === true) {
    if ([EXECUTION_STATE.PROTECTED, EXECUTION_STATE.CLOSED, EXECUTION_STATE.REJECTED].includes(record.state) && record.orderFullyExecuted === true) {
      return { ok: true, matched: true, ignoredAsStale: true, record, actions: [] };
    }
    // A final event after partial fills must carry a fresh, full position snapshot.
    // Without it we cannot compute the final VWAP-based TP or verify total volume.
    return partialOrFinalFillSnapshot(updated, details, now, { orderFullyExecuted: true });
  }

  if (type === 'ORDER_FILLED') {
    if ([EXECUTION_STATE.PROTECTION_UPDATE_PENDING, EXECUTION_STATE.PROTECTED,
      EXECUTION_STATE.PROTECTION_UNCONFIRMED, EXECUTION_STATE.PROTECTION_FAILED,
      EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION, EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING].includes(updated.state)) {
      return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    }
    if ([EXECUTION_STATE.REJECTED, EXECUTION_STATE.CLOSED].includes(updated.state)) return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    if (details.eventSide && details.eventSide !== updated.side) {
      return manualState(updated, 'FILL_SIDE_MISMATCH', 'Filled event side does not match the approved order intent.', { orderId: details.orderId, positionId: details.positionId });
    }
    if (details.eventSymbolId && details.eventSymbolId !== String(updated.symbolId)) {
      return manualState(updated, 'FILL_SYMBOL_MISMATCH', 'Filled event symbol does not match the approved order intent.', { orderId: details.orderId, positionId: details.positionId });
    }
    if (!details.positionId || !Number.isFinite(details.fillPrice) || details.fillPrice <= 0) {
      updated.state = EXECUTION_STATE.FILL_REQUIRES_RECONCILIATION;
      updated.errorCode = 'FILL_DATA_INCOMPLETE';
      updated.errorMessage = 'Fill event lacks a reliable position ID or execution price; retrieve the current position before protection can be confirmed.';
      updated.unresolved = true;
      return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
    }
    if (details.filledVolumeCents && details.filledVolumeCents > updated.requestedVolumeCents) {
      return manualState(updated, 'FILLED_VOLUME_EXCEEDS_REQUEST', 'Reported filled volume exceeds the approved requested volume.', { orderId: details.orderId, positionId: details.positionId, fillPrice: details.fillPrice, filledVolumeCents: details.filledVolumeCents });
    }

    const structuralSL = roundPrice(updated.stopLossReference, updated.digits);
    const validStructuralSL = updated.side === 'BUY' ? structuralSL < details.fillPrice : structuralSL > details.fillPrice;
    if (!validStructuralSL) {
      return manualState(updated, 'STRUCTURAL_SL_CROSSED_BY_FILL', 'Actual fill is at or beyond the structural SL. Do not silently move the risk anchor or re-price the intended trade.', {
        orderId: details.orderId, positionId: details.positionId, fillPrice: details.fillPrice,
        filledVolumeCents: details.filledVolumeCents ?? null,
        serverStopLoss: Number.isFinite(details.serverStopLoss) ? details.serverStopLoss : null,
        serverTakeProfit: Number.isFinite(details.serverTakeProfit) ? details.serverTakeProfit : null
      });
    }

    const actualRDistance = Math.abs(details.fillPrice - structuralSL);
    const expectedTP = roundPrice(details.fillPrice + (updated.side === 'BUY' ? 1 : -1) * actualRDistance * updated.takeProfitR, updated.digits);
    const estimatedRiskUsdAtFill = Number.isFinite(updated.estimatedRiskUsdAtPreview) && updated.estimatedRDistance > 0
      ? updated.estimatedRiskUsdAtPreview * (actualRDistance / updated.estimatedRDistance) : null;
    const fillRiskBudgetExceeded = Number.isFinite(estimatedRiskUsdAtFill) &&
      estimatedRiskUsdAtFill > updated.targetRiskUsd + 0.01;
    if (!Number.isFinite(expectedTP) || expectedTP <= 0) {
      return manualState(updated, 'FILL_TP_INVALID', 'The fill-anchored 5R target could not be calculated safely.', { orderId: details.orderId, positionId: details.positionId, fillPrice: details.fillPrice });
    }
    updated = {
      ...updated,
      state: EXECUTION_STATE.PROTECTION_UPDATE_PENDING,
      orderId: details.orderId ?? updated.orderId,
      positionId: details.positionId,
      fillPrice: details.fillPrice,
      filledVolumeCents: details.filledVolumeCents ?? updated.requestedVolumeCents,
      actualRDistance,
      estimatedRiskUsdAtFill,
      fillRiskBudgetExceeded,
      riskWarning: fillRiskBudgetExceeded
        ? 'Estimated price risk exceeds the $10 target after the actual fill/slippage. Structural SL will still be applied; inspect and decide manually.'
        : null,
      expectedAbsoluteStopLoss: structuralSL,
      expectedAbsoluteTakeProfit: expectedTP,
      protectionTolerance: Math.max(10 ** -updated.digits * URM_EXECUTION_POLICY.minimumPriceToleranceFactor, 1e-10),
      orderFullyExecuted: true,
      remainingOrderOpen: false,
      protectionTargetVersion: Number(updated.protectionTargetVersion ?? 0) + 1,
      inFlightProtection: { stopLoss: structuralSL, takeProfit: expectedTP, targetVersion: Number(updated.protectionTargetVersion ?? 0) + 1 },
      protectionPurpose: 'FINAL_FILL',
      pendingProtectionRefresh: false,
      errorCode: null,
      errorMessage: null,
      protectionConfirmed: false,
      unresolved: true
    };
    const actions = [{
      type: 'MODIFY_POSITION_PROTECTION',
      params: { positionId: Number(details.positionId), stopLoss: structuralSL, takeProfit: expectedTP, ...(updated.guaranteedStopLoss === true ? { guaranteedStopLoss: true } : {}) },
      reason: 'After fill, align the server protection to the fixed structural SL and actual-fill 5R TP; await server acknowledgement plus returned position values.'
    }];
    if (fillRiskBudgetExceeded) actions.push({
      type: 'ALERT', severity: 'HIGH', code: 'ACTUAL_FILL_RISK_OVER_TARGET',
      message: updated.riskWarning, estimatedRiskUsd: estimatedRiskUsdAtFill, targetRiskUsd: updated.targetRiskUsd
    });
    return { ok: true, matched: true, record: updated, actions };
  }

  if (type === 'ORDER_REPLACED') {
    if (updated.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING) {
      return { ok: true, matched: true, ignoredAsUnrelatedAmendment: true, record: updated, actions: [] };
    }
    if (!details.positionId || String(details.positionId) !== String(updated.positionId)) {
      return { ok: true, matched: true, ignoredAsUnrelatedAmendment: true, record: updated, actions: [] };
    }
    if (updated.partialFillObserved === true) return handlePartialProtectionAcknowledgement(updated, details, now);
    // Only the actual ProtoPosition values count as protection confirmation;
    // order-child fields are not sufficient evidence that the live position changed.
    const validOpenPositionSnapshot = details.hasPosition && isOpenPositionStatus(details.positionStatus) &&
      Number.isSafeInteger(details.positionVolumeCents) && details.positionVolumeCents === updated.filledVolumeCents &&
      (!details.eventSide || details.eventSide === updated.side) &&
      (!details.eventSymbolId || details.eventSymbolId === String(updated.symbolId));
    const hasServerSL = validOpenPositionSnapshot && Number.isFinite(details.positionStopLoss) && details.positionStopLoss > 0;
    const hasServerTP = validOpenPositionSnapshot && Number.isFinite(details.positionTakeProfit) && details.positionTakeProfit > 0;
    if (!hasServerSL || !hasServerTP) {
      updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
      updated.errorCode = 'PROTECTION_VALUES_MISSING';
      updated.errorMessage = 'Amendment event did not include both server-reported SL and TP values. Protection cannot be declared confirmed.';
      updated.unresolved = true;
      return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
    }
    const tol = updated.protectionTolerance ?? 1e-8;
    if (!closeEnough(details.positionStopLoss, updated.expectedAbsoluteStopLoss, tol) ||
        !closeEnough(details.positionTakeProfit, updated.expectedAbsoluteTakeProfit, tol)) {
      updated.state = EXECUTION_STATE.PROTECTION_UNCONFIRMED;
      updated.lastConfirmedStopLoss = details.positionStopLoss;
      updated.lastConfirmedTakeProfit = details.positionTakeProfit;
      updated.errorCode = 'PROTECTION_VALUE_MISMATCH';
      updated.errorMessage = 'Server-reported protection does not match the requested structural SL and actual-fill 5R TP.';
      updated.unresolved = true;
      return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }] };
    }
    updated.state = EXECUTION_STATE.PROTECTED;
    updated.lastConfirmedStopLoss = details.positionStopLoss;
    updated.lastConfirmedTakeProfit = details.positionTakeProfit;
    updated.inFlightProtection = null;
    updated.protectionPurpose = null;
    updated.pendingProtectionRefresh = false;
    updated.protectionConfirmed = true;
    updated.errorCode = null;
    updated.errorMessage = null;
    updated.unresolved = false;
    return { ok: true, matched: true, record: updated, actions: [{ type: 'PROTECTION_CONFIRMED', positionId: Number(updated.positionId), stopLoss: details.positionStopLoss, takeProfit: details.positionTakeProfit }] };
  }

  if (type === 'ORDER_CANCELLED' && record.partialFillObserved === true) {
    return applyRemainderCancellationConfirmed(updated, details, now);
  }

  if (type === 'ORDER_CANCEL_REJECTED' && record.partialFillObserved === true) {
    return applyRemainderCancellationRejected(updated, details, now);
  }

  if (type === 'ORDER_CANCELLED' || type === 'ORDER_EXPIRED' || type === 'ORDER_CANCEL_REJECTED') {
    if ([EXECUTION_STATE.PROTECTED, EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION].includes(updated.state)) {
      return { ok: true, matched: true, ignoredAsStale: true, record: updated, actions: [] };
    }
    updated.state = EXECUTION_STATE.RECONCILIATION_REQUIRED;
    updated.errorCode = type;
    updated.errorMessage = 'Order lifecycle ended without a fully reconciled result. Check current positions and any remaining order before retrying.';
    updated.unresolved = true;
    return { ok: true, matched: true, record: updated, actions: [{ type: 'ALERT', severity: 'HIGH', code: updated.errorCode, message: updated.errorMessage }] };
  }

  return { ok: true, matched: true, ignoredUnknownEvent: true, record: updated, actions: [] };
}

export function markProtectionRequestTransportError(record, error, now = Date.now()) {
  if (!record || record.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING) {
    return fail('INVALID_PROTECTION_TRANSPORT_STATE', 'Protection transport error is not valid in the current state.');
  }
  return {
    ok: true,
    record: {
      ...record,
      state: EXECUTION_STATE.PROTECTION_UNCONFIRMED,
      updatedAt: now,
      protectionConfirmed: false,
      errorCode: 'PROTECTION_REQUEST_OUTCOME_UNKNOWN',
      errorMessage: String(error?.message ?? error ?? 'Protection request outcome is unknown; inspect the live position in cTrader immediately.'),
      unresolved: true
    }
  };
}

/**
 * After browser/plugin restart, active order/position state is NOT treated as
 * reconciled just because it was written to local storage. cTrader remains the
 * source of truth; a fresh platform position/protection check is required.
 */
export function restoreExecutionRecord(record, now = Date.now(), activeAccountKey = null) {
  const clientOrderId = record?.clientOrderId;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof clientOrderId !== 'string' || clientOrderId.length <= URM_EXECUTION_POLICY.clientOrderIdPrefix.length ||
      clientOrderId.length > URM_EXECUTION_POLICY.clientOrderIdMaxLength ||
      !clientOrderId.startsWith(URM_EXECUTION_POLICY.clientOrderIdPrefix) || !/^[A-Za-z0-9-]+$/.test(clientOrderId)) {
    return fail('RESTORE_RECORD_INVALID', 'Saved record must contain a valid URM clientOrderId no longer than the cTrader 50-character limit.');
  }
  if (typeof activeAccountKey !== 'string' || !activeAccountKey.trim()) return fail('RESTORE_ACCOUNT_UNVERIFIED', 'Cannot restore a journal record until the current cTrader account identity is verified.');
  if (typeof record.accountKey !== 'string' || !record.accountKey.trim() || record.accountKey.length > 200 || record.accountKey !== activeAccountKey) return fail('RESTORE_ACCOUNT_MISMATCH', 'Saved execution state belongs to a different or unverifiable account. Quarantine it and do not apply its identifiers to the current account.');
  if ([EXECUTION_STATE.REJECTED, EXECUTION_STATE.CLOSED].includes(record.state)) {
    return { ok: true, record: { ...record, updatedAt: now } };
  }
  return {
    ok: true,
    record: {
      ...record,
      state: EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED,
      updatedAt: now,
      protectionConfirmed: false,
      unresolved: true,
      errorCode: 'RESTART_RECONCILIATION_REQUIRED',
      errorMessage: 'Plugin restarted. Do not infer active protection from saved data; reconcile current cTrader position, SL/TP and order status before any new order or management action.'
    }
  };
}

/**
 * Returns current RTP absolute-price protection target only for the initial
 * post-fill transition. Dynamic BE/trailing is handled by the position manager.
 */
export function plannedPostFillProtection(record) {
  if (!record || record.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING || !positiveSafeInt(record.positionId)) {
    return fail('PROTECTION_PLAN_NOT_READY', 'A filled position with a valid pending protection transition is required.');
  }
  return {
    ok: true,
    params: {
      positionId: Number(record.positionId),
      stopLoss: record.expectedAbsoluteStopLoss,
      takeProfit: record.expectedAbsoluteTakeProfit,
      ...(record.guaranteedStopLoss === true ? { guaranteedStopLoss: true } : {})
    }
  };
}

export function isExecutionStateUnresolved(state) {
  return PRICE_STATES.has(state) && ![EXECUTION_STATE.PROTECTED].includes(state);
}


/**
 * SDK coordinator. The caller supplies the current official SDK methods and
 * RxJS `take` operator. It is safe by default because gateProvider defaults to
 * every gate false; host integration must not unlock it before Demo validation.
 */
export class CTraderExecutionCoordinator {
  constructor({
    adapter,
    sdk,
    ServerInterfaces,
    take,
    gateProvider = () => ({}),
    activeAccountKeyProvider = () => null,
    onRecord = () => {},
    onAction = () => {},
    persistSnapshot = () => {},
    now = () => Date.now()
  } = {}) {
    this.adapter = adapter;
    this.sdk = sdk ?? {};
    this.ServerInterfaces = ServerInterfaces;
    this.take = take;
    this.gateProvider = gateProvider;
    this.activeAccountKeyProvider = activeAccountKeyProvider;
    this.onRecord = onRecord;
    this.onAction = onAction;
    this.persistSnapshot = typeof persistSnapshot === 'function' ? persistSnapshot : null;
    this.now = now;
    this.records = new Map();
    this.quarantinedRecords = new Map();
    this.boundAccountKey = null;
    this.requests = new Map();
    // Only an explicit persistence callback returning true makes the journal durable.
    this.persistenceHealthy = false;
  }

  snapshot() { return [...this.records.values()].map(record => structuredCloneSafe(record)); }

  _isCurrentBoundAccount(record = null) {
    const active = this.activeAccountKeyProvider();
    if (typeof active !== 'string' || !active.trim() || typeof this.boundAccountKey !== 'string' || !this.boundAccountKey) return false;
    if (active !== this.boundAccountKey) return false;
    return !record || String(record.accountKey ?? '') === this.boundAccountKey;
  }

  _markAccountScopeFailure(clientOrderId, code, message) {
    this.persistenceHealthy = false;
    const candidates = clientOrderId != null
      ? [this.records.get(String(clientOrderId))].filter(Boolean)
      : [...this.records.values()];
    let changed = 0;
    for (const record of candidates) {
      if ([EXECUTION_STATE.REJECTED, EXECUTION_STATE.CLOSED].includes(record.state)) continue;
      const updated = { ...record, state: EXECUTION_STATE.POSITION_RECONCILIATION_REQUIRED,
        protectionConfirmed: false, unresolved: true, accountScopeMismatch: true,
        updatedAt: this.now(), errorCode: String(code), errorMessage: String(message) };
      this.records.set(updated.clientOrderId, updated);
      changed += 1;
      try { this.onRecord(structuredCloneSafe(updated)); } catch {}
      try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: String(code),
        message: String(message), clientOrderId: updated.clientOrderId,
        accountKey: updated.accountKey, activeAccountKey: this.activeAccountKeyProvider() }, structuredCloneSafe(updated)); } catch {}
    }
    return changed;
  }

  _ensureAccountScope(clientOrderId, code, message) {
    const record = this.records.get(String(clientOrderId));
    if (this._isCurrentBoundAccount(record)) return true;
    this._markAccountScopeFailure(clientOrderId, code,
      message ?? 'The active account no longer matches this execution record. No operation or journal write may cross account scope; reconcile the original account manually.');
    return false;
  }

  restore(records = []) {
    if (!Array.isArray(records)) return fail('RESTORE_INPUT_INVALID', 'The execution journal must be supplied as an array of records.');
    const restored = [];
    let restoredCount = 0;
    let quarantinedCount = 0;
    const activeAccountKey = this.activeAccountKeyProvider();
    if (typeof activeAccountKey !== 'string' || !activeAccountKey.trim()) {
      // All input rows will be quarantined below; do not infer account identity.
    } else if (this.boundAccountKey && this.boundAccountKey !== activeAccountKey) {
      return fail('RESTORE_ACTIVE_ACCOUNT_CHANGED', 'This coordinator is bound to a different account. Create a fresh account-scoped coordinator and journal before restoring.');
    } else {
      this.boundAccountKey = activeAccountKey;
    }
    const idCounts = new Map();
    for (const saved of records) {
      const id = typeof saved?.clientOrderId === 'string' ? saved.clientOrderId : '';
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const duplicateIds = new Set([...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
    const quarantine = (saved, id, code, reason, suffix) => {
      const clientOrderId = id || `QUARANTINE-${this.now()}-${quarantinedCount + 1}`;
      const quarantineKey = `${clientOrderId}::${suffix ?? this.now()}::${this.quarantinedRecords.size + 1}`;
      const quarantined = { ...structuredCloneSafe(saved), clientOrderId,
        state: EXECUTION_STATE.NEEDS_MANUAL_INTERVENTION, protectionConfirmed: false, unresolved: true,
        errorCode: code, errorMessage: reason };
      this.quarantinedRecords.set(quarantineKey, quarantined);
      quarantinedCount += 1;
      restored.push(quarantined);
      try { this.onAction({ type: 'EXECUTION_RECORD_QUARANTINED', severity: 'CRITICAL', code, clientOrderId, message: reason }, structuredCloneSafe(quarantined)); } catch {}
    };

    // A duplicate clientOrderId means the journal cannot identify one authoritative
    // state. Quarantine every copy instead of silently overwriting one with another.
    for (let index = 0; index < records.length; index += 1) {
      const saved = records[index];
      const id = typeof saved?.clientOrderId === 'string' ? saved.clientOrderId : '';
      if (id && duplicateIds.has(id)) {
        this.records.delete(id);
        this.requests.delete(id);
        quarantine(saved, id, 'RESTORE_DUPLICATE_CLIENT_ORDER_ID', 'Multiple saved records share the same clientOrderId. Reconcile the original journal and broker state manually.', `DUP-${index}`);
        continue;
      }

      if (id && this.records.has(id)) {
        // Do not overwrite a runtime record with a stale duplicate restore call.
        const alreadyLoaded = this.records.get(id);
        restored.push(alreadyLoaded);
        continue;
      }
      const result = restoreExecutionRecord(saved, this.now(), activeAccountKey);
      if (!result.ok) {
        quarantine(saved, id, result.code, result.reason, `RESTORE-${index}`);
        continue;
      }
      this.records.set(result.record.clientOrderId, result.record);
      restoredCount += 1;
      restored.push(result.record);
      try { this.onRecord(structuredCloneSafe(result.record)); } catch {}
    }

    // Never write a partial snapshot while the restore loop is still processing
    // rows. If any row is quarantined, leave the original journal untouched.
    let journalPersisted = null;
    if (restoredCount > 0 && quarantinedCount === 0) journalPersisted = this._persistCurrentSnapshot();
    else if (quarantinedCount > 0) this.persistenceHealthy = false;
    if (journalPersisted === false) {
      try { this.onAction({ type: 'RESTORE_JOURNAL_PERSIST_FAILED', severity: 'CRITICAL', code: 'EXECUTION_LEDGER_NOT_DURABLE', message: 'Restored records remain unresolved and no new order may be sent until the full state is durably written.' }); } catch {}
    }
    return { ok: true, restoredCount, quarantinedCount, journalPersisted, records: restored };
  }

  getRecord(clientOrderId) { return this.records.get(String(clientOrderId)) ?? null; }
  getQuarantinedRecords() { return [...this.quarantinedRecords.values()].map(record => structuredCloneSafe(record)); }

  hasUnresolvedRecords(exceptClientOrderId = null) {
    if (this.quarantinedRecords.size > 0) return true;
    for (const [id, record] of this.records) {
      if (id === exceptClientOrderId) continue;
      if (isExecutionStateUnresolved(record.state)) return true;
    }
    return false;
  }

  prepare(input = {}) {
    if (this.hasUnresolvedRecords()) {
      return fail('UNRESOLVED_EXECUTION_EXISTS', 'A previous order/position state requires reconciliation. Do not prepare another trade yet.');
    }
    const activeAccountKey = this.activeAccountKeyProvider();
    if (typeof activeAccountKey !== 'string' || !activeAccountKey.trim()) return fail('ACCOUNT_CONTEXT_UNVERIFIED', 'A verified active account key is required to prepare an execution-coordinator intent.');
    if (String(input.accountKey ?? '') !== activeAccountKey) return fail('ACCOUNT_CONTEXT_MISMATCH', 'The requested risk preview account does not match the verified active cTrader account.');
    if (this.boundAccountKey && this.boundAccountKey !== activeAccountKey) return fail('COORDINATOR_ACCOUNT_SCOPE_CHANGED', 'This coordinator is bound to a different account. Reinitialize with a separate account-scoped journal before preparing another trade.');
    this.boundAccountKey = activeAccountKey;
    if ([...this.records.values()].some(row => row.accountKey !== activeAccountKey)) return fail('ACTIVE_LEDGER_ACCOUNT_MISMATCH', 'The active ledger contains records from another account. Reconcile account scope before preparing another trade.');
    const result = prepareMarketOrderIntent({ ...input, now: input.now ?? this.now() });
    if (!result.ok) return result;
    if (this.records.has(result.record.clientOrderId)) return fail('CLIENT_ORDER_ID_DUPLICATE', 'This clientOrderId already exists in the local execution ledger.');
    this.records.set(result.record.clientOrderId, result.record);
    this.requests.set(result.record.clientOrderId, result.request);
    this._publish(result.record);
    return result;
  }

  /**
   * Submit exactly once. Any timeout/transport failure becomes unknown outcome;
   * the controller never retries an order automatically.
   */
  submit(clientOrderId, gateOverrides = {}) {
    const id = String(clientOrderId);
    const record = this.records.get(id);
    const request = this.requests.get(id);
    if (!record || !request) return fail('INTENT_NOT_FOUND', 'Prepare the exact order intent in this coordinator before submitting.');
    if (typeof this.sdk.createNewOrder !== 'function') return fail('SDK_CREATE_ORDER_UNAVAILABLE', 'The current SDK createNewOrder method is unavailable.');
    const activeAccountKey = this.activeAccountKeyProvider();
    if (typeof activeAccountKey !== 'string' || !activeAccountKey.trim()) return fail('ACCOUNT_CONTEXT_UNVERIFIED', 'The active account identity is unavailable at submit time; no order was sent.');
    if (String(record.accountKey) !== activeAccountKey || (this.boundAccountKey && this.boundAccountKey !== activeAccountKey)) {
      return fail('COORDINATOR_ACCOUNT_SCOPE_CHANGED', 'The active cTrader account changed after preview. The old intent is stale; no order was sent. Rebuild the preview in a fresh account-scoped coordinator.');
    }

    // Persist the approved intent before moving toward the SDK call. A missing or
    // failed durable journal blocks execution rather than relying on RAM state.
    const preparedPersisted = this._persistCurrentSnapshot();
    if (!preparedPersisted) return fail('EXECUTION_LEDGER_NOT_DURABLE', 'The prepared intent was not durably saved. No order was sent.');
    const baseGate = typeof this.gateProvider === 'function' ? this.gateProvider(record) : this.gateProvider;
    const gate = { ...baseGate, ...gateOverrides, journalDurable: this.persistenceHealthy, noUnresolvedExecution: !this.hasUnresolvedRecords(id) };
    const started = beginSubmission(record, gate, this.now());
    if (!started.ok) return started;
    const mapped = toSdkMarketOrderParams(request, this.ServerInterfaces);
    if (!mapped.ok) return mapped;

    this.records.set(id, started.record);
    const inFlightPersisted = this._publish(started.record);
    if (!inFlightPersisted) {
      const rolledBack = { ...record, state: EXECUTION_STATE.PREPARED, updatedAt: this.now(),
        errorCode: 'IN_FLIGHT_LEDGER_WRITE_FAILED',
        errorMessage: 'The SUBMITTING state could not be durably saved; no SDK order request was sent. Restore journal storage before retrying.',
        unresolved: true };
      this.records.set(id, rolledBack);
      this._publish(rolledBack);
      return fail('EXECUTION_LEDGER_NOT_DURABLE', 'The in-flight state could not be durably saved. No order was sent.', { record: rolledBack, requestSent: false });
    }
    let observable;
    try {
      observable = this.sdk.createNewOrder(this.adapter, mapped.params);
    } catch (error) {
      this._applyTransportFailure(id, error, false);
      return { ok: true, requestStarted: true, record: this.records.get(id), warning: 'Synchronous SDK error recorded as an unknown outcome; do not retry until reconciled.' };
    }
    this._subscribeOnce(observable, {
      next: event => {
        if (event?.executionType == null && (event?.errorCode != null || Number(event?.payloadType) === 138)) {
          this._applyKnownRequestRejection(id, event.errorCode ?? 'ORDER_REQUEST_REJECTED', event.description);
        } else {
          this.onExecutionEvent(event);
        }
      },
      error: error => this._applyTransportFailure(id, error, false),
      empty: () => this._applyTransportFailure(id, new Error('createNewOrder completed without a correlated execution event'), false)
    });
    return { ok: true, requestStarted: true, record: this.records.get(id) };
  }

  onExecutionEvent(event) {
    if (!event || typeof event !== 'object') return { ok: false, code: 'EVENT_INPUT_INVALID', reason: 'Execution event must be an object.' };
    const rows = [...this.records.values()];
    const ledgerScopeValid = this._isCurrentBoundAccount() && rows.every(row => String(row.accountKey ?? '') === this.boundAccountKey);
    if ((this.boundAccountKey || rows.length > 0) && !ledgerScopeValid) {
      this._markAccountScopeFailure(null, 'EXECUTION_EVENT_ACCOUNT_SCOPE_CHANGED',
        'An execution event arrived while the active account no longer matches this coordinator’s bound account. The event was not applied and no cross-account journal write was made; reconcile the original account manually.');
      return { ok: false, code: 'EXECUTION_EVENT_ACCOUNT_SCOPE_CHANGED', matched: false,
        reason: 'Execution event ignored because account scope is no longer verified.' };
    }
    let matchedAny = false;
    const output = [];
    // Iterate a snapshot because handling a fill may synchronously update state.
    for (const [id, record] of [...this.records.entries()]) {
      const result = applyExecutionEvent(record, event, this.now());
      if (!result.ok || result.matched !== true) continue;
      matchedAny = true;
      this.records.set(id, result.record);
      this._publish(result.record);
      output.push(result);
      for (const action of result.actions ?? []) {
        // Protection is initiated before remainder cancellation when both are
        // requested by one partial-fill event; either response may arrive first,
        // and both transitions are reconciled independently.
        if (action.type === 'MODIFY_POSITION_PROTECTION') this._modifyProtection(id, action.params);
        if (action.type === 'CANCEL_REMAINDER_ORDER') this._cancelRemainder(id, action.params);
        try { this.onAction(structuredCloneSafe(action), structuredCloneSafe(result.record)); } catch { /* Alert/UI callbacks must not break execution state transitions. */ }
      }
    }
    return { ok: true, matched: matchedAny, results: output };
  }

  markTimeout(clientOrderId) {
    const id = String(clientOrderId);
    if (!this._ensureAccountScope(id, 'TIMEOUT_ACCOUNT_SCOPE_CHANGED',
      'A timeout callback arrived after the active account changed. The record is marked for reconciliation; no journal write may cross account scope.')) {
      return fail('TIMEOUT_ACCOUNT_SCOPE_CHANGED', 'The active account no longer matches this execution record.');
    }
    const record = this.records.get(id);
    const result = markExecutionTimeout(record, this.now());
    if (!result.ok) return result;
    this.records.set(id, result.record);
    this._publish(result.record);
    return result;
  }

  _modifyProtection(id, params) {
    if (!this._ensureAccountScope(id, 'PROTECTION_ACCOUNT_SCOPE_CHANGED',
      'The active account changed before the protection request. No SDK operation was sent; reconcile the original position in its original account.')) return;
    if (typeof this.sdk.modifyOrderProtection !== 'function') {
      const current = this.records.get(id);
      const result = markProtectionRequestTransportError(current, new Error('SDK modifyOrderProtection method is unavailable'), this.now());
      if (result.ok) { this.records.set(id, result.record); this._publish(result.record); }
      return;
    }
    let observable;
    try {
      observable = this.sdk.modifyOrderProtection(this.adapter, params);
    } catch (error) {
      this._applyTransportFailure(id, error, true);
      return;
    }
    this._subscribeOnce(observable, {
      next: event => {
        if (event?.executionType == null && (event?.errorCode != null || Number(event?.payloadType) === 138)) {
          this._applyProtectionFailure(id, event.errorCode ?? 'PROTECTION_UPDATE_REJECTED', event.description);
        } else {
          this.onExecutionEvent(event);
        }
      },
      error: error => this._applyTransportFailure(id, error, true),
      empty: () => this._applyTransportFailure(id, new Error('modifyOrderProtection completed without server confirmation'), true)
    });
  }

  _cancelRemainder(id, params) {
    let record = this.records.get(id);
    if (!record || record.orderFullyExecuted === true || record.remainingOrderOpen === false ||
        record.remainderCancelStatus !== 'REQUEST_PLANNED') return;
    if (!this._ensureAccountScope(id, 'CANCEL_ACCOUNT_SCOPE_MISMATCH',
      'The active account context changed before the remainder-cancel request. No cancel was sent and no cross-account journal write was made; reconcile the order in its original account immediately.')) return;
    if (!params || Number(params.orderId) <= 0 || String(params.orderId) !== String(record.orderId) ||
        String(params.originalClientOrderId ?? '') !== String(record.clientOrderId) ||
        String(params.clientOrderId ?? '') !== String(record.cancelRequestClientOrderId)) {
      const updated = { ...unresolvedPartialRemainderState(record), remainderCancelStatus: 'BLOCKED_REQUEST_IDENTITY', remainingOrderOpen: true,
        updatedAt: this.now(), errorCode: 'CANCEL_REQUEST_IDENTITY_MISMATCH',
        errorMessage: 'The cancel request does not match this record’s exact original order ID and client-order identity. No cancel was sent.' };
      this.records.set(id, updated); this._publish(updated);
      try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }, structuredCloneSafe(updated)); } catch {}
      return;
    }
    if (typeof this.sdk.cancelOrder !== 'function') {
      const updated = { ...unresolvedPartialRemainderState(record), remainderCancelStatus: 'UNAVAILABLE', remainingOrderOpen: true,
        updatedAt: this.now(), errorCode: 'SDK_CANCEL_ORDER_UNAVAILABLE',
        errorMessage: 'The SDK cancelOrder method is unavailable. The partial position may be protected, but the remaining order is not reconciled; cancel it manually in cTrader.' };
      this.records.set(id, updated); this._publish(updated);
      try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }, structuredCloneSafe(updated)); } catch {}
      return;
    }

    record = { ...record, remainderCancelStatus: 'REQUEST_PENDING', cancelRequestSentAt: this.now(),
      cancelRequestAttemptCount: 1, remainingOrderOpen: true, unresolved: true };
    this.records.set(id, record);
    const durableBeforeCancel = this._publish(record);
    if (!durableBeforeCancel) {
      // This is an exposure-reducing safety action, not a new-risk order. Make a
      // single cancel attempt anyway, but explicitly preserve an unresolved warning
      // because its request identity cannot be guaranteed durable across a restart.
      record = { ...this.records.get(id), cancelRequestDurabilityWarning: true };
      this.records.set(id, record);
      try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: 'CANCEL_JOURNAL_NOT_DURABLE',
        message: 'The remainder-cancel intent could not be durably saved. A single risk-reducing cancel attempt will be made; restart recovery remains manual and no automatic retry is allowed.' }, structuredCloneSafe(record)); } catch {}
    }

    let observable;
    try {
      observable = this.sdk.cancelOrder(this.adapter, {
        orderId: Number(params.orderId),
        originalClientOrderId: String(params.originalClientOrderId),
        clientOrderId: String(params.clientOrderId)
      });
    } catch (error) {
      this._applyCancelTransportFailure(id, error);
      return;
    }
    this._subscribeOnce(observable, {
      next: event => {
        if (event?.executionType == null && (event?.errorCode != null || Number(event?.payloadType) === 138)) {
          this._applyCancelFailure(id, event.errorCode ?? 'CANCEL_REQUEST_REJECTED', event.description);
        } else {
          this.onExecutionEvent(event);
        }
      },
      error: error => this._applyCancelTransportFailure(id, error),
      empty: () => this._applyCancelTransportFailure(id, new Error('cancelOrder completed without correlated cancellation confirmation'))
    });
  }

  _applyCancelFailure(id, code, message) {
    if (!this._ensureAccountScope(id, 'CANCEL_RESPONSE_ACCOUNT_SCOPE_CHANGED',
      'The cancellation response arrived after the active account changed; it was not applied.')) return;
    const record = this.records.get(id);
    if (!record || record.orderFullyExecuted === true || record.remainderCancelStatus === 'CANCELLED') return;
    const updated = { ...unresolvedPartialRemainderState(record), remainderCancelStatus: 'CANCEL_REJECTED', remainingOrderOpen: true,
      cancelVolumeReconciled: false, updatedAt: this.now(),
      errorCode: String(code),
      errorMessage: String(message ?? 'cTrader rejected the remainder-cancel request. Do not retry automatically; reconcile the live order and position.') };
    if (updated.protectionConfirmed === true && updated.state === EXECUTION_STATE.PROTECTED) {
      updated.state = EXECUTION_STATE.PARTIAL_FILL_PROTECTED_REMAINDER_PENDING;
    }
    this.records.set(id, updated); this._publish(updated);
    try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }, structuredCloneSafe(updated)); } catch {}
  }

  _applyCancelTransportFailure(id, error) {
    if (!this._ensureAccountScope(id, 'CANCEL_TRANSPORT_ACCOUNT_SCOPE_CHANGED',
      'The cancellation transport result arrived after the active account changed; it was not applied.')) return;
    const record = this.records.get(id);
    if (!record || record.orderFullyExecuted === true || record.remainderCancelStatus === 'CANCELLED') return;
    const updated = { ...unresolvedPartialRemainderState(record), remainderCancelStatus: 'UNKNOWN', remainingOrderOpen: true,
      cancelVolumeReconciled: false, updatedAt: this.now(),
      errorCode: 'REMAINDER_CANCEL_OUTCOME_UNKNOWN',
      errorMessage: String(error?.message ?? error ?? 'Cancel outcome is unknown. Do not retry; reconcile the original order in cTrader.') };
    this.records.set(id, updated); this._publish(updated);
    try { this.onAction({ type: 'ALERT', severity: 'CRITICAL', code: updated.errorCode, message: updated.errorMessage }, structuredCloneSafe(updated)); } catch {}
  }

  _subscribeOnce(observable, { next, error, empty }) {
    if (!observable || typeof observable.subscribe !== 'function') {
      error(new Error('SDK method did not return a subscribable observable'));
      return;
    }
    let gotValue = false;
    const source = typeof observable.pipe === 'function' && typeof this.take === 'function'
      ? observable.pipe(this.take(1)) : observable;
    try {
      source.subscribe({
        next: value => { gotValue = true; next(value); },
        error,
        complete: () => { if (!gotValue) empty(); }
      });
    } catch (exception) { error(exception); }
  }

  _applyTransportFailure(id, error, isProtection) {
    if (!this._ensureAccountScope(id, 'TRANSPORT_ACCOUNT_SCOPE_CHANGED',
      'A transport callback arrived after the active account changed; no state mutation or cross-account journal write is allowed.')) return;
    const record = this.records.get(id);
    const result = isProtection
      ? markProtectionRequestTransportError(record, error, this.now())
      : markRequestTransportError(record, error, this.now());
    if (result.ok) { this.records.set(id, result.record); this._publish(result.record); }
  }

  _applyKnownRequestRejection(id, code, message) {
    if (!this._ensureAccountScope(id, 'REJECTION_ACCOUNT_SCOPE_CHANGED',
      'A rejection callback arrived after the active account changed; it was not applied.')) return;
    const record = this.records.get(id);
    if (!record || ![EXECUTION_STATE.SUBMITTING, EXECUTION_STATE.ACCEPTED].includes(record.state)) return;
    const updated = { ...record, state: EXECUTION_STATE.REJECTED, updatedAt: this.now(), errorCode: String(code),
      errorMessage: String(message ?? 'The cTrader SDK returned a correlated order validation error.'), unresolved: false };
    this.records.set(id, updated);
    this._publish(updated);
  }

  _applyProtectionFailure(id, code, message) {
    if (!this._ensureAccountScope(id, 'PROTECTION_RESPONSE_ACCOUNT_SCOPE_CHANGED',
      'A protection response arrived after the active account changed; it was not applied.')) return;
    const record = this.records.get(id);
    if (!record || record.state !== EXECUTION_STATE.PROTECTION_UPDATE_PENDING) return;
    const updated = { ...record, state: EXECUTION_STATE.PROTECTION_FAILED, updatedAt: this.now(), protectionConfirmed: false,
      errorCode: String(code), errorMessage: String(message ?? 'The server rejected the protective update; inspect the existing position protection immediately.'), unresolved: true };
    this.records.set(id, updated);
    this._publish(updated);
  }

  _persistCurrentSnapshot() {
    const activeAccountKey = this.activeAccountKeyProvider();
    if (!this.boundAccountKey || typeof activeAccountKey !== 'string' || !activeAccountKey.trim() ||
        activeAccountKey !== this.boundAccountKey ||
        [...this.records.values()].some(record => String(record.accountKey ?? '') !== this.boundAccountKey)) {
      // Never write the old account's snapshot through an adapter that may now
      // point at a different active account. Scope failure must be reconciled manually.
      this.persistenceHealthy = false;
      return false;
    }
    if (this.quarantinedRecords.size > 0) {
      // The persistence adapter is intentionally account-scoped. Do not overwrite
      // its active-account journal while cross-account/ambiguous rows remain quarantined.
      this.persistenceHealthy = false;
      return false;
    }
    if (!this.persistSnapshot) { this.persistenceHealthy = false; return false; }
    try {
      const result = this.persistSnapshot(this.snapshot());
      this.persistenceHealthy = result === true;
    } catch {
      this.persistenceHealthy = false;
    }
    return this.persistenceHealthy;
  }

  _publish(record) {
    const persisted = this._persistCurrentSnapshot();
    try { this.onRecord(structuredCloneSafe(record)); } catch { /* UI callbacks must not break execution state transitions. */ }
    return persisted;
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
