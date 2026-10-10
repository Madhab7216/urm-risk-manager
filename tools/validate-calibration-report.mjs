#!/usr/bin/env node
/**
 * Validates a user-copied URM_CAL_V1 report emitted by URMCalibrationProbe.cs.
 * The report is NOT authenticated and can NEVER unlock order execution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'URM_CAL_V1';
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const finite = v => Number.isFinite(Number(v)) && String(v).trim() !== '' && v !== 'NA';
const numeric = v => finite(v) ? Number(v) : NaN;
const decode = v => {
  try { return decodeURIComponent(v); } catch { return null; }
};
const fail = (code, message) => ({ ok: false, code, message, diagnosticOnly: true, authenticated: false, executionAllowed: false });

function parseBoolean(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
function parseIso(v) {
  // The probe emits DateTime.ToString("O") from Server.TimeInUtc.
  // Require explicit UTC to avoid local-time interpretation ambiguity.
  if (typeof v !== 'string' || !/(?:Z|\+00:00)$/.test(v)) return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}
function rowMap(lines) {
  const rows = [];
  for (const raw of lines) {
    const i = raw.indexOf(`${SCHEMA}|`);
    if (i < 0) continue;
    const fields = raw.slice(i).trim().split('|');
    if (fields[0] !== SCHEMA) continue;
    rows.push(fields);
  }
  return rows;
}

export function parseCalibrationReport(text, {
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  expectedSymbol = null,
  requireDemo = true
} = {}) {
  if (typeof text !== 'string' || !text.trim()) return fail('CALIBRATION_INPUT_EMPTY', 'Paste the complete URM_CAL_V1 BEGIN-to-END report.');
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return fail('CALIBRATION_CLOCK_OPTIONS_INVALID', 'Validator clock options are invalid.');

  let rows;
  try { rows = rowMap(text.split(/\r?\n/)); }
  catch (error) { return fail(error.message || 'CALIBRATION_PARSE_ERROR', 'A report field could not be decoded.'); }
  if (!rows.length) return fail('CALIBRATION_MARKER_NOT_FOUND', 'No URM_CAL_V1 report records were found.');

  const byType = new Map();
  for (const row of rows) {
    if (row.length < 2) return fail('CALIBRATION_ROW_INVALID', 'A report row has too few fields.');
    const type = row[1];
    if (!['BEGIN','META','SYMBOL','RISK','POSITION','PENDING','END','NOTE','BLOCK'].includes(type)) {
      return fail('CALIBRATION_ROW_TYPE_UNKNOWN', `Unknown report row type: ${type}`);
    }
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(row);
  }
  const one = type => {
    const list = byType.get(type) || [];
    return list.length === 1 ? list[0] : null;
  };
  const begin = one('BEGIN'), meta = one('META'), symbol = one('SYMBOL'), risk = one('RISK'), end = one('END'), note = one('NOTE');
  if ((byType.get('BLOCK') || []).length) return fail('CALIBRATION_PROBE_BLOCKED', 'The probe emitted a BLOCK record; discard this snapshot and inspect the cBot log.');
  if (!begin || !meta || !symbol || !risk || !end || !note) return fail('CALIBRATION_REQUIRED_ROWS_MISSING_OR_DUPLICATED', 'Exactly one BEGIN, META, SYMBOL, RISK, END and NOTE row is required.');
  if (begin.length !== 3 || end.length !== 6 || meta.length !== 13 || symbol.length !== 17 || risk.length !== 15 || note.length !== 6) {
    return fail('CALIBRATION_ROW_LENGTH_INVALID', 'One or more required records do not match URM_CAL_V1 field counts.');
  }
  if (note[3] !== 'DIAGNOSTIC_ONLY' || note[4] !== 'NOT_AUTHENTICATED' || note[5] !== 'EXECUTION_DISABLED') {
    return fail('CALIBRATION_NOTE_INVALID', 'The terminal NOTE row does not carry the required diagnostic-only and execution-disabled flags.');
  }

  const snapshotId = begin[2];
  if (!/^[0-9a-f]{32}$/i.test(snapshotId)) return fail('CALIBRATION_SNAPSHOT_ID_INVALID', 'Snapshot identifier is invalid.');
  for (const row of [meta, symbol, risk, end, ...(byType.get('POSITION') || []), ...(byType.get('PENDING') || []), ...(byType.get('NOTE') || []), ...(byType.get('BLOCK') || [])]) {
    if (row[2] !== snapshotId) return fail('CALIBRATION_SNAPSHOT_ID_MISMATCH', 'Records from different snapshots were mixed.');
  }

  const metaAt = parseIso(meta[3]);
  const endedAt = parseIso(end[3]);
  if (!Number.isFinite(metaAt) || !Number.isFinite(endedAt) || endedAt < metaAt) return fail('CALIBRATION_TIMESTAMP_INVALID', 'Snapshot UTC timestamps are invalid.');
  if (metaAt > nowMs + 30_000 || endedAt > nowMs + 30_000) return fail('CALIBRATION_TIMESTAMP_IN_FUTURE', 'Snapshot time is ahead of the validator clock.');
  if (nowMs - endedAt > maxAgeMs) return fail('CALIBRATION_REPORT_STALE', 'Calibration report is older than the allowed diagnostic window.');
  if (endedAt - metaAt > 120_000) return fail('CALIBRATION_SNAPSHOT_TOO_LONG', 'Snapshot took too long; repeat the read-only probe.');

  const brokerName = decode(meta[4]);
  const maskedAccount = meta[5];
  const currency = meta[6];
  const isLive = parseBoolean(meta[7]);
  const accountTypeRaw = decode(meta[8]);
  const balance = numeric(meta[9]);
  const equity = meta[10] === 'NA' ? null : numeric(meta[10]);
  const freeMargin = numeric(meta[11]);
  const connected = parseBoolean(meta[12]);
  if (!brokerName || !/^\*+(?:[0-9]{3})?$/.test(maskedAccount) || !/^[A-Z]{3}$/.test(currency) || isLive === null || !accountTypeRaw ||
      !Number.isFinite(balance) || (equity !== null && !Number.isFinite(equity)) || !Number.isFinite(freeMargin) || connected === null) {
    return fail('CALIBRATION_ACCOUNT_FIELDS_INVALID', 'Account metadata is incomplete or invalid.');
  }
  if (requireDemo && isLive) return fail('CALIBRATION_LIVE_ACCOUNT_BLOCKED', 'This diagnostic tool accepts Demo-account reports only.');
  if (!connected) return fail('CALIBRATION_SERVER_DISCONNECTED', 'The cBot reported that its server connection was down.');

  const symbolName = decode(symbol[3]);
  const digits = numeric(symbol[4]);
  const tickSize = numeric(symbol[5]);
  const pipSize = numeric(symbol[6]);
  const pipValueAtStart = numeric(symbol[7]);
  const tickValueAtStart = numeric(symbol[8]);
  const lotSize = numeric(symbol[9]);
  const volumeMin = numeric(symbol[10]);
  const volumeStep = numeric(symbol[11]);
  const volumeMax = numeric(symbol[12]);
  const bid = numeric(symbol[13]);
  const ask = numeric(symbol[14]);
  const spread = numeric(symbol[15]);
  const marketOpen = parseBoolean(symbol[16]);
  if (!symbolName || !Number.isInteger(digits) || digits < 0 || digits > 12 ||
      ![tickSize,pipSize,pipValueAtStart,tickValueAtStart,lotSize,volumeMin,volumeStep,volumeMax,bid,ask,spread].every(Number.isFinite) ||
      tickSize <= 0 || pipSize <= 0 || pipValueAtStart <= 0 || tickValueAtStart <= 0 || lotSize <= 0 ||
      volumeMin <= 0 || volumeStep <= 0 || volumeMax < volumeMin || bid <= 0 || ask < bid || spread < 0 || marketOpen === null) {
    return fail('CALIBRATION_SYMBOL_FIELDS_INVALID', 'Symbol metadata is incomplete or invalid.');
  }
  if (expectedSymbol && symbolName.toUpperCase() !== String(expectedSymbol).trim().toUpperCase()) {
    return fail('CALIBRATION_SYMBOL_MISMATCH', `Expected ${expectedSymbol}, received ${symbolName}.`);
  }

  const side = risk[3];
  const stopPrice = risk[4] === 'NA' ? null : numeric(risk[4]);
  const entryReference = risk[5] === 'NA' ? null : numeric(risk[5]);
  const stopDistancePips = risk[6] === 'NA' ? null : numeric(risk[6]);
  const targetRiskUsd = numeric(risk[7]);
  const targetRiskDeposit = risk[8] === 'NA' ? null : numeric(risk[8]);
  const rawVolume = risk[9] === 'NA' ? null : numeric(risk[9]);
  const normalizedVolume = risk[10] === 'NA' ? null : numeric(risk[10]);
  const estimatedRiskDeposit = risk[11] === 'NA' ? null : numeric(risk[11]);
  const estimatedRiskUsd = risk[12] === 'NA' ? null : numeric(risk[12]);
  const estimatedMargin = risk[13] === 'NA' ? null : numeric(risk[13]);
  const riskStatus = risk[14];
  if (!['BUY','SELL','INVALID'].includes(side) || !Number.isFinite(targetRiskUsd) || Math.abs(targetRiskUsd - 10) > 1e-9 ||
      !riskStatus || [stopPrice,entryReference,stopDistancePips,targetRiskDeposit,rawVolume,normalizedVolume,estimatedRiskDeposit,estimatedRiskUsd,estimatedMargin].some(v => v !== null && !Number.isFinite(v))) {
    return fail('CALIBRATION_RISK_FIELDS_INVALID', 'Risk preview metadata is invalid or does not match the fixed USD 10 policy.');
  }

  const positions = [];
  for (const row of byType.get('POSITION') || []) {
    if (row.length !== 12 || row[2] !== snapshotId) return fail('CALIBRATION_POSITION_ROW_INVALID', 'A position inventory row is malformed.');
    const id = numeric(row[3]), volume = numeric(row[6]), entry = numeric(row[7]);
    const sl = row[8] === 'NA' ? null : numeric(row[8]);
    const tp = row[9] === 'NA' ? null : numeric(row[9]);
    const isUrm = parseBoolean(row[10]);
    const margin = row[11] === 'NA' ? null : numeric(row[11]);
    const positionSymbol = decode(row[4]);
    if (![id,volume,entry].every(Number.isFinite) || !Number.isSafeInteger(id) || id <= 0 || volume <= 0 || entry <= 0 ||
      !positionSymbol || !['BUY','SELL'].includes(row[5]) || (sl !== null && !Number.isFinite(sl)) ||
      (tp !== null && !Number.isFinite(tp)) || isUrm === null || (margin !== null && !Number.isFinite(margin))) {
      return fail('CALIBRATION_POSITION_FIELDS_INVALID', 'A position inventory row contains invalid values.');
    }
    positions.push({ id, symbol: positionSymbol, side: row[5], volumeInUnits: volume, entryPrice: entry,
      stopLoss: sl, takeProfit: tp, isUrmLabel: isUrm, estimatedMargin: margin });
  }

  const pendingOrders = [];
  for (const row of byType.get('PENDING') || []) {
    if (row.length !== 13 || row[2] !== snapshotId) return fail('CALIBRATION_PENDING_ROW_INVALID', 'A pending-order inventory row is malformed.');
    const id = numeric(row[3]), volume = numeric(row[7]), target = numeric(row[8]);
    const slPips = row[9] === 'NA' ? null : numeric(row[9]);
    const tpPips = row[10] === 'NA' ? null : numeric(row[10]);
    const isUrm = parseBoolean(row[11]);
    const margin = row[12] === 'NA' ? null : numeric(row[12]);
    const orderSymbol = decode(row[4]);
    if (![id,volume,target].every(Number.isFinite) || !Number.isSafeInteger(id) || id <= 0 || volume <= 0 || target <= 0 ||
      !orderSymbol || !['BUY','SELL'].includes(row[5]) || !decode(row[6]) ||
      (slPips !== null && !Number.isFinite(slPips)) || (tpPips !== null && !Number.isFinite(tpPips)) ||
      isUrm === null || (margin !== null && !Number.isFinite(margin))) {
      return fail('CALIBRATION_PENDING_FIELDS_INVALID', 'A pending-order inventory row contains invalid values.');
    }
    pendingOrders.push({ id, symbol: orderSymbol, side: row[5], orderType: decode(row[6]), volumeInUnits: volume,
      targetPrice: target, stopLossPips: slPips, takeProfitPips: tpPips, isUrmLabel: isUrm, estimatedMargin: margin });
  }

  if (new Set(positions.map(x => x.id)).size !== positions.length || new Set(pendingOrders.map(x => x.id)).size !== pendingOrders.length) {
    return fail('CALIBRATION_DUPLICATE_INVENTORY_ID', 'A position or pending-order ID appears more than once in the snapshot.');
  }
  if (numeric(end[4]) !== positions.length || numeric(end[5]) !== pendingOrders.length) {
    return fail('CALIBRATION_INVENTORY_COUNT_MISMATCH', 'Declared position/order counts do not match the rows included in the report.');
  }
  if (['READY_DIAGNOSTIC_PREVIEW','CAPPED_TO_SYMBOL_MAX_DIAGNOSTIC_ONLY'].includes(riskStatus)) {
    if (!(normalizedVolume > 0) || normalizedVolume < volumeMin || normalizedVolume > volumeMax ||
        !(stopDistancePips > 0) || !(entryReference > 0) || !(stopPrice > 0) ||
        !(estimatedRiskUsd >= 0) || estimatedRiskUsd > targetRiskUsd + 0.01) {
      return fail('CALIBRATION_RISK_STATUS_CONTRADICTS_VALUES', 'Risk preview claims readiness but volume, stop/entry, or estimated risk fields contradict the fixed-risk rules.');
    }
  }
  const reportAgeMs = nowMs - endedAt;
  return {
    ok: true,
    code: 'CALIBRATION_REPORT_VALID_DIAGNOSTIC_ONLY',
    schema: SCHEMA,
    snapshotId,
    generatedAtUtc: new Date(metaAt).toISOString(),
    endedAtUtc: new Date(endedAt).toISOString(),
    reportAgeMs,
    account: { brokerName, maskedAccount, currency, isLive, accountType: accountTypeRaw, balance, equity, freeMargin, connected },
    symbol: { name: symbolName, digits, tickSize, pipSize, pipValueAtStart, tickValueAtStart, lotSize,
      volumeMin, volumeStep, volumeMax, bid, ask, spread, marketOpen },
    riskPreview: { side, stopPrice, entryReference, stopDistancePips, targetRiskUsd, targetRiskDeposit,
      rawVolume, normalizedVolume, estimatedRiskDeposit, estimatedRiskUsd, estimatedMargin, status: riskStatus },
    inventory: { positions, pendingOrders, openPositionCount: positions.length, pendingOrderCount: pendingOrders.length,
      aggregateMaxExposureStatus: 'NOT_CALCULATED_IN_STAGE_G' },
    provenance: { source: 'USER_COPIED_CTRADER_ALGO_LOG', authenticated: false, verifiedByPlatform: false },
    diagnosticOnly: true,
    executionAllowed: false,
    releaseGateCanBeUnlockedByThisReport: false,
    notes: [
      'This report is user-copied and not cryptographically authenticated.',
      'cTrader Symbol.PipValue/TickValue are values as of cBot start and are not updated in real time.',
      'VolumeForFixedRisk/AmountRisked are estimates; actual loss can differ due to fill, gaps, slippage and conversion movement.',
      'Current position/order inventory is diagnostic only and does not establish an authoritative broker maxExposure calculation.'
    ]
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const symbolIndex = args.indexOf('--symbol');
  const expectedSymbol = symbolIndex >= 0 ? args[symbolIndex + 1] : null;
  if (!file) {
    console.error('Usage: node tools/validate-calibration-report.mjs <calibration-report.txt> [--symbol XAUUSD]');
    process.exitCode = 2;
    return;
  }
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const result = parseCalibrationReport(text, { expectedSymbol });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main().catch(err => { console.error(err.message); process.exitCode = 1; });
