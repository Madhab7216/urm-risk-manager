# URM Stage G — Demo Validation Checklist

**Status: NOT RUN / NOT VERIFIED.** This is a test plan, not a statement that the package is broker-safe. Use a dedicated Demo account only. The calibration probe is read-only. The Web Plugin remains locked; a separate native one-shot executor is opt-in and must default to preflight-only.

## A. Build calibration probe

- [ ] In the installed cTrader Automate environment, create a new C# cBot named `URMCalibrationProbe` and paste `cbot/URMCalibrationProbe.cs`.
- [ ] Compile; save the complete build output and cTrader version. Do not remove safety checks to work around API differences.
- [ ] Run in Demo only with the exact broker symbol name.
- [ ] Confirm the log includes BEGIN, META, SYMBOL, RISK, all POSITION/PENDING rows, END and diagnostic-only NOTE.
- [ ] Confirm the cBot stops after the single snapshot.
- [ ] Confirm account ID is masked and raw position/order labels are not emitted.
- [ ] Confirm no order/position mutation occurs while the probe runs.

## B. Validate copied report

- [ ] Copy all `URM_CAL_V1|...` rows to a UTF-8 text file.
- [ ] Run `node tools/validate-calibration-report.mjs calibration-report.txt --symbol <EXACT_SYMBOL>`.
- [ ] Confirm output keeps `authenticated:false`, `executionAllowed:false` and `releaseGateCanBeUnlockedByThisReport:false`.
- [ ] Test that stale, future, Live, mixed-snapshot, incomplete and modified rows fail validation.
- [ ] Compare reported symbol, tick size, pip size, volume min/step/max, Bid/Ask, spread and market status against cTrader.
- [ ] Compare every position and pending order (symbol, side, volume, entry/target, SL/TP) against cTrader Trade Watch.
- [ ] Negative free margin, if it occurs in Demo, should remain a signed diagnostic value rather than becoming missing data.
- [ ] Remember the report is copied plain text and can be edited; it is not authenticated and must never be imported as live authority.

## C. Validate risk sizing

- [ ] Test BUY stop below current Ask and SELL stop above current Bid; wrong-side stops must block.
- [ ] Compare platform `VolumeForFixedRisk` output with normalized volume after rounding down.
- [ ] Confirm too-small target budgets block when the minimum volume risks more than the $10 target.
- [ ] Confirm any symbol-max cap is disclosed and post-normalization `AmountRisked` remains at/below target plus defined tolerance; otherwise block.
- [ ] Test USD and a non-USD account currency where the platform converter is available.
- [ ] Record the exact current Bid/Ask: it is only a preview reference, not the eventual fill.
- [ ] Show commission separately; do not subtract it from the $10 budget under the approved policy.

## D. Inspect inventory and exposure

- [ ] Compare cBot `Positions`/`PendingOrders` snapshot against all rows in Trade Watch.
- [ ] Note the snapshot is not guaranteed atomic. If disconnect or account identity change occurs, probe must not output a complete END row.
- [ ] Do not derive a final `maxExposure` compliance result from this parser; Stage G only provides diagnostic inventory.
- [ ] Define the supported account model's exposure aggregation in the execution-owning runtime before any submission is allowed.

## E. Native one-shot executor and R-ladder manager

- [ ] In local cTrader Desktop Automate, create/compile `URMRLadderPositionManager` from `cbot/URMRLadderPositionManager.cs`.
- [ ] Check cBot log confirms Demo account, HEDGED model, exact chart symbol and `URM_PM|STARTED`.
- [ ] Start exactly one manager instance for the account/symbol **before** starting the one-shot executor.
- [ ] Do not use Cloud for this manager. cTrader documents `LocalStorage.Flush` as unsupported/no-op in Cloud.
- [ ] Create/compile `URMDemoOneShotExecutor` from `cbot/URMDemoOneShotExecutor.cs`.
- [ ] Start executor with `Confirm one-shot DEMO order=false`; verify it prints preflight-only and sends no order.
- [ ] Only after reviewing the preflight on the intended Demo account, exact symbol, direction, structural SL, estimated risk, volume and margin, set confirmation true and Start once.
- [ ] Verify the opened position label follows `URM1|ID=URM-...|SL=...` and that manager observes it.
- [ ] Test +1R break-even, +2R lock to +1.7R, +3R trailing with a +2R floor, and unchanged +5R TP. Compare every step to Trade Watch.
- [ ] Verify `URM_PM|UPDATED` follows with cTrader server read-back of the new SL and unchanged TP.
- [ ] Test stop modification rejection, stale/no tick, missing TP, account switching, manager restart with stored peak, and missing/corrupt peak state. Ambiguous states must block and require manual reconciliation.
- [ ] Never run two manager instances for the same account/symbol. Do not automatically retry an unknown/rejected order or SL modification.
- [ ] Save compiler output, cTrader version, cBot logs and screenshots. Static GitHub tests are not a substitute for C# compilation or broker-host Demo testing.

## F. Plugin/cBot architecture

- [ ] Keep the Web Plugin's order submission hard-locked.
- [ ] Do not assume the Plugin can read the cBot's TickSize or position snapshot through a hidden/shared runtime.
- [ ] Select the final execution authority (recommended for safe iteration: cBot/native Algo runtime re-reads all inputs independently; Plugin remains preview-only).
- [ ] If an external bridge is considered, complete separate architecture and threat-model review: auth, account scoping, expiry/nonce, replay prevention, durable journal, retries, outage and status reconciliation.

## G. Final state

- [ ] Compile the separate read-only position observer, calibration probe, one-shot executor and R-ladder manager.
- [ ] Test restart/recovery, account switching, late callbacks, partial fill and server-confirmed protection on Demo.
- [ ] Attach report, logs and actual SDK/compiler results.
- [ ] Do not promote to an execution-enabled build until all `RELEASE_GATES.md` items are signed off.

**Current result: NOT RUN / NOT VERIFIED.** The Web Plugin is diagnostic-only and order-locked. Native cBot order submission is only an opt-in Demo prototype and remains unverified until the checklist is completed.
