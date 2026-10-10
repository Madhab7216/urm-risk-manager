// Privacy-conscious normalisation for cTrader ProtoQuoteEvent messages.
// cTrader documents bid/ask in 1/100,000 price units and timestamp in UNIX ms.
// Field names are read case-insensitively because SDK wrappers may alter casing.
const MAX_DEPTH = 12;
const PRICE_SCALE = 100000;

function field(object, ...aliases) {
  if (!object || typeof object !== "object") return { found: false, key: null, value: undefined };
  const exact = aliases.find(alias => Object.prototype.hasOwnProperty.call(object, alias));
  if (exact !== undefined) return { found: true, key: exact, value: object[exact] };
  const wanted = new Set(aliases.map(alias => String(alias).toLowerCase()));
  const actual = Object.keys(object).find(key => wanted.has(key.toLowerCase()));
  return actual === undefined
    ? { found: false, key: null, value: undefined }
    : { found: true, key: actual, value: object[actual] };
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
  maxAgeMs = 10000
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
      bidType: bidField.found ? (bidField.value === null ? "null" : typeof bidField.value) : "missing",
      askType: askField.found ? (askField.value === null ? "null" : typeof askField.value) : "missing",
      timestampType: stampField.found ? (stampField.value === null ? "null" : typeof stampField.value) : "missing"
    });
    if (!bidField.found || !askField.found) {
      lastDiagnostic = { reason: "bid_or_ask_field_missing", ...shape() };
      continue;
    }
    if (!stampField.found || stampField.value === null || stampField.value === "") {
      lastDiagnostic = { reason: "source_timestamp_missing", ...shape() };
      continue;
    }
    const bidRaw = Number(bidField.value);
    const askRaw = Number(askField.value);
    const timestamp = Number(stampField.value);
    const bid = bidRaw / PRICE_SCALE;
    const ask = askRaw / PRICE_SCALE;
    if (!Number.isFinite(bidRaw) || !Number.isFinite(askRaw) || bid <= 0 || ask < bid) {
      lastDiagnostic = { reason: "invalid_bid_ask_values", ...shape() };
      continue;
    }
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
      quote: { bid, ask, timestamp },
      diagnostic: { reason: "accepted", ageBucket: ageMs < 1000 ? "under_1s" : "under_max_age", ...shape() }
    };
  }
  return { quote: null, diagnostic: lastDiagnostic ?? {
    reason: "matching_symbol_quote_unreadable", eventKeys: keySample(matching[0]), targetSymbolMatched: true
  } };
}
