import test from "node:test";
import assert from "node:assert/strict";
import { parseQuoteEventPayload } from "../quote-data.mjs";

const NOW = 1_800_000_000_000;
const validCamel = {
  payloadType: 3,
  symbolId: 42,
  bid: 400_000_000,
  ask: 400_010_000,
  timestamp: NOW - 500
};

test("accepts documented cTrader camelCase ProtoQuoteEvent price units", () => {
  const result = parseQuoteEventPayload(validCamel, { expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000 });
  assert.deepEqual(result.quote, { bid: 4000, ask: 4000.1, timestamp: NOW - 500 });
  assert.equal(result.diagnostic.reason, "accepted");
});

test("accepts PascalCase SDK wrapper fields without relaxing validation", () => {
  const result = parseQuoteEventPayload({
    PayloadType: 3, SymbolId: "42", Bid: "400000000", Ask: "400010000", Timestamp: String(NOW - 500)
  }, { expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000 });
  assert.deepEqual(result.quote, { bid: 4000, ask: 4000.1, timestamp: NOW - 500 });
  assert.equal(result.diagnostic.bidField, "Bid");
  assert.equal(result.diagnostic.timestampField, "Timestamp");
});

test("reads a JSON-encoded payload envelope while preserving quote checks", () => {
  const result = parseQuoteEventPayload({
    payloadType: 3,
    payload: JSON.stringify({ SymbolId: 42, Bid: 400_000_000, Ask: 400_010_000, Timestamp: NOW - 500 })
  }, { expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000 });
  assert.equal(result.quote?.bid, 4000);
  assert.equal(result.diagnostic.reason, "accepted");
});

test("rejects a quote for a different symbol with a clear diagnostic", () => {
  const result = parseQuoteEventPayload({ ...validCamel, symbolId: 99 }, { expectedSymbolId: 42, nowMs: NOW });
  assert.equal(result.quote, null);
  assert.equal(result.diagnostic.reason, "symbol_id_mismatch");
});

test("rejects missing source timestamp and reports the field reason", () => {
  const { timestamp, ...withoutTimestamp } = validCamel;
  const result = parseQuoteEventPayload(withoutTimestamp, { expectedSymbolId: 42, nowMs: NOW });
  assert.equal(result.quote, null);
  assert.equal(result.diagnostic.reason, "source_timestamp_missing");
});

test("rejects stale source timestamps", () => {
  const result = parseQuoteEventPayload({ ...validCamel, timestamp: NOW - 10_001 }, {
    expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000
  });
  assert.equal(result.quote, null);
  assert.equal(result.diagnostic.reason, "source_timestamp_stale");
});

test("rejects source timestamps in the future", () => {
  const result = parseQuoteEventPayload({ ...validCamel, timestamp: NOW + 1 }, {
    expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000
  });
  assert.equal(result.quote, null);
  assert.equal(result.diagnostic.reason, "source_timestamp_in_future");
});

test("rejects invalid prices and never returns a partial quote", () => {
  const result = parseQuoteEventPayload({ ...validCamel, ask: 399_000_000 }, {
    expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000
  });
  assert.equal(result.quote, null);
  assert.equal(result.diagnostic.reason, "invalid_bid_ask_values");
});

test("diagnostics expose field names/types but not raw prices or account data", () => {
  const result = parseQuoteEventPayload({ ...validCamel, timestamp: undefined }, {
    expectedSymbolId: 42, nowMs: NOW, maxAgeMs: 10_000
  });
  assert.equal(result.quote, null);
  const encoded = JSON.stringify(result.diagnostic);
  assert.equal(encoded.includes(String(validCamel.bid)), false);
  assert.equal(encoded.includes(String(validCamel.ask)), false);
  assert.equal(encoded.includes("account"), false);
});
