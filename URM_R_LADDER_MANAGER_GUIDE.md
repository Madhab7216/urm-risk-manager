# URM R-Ladder Position Manager — Demo Guide

## Purpose
`cbot/URMRLadderPositionManager.cs` implements the approved stop-management policy for URM-labelled positions on one symbol chart. It is separate from the Web Plugin and separate from the one-shot executor. The Web Plugin remains locked.

**Policy**
- At +1R peak: move SL to break-even.
- At +2R peak: lock +1.7R.
- From +3R peak: trail one original R behind the best favourable excursion, with a +2R minimum lock.
- Keep TP at the original fill-anchored +5R. At/after the 5R boundary, log a reconciliation alert and do not assume the position was closed.
- The initial structural SL and entry price define immutable R. A tightened SL never becomes the new R anchor.

## Important operating rules
- Demo account only; the manager stops on a Live account or an unsupported account model.
- Use the **local cTrader desktop** for this version. The official cTrader Algo docs state that `LocalStorage.Flush` is unsupported/no-op in Cloud; this manager fails closed if storage access throws, but the runtime cannot treat Cloud persistence as verified. Do not use Cloud for this test.
- Run exactly one manager instance for each account/symbol pair.
- Start the manager **before** starting `URMDemoOneShotExecutor`. This allows the manager to observe the position's opening event and initialize peak-R history from inception.
- The manager only manages positions on the chart symbol whose label matches `URM1|ID=URM-...|SL=<structural-price>`. The one-shot executor writes this label. It never manages arbitrary/manual positions.
- If the manager starts after a URM position already exists and has no saved peak-R state, it blocks that position for manual reconciliation. It will not guess whether +1R/+2R/+3R had already been reached before startup.
- Do not run the read-only `URMPositionObserver` and confuse its logs with active protection: that observer never modifies trades.

## Install and first test
1. Open cTrader **Automate → cBots → Create cBot**.
2. Name it `URMRLadderPositionManager`; replace the template with the complete `cbot/URMRLadderPositionManager.cs` source.
3. Compile in the installed cTrader Automate version. Do not remove guards to work around API differences. If compilation fails, keep the exact compiler output so the source can be fixed against that API build.
4. Attach it to the exact symbol chart used by the executor on a dedicated Demo account, then Start it. It should print `URM_PM|STARTED`.
5. Run the one-shot executor separately. First run it with `Confirm one-shot DEMO order=false` and verify its preflight. Only when the output is understood, the symbol/side/structural SL are correct, and the chart manager is already running, set the confirmation to `true` and Start once.
6. Verify the cBot log and Trade Watch. A successful manager update prints `URM_PM|UPDATED`; it must state that the new SL was read back from cTrader and that the TP remains unchanged.
7. Do not automatically retry a rejected modification. `URM_PM|CRITICAL` means stop and manually inspect Trade Watch and the broker's position state.

## Recovery and limitations
- Peak-R is saved under a key scoped by account, user and position ID, with explicit flushing on each new high-water observation before an SL update. If the state cannot be read/written or is corrupted, this position is blocked.
- On an account identity change, the manager halts and refuses to write further state under the newly selected account.
- The manager only advances an SL. It never widens it, never modifies TP, and never closes a position.
- At the 5R boundary, TP and the open position must be reconciled manually; the manager will not infer that TP closed the trade.
- This is still an initial Demo implementation. It has **not** been compiled or run against your installed cTrader Automate version. Repository tests are static checks, not C# compiler validation or broker-host verification. Do not use on Live.
