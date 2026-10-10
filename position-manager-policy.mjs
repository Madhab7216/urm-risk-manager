/**
 * URM Position Manager policy — pure/testable JavaScript reference.
 * This module computes management targets only; it does not send broker requests.
 */
export const MAX_SYMBOL_GRID_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export const URM_POSITION_POLICY = Object.freeze({
  version: 'URM-POSITION-1.1',
  labelPrefix: 'URM1|',
  labelMaxLength: 100,
  breakEvenAtR: 1,
  lockAtR: 2,
  lockToR: 1.7,
  trailingAtR: 3,
  trailingGapR: 1,
  minimumTrailingLockR: 2,
  takeProfitR: 5
});

const finite = v => Number.isFinite(Number(v));
const positive = v => finite(v) && Number(v) > 0;
const roundDecimal = (v, digits) => Math.round((v + Number.EPSILON) * (10 ** digits)) / (10 ** digits);

/**
 * A cTrader position label persists with the position. Encode the structural SL
 * and client-order correlation ID so a C# cBot can recover the original R anchor
 * after a restart. Label is metadata, not an authentication token.
 */
export function buildUrmPositionLabel({ clientOrderId, structuralStopLoss, digits } = {}) {
  const id = String(clientOrderId ?? '').trim();
  const sl = Number(structuralStopLoss);
  const d = Number(digits);
  if (!/^URM-[A-Za-z0-9-]{1,45}$/.test(id)) {
    return { ok: false, code: 'LABEL_CLIENT_ID_INVALID', reason: 'A valid URM clientOrderId is required.' };
  }
  if (!positive(sl)) return { ok: false, code: 'LABEL_SL_INVALID', reason: 'A finite positive structural SL is required.' };
  if (!Number.isInteger(d) || d < 0 || d > 10) {
    return { ok: false, code: 'LABEL_DIGITS_INVALID', reason: 'Verified symbol digits from 0 to 10 are required.' };
  }
  const slText = sl.toFixed(d);
  const label = `${URM_POSITION_POLICY.labelPrefix}ID=${id}|SL=${slText}`;
  if (label.length > URM_POSITION_POLICY.labelMaxLength) {
    return { ok: false, code: 'LABEL_TOO_LONG', reason: 'The position anchor label exceeds cTrader’s 100-character limit.' };
  }
  return { ok: true, label, clientOrderId: id, structuralStopLoss: Number(slText), digits: d };
}

export function parseUrmPositionLabel(label) {
  if (typeof label !== 'string' || label.length === 0 || label.length > URM_POSITION_POLICY.labelMaxLength) {
    return { ok: false, code: 'LABEL_INVALID_LENGTH', reason: 'Position label is missing or exceeds the protocol limit.' };
  }
  const match = /^URM1\|ID=(URM-[A-Za-z0-9-]{1,45})\|SL=(\d+(?:\.\d+)?)$/.exec(label);
  if (!match) return { ok: false, code: 'LABEL_SCHEMA_INVALID', reason: 'The position label does not match the supported URM1 anchor schema.' };
  const structuralStopLoss = Number(match[2]);
  if (!positive(structuralStopLoss)) return { ok: false, code: 'LABEL_SL_INVALID', reason: 'The encoded structural SL must be finite and positive.' };
  return { ok: true, schemaVersion: 1, clientOrderId: match[1], structuralStopLoss };
}

function priceAtR(side, entry, rDistance, stopR) {
  return side === 'BUY' ? entry + (rDistance * stopR) : entry - (rDistance * stopR);
}

// Round a protective stop away from the executable market: BUY stops down, SELL stops up.
// Round a target outwards so price-grid normalization never shortens the requested R target.
function roundToGrid(price, tickSize, mode) {
  const units = price / tickSize;
  const n = mode === 'floor'
    ? Math.floor(units + 1e-10)
    : mode === 'ceil'
      ? Math.ceil(units - 1e-10)
      : Math.round(units);
  return Number((n * tickSize).toPrecision(14));
}

function invalid(code, reason) { return { ok: false, code, reason, requiresManualIntervention: true }; }

/**
 * Returns a read-only management plan from an immutable structural SL anchor.
 * peakR is the best favourable R observed and must be persisted by an active
 * manager. existingStopLoss, when supplied, is treated as a protection floor:
 * the plan must never move it backwards.
 */
export function calculatePositionManagementPlan(input = {}) {
  const side = input.side;
  const entry = Number(input.entryPrice);
  const structuralSL = Number(input.structuralStopLoss);
  const currentPrice = Number(input.currentPrice);
  const digits = Number(input.digits);
  const tickSize = Number(input.tickSize);
  const tickSizeVerified = input.tickSizeVerified === true;
  const tickSizeSource = typeof input.tickSizeSource === 'string' ? input.tickSizeSource.trim() : '';
  const tickSizeVerifiedAt = Number(input.tickSizeVerifiedAt);
  const now = Number(input.now);
  const peakIn = input.peakR == null ? 0 : Number(input.peakR);
  const existingSL = input.existingStopLoss == null ? null : Number(input.existingStopLoss);

  if (side !== 'BUY' && side !== 'SELL') return invalid('SIDE_INVALID', 'Side must be BUY or SELL.');
  if (![entry, structuralSL, currentPrice].every(Number.isFinite) || entry <= 0 || structuralSL <= 0 || currentPrice <= 0) {
    return invalid('PRICE_INVALID', 'Entry, structural SL and current price must be finite positive values.');
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 10 || !positive(tickSize)) {
    return invalid('SYMBOL_GRID_INVALID', 'Verified symbol digits and positive tickSize are required.');
  }
  if (!tickSizeVerified || tickSizeSource.length < 3 || tickSizeSource.length > 160 ||
      !Number.isFinite(tickSizeVerifiedAt) || tickSizeVerifiedAt <= 0 ||
      !Number.isFinite(now) || now < tickSizeVerifiedAt ||
      (now - tickSizeVerifiedAt) > MAX_SYMBOL_GRID_EVIDENCE_AGE_MS) {
    return invalid('SYMBOL_GRID_EVIDENCE_UNVERIFIED', 'Tick size requires explicit sourced evidence and a verification timestamp no older than 24 hours.');
  }
  if (!finite(peakIn) || peakIn < 0) return invalid('PEAK_R_INVALID', 'peakR must be finite and non-negative.');
  if (existingSL != null && (!Number.isFinite(existingSL) || existingSL <= 0)) {
    return invalid('EXISTING_SL_INVALID', 'Existing stop-loss must be null or a finite positive price.');
  }
  if ((side === 'BUY' && structuralSL >= entry) || (side === 'SELL' && structuralSL <= entry)) {
    return invalid('STRUCTURAL_SL_DIRECTION_INVALID', 'BUY requires structural SL below entry; SELL requires it above entry.');
  }

  const rDistance = Math.abs(entry - structuralSL);
  if (!Number.isFinite(rDistance) || rDistance < tickSize - 1e-12) {
    return invalid('R_DISTANCE_INVALID', 'Initial R distance must be at least one symbol tick.');
  }
  const currentR = side === 'BUY' ? (currentPrice - entry) / rDistance : (entry - currentPrice) / rDistance;
  let existingStopR = null;
  let inferredPeakFromStop = 0;
  if (existingSL != null) {
    existingStopR = side === 'BUY' ? (existingSL - entry) / rDistance : (entry - existingSL) / rDistance;
    // Conservative bootstrap heuristic: existing server SL can prove some progress,
    // but it cannot prove an excursion whose stop update previously failed.
    if (existingStopR >= URM_POSITION_POLICY.minimumTrailingLockR) inferredPeakFromStop = existingStopR + URM_POSITION_POLICY.trailingGapR;
    else if (existingStopR >= URM_POSITION_POLICY.lockToR) inferredPeakFromStop = URM_POSITION_POLICY.lockAtR;
    else if (existingStopR >= -1e-8) inferredPeakFromStop = URM_POSITION_POLICY.breakEvenAtR;
  }
  const peakR = Math.max(peakIn, currentR, inferredPeakFromStop);
  const takeProfit = roundToGrid(
    priceAtR(side, entry, rDistance, URM_POSITION_POLICY.takeProfitR),
    tickSize,
    side === 'BUY' ? 'ceil' : 'floor'
  );

  if (peakR >= URM_POSITION_POLICY.takeProfitR || currentR >= URM_POSITION_POLICY.takeProfitR) {
    return {
      ok: true,
      policyVersion: URM_POSITION_POLICY.version,
      phase: 'TP_BOUNDARY_RECONCILIATION_REQUIRED',
      code: 'TP_BOUNDARY_RECONCILIATION_REQUIRED',
      side, entryPrice: entry, structuralStopLoss: structuralSL, rDistance,
      currentR, peakR, existingStopLoss: existingSL, existingStopR,
      targetStopLoss: existingSL,
      targetStopR: existingStopR,
      takeProfit,
      action: 'RECONCILE_POSITION_AND_TP',
      requiresManualIntervention: true,
      reason: 'The position has reached or may have reached 5R. Do not infer a normal trailing state; reconcile server position and TP execution.'
    };
  }

  let phase;
  let requestedStopR;
  if (peakR >= URM_POSITION_POLICY.trailingAtR) {
    phase = 'TRAILING';
    requestedStopR = Math.max(URM_POSITION_POLICY.minimumTrailingLockR, peakR - URM_POSITION_POLICY.trailingGapR);
  } else if (peakR >= URM_POSITION_POLICY.lockAtR) {
    phase = 'LOCK_1_7R';
    requestedStopR = URM_POSITION_POLICY.lockToR;
  } else if (peakR >= URM_POSITION_POLICY.breakEvenAtR) {
    phase = 'BREAK_EVEN';
    requestedStopR = 0;
  } else {
    phase = 'INITIAL_PROTECTION';
    requestedStopR = -1;
  }

  // Never reduce confirmed protection. R-space is oriented so larger stopR is always more protective.
  const targetStopR = existingStopR == null ? requestedStopR : Math.max(requestedStopR, existingStopR);
  const rawTargetSL = targetStopR === -1 ? structuralSL : priceAtR(side, entry, rDistance, targetStopR);
  // For the initial risk stop, round towards entry (tighter) so normalization
  // cannot enlarge the planned price-risk. For profit-lock/trailing stops, round
  // conservatively away from the executable quote so the broker is less likely
  // to reject a target due to a sub-tick overshoot.
  const targetStopLoss = targetStopR < 0
    ? roundToGrid(rawTargetSL, tickSize, side === 'BUY' ? 'ceil' : 'floor')
    : roundToGrid(rawTargetSL, tickSize, side === 'BUY' ? 'floor' : 'ceil');
  const executableExitPrice = currentPrice;
  const targetIsCrossed = side === 'BUY'
    ? targetStopLoss >= executableExitPrice - (tickSize * 1e-6)
    : targetStopLoss <= executableExitPrice + (tickSize * 1e-6);
  if (targetIsCrossed) {
    return {
      ok: true, policyVersion: URM_POSITION_POLICY.version,
      phase: 'STOP_TARGET_CROSSED_BY_MARKET', code: 'STOP_TARGET_CROSSED_BY_MARKET',
      side, entryPrice: entry, structuralStopLoss: structuralSL, rDistance,
      currentR, peakR, existingStopLoss: existingSL, existingStopR,
      targetStopLoss, targetStopR, takeProfit,
      action: 'RECONCILE_MANUALLY', requiresManualIntervention: true,
      reason: 'The required SL is at or through the current executable price; do not send an invalid modification. Inspect current server protection and exposure.'
    };
  }

  let action;
  if (existingSL == null) action = 'INITIAL_SL_MISSING';
  else if (targetStopR > existingStopR + (tickSize / rDistance / 1000)) action = 'ADVANCE_SL_ONLY';
  else action = 'PRESERVE_EXISTING_SL';
  return {
    ok: true,
    policyVersion: URM_POSITION_POLICY.version,
    phase,
    side,
    entryPrice: entry,
    structuralStopLoss: structuralSL,
    rDistance,
    currentR,
    peakR,
    existingStopLoss: existingSL,
    existingStopR,
    targetStopLoss,
    targetStopR,
    takeProfit,
    action,
    requiresManualIntervention: existingSL == null,
    reason: existingSL == null
      ? 'No server-confirmed SL was provided. This plan is read-only; position protection must be verified before treating the trade as safe.'
      : action === 'PRESERVE_EXISTING_SL'
        ? 'Existing SL is already at least as protective as the computed target; never move it backwards.'
        : 'The target is a proposal only. Any active manager must modify, then independently confirm the server-reported SL/TP.'
  };
}

export function evaluateUrmLabelForPosition({ label, positionSymbolName, expectedSymbolName, side, entryPrice } = {}) {
  const parsed = parseUrmPositionLabel(label);
  if (!parsed.ok) return parsed;
  if (typeof positionSymbolName !== 'string' || !positionSymbolName || positionSymbolName !== expectedSymbolName) {
    return { ok: false, code: 'POSITION_SYMBOL_MISMATCH', reason: 'The cBot instance must match the position symbol.' };
  }
  const entry = Number(entryPrice);
  if (!positive(entry)) return { ok: false, code: 'POSITION_ENTRY_INVALID', reason: 'Position fill price is invalid.' };
  if (side !== 'BUY' && side !== 'SELL') return { ok: false, code: 'POSITION_SIDE_INVALID', reason: 'Position side must be BUY or SELL.' };
  if ((side === 'BUY' && parsed.structuralStopLoss >= entry) || (side === 'SELL' && parsed.structuralStopLoss <= entry)) {
    return { ok: false, code: 'ANCHOR_INVALID_AFTER_FILL', reason: 'The structural SL is not on the protective side of actual fill. Manual reconciliation required.' };
  }
  return { ok: true, ...parsed, actualEntryPrice: entry, actualRDistance: Math.abs(entry - parsed.structuralStopLoss) };
}
