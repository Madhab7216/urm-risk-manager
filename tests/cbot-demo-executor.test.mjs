import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'cbot/URMDemoOneShotExecutor.cs'), 'utf8');
const guide = readFileSync(resolve(root, 'URM_DEMO_ONE_SHOT_EXECUTOR_GUIDE.md'), 'utf8');

test('one-shot cBot is Demo-only with opt-in confirmation disabled by default', () => {
  assert.match(source, /Application\.EnvironmentType != EnvironmentType\.Desktop/);
  assert.match(source, /if\s*\(Account\.IsLive\)/);
  assert.match(source, /\[Parameter\("Confirm one-shot DEMO order", DefaultValue = false\)\]/);
  assert.match(source, /if\s*\(!ConfirmOneShotDemoOrder\)/);
  assert.match(source, /Account\.AccountType\.ToString\(\)/);
});

test('preflight requires a fresh platform tick and exact broker tick grid', () => {
  assert.match(source, /MarketData\.GetTicks\(symbol\.Name\)/);
  assert.match(source, /tickAgeSeconds > MaxTickAgeSeconds/);
  assert.match(source, /symbol\.TickSize/);
  assert.match(source, /STRUCTURAL_SL_OFF_TICK_GRID/);
  assert.match(source, /SPREAD_TOO_WIDE/);
  assert.match(source, /!symbol\.MarketHours\.IsOpened\(\)/);
});

test('fixed USD 10 risk sizing rounds down and rechecks estimated loss', () => {
  assert.match(source, /private const double TargetRiskUsd = 10\.0/);
  assert.match(source, /BuildPositionLabel\(StructuralStopPrice, symbol\.Digits\)/);
  assert.match(source, /URM1\|ID=/);
  assert.match(source, /\|SL=/);
  assert.match(source, /AssetConverter\.Convert\(TargetRiskUsd, "USD", Account\.Asset\.Name\)/);
  assert.match(source, /VolumeForFixedRisk\(budgetInDeposit, stopDistancePips, RoundingMode\.Down\)/);
  assert.match(source, /NormalizeVolumeInUnits\(rawVolume, RoundingMode\.Down\)/);
  assert.match(source, /symbol\.AmountRisked\(volume, stopDistancePips\)/);
  assert.match(source, /RISK_ABOVE_USD_10/);
});

test('order request includes initial protection and verifies structural SL plus fill-anchored 5R TP', () => {
  assert.match(source, /ExecuteMarketOrder\(Direction, symbol\.Name, volume, orderLabel,[\s\S]*?stopDistancePips, takeProfitDistancePips/);
  assert.match(source, /ModifyPosition\(position, StructuralStopPrice, absoluteTarget/);
  assert.match(source, /SERVER_PROTECTION_READBACK_MISMATCH/);
  assert.match(source, /CloseAfterProtectionProblem\(position,/);
  assert.match(source, /ORDER_PROTECTED/);
});

test('executor blocks pre-existing exposure and never auto-retries', () => {
  assert.match(source, /Positions\.Count != 0/);
  assert.match(source, /PendingOrders\.Count != 0/);
  assert.match(source, /NO_AUTO_RETRY/);
  assert.match(source, /ORDER_CALL_EXCEPTION/);
  assert.match(guide, /Do not click Start again or automatically retry/);
});

test('guide explains native cBot is not the WebView plugin and C# compile remains required', () => {
  assert.match(guide, /not connected to the WebView plugin/i);
  assert.match(guide, /Confirm one-shot DEMO order = false/);
  assert.ok(guide.toLowerCase().includes("has **not** been compiled in your local ctrader automate version"));
  assert.match(guide, /Do not use it on a Live account/i);
});
