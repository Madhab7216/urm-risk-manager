import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../cbot/URMScalperLocalPro.cs', import.meta.url), 'utf8');
const project = readFileSync(new URL('../cbot/URMScalperLocalPro.csproj', import.meta.url), 'utf8');

test('local strategy is an isolated cTrader cBot and starts with entry execution disabled', () => {
  assert.match(source, /class URMScalperLocalPro\s*:\s*Robot/);
  assert.match(source, /Enable new entries".*DefaultValue = false/);
  assert.match(source, /Allow Live entries \(explicit\)".*DefaultValue = false/);
  assert.match(source, /Allow Demo entries".*DefaultValue = true/);
  assert.match(project, /PackageReference Include="cTrader\.Automate" Version="1\.0\.21"/);
});

test('strategy uses closed M5 breakout plus M1 pullback and an explicit OB retest option', () => {
  assert.match(source, /MarketData\.GetBars\(TimeFrame\.Minute, Symbol\.Name\)/);
  assert.match(source, /MarketData\.GetBars\(TimeFrame\.Minute5, Symbol\.Name\)/);
  assert.match(source, /ProcessNewM5Close/);
  assert.match(source, /ProcessClosedM1Bar/);
  assert.match(source, /RequireOrderBlockRetest/);
  assert.match(source, /TryFindOrderBlock/);
  assert.match(source, /M1_CONFIRM/);
  assert.doesNotMatch(source, /var structureBroken/);
  assert.match(source, /if \(_pullbackCount >= MaxPullbackBars\)/);
  assert.match(source, /Include its wick so later bars/);
});

test('USD risk sizing is cross-checked against broker volume limits and margin', () => {
  assert.match(source, /AssetConverter\.Convert\(riskUsd, "USD", Account\.Asset\.Name\)/);
  assert.match(source, /private bool TryCalculateTicket/);
  assert.match(source, /VolumeForFixedRisk/);
  assert.match(source, /AmountRisked/);
  assert.match(source, /VolumeForFixedRisk/);
  assert.match(source, /NormalizeVolumeInUnits\(rawVolume, RoundingMode\.Down\)/);
  assert.match(source, /AmountRisked/);
  assert.match(source, /GetEstimatedMargin/);
  assert.match(source, /BlockEntriesWithForeignExposure/);
  assert.match(source, /FOREIGN_ACCOUNT_EXPOSURE_EXISTS/);
  assert.match(source, /ESTIMATED_RISK_OVER_BUDGET/);
});

test('every new order is checked for fill risk and server SL/TP readback', () => {
  assert.match(source, /ExecuteMarketOrder/);
  assert.match(source, /FILLED_ESTIMATED_RISK_OVER_BUDGET/);
  assert.match(source, /PROTECTION_READBACK_MISMATCH/);
  assert.match(source, /EmergencyClose/);
  assert.match(source, /Positions\.FindById/);
});

test('R management stores immutable original structural SL in position label', () => {
  assert.match(source, /BuildPositionLabel/);
  assert.match(source, /TryParseOriginalStop/);
  assert.match(source, /BreakEvenAtR/);
  assert.match(source, /LockToR/);
  assert.match(source, /TrailStartsAtR/);
  assert.match(source, /TrailGapR/);
  assert.match(source, /TrailFloorR/);
  assert.match(source, /MinimumStopAdvanceTicks/);
  assert.match(source, /SL_ADVANCED/);
  assert.match(source, /R_LADDER_THRESHOLDS_INCONSISTENT/);
  assert.match(source, /M1_PULLBACK_MIN_EXCEEDS_MAX/);
});

test('native candle-colour flip proxy is documented and order ownership is scoped', () => {
  assert.match(source, /bearish candle -> bullish candle/);
  assert.match(source, /bullish -> bearish/);
  assert.match(source, /LabelPrefix/);
  assert.match(source, /Only one URM instance per account\/symbol/);
});
