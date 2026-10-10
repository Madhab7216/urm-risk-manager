# Stage G — Demo Calibration Probe Guide

## Purpose

Collect platform-side diagnostic evidence for one symbol and a possible structural SL using cTrader Algo. The probe is read-only and rejects live accounts. It does not open, amend, close, or cancel trades.

## Before running

- Use a dedicated cTrader **Demo** account.
- Confirm that the cBot source compiles in the installed cTrader Automate build; this repository's test environment does not include the cAlgo compiler.
- Select the exact broker symbol name. Broker suffixes vary (for example, `XAUUSD`, `XAUUSD.`, `XAUUSDm`). Never assume a universal symbol name.
- Use a plausible structural SL below the current BUY reference quote or above the current SELL reference quote. The stop and Bid/Ask must lie on the exact cTrader Algo `TickSize` grid or the sizing preview is blocked. Use `0` only to skip sizing.
- Read the cBot's inputs before starting. The probe must stay read-only.

## Run

1. In cTrader, open **Automate** and create a new C# cBot called `URMCalibrationProbe`.
2. Replace the template content with `cbot/URMCalibrationProbe.cs`.
3. Compile inside the installed cTrader environment. If the compiler rejects any member/overload, do not work around it by weakening the safeguards; update the code against the exact installed API and re-test.
4. Attach/run it on a Demo account. It should stop after one snapshot. If it prints `URM_CAL_V1|BLOCK|...`, stop and resolve the reported reason rather than trying an order.
5. Copy the complete `URM_CAL_V1|...` report into `calibration-report.txt`.
6. Run:

   ```bash
   node tools/validate-calibration-report.mjs calibration-report.txt --symbol XAUUSD
   ```

   Replace `XAUUSD` with the exact configured symbol.

## Interpret the output

- `ok: true` means the report is structurally consistent, recent according to the local machine clock and matches requested parse rules.
- `diagnosticOnly: true`, `authenticated: false` and `executionAllowed: false` are intentionally invariant. They are not errors.
- Compare `targetRiskUsd`, `estimatedRiskUsd`, `normalizedVolume`, `tickSize`, `pipSize`, `min/step/max volume`, the current spread and minimum SL/TP conditions against the values in cTrader.
- Compare the position and pending-order rows with Trade Watch. Check all symbols and account rows; the cBot report can be manually altered, so it cannot act as verified Plugin↔cBot state.
- Commission is not subtracted from the $10 price-risk sizing; it remains a separate cost estimate per approved policy.

## Important limitations

- The risk estimate uses the current Bid/Ask as its entry reference, not a future fill. Actual fill and slippage can change risk.
- Account-currency conversion and instrument P/L can change. The platform's fixed-risk helpers are estimates.
- A valid report does not validate the JavaScript Web Plugin or unlock its execution gate.
- The cBot is single-snapshot diagnostic code, not a persistent manager. It makes no SL/TP change and has no authority over the plugin's orders.
