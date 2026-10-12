# URM Cloud One-Shot + R-Ladder cBot — prototype guide

File: `cbot/URMCloudOneShotLadder.cs`

## Purpose

This is a **new Cloud-compatible prototype** that combines the one-shot fixed-risk executor and the R-ladder position manager into one cBot instance. It avoids Desktop-only environment guards and does not use `LocalStorage.Flush()`, local files, Windows APIs, or external DLLs. cTrader Cloud runs cBots in a Linux-based environment; see the official [Cloud requirements](https://help.ctrader.com/ctrader-algo/documentation/cbots/cloud-requirements/) and [Cloud features](https://help.ctrader.com/ctrader-algo/documentation/cloud-features/).

## Safety defaults

- Demo account only; Live accounts are rejected.
- Hedged account model only.
- `Confirm one-shot DEMO order` defaults to `false`. With the default, the bot does not submit a new order.
- If order submission is explicitly enabled, it requires the account to have no open positions or pending orders, a fresh platform tick, an exact symbol match, a structural SL, USD-to-deposit conversion, fixed-risk sizing, spread checks, broker volume checks, and server-side SL/TP read-back.
- It manages only positions with its own `URM1|ID=...|SL=...` label on the chart symbol.
- It never changes TP during R-ladder management and never closes positions during normal management. The emergency close path is only used if the initial order's protection cannot be confirmed.
- Only one cBot instance should be run per Demo account. cTrader's official Cloud documentation says Demo accounts generally allow one concurrent Cloud instance and Cloud Demo instances stop after seven days.

## R-ladder

- At +1R: move SL to breakeven.
- At +2R: lock +1.7R.
- From +3R: trail at a 1R gap with a +2R minimum lock.
- Keep the fill-anchored 5R TP unchanged.

## Cloud state/restart behavior — important limitation

Cloud does not support durable `LocalStorage.Flush()`; it does nothing in Cloud. This prototype therefore reconstructs a conservative lower-bound peak from the broker-confirmed server SL and current executable price. This works for confirmed SL stages (BE, +1.7R lock, and the trailing stop) and avoids depending on ephemeral Cloud files.

However, a server SL cannot encode a favourable excursion that never resulted in a confirmed SL change. If an SL modification fails before a new stop is confirmed, a Cloud restart cannot recover that unconfirmed peak exactly. The bot logs errors and halts management of the affected position for the remainder of that running instance. This limitation must be understood and tested; it is not a mathematically complete persistent high-water store.

## Install and validate

1. In cTrader Desktop Algo, create a **new** cBot named `URMCloudOneShotLadder`, language C# (.NET), From scratch.
2. Copy the full source from [GitHub](https://github.com/Madhab7216/urm-risk-manager/blob/main/cbot/URMCloudOneShotLadder.cs) into the editor, replacing the template.
3. Save and Build. A successful JavaScript repository test is **not** a C# compile; the cTrader Build result must say `Build succeeded`.
4. Start a **Cloud** instance on a Demo Hedged account with `Confirm one-shot DEMO order = false` first. Verify logs show `URM_CLOUD|STARTED` and `URM_CLOUD|PREFLIGHT_ONLY`, and verify no order was sent.
5. Before enabling order submission, test in a separate clean Demo account, verify the exact broker symbol and SL price, and review all parameters. Do not use a Live account.
6. For an order test, set `Confirm one-shot DEMO order = true` only after reviewing the parameters. The cBot is one-shot per start and will stop on preflight failures. Check Trade Watch after every order/protection error; do not blindly restart or retry.

## Status

Prototype only. It has **not** been compiled against the user's installed cTrader 5.10.18 API or validated on a broker Demo Cloud instance yet. It is not production-ready and does not guarantee a $10 maximum realised loss (slippage, gaps, commissions, and execution conditions can increase loss).
