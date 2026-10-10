import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../cbot/URMCalibrationProbe.cs', import.meta.url), 'utf8');

test('calibration cBot is explicitly Demo-only and read-only', () => {
  assert.match(src, /if\s*\(Account\.IsLive\)/);
  assert.match(src, /LIVE_ACCOUNT_NOT_ALLOWED/);
  for (const forbidden of [
    'ExecuteMarketOrder(', 'PlaceLimitOrder(', 'PlaceStopOrder(', 'PlaceStopLimitOrder(',
    'ModifyPosition(', 'ModifyPendingOrder(', 'CancelPendingOrder(', 'ClosePosition('
  ]) assert.equal(src.includes(forbidden), false, `Unexpected trade mutation API: ${forbidden}`);
});

test('probe uses cTrader authoritative tick, pip, volume and monetary risk APIs', () => {
  for (const expected of [
    'probeSymbol.TickSize', 'probeSymbol.PipSize', 'probeSymbol.VolumeInUnitsMin',
    'probeSymbol.VolumeInUnitsStep', 'probeSymbol.VolumeInUnitsMax',
    'VolumeForFixedRisk(', 'AmountRisked(', 'AssetConverter.Convert(',
    'Symbols.GetSymbol(', 'Positions', 'PendingOrders'
  ]) assert.ok(src.includes(expected), `Expected official API use missing: ${expected}`);
});

test('probe never emits raw account number or full labels', () => {
  assert.match(src, /MaskAccount\(rawAccountNumber/);
  assert.match(src, /IsUrmLabel\(position\.Label\)/);
  assert.match(src, /IsUrmLabel\(order\.Label\)/);
  assert.equal(src.includes('Encode(position.Label)'), false);
  assert.equal(src.includes('Encode(order.Label)'), false);
});

test('snapshot protocol includes matching begin/end and diagnostic-only note', () => {
  assert.match(src, /URM_CAL_V1\|BEGIN\|\{0\}/);
  assert.match(src, /Emit\("END"/);
  assert.match(src, /DIAGNOSTIC_ONLY\|NOT_AUTHENTICATED\|EXECUTION_DISABLED/);
});

test('probe uses a fixed USD 10 target and rounds volume down', () => {
  assert.match(src, /private const double TargetRiskUsd = 10\.0/);
  assert.match(src, /RoundingMode\.Down/);
});

test('probe preserves signed free-margin data and rechecks account/server context before END', () => {
  assert.match(src, /FSigned\(Account\.FreeMargin\)/);
  assert.match(src, /private static string FSigned\(double value\)/);
  assert.match(src, /accountChanged\s*=\s*!string\.Equals/);
  assert.match(src, /if\s*\(!Server\.IsConnected\s*\|\|\s*accountChanged\)/);
  assert.match(src, /ACCOUNT_CONTEXT_CHANGED_DURING_SNAPSHOT/);
  assert.match(src, /SERVER_DISCONNECTED_DURING_SNAPSHOT/);
});

test('calibration cBot does not emit a completed snapshot after a context-change guard', () => {
  const guard = src.indexOf('if (!Server.IsConnected || accountChanged)');
  const stop = src.indexOf('Stop();', guard);
  const end = src.indexOf('Emit("END"', guard);
  assert.ok(guard >= 0 && stop > guard && end > stop, 'context guard must stop before END emission');
});


test('risk calibration blocks structural stops and current quotes that are off the platform tick grid', () => {
  assert.match(src, /IsOnTickGrid\(stop, symbol\.TickSize\)/);
  assert.match(src, /BLOCK_STOP_OFF_TICK_GRID/);
  assert.match(src, /IsOnTickGrid\(entryReference, symbol\.TickSize\)/);
  assert.match(src, /BLOCK_QUOTE_OFF_TICK_GRID/);
  assert.match(src, /private static bool IsOnTickGrid\(double price, double tickSize\)/);
});
