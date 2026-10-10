# URM Stage G v1.0 — Automated Test Report

**Scope:** local JavaScript unit tests, inline Web Plugin syntax/build invariants, account/evidence and broker-constraint checks, execution lifecycle mocks, R-position policy, copied calibration report parsing and static assertions about the Demo-only read-only C# calibration probe. This is not a cTrader host, C# compiler, or broker integration test.

## Commands

```bash
for f in risk-core.mjs plugin-policy.mjs account-profile.mjs evidence-integrity.mjs broker-constraints.mjs execution-engine.mjs position-manager-policy.mjs tools/validate-calibration-report.mjs; do
  node --check "$f" || exit 1
done
node --test tests/*.test.mjs
```

The plugin-build test extracts the inline `<script type="module">` block from `index.html` and syntax-checks it with Node. Static C# tests assert that the calibration probe includes Demo-only guards and does not contain trade mutation calls; they are **not C# compilation**.

## Latest local result

**193 passed, 0 failed, 0 skipped.**

Coverage includes:

- USD 10 estimated price-risk budget and down-rounded volume sizing.
- 5R TP and R policy: +1R BE, +2R → +1.7R, +3R 1R favourable-only trailing with +2R floor.
- Account model/profile consistency and stale evidence rejection.
- Manual pip-value/FX/commission evidence bound to account, symbol, value, source and declared age.
- Broker minimum stop/TP-distance and unresolved tick-grid/max-exposure checks.
- Mock execution lifecycle: order intent identity, accepted-vs-filled, partial fill, cancellation and unresolved/late event paths.
- Calibration report validation: stale/future, live account, wrong symbol, missing/duplicate rows, cross-snapshot mix, invalid metadata, incorrect risk budget, disconnection, inventory-count mismatch, missing/malformed NOTE, explicit BLOCK records, duplicate inventory IDs, readiness-status/risk-value contradiction, non-UTC timestamps and unmasked account identifiers.
- C# source static assertions: explicit Live-account rejection, no order/position mutation methods, platform TickSize/risk/conversion APIs, masked account and no raw labels, signed free-margin formatting, structural-SL/quote tick-grid guards, account/server recheck and snapshot END/block contract.
- ZIP/report/UI build safety invariants.

## What this result does not prove

- C# files have not been compiled against the exact installed cTrader Algo assemblies; this runtime has no `dotnet`, `csc`, or `mcs` compiler.
- No calibration probe was run inside cTrader Automate.
- No actual cTrader WebView handshake or broker SDK payload was captured in this environment.
- No broker Demo order/fill/protection/cancel/partial-fill test has been run.
- The copied calibration report is not cryptographically authenticated; it cannot authorize execution.
- Platform risk helpers are estimates, not a guarantee of exact $10 realized loss.
- Plugin↔cBot authenticated bridge and authoritative maxExposure aggregation remain unresolved.

The package is diagnostic-only; order submission is disabled.
