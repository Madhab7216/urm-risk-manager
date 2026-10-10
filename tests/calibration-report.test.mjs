import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalibrationReport } from '../tools/validate-calibration-report.mjs';

const NOW = Date.parse('2026-10-10T06:00:00.000Z');
const ID = '0123456789abcdef0123456789abcdef';
function fixture(overrides = {}) {
  const ts = overrides.timestamp || '2026-10-10T05:59:55.000Z';
  const endTs = overrides.endTimestamp || '2026-10-10T05:59:56.000Z';
  const id = overrides.id || ID;
  const meta = `URM_CAL_V1|META|${id}|${ts}|Broker%20Demo|***789|USD|false|Hedged|1000|1010|950|true`;
  const symbol = `URM_CAL_V1|SYMBOL|${id}|XAUUSD|2|0.01|0.1|1|0.1|100|1|1|1000000|2000|2000.1|0.1|true`;
  const risk = `URM_CAL_V1|RISK|${id}|BUY|1999|2000.1|11|10|10|90|90|9.9|9.9|20|READY_DIAGNOSTIC_PREVIEW`;
  const rows = [
    `URM_CAL_V1|BEGIN|${id}`,
    meta,
    symbol,
    risk,
    `URM_CAL_V1|POSITION|${id}|1234|XAUUSD|BUY|90|2000|1999|2055|true|20`,
    `URM_CAL_V1|PENDING|${id}|5678|EURUSD|SELL|LIMIT|1000|1.1|10|15|false|5`,
    `URM_CAL_V1|END|${id}|${endTs}|1|1`,
    `URM_CAL_V1|NOTE|${id}|DIAGNOSTIC_ONLY|NOT_AUTHENTICATED|EXECUTION_DISABLED`
  ];
  let text = rows.join('\n');
  if (overrides.edit) text = overrides.edit(text);
  return text;
}

test('valid Demo report is parsed as diagnostic only and never unlocks execution', () => {
  const parsed = parseCalibrationReport(fixture(), { nowMs: NOW, expectedSymbol: 'XAUUSD' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 'CALIBRATION_REPORT_VALID_DIAGNOSTIC_ONLY');
  assert.equal(parsed.symbol.tickSize, 0.01);
  assert.equal(parsed.riskPreview.targetRiskUsd, 10);
  assert.equal(parsed.inventory.positions.length, 1);
  assert.equal(parsed.inventory.pendingOrders.length, 1);
  assert.equal(parsed.provenance.authenticated, false);
  assert.equal(parsed.executionAllowed, false);
  assert.equal(parsed.releaseGateCanBeUnlockedByThisReport, false);
});

test('empty input and missing marker fail closed', () => {
  assert.equal(parseCalibrationReport('').code, 'CALIBRATION_INPUT_EMPTY');
  assert.equal(parseCalibrationReport('ordinary log').code, 'CALIBRATION_MARKER_NOT_FOUND');
});

test('stale report is rejected', () => {
  const parsed = parseCalibrationReport(fixture({ timestamp: '2026-10-10T05:00:00.000Z', endTimestamp: '2026-10-10T05:00:01.000Z' }), { nowMs: NOW });
  assert.equal(parsed.code, 'CALIBRATION_REPORT_STALE');
});

test('future report is rejected', () => {
  const parsed = parseCalibrationReport(fixture({ timestamp: '2026-10-10T06:10:00.000Z', endTimestamp: '2026-10-10T06:10:01.000Z' }), { nowMs: NOW });
  assert.equal(parsed.code, 'CALIBRATION_TIMESTAMP_IN_FUTURE');
});

test('Live account report is blocked', () => {
  const parsed = parseCalibrationReport(fixture({ edit: t => t.replace('|USD|false|Hedged|', '|USD|true|Hedged|') }), { nowMs: NOW });
  assert.equal(parsed.code, 'CALIBRATION_LIVE_ACCOUNT_BLOCKED');
});

test('expected symbol mismatch is rejected', () => {
  assert.equal(parseCalibrationReport(fixture(), { nowMs: NOW, expectedSymbol: 'EURUSD' }).code, 'CALIBRATION_SYMBOL_MISMATCH');
});

test('missing END record is rejected', () => {
  const text = fixture().split('\n').filter(x => !x.includes('|END|')).join('\n');
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_REQUIRED_ROWS_MISSING_OR_DUPLICATED');
});

test('duplicate SYMBOL record is rejected', () => {
  const text = fixture({ edit: t => t.replace(/(URM_CAL_V1\|SYMBOL[^\n]*)/, '$1\n$1') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_REQUIRED_ROWS_MISSING_OR_DUPLICATED');
});

test('cross-snapshot row mix is rejected', () => {
  const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const text = fixture({ edit: t => t.replace(`URM_CAL_V1|POSITION|${ID}|`, `URM_CAL_V1|POSITION|${other}|`) });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_SNAPSHOT_ID_MISMATCH');
});

test('inventory row count mismatch is rejected', () => {
  const text = fixture({ edit: t => t.replace('|END|'+ID+'|2026-10-10T05:59:56.000Z|1|1', '|END|'+ID+'|2026-10-10T05:59:56.000Z|2|1') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_INVENTORY_COUNT_MISMATCH');
});

test('invalid tick grid and bad symbol metadata are rejected', () => {
  const text = fixture({ edit: t => t.replace(`|XAUUSD|2|0.01|0.1|`, `|XAUUSD|2|0|0.1|`) });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_SYMBOL_FIELDS_INVALID');
});

test('risk budget must remain exactly USD 10', () => {
  const text = fixture({ edit: t => t.replace('|11|10|10|90|', '|11|20|20|90|') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_RISK_FIELDS_INVALID');
});

test('disconnected server is rejected', () => {
  const text = fixture({ edit: t => t.replace('|1000|1010|950|true', '|1000|1010|950|false') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_SERVER_DISCONNECTED');
});

test('bad URI-encoded symbol field is rejected', () => {
  const text = fixture({ edit: t => t.replace('|XAUUSD|2|', '|%ZZ|2|') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_SYMBOL_FIELDS_INVALID');
});

test('zero or negative position volume is rejected', () => {
  const text = fixture({ edit: t => t.replace('|BUY|90|2000|1999|2055|true|20', '|BUY|0|2000|1999|2055|true|20') });
  assert.equal(parseCalibrationReport(text, { nowMs: NOW }).code, 'CALIBRATION_POSITION_FIELDS_INVALID');
});

test('trade manager evidence cannot authenticate pasted report', () => {
  const parsed = parseCalibrationReport(fixture(), { nowMs: NOW });
  assert.equal(parsed.provenance.source, 'USER_COPIED_CTRADER_ALGO_LOG');
  assert.equal(parsed.provenance.verifiedByPlatform, false);
  assert.equal(parsed.aggregateMaxExposureStatus, undefined);
  assert.equal(parsed.inventory.aggregateMaxExposureStatus, 'NOT_CALCULATED_IN_STAGE_G');
  assert.equal(parsed.executionAllowed, false);
});

test('negative free margin is preserved as signed diagnostic metadata', () => {
  const parsed = parseCalibrationReport(fixture({ edit: t => t.replace('|1000|1010|950|true', '|1000|1010|-25|true') }), { nowMs: NOW });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.account.freeMargin, -25);
  assert.equal(parsed.executionAllowed, false);
});


test('missing or malformed terminal NOTE fails closed', () => {
  const missing = fixture({ edit: t => t.split('\n').filter(x => !x.includes('|NOTE|')).join('\n') });
  assert.equal(parseCalibrationReport(missing, { nowMs: NOW }).code, 'CALIBRATION_REQUIRED_ROWS_MISSING_OR_DUPLICATED');
  const malformed = fixture({ edit: t => t.replace('DIAGNOSTIC_ONLY|NOT_AUTHENTICATED|EXECUTION_DISABLED', 'EXECUTION_ENABLED|AUTHENTICATED|READY') });
  assert.equal(parseCalibrationReport(malformed, { nowMs: NOW }).code, 'CALIBRATION_NOTE_INVALID');
});

test('any explicit BLOCK record makes the snapshot non-parseable as complete', () => {
  const blocked = fixture({ edit: t => t.replace(`URM_CAL_V1|BEGIN|${ID}`, `URM_CAL_V1|BLOCK|${ID}|SERVER_DISCONNECTED\nURM_CAL_V1|BEGIN|${ID}`) });
  assert.equal(parseCalibrationReport(blocked, { nowMs: NOW }).code, 'CALIBRATION_PROBE_BLOCKED');
});

test('a readiness status cannot conceal estimated risk above the USD 10 target', () => {
  const over = fixture({ edit: t => t.replace('|90|90|9.9|9.9|20|READY_DIAGNOSTIC_PREVIEW', '|90|90|10.5|10.5|20|READY_DIAGNOSTIC_PREVIEW') });
  assert.equal(parseCalibrationReport(over, { nowMs: NOW }).code, 'CALIBRATION_RISK_STATUS_CONTRADICTS_VALUES');
});

test('duplicate position or pending-order IDs are rejected', () => {
  const duplicatePosition = fixture({ edit: t => t.replace('URM_CAL_V1|END|', `URM_CAL_V1|POSITION|${ID}|1234|XAUUSD|BUY|90|2000|1999|2055|true|20\nURM_CAL_V1|END|`).replace('|2026-10-10T05:59:56.000Z|1|1', '|2026-10-10T05:59:56.000Z|2|1') });
  assert.equal(parseCalibrationReport(duplicatePosition, { nowMs: NOW }).code, 'CALIBRATION_DUPLICATE_INVENTORY_ID');
});


test('timestamp without explicit UTC designator is rejected', () => {
  const localTime = fixture({ edit: t => t.replace('2026-10-10T05:59:55.000Z', '2026-10-10T05:59:55.000').replace('2026-10-10T05:59:56.000Z', '2026-10-10T05:59:56.000') });
  assert.equal(parseCalibrationReport(localTime, { nowMs: NOW }).code, 'CALIBRATION_TIMESTAMP_INVALID');
});

test('unmasked account identifiers are rejected by the report parser', () => {
  const unmasked = fixture({ edit: t => t.replace('|***789|', '|123456789|') });
  assert.equal(parseCalibrationReport(unmasked, { nowMs: NOW }).code, 'CALIBRATION_ACCOUNT_FIELDS_INVALID');
});
