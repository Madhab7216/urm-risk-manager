# URM Stage G — Release Gates

**Current status: BLOCKED. Web Plugin order submission remains disabled.** The separate native one-shot executor/R-ladder manager are Demo-only prototypes; no local cTrader compilation or broker-host Demo pass has yet been verified. A local test pass or copied calibration report must never override these gates.

## Gate 1 — Risk math and evidence

- [x] Fixed USD 10 target price-risk; commission is shown separately and excluded from sizing per approved policy.
- [x] BUY/SELL structural-stop direction checks and volume step-down sizing tests.
- [x] Context-bound and freshness-bound manual evidence remains explicitly user-attested, not independently authenticated.
- [x] Stage G cBot can produce an approximate platform-side fixed-risk sizing cross-check for a Demo account.
- [ ] Compare `VolumeForFixedRisk` and `AmountRisked` output against real Demo-account results on each intended symbol and account currency.
- [ ] Independently validate P/L conversion for all supported instruments; account for fill/slippage/gap effects.
- [ ] Decide whether commission remains display-only (current policy) or a separate cost-inclusive warning is required. Validate minimum/per-side/round-turn tiers if displayed.

## Gate 2 — Symbol constraints and price grid

- [x] Web Plugin checks provided enabled status and documented minimum SL/TP distance.
- [x] Stage G Algo probe reports platform `TickSize`, `PipSize`, volume bounds/step and a diagnostic inventory.
- [x] Probe blocks off-tick-grid stop references and quote prices in its diagnostic sizing path.
- [ ] Do not use copied probe text as an authenticated Plugin tick-size bridge.
- [x] Added a native cTrader Algo execution prototype and R-ladder manager that read authoritative TickSize inside the execution-owning runtime; the Web Plugin remains preview-only.
- [ ] Compile and broker-Demo-test the native cBots before treating this architecture as validated.
- [ ] Test tick-grid rounding, min/max/step volumes and SL/TP distance on actual broker Demo symbols: XAUUSD, XAGUSD, intended FX pairs and indices.
- [ ] Define and validate aggregate `maxExposure` per supported account model with authoritative open-position and pending-order data in the execution-owning runtime.
- [ ] Validate symbol trading mode, market schedule, minimum distance interpretation, volume rules and dynamic leverage through the installed SDK/runtime.

## Gate 3 — Account context

- [x] Web Plugin profile validation binds broker/login/account model/limited-risk flag/deposit currency, and fails closed on missing or changing context.
- [x] Stage G cBot probe rejects Live accounts and checks connection/account identity again before emitting a completed snapshot.
- [ ] Compile the probe in the current installed cTrader Automate environment and inspect actual report output.
- [ ] Test account switching during Plugin refresh, cBot run and report parsing in Demo.
- [ ] Keep unsupported NETTED, SPREAD_BETTING and limited-risk/guaranteed-stop account models blocked until their distinct rules are implemented and tested.

## Gate 4 — Execution authority and lifecycle

- [x] UI execution gates remain hard-locked.
- [x] Mock tests cover intent identity, acceptance vs fill, partial-fill/cancel races, late event handling and unresolved states.
- [x] Stage G documents that a copied text report is neither authenticated nor an execution control channel.
- [x] Prototype decision: native cTrader Algo cBots are the execution/SL-management authority for this Demo test path; the Web Plugin remains preview-only and has no execution bridge.
- [ ] Validate that the native cBots compile and run correctly in the installed cTrader version before accepting this authority decision as production-ready.
- [ ] If a bridge is chosen, threat-model and test authentication, account scoping, nonce/expiry, replay prevention, durability, retry, outage and status reconciliation.
- [ ] Durable journal crash consistency and restore tests in the actual runtime.
- [ ] Actual cTrader Demo execution event, fill price/volume, position ID, SL/TP acceptance and server-side protection verification.
- [ ] Test full fill, partial fill, extra fill during cancel, cancel rejection/timeout, protection rejection, unknown outcome, duplicate submit, late callback and restart.
- [ ] Block new orders while any execution/position/protection record is unresolved.

## Gate 5 — Position manager and recovery

- [x] Pure R-policy tests: +1R BE, +2R → +1.7R, +3R 1R favourable-only trail with +2R floor, TP 5R.
- [x] Read-only observer, calibration probe, opt-in one-shot executor and native R-ladder manager source files are provided.
- [x] R-ladder source encodes immutable structural SL in the URM1 position label, binds saved peak-R to the exact account/user/position/symbol/side/entry/SL identity, and requires write-ahead peak persistence before an SL modification.
- [x] R-ladder manager never changes TP, never closes a position, advances SL only, pauses at the 5R boundary and requires server-reported SL/TP read-back.
- [ ] Compile all C# cBots in the target cTrader Automate version; record actual compiler output.
- [ ] Validate structural-SL/initial-R persistence through position open, account switch, local restart, missing/corrupt state and stop modification.
- [ ] Run only on local cTrader for the initial implementation. Official cTrader docs state LocalStorage.Flush is unsupported/no-op in Cloud; do not use Cloud for this manager.
- [ ] Demonstrate exactly one manager per account/symbol, idempotent updates, persistence latency and no stop regression in broker Demo.

## Gate 6 — Packaging and acceptance

- [x] 232 automated JavaScript/static safety tests pass on GitHub Actions for the current tested code snapshot; this does not compile C# or validate broker execution.
- [ ] Re-run the full suite after any subsequent code or documentation change and retain the passing run URL.
- [x] ZIP integrity and SHA-256 manifest generated.
- [ ] Compile the calibration probe, one-shot executor and R-ladder manager in cTrader Automate.
- [ ] Verify first preflight sends no order when confirmation is false; verify single, confirmed Demo order only after manager is running.
- [ ] Test BE +1R, lock +1.7R at +2R, trailing with +2R floor at +3R, TP=5R reconciliation, server read-back, and restart after each phase.
- [ ] Web Plugin opened in cTrader host; actual SDK handshake, account/symbol payloads and quote freshness observed.
- [ ] Complete `DEMO_VALIDATION_CHECKLIST.md` on a dedicated Demo account.
- [ ] Independent safety review and release sign-off.
- [ ] Only after every blocker is closed may a separate explicitly execution-enabled build be created and retested from a clean source tree.
