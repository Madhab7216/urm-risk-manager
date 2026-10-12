// Privacy-conscious normalisation for cTrader ProtoQuoteEvent messages.
// cTrader documents bid/ask in 1/100,000 price units and timestamp in UNIX ms.
// Field names are read case-insensitively because SDK wrappers may alter casing.
const MAX_DEPTH = 12;
const PRICE_SCALE = 100000;

function field(object, ...aliases) {
  if (!object || typeof object !== "object") {
    return { found: false, key: null, value: undefined, source: "missing" };
  }

  // Prefer exact aliases, allowing non-enumerable own properties and
  // inherited getters/data properties. Limit prototype traversal to avoid
  // wandering through unexpected proxy/class chains.
  for (const alias of aliases) {
    try {
      if (alias in object) {
        const own = Object.prototype.hasOwnProperty.call(object, alias);
        return {
          found: true,
          key: alias,
          value: object[alias],
          source: own
            ? (Object.prototype.propertyIsEnumerable.call(object, alias) ? "own-enumerable" : "own-nonenumerable")
            : "inherited"
        };
      }
    } catch {
      // A hostile or throwing getter is treated as unavailable; never trust it.
      return { found: false, key: null, value: undefined, source: "unreadable" };
    }
  }

  const wanted = new Set(aliases.map(alias => String(alias).toLowerCase()));
  let current = object;
  for (let depth = 0; current && depth <= 5; depth += 1) {
    let names;
    try { names = Object.getOwnPropertyNames(current); }
    catch { return { found: false, key: null, value: undefined, source: "unreadable" }; }

    const actual = names.find(key => wanted.has(key.toLowerCase()));
    if (actual !== undefined) {
      try {
        const own = current === object;
        return {
          found: true,
          key: actual,
          value: object[actual],
          source: own
            ? (Object.prototype.propertyIsEnumerable.call(object, actual) ? "own-enumerable" : "own-nonenumerable")
            : "inherited"
        };
      } catch {
        return { found: false, key: null, value: undefined, source: "unreadable" };
      }
    }
    try { current = Object.getPrototypeOf(current); }
    catch { break; }
  }
  return { found: false, key: null, value: undefined, source: "missing" };
}

function collectObjects(root) {
  const objects = [];
  const visited = new Set();
  function walk(value, depth) {
    if (value == null || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try { walk(JSON.parse(trimmed), depth + 1); } catch { /* not JSON; do not inspect arbitrary strings */ }
      }
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (!Array.isArray(value)) objects.push(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  }
  walk(root, 0);
  return objects;
}

function keySample(object) {
  return object && typeof object === "object" ? Object.keys(object).sort().slice(0, 30) : [];
}

function diagFor(object, reason, extras = {}) {
  const bid = field(object, "bid", "bidPrice");
  const ask = field(object, "ask", "askPrice");
  const stamp = field(object, "timestamp");
  return {
    reason,
    eventKeys: keySample(object),
    bidField: bid.found ? bid.key : null,
    askField: ask.found ? ask.key : null,
    timestampField: stamp.found ? stamp.key : null,
    timestampFieldSource: stamp.source,
    bidType: bid.found ? (bid.value === null ? "null" : typeof bid.value) : "missing",
    askType: ask.found ? (ask.value === null ? "null" : typeof ask.value) : "missing",
    timestampType: stamp.found ? (stamp.value === null ? "null" : typeof stamp.value) : "missing",
    ...extras
  };
}

/**
 * @returns {{quote: null|{bid:number,ask:number,timestamp:number}, diagnostic:object}}
 * Never promotes a quote with absent, invalid, future or stale source timestamps.
 */
export function parseQuoteEventPayload(event, {
  expectedSymbolId,
  nowMs = Date.now(),
  maxAgeMs = 10000,
  // Preview-only fallback. Never implies broker/source timestamp verification.
  allowReceiptTimeFallback = false
} = {}) {
  const objects = collectObjects(event);
  const candidates = objects.filter(object => field(object, "symbolId").found);
  if (candidates.length === 0) {
    return { quote: null, diagnostic: { reason: "symbol_id_field_missing", eventKeys: keySample(objects[0]), candidateObjects: 0 } };
  }

  const matching = candidates.filter(object => {
    const id = Number(field(object, "symbolId").value);
    return Number.isFinite(id) && Number.isFinite(Number(expectedSymbolId)) && id === Number(expectedSymbolId);
  });
  if (matching.length === 0) {
    return { quote: null, diagnostic: {
      reason: "symbol_id_mismatch", eventKeys: keySample(candidates[0]),
      candidateObjects: candidates.length, targetSymbolMatched: false
    } };
  }

  let lastDiagnostic = null;
  for (const object of matching) {
    const bidField = field(object, "bid", "bidPrice");
    const askField = field(object, "ask", "askPrice");
    const stampField = field(object, "timestamp");
    const shape = () => ({
      eventKeys: keySample(object),
      targetSymbolMatched: true,
      bidField: bidField.found ? bidField.key : null,
      askField: askField.found ? askField.key : null,
      timestampField: stampField.found ? stampField.key : null,
      timestampFieldSource: stampField.source,
      bidType: bidField.found ? (bidField.value === null ? "null" : typeof bidField.value) : "missing",
      askType: askField.found ? (askField.value === null ? "null" : typeof askField.value) : "missing",
      timestampType: stampField.found ? (stampField.value === null ? "null" : typeof stampField.value) : "missing"
    });
    if (!bidField.found || !askField.found) {
      lastDiagnostic = { reason: "bid_or_ask_field_missing", ...shape() };
      continue;
    }

    // Validate quote content before deciding how to handle its optional timestamp.
    const bidRaw = Number(bidField.value);
    const askRaw = Number(askField.value);
    const bid = bidRaw / PRICE_SCALE;
    const ask = askRaw / PRICE_SCALE;
    if (!Number.isFinite(bidRaw) || !Number.isFinite(askRaw) || bid <= 0 || ask < bid) {
      lastDiagnostic = { reason: "invalid_bid_ask_values", ...shape() };
      continue;
    }

    const stampMissing = !stampField.found || stampField.value === undefined || stampField.value === null || stampField.value === "";
    if (stampMissing) {
      if (allowReceiptTimeFallback && Number.isFinite(Number(nowMs)) && Number(nowMs) > 0) {
        // The quote payload has no source timestamp. Use host receipt time strictly
        // for UI/risk preview freshness and make provenance explicit; execution gates
        // must continue to reject this as an unverified source-time quote.
        return {
          quote: {
            bid, ask, timestamp: Number(nowMs),
            timestampSource: "host-receipt-only",
            sourceTimestampVerified: false
          },
          diagnostic: {
            reason: "accepted_receipt_time_only",
            ageBucket: "host_receipt",
            sourceTimestampVerified: false,
            timestampFieldSource: stampField.source,
            ...shape()
          }
        };
      }
      lastDiagnostic = { reason: "source_timestamp_missing", ...shape() };
      continue;
    }

    const timestamp = Number(stampField.value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      lastDiagnostic = { reason: "invalid_source_timestamp", ...shape() };
      continue;
    }
    const ageMs = Number(nowMs) - timestamp;
    if (ageMs < 0) {
      lastDiagnostic = { reason: "source_timestamp_in_future", ageBucket: "future", ...shape() };
      continue;
    }
    if (ageMs >= Number(maxAgeMs)) {
      lastDiagnostic = { reason: "source_timestamp_stale", ageBucket: "stale", ...shape() };
      continue;
    }
    return {
      quote: { bid, ask, timestamp, timestampSource: "broker", sourceTimestampVerified: true },
      diagnostic: { reason: "accepted", ageBucket: ageMs < 1000 ? "under_1s" : "under_max_age", sourceTimestampVerified: true, ...shape() }
    };
  }
  return { quote: null, diagnostic: lastDiagnostic ?? {
    reason: "matching_symbol_quote_unreadable", eventKeys: keySample(matching[0]), targetSymbolMatched: true
  } };
}
