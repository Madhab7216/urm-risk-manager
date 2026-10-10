# URM Risk Manager — Changelog

## Stage G v1.0 — 10 October 2026

- Added a separate Demo-only, read-only cTrader Algo calibration probe using platform-side `TickSize`, `VolumeForFixedRisk`, `AmountRisked`, estimated margin and `AssetConverter` calls.
- Probe reads the current cBot account's open positions and pending orders into a structured diagnostic snapshot; account IDs and labels are masked/reduced before output.
- Added a local report validator with timestamp/snapshot consistency checks, Demo-only parsing, symbol checking, required terminal NOTE verification, BLOCK-row rejection, schema validation, inventory ID de-duplication and consistency between a ready status and the reported risk values.
- The validator always keeps `authenticated:false`, `executionAllowed:false` and `releaseGateCanBeUnlockedByThisReport:false`; pasted text cannot authorize trading.
- Added execution-authority decision: no supported authenticated Plugin↔cBot bridge is assumed. The Web Plugin remains preview-only and the cBot probe is not connected to it.
- Added a second connection/account-identity check before completing a diagnostic snapshot; if context changes mid-run the probe does not emit a valid END record.
- Added signed formatting for free margin so a legitimate negative free-margin snapshot remains parseable as diagnostic data rather than silently becoming `NA`.
- Added platform TickSize-grid checks for the user-entered structural SL and current Bid/Ask; an off-grid price blocks sizing preview rather than being silently rounded.
- Updated Web Plugin visible title/status to Stage G while preserving the hard execution lock.
- Local test result: 193 passed, 0 failed, 0 skipped. C# compilation, real cTrader WebView payloads and broker Demo execution are not verified.

## Stage F v1.0 — 10 October 2026

- Added account profile, evidence freshness and broker minimum-distance gating for a non-executable preview.
- Kept TickSize and aggregate maxExposure validation explicitly unresolved in the Web Plugin path.
- Local test result at that stage: 162 passed, 0 failed. No C# compile or broker-host Demo test.

## Stage E v1.1

- Added trusted tick-grid gate to the order-intent helper and separate read-only C# position observer prototype.

## Stage D v1.1

- Hardened partial-fill planning, remaining-order cancellation reconciliation, account isolation and late-callback handling in the execution lifecycle prototype.

## Stage C v1.3

- Added execution-event correlation, order/fill/protection state separation and safer unresolved-state handling in mocks.

## Stage B v1.1

- Added plugin risk preview adapter with fixed $10 target price-risk and separate commission estimate.

## Stage A v1.0

- Created standalone JavaScript risk core and initial local test suite.
