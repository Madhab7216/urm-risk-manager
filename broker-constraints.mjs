/**
 * URM Stage F — broker/symbol constraint checks for a NON-EXECUTABLE preview.
 * ProtoSymbol slDistance/tpDistance are expressed in symbol points. TickSize is
 * deliberately not inferred from digits; this only evaluates broker min-distance.
 */
function n(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return NaN;
  return Number(value);
}
function fail(code, reason, details = {}) { return { ok: false, code, reason, ...details }; }

export function evaluateBrokerConstraints(input = {}) {
  const side = input.side;
  const digits = n(input.digits);
  const bid = n(input.bid);
  const ask = n(input.ask);
  const stopLoss = n(input.stopLoss);
  const takeProfit = n(input.takeProfit);
  const slDistancePoints = n(input.slDistancePoints);
  const tpDistancePoints = n(input.tpDistancePoints);

  if (input.symbolEnabled !== true) return fail('SYMBOL_NOT_CONFIRMED_ENABLED', 'The selected symbol is not confirmed as enabled by the broker metadata.');
  if (side !== 'BUY' && side !== 'SELL') return fail('BROKER_SIDE_INVALID', 'Trade side must be BUY or SELL.');
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) return fail('BROKER_DIGITS_INVALID', 'Symbol digits are missing or invalid.');
  if (![bid, ask, stopLoss, takeProfit].every(Number.isFinite) || bid <= 0 || ask < bid || stopLoss <= 0 || takeProfit <= 0) {
    return fail('BROKER_PRICE_DATA_INVALID', 'Fresh bid/ask, SL and TP prices are required.');
  }
  if (![slDistancePoints, tpDistancePoints].every(Number.isFinite) || slDistancePoints < 0 || tpDistancePoints < 0) {
    return fail('BROKER_MIN_DISTANCE_UNVERIFIED', 'The symbol response must include non-negative SL and TP minimum distances.');
  }
  const pricePoint = Math.pow(10, -digits);
  if (!Number.isFinite(pricePoint) || pricePoint <= 0) return fail('BROKER_POINT_SIZE_INVALID', 'Could not derive the documented price-point unit from symbol digits.');
  const closeSidePrice = side === 'BUY' ? bid : ask;
  const actualSLDistance = side === 'BUY' ? closeSidePrice - stopLoss : stopLoss - closeSidePrice;
  const actualTPDistance = side === 'BUY' ? takeProfit - closeSidePrice : closeSidePrice - takeProfit;
  const minSL = slDistancePoints * pricePoint;
  const minTP = tpDistancePoints * pricePoint;
  const epsilon = pricePoint * 1e-7;
  if (actualSLDistance < -epsilon) return fail('BROKER_SL_WRONG_SIDE', 'SL is on the wrong side of the current executable quote.', { actualSLDistance, closeSidePrice });
  if (actualTPDistance < -epsilon) return fail('BROKER_TP_WRONG_SIDE', 'TP is on the wrong side of the current executable quote.', { actualTPDistance, closeSidePrice });
  if (actualSLDistance + epsilon < minSL) return fail('BROKER_SL_DISTANCE_TOO_SMALL', 'SL is closer to current executable price than the broker minimum.', { actualSLDistance, minSL, slDistancePoints, pointSize: pricePoint });
  if (actualTPDistance + epsilon < minTP) return fail('BROKER_TP_DISTANCE_TOO_SMALL', 'TP is closer to current executable price than the broker minimum.', { actualTPDistance, minTP, tpDistancePoints, pointSize: pricePoint });

  return {
    ok: true, code: 'BROKER_MIN_DISTANCES_PASS', closeSidePrice,
    actualSLDistance, actualTPDistance, minSL, minTP,
    pointSize: pricePoint,
    tickGridStatus: 'UNVERIFIED_TICKSIZE_NOT_EXPOSED_BY_WEB_PLUGIN_PROTO_SYMBOL',
    exposureStatus: input.maxExposureUsdCents === null || input.maxExposureUsdCents === undefined
      ? 'MAX_EXPOSURE_NOT_SUPPLIED'
      : 'EXPOSURE_CAP_UNCHECKED_POSITION_LIST_UNAVAILABLE',
    executionEnabled: false
  };
}

export function classifyTickGrid({ tickSize, source, verified, verifiedAtMs, nowMs = Date.now() } = {}) {
  const tick = n(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return { ok: false, code: 'TICK_SIZE_MISSING' };
  if (verified !== true || typeof source !== 'string' || !source.trim()) return { ok: false, code: 'TICK_SIZE_UNVERIFIED' };
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > nowMs || nowMs - verifiedAtMs > 24 * 60 * 60 * 1000) {
    return { ok: false, code: 'TICK_SIZE_VERIFICATION_STALE' };
  }
  return { ok: true, code: 'TICK_SIZE_MANUALLY_ATTESTED', tickSize: tick, source: source.trim(), executionEnabled: false };
}
