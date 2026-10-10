# URM Stage G Source and SDK Audit — 10 October 2026

## Stage G change set

1. Added `cbot/URMCalibrationProbe.cs` as a one-shot, Demo-only, read-only diagnostic probe. It refuses Live accounts and emits an explicitly unauthenticated snapshot of account metadata, selected symbol metadata, an estimated fixed-risk sizing result, all current cBot-visible positions and pending orders.
2. Added `tools/validate-calibration-report.mjs`, a local parser for copied cBot output. It validates timestamps, snapshot IDs, account/symbol/risk fields, required terminal NOTE, explicit BLOCK rows, inventory counts, duplicate IDs and readiness status versus risk values.
3. Tightened the probe to re-check connection/account context before printing END. If the account context or connection changes, it emits BLOCK and stops rather than outputting a complete snapshot.
4. Added signed formatting for free margin. A legitimate negative free-margin value is preserved as diagnostic data instead of being silently converted to NA.
5. Added a tolerance-based `TickSize` grid check for the structural SL and current Bid/Ask before sizing preview; off-grid prices block the risk preview instead of being rounded silently.
5. Kept the Web Plugin visibly Stage G and preview-only. The probe is not connected to the Plugin; report parsing never unlocks execution.

## Source API verification

Official cTrader Algo documentation describes:

- `Symbol.TickSize` as the symbol's tick size.
- `VolumeForFixedRisk(amount, stopLossInPips, roundingMode)` as an estimate of volume for an amount in the account deposit currency; the result can be imprecise because market movement cannot be predicted.
- `AmountRisked(volume, stopLossInPips)` as a price-risk estimate in the account deposit currency.
- `IAssetConverter.Convert(double, string, string)` as an asset/currency conversion helper.
- `Positions` and `PendingOrders` as current account collections available to a cBot.
- `Account.IsLive`, account asset/currency, balance, equity and free margin as account context properties.

Official references:

- https://help.ctrader.com/ctrader-algo/references/MarketData/Symbols/Symbol/
- https://help.ctrader.com/ctrader-algo/references/MarketData/IAssetConverter/
- https://help.ctrader.com/ctrader-algo/references/Trading/Positions/Positions/
- https://help.ctrader.com/ctrader-algo/references/Trading/Orders/PendingOrders/
- https://help.ctrader.com/ctrader-algo/references/Account/IAccount/
- https://help.ctrader.com/plugins/developers/web-based/sdk-basics/
- https://help.ctrader.com/plugins/developers/web-based/sdk-references/public-server-message/

## Parser hardening in final Stage G package

- Requires exactly one BEGIN, META, SYMBOL, RISK, END and NOTE row.
- Requires explicit UTC timestamps and a masked account identifier; unzoned/local timestamps and unmasked account identifiers are rejected.
- Rejects a probe BLOCK record, malformed terminal NOTE, mixed snapshot IDs, future/stale timestamps, mismatched symbol, incomplete/invalid fields and inventory count mismatch.
- Rejects duplicate position or pending-order IDs.
- If a risk row claims READY or capped diagnostic preview, its normalized volume must satisfy symbol min/max and the estimated USD price-risk must not exceed the target plus the declared $0.01 tolerance.
- Always sets `authenticated:false`, `executionAllowed:false`, and `releaseGateCanBeUnlockedByThisReport:false`.

## Test result

The local Node.js suite was re-run after these changes: **193 passed, 0 failed, 0 skipped**. JavaScript syntax checks passed. The C# code has **not** been compiled against the exact installed cTrader Algo version because this runtime has no `dotnet`, `csc` or `mcs` toolchain.

## Material limitations and release decision

- A cBot report pasted into a file is editable text; it is not an authenticated bridge to the Plugin.
- `Symbol.PipValue` and `Symbol.TickValue` are documented as values captured at cBot/indicator initialization and not updated in real time. The primary preview uses platform fixed-risk helper methods but remains an estimate.
- The cBot snapshot is not an atomic account transaction. It now refuses to print END if server/account identity changes during collection, but Demo comparison against Trade Watch is still required.
- No actual cTrader host/WebView, cBot compile, broker Demo execution, SL/TP confirmation, partial fill, restart or Cloud-storage scenario was tested here.
- Aggregate `maxExposure` is not calculated or authenticated by this stage.
- No supported authenticated Plugin-to-cBot command/state bridge has been implemented.

**Release decision: diagnostic-only / execution disabled.**
