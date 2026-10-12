import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../cbot/URMCloudOneShotLadder.cs', import.meta.url), 'utf8');

test('Cloud combined cBot is Demo-only and defaults to no order submission', () => {
  assert.match(source, /class URMCloudOneShotLadder\s*:\s*Robot/);
  assert.match(source, /Account\.IsLive/);
  assert.match(source, /Account\.AccountType\.ToString\(\)/);
  assert.match(source, /Confirm one-shot DEMO order", DefaultValue = false/);
});

test('Cloud cBot avoids Desktop-only and non-durable local storage assumptions', () => {
  assert.doesNotMatch(source, /EnvironmentType\.Desktop/);
  assert.doesNotMatch(source, /LocalStorage\.Flush|LocalStorage\.SetString|LocalStorage\.GetString/);
  assert.doesNotMatch(source, /System\.IO|DllImport|Windows\.Forms|System\.Windows/);
});

test('One-shot order requires explicit confirmation and broker-side protection readback', () => {
  assert.match(source, /if \(ConfirmOneShotDemoOrder\)/);
  assert.match(source, /Positions\.Count != 0 \|\| PendingOrders\.Count != 0/);
  assert.match(source, /VolumeForFixedRisk/);
  assert.match(source, /ProtectionType\.Absolute/);
  assert.match(source, /PROTECTION_READBACK_MISMATCH/);
  assert.match(source, /CloseAfterProtectionProblem/);
});

test('R ladder only manages URM-labelled positions and preserves server TP', () => {
  assert.match(source, /TryParseLabel\(position\.Label/);
  assert.match(source, /BreakEvenAtR = 1\.0/);
  assert.match(source, /LockToR = 1\.7/);
  assert.match(source, /TrailGapR = 1\.0/);
  assert.match(source, /TrailFloorR = 2\.0/);
  assert.match(source, /TakeProfitR = 5\.0/);
  assert.match(source, /ModifyPosition\(position, targetSL, oldTP, ProtectionType\.Absolute/);
  assert.match(source, /SERVER_READBACK_MISMATCH/);
});
