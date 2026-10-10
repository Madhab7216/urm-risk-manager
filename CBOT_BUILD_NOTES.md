# cBot Build Notes — Stage G v1.0

## Included cBots

- `cbot/URMPositionObserver.cs` — earlier read-only observer prototype. Compile status unverified.
- `cbot/URMCalibrationProbe.cs` — single-run, Demo-only read-only calibration/report cBot.

## Compile in cTrader Automate

The current container does not have .NET/C# compilers or cTrader Algo assemblies. Therefore no compile-success claim is made.

1. Open the installed cTrader application.
2. Switch to a Demo account.
3. Open Automate and create a new cBot.
4. Copy the `URMCalibrationProbe.cs` source into the cBot editor.
5. Compile. Fix only genuine API compatibility errors against the installed cTrader version; never remove the `Account.IsLive` guard or add any order/position-mutating call to the probe.
6. Run it once with the correct symbol and optional structural stop.
7. Confirm the log includes `BEGIN`, `META`, `SYMBOL`, `RISK`, all current `POSITION`/`PENDING` rows, `END`, and `NOTE`.
8. Compare inventory to cTrader Trade Watch manually.

## Source API usage to compile-check

The probe expects these cTrader Algo APIs to be available: `Account.IsLive`, `Server.IsConnected`, `Symbols.GetSymbol`, `Symbol.TickSize`, `Symbol.PipSize`, `Symbol.VolumeForFixedRisk`, `Symbol.NormalizeVolumeInUnits`, `Symbol.AmountRisked`, `Symbol.GetEstimatedMargin`, `AssetConverter.Convert`, `Positions`, and `PendingOrders`. Their existence in official documentation is not a substitute for compilation in the target installed application/version.

## Safety assertion

The probe should only read account/symbol/position/order data and print diagnostics. It must never invoke `ExecuteMarketOrder`, `Place*Order`, `ModifyPosition`, `ModifyPendingOrder`, `ClosePosition`, or `CancelPendingOrder`. Static tests inspect these invariants but do not replace a runtime review.
