# URM Demo One-Shot Executor

## What this is
This is a **separate native cTrader Automate cBot** for a single, explicitly confirmed Demo market order. It is not connected to the WebView plugin and does not unlock the plugin. The WebView plugin remains preview-only until its independent execution-authority, persistence, inventory, and broker-host validation gates are complete.

The cBot:
- Refuses Live accounts and unsupported account models.
- Defaults to **Confirm one-shot DEMO order = false**. In this mode it performs preflight only and sends no order.
- Requires a recent cTrader tick, a market-open result, valid bid/ask, a bounded spread, exact broker TickSize alignment for the structural SL, a clean account with no open positions or pending orders, and a verified $10 USD fixed-price-risk estimate.
- Rounds volume down to broker bounds/step; it does not increase volume to meet a minimum. If minimum volume would exceed the target, preflight blocks.
- Sends initial relative SL/TP with the order request, then attempts to set the exact structural SL and fill-anchored 5R TP and reads protection back from cTrader.
- If post-fill risk or protection checks fail, it attempts to close the position and prints a critical message if the close fails.
- Sends one order per confirmed cBot start and never auto-retries an uncertain outcome.

## Compile and preflight in Demo

1. In cTrader, open **Algo → cBots** and create a new C# cBot named `URMDemoOneShotExecutor`.
2. Replace the template with the complete contents of `cbot/URMDemoOneShotExecutor.cs`.
3. Compile in the installed cTrader Automate version. The repository cannot compile against your installed cAlgo API; if compilation fails, save the complete compiler output and fix it against that version—do not remove safeguards.
4. Attach the cBot to a dedicated **Demo** account. Set the exact symbol name as listed by the broker (for example, `XAUUSD`, but respect any broker suffix), direction, and planned structural SL price.
5. Leave **Confirm one-shot DEMO order = false** and start it. The cBot should print `URM_DEMO|PREFLIGHT_PASS` and `URM_DEMO|PREFLIGHT_ONLY`, then stop. No order is sent.
6. Review tick age, spread, estimated USD risk, volume, stop price, 5R target and margin in the cBot log. Make sure the stop is on the broker TickSize grid and on the correct side of the current quote.

## One-shot Demo order

Only after the preflight output is understood and all values are correct:

1. Confirm you are still on the intended Demo account, with **zero open positions and zero pending orders**. This initial executor conservatively refuses to trade when either list is non-empty.
2. Reopen the cBot parameters and set **Confirm one-shot DEMO order = true**. Recheck exact symbol, direction and structural SL.
3. Start once. Do not click Start again or automatically retry if the result is uncertain. Check Trade Watch and the cBot log first.
4. A successful result must include `URM_DEMO|ORDER_PROTECTED`. If the log says `CRITICAL_CLOSE_FAILED`, inspect Trade Watch immediately and manually manage the position because protection could not be confirmed.

## Limitations / release status

- This is an initial one-shot execution probe, not the finished WebView-plugin integration and not the full live R-ladder position manager.
- It uses platform-side current tick and symbol properties; estimated risk can still differ due to gaps, slippage, fast movement, FX conversion changes and commissions.
- Commission is deliberately separate from the $10 **price-risk** target.
- It blocks accounts unless their account model reports HEDGED. It also blocks when any position/order already exists, so portfolio max-exposure is not inferred.
- The initial relative protections are sent with the order. The cBot then requests exact absolute structural SL and fill-anchored 5R TP, checks them, and attempts to close on failed protection validation. Broker/API behavior must be confirmed in the installed Demo environment.
- This C# file has **not** been compiled in your local cTrader Automate version. A repository JS test pass is not a C# compile or broker-host Demo pass.
- Do not use it on a Live account. The source also refuses Live accounts at runtime.
