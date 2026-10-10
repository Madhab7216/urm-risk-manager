# URM cTrader Advanced Risk Manager — Stage G v1.0

**Status: diagnostic calibration build only. Order submission is locked.** This stage adds a Demo-only, read-only cTrader Algo calibration probe and a local validator for its copied output. It does not enable live trading, does not authenticate pasted reports, and does not connect the Web Plugin to the cBot.

## Approved risk policy

- Fixed target: **USD 10 estimated price-risk per trade**. This is not a guaranteed maximum realized loss.
- Commission is displayed separately and excluded from volume sizing by user decision.
- Entry remains manual. The user selects the structural stop-loss.
- TP target: **5R** from the actual fill and immutable initial structural-stop distance.
- **+1R:** proposed SL at break-even.
- **+2R:** proposed SL at +1.7R.
- **+3R:** activate a 1R favourable-only trailing gap with a +2R minimum lock.
- Original R must not be recalculated from a tightened SL.
- One authoritative component must own SL/TP changes per position.

## What Stage G adds

1. **Demo-only, read-only calibration cBot** (`cbot/URMCalibrationProbe.cs`). It refuses to run on a live account, reads the cTrader Algo account/symbol/positions/pending orders, and emits a structured report. It does not submit, modify, cancel, or close trades.
2. **Platform-calculated risk cross-check.** The probe uses cTrader Algo's `TickSize`, `PipSize`, `VolumeForFixedRisk`, `NormalizeVolumeInUnits`, `AmountRisked`, `GetEstimatedMargin`, and `AssetConverter` APIs for a diagnostic estimate. cTrader's documentation explicitly describes fixed-risk/amount-risked outputs as estimates; actual loss can differ because price and conversion rates move.
3. **Account inventory snapshot.** The probe lists open positions and pending orders available to the cBot's account context. This inventory is diagnostic and is not a cryptographically authenticated Web Plugin snapshot.
4. **Local report parser** (`tools/validate-calibration-report.mjs`). It validates syntax, snapshot consistency, staleness, UTC timestamps, masked account identifier, symbol expectations, Demo flag, required terminal NOTE, explicit BLOCK records, duplicate inventory IDs, inventory counts and the fixed $10 policy. It always returns `authenticated:false`, `executionAllowed:false`, and `releaseGateCanBeUnlockedByThisReport:false`.
5. **Tests** for report parsing and cBot static safety properties, including off-tick-grid stop/quote guards.
6. **Execution authority decision** explains why the Web Plugin and cBot are not assumed to share state or a control channel.

## Project layout

- `index.html` — cTrader Web Plugin UI; preview only, execution locked.
- `risk-core.mjs` — core fixed-USD price-risk sizing and R ladder.
- `plugin-policy.mjs` — plugin-facing risk preview validation.
- `account-profile.mjs` — account identity/freshness profile and supported-account policy.
- `evidence-integrity.mjs` — source/value/context/age binding for user attestations.
- `broker-constraints.mjs` — broker minimum-distance checks; does not certify Plugin-side tick grid or aggregate exposure.
- `execution-engine.mjs` — testable execution lifecycle prototype; not enabled for submission.
- `position-manager-policy.mjs` — pure R-policy/label calculator with source/timestamp-bound tick-grid guard.
- `cbot/URMCalibrationProbe.cs` — Demo-only, read-only platform calibration and account inventory report.
- `cbot/URMPositionObserver.cs` — separate read-only position observer prototype; compile status unverified.
- `tools/validate-calibration-report.mjs` — local validator for copied report text; diagnostic only.
- `tests/*.test.mjs` — local automated tests.
- `integration/EXECUTION_AUTHORITY_DECISION.md` — runtime ownership/bridge limitation and recommendation.
- `SDK_RESEARCH_NOTES.md`, `STAGE_F_AUDIT.md`, `SYMBOL_ACCOUNT_EVIDENCE_SPEC.md` — research and risk evidence notes.
- `DEMO_VALIDATION_CHECKLIST.md`, `RELEASE_GATES.md` — mandatory validation before any execution-enabled build.

## Stage G calibration workflow

1. In cTrader **Demo**, open Automate and create a new cBot named `URMCalibrationProbe`.
2. Paste `cbot/URMCalibrationProbe.cs` into that cBot and compile it inside the installed cTrader Automate environment. This source has **not** been compiled in this build environment.
3. Run once on a Demo account. Set `ProbeSymbolName` to the broker's exact symbol name (for example, `XAUUSD` only if that exact symbol exists). Set `SideForSizing` to `BUY` or `SELL`; enter a structural SL price only if a preview is needed. The cBot stops after emitting one diagnostic snapshot.
4. Copy all `URM_CAL_V1|...` lines from the cBot log into a UTF-8 text file. CTrader may prefix log lines with timestamps; the parser extracts the marker.
5. From this folder, run:

   ```bash
   node tools/validate-calibration-report.mjs calibration-report.txt --symbol XAUUSD
   ```

6. Inspect the JSON result and compare it with the Demo account/symbol shown in cTrader. A valid parse is **not** proof that the copied report is authentic, current broker state, or safe for trading.

## Local checks

Requires Node.js. The unit tests need no third-party package:

```bash
node --check risk-core.mjs
node --check plugin-policy.mjs
node --check account-profile.mjs
node --check evidence-integrity.mjs
node --check broker-constraints.mjs
node --check execution-engine.mjs
node --check position-manager-policy.mjs
node --check tools/validate-calibration-report.mjs
node --test tests/*.test.mjs
```

The suite includes report-parser tests, static safety checks for the probe source, and inline Web Plugin module syntax checks. These tests do **not** compile C#, run inside cTrader WebView, or test broker execution.

## Explicit blockers — do not enable execution

- The Web Plugin public `ProtoSymbol` schema does not expose the authoritative Algo `Symbol.TickSize` property. Stage G's cBot can inspect tick size inside its own Algo context, but the copied report is not authenticated and must not act as a cross-runtime trust bridge.
- The cBot can inspect its account's current open positions and pending orders, but no documented secure plugin-to-cBot control bridge has been proven in this project.
- The calibration output is a user-copied diagnostic report. It is not cryptographically signed and can be edited or become stale.
- `VolumeForFixedRisk` and `AmountRisked` are estimates, not a guaranteed realized-loss cap. Slippage, gaps, commission, liquidity and conversion changes can change realized loss.
- The cBot has not been compiled against the installed cTrader Algo assemblies and has not been run on a broker Demo account here.
- No partial-fill, server-confirmed SL/TP, local/Cloud restart, account-switch, or live host integration test has been performed.
- The `maxExposure` aggregate still requires a defined authoritative exposure calculation and review of positions plus pending orders across the relevant account model.

The package is **for diagnostic calibration and research only**. Keep order execution disabled until all release gates have been independently completed in cTrader Demo.
