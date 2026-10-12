# URM Scalper Local Pro — setup, rules and validation

**Source:** [`cbot/URMScalperLocalPro.cs`](https://github.com/Madhab7216/urm-risk-manager/blob/main/cbot/URMScalperLocalPro.cs)  
**Build project:** [`cbot/URMScalperLocalPro.csproj`](https://github.com/Madhab7216/urm-risk-manager/blob/main/cbot/URMScalperLocalPro.csproj)  
**Build workflow:** [URM Scalper Local Pro Build](https://github.com/Madhab7216/urm-risk-manager/actions/workflows/urm-local-pro-build.yml)

## Strategy rules implemented

1. **M5 breakout:** use the last fully closed M5 bar. A bullish signal needs a close above the highest high of the configured preceding lookback; a bearish signal needs a close below the lowest low. Buffer is configurable. This is a deterministic price-action equivalent, not the proprietary LuxAlgo Support and Resistance calculation.
2. **M5 Order Block proxy:** locate the most recent opposing-colour M5 candle before the breakout. Its full high-low range defines the OB zone. With `Require OB retest = true`, an M1 pullback must overlap that zone.
3. **M1 confirmation:** after the breakout close, wait for the minimum number of opposite-colour M1 candles, then require a completed M1 candle to close beyond the pullback range. Old/history signals are not traded at startup, and setups expire.
4. **Structural SL:** use the pullback's low for buys or high for sells, expanded by a tick buffer. The stop is rounded outward to the broker's tick grid.
5. **Universal risk target:** convert the configured USD risk into the account's deposit currency, calculate volume with cTrader `VolumeForFixedRisk`, round volume down, cross-check with `AmountRisked`, and check margin, quote freshness, spread, symbol and market state. Any failed check blocks the order.
6. **Server protection:** submit with initial relative protection; then adjust to the structural absolute SL and fill-anchored TP at the configured R multiple (default 5R). Read back the position's server-side SL/TP. If fill risk exceeds the estimate budget or protection cannot be confirmed, the bot attempts to close the position and writes a critical log. A close can still fail, so check Trade Watch immediately on any `CRITICAL` log.
7. **R ladder:** at +1R move SL toward break-even; at +2R lock +1.7R; from +3R trail with a 1R gap and +2R floor. TP is kept unchanged during normal management. Only more-protective SL changes are accepted.
8. **Candle-flip trail:** after the trail activation threshold, a bearish-to-bullish M1 colour change for buys adds the preceding bearish candle's low as another candidate stop; reverse for sells. It is combined with the R trail and never loosens the existing SL.

## Important indicator compatibility note

The private candle-state output and internal rules of TradingView's LuxAlgo and Sideways Alarm indicators are not exposed to this standalone cTrader cBot. This version implements the above explicit price-action/candle-colour proxy from the user's written strategy. It does **not** claim a byte-for-byte reproduction of either third-party indicator. Exact matching would require an authorized cTrader-native port or access to the original indicator's logic.

## Run locally in cTrader Desktop

1. In cTrader Desktop, stop any older URM cBots that may submit trades or modify stops, especially `URMRLadderPositionManager`, `URMDemoOneShotExecutor`, and `URMCloudOneShotLadder`. Do not let two managers control the same position.
2. In **Algo → cBots**, create/import `URMScalperLocalPro`. If a successful GitHub Actions build artifact is available, download the `.algo` from that workflow's run under **Artifacts** and import it. Otherwise create a C# cBot, paste the complete source, save, and Build.
3. Attach exactly one instance to the intended broker symbol. The bot fetches M1 and M5 data internally, so signals are not restricted to the chart timeframe. Ensure the symbol shown in cTrader is the one you intend to trade.
4. First start with **Enable new entries = false**. Read Logs and verify the `URM_LOCAL|STARTED` message, account type, and signal-rule summary.
5. On a clean **Demo** account, enable `Enable new entries` only after checking parameters. Keep `Allow Demo entries = true` and `Allow Live entries (explicit) = false`. Use a broker's exact supported symbol and verify the risk calculation and attached SL/TP after the first trade.
6. Do not enable Live entries until Demo execution, stop/target readback, restart recovery, and the +1R/+2R/+3R ladder have been manually verified. On Live, both `Enable new entries` and `Allow Live entries (explicit)` must be true. These are separate switches; default Live entry execution is off.
7. Use one cBot instance per account/symbol. The bot supports only its own `URMSTRAT|V1|` labelled positions; it will not manage unrelated manual positions. It blocks fresh entries on non-Hedged accounts when `Require Hedged account` remains true. By default, `Block entries with foreign exposure = true` also blocks new entries while any unrelated open position or pending order exists in the account. For safest testing, use a clean, dedicated Demo account.

## Default parameters

| Parameter | Default |
|---|---:|
| New entries | Off |
| Demo entries | Allowed |
| Live entries | Off |
| Block entries with foreign account exposure | Yes |
| Estimated price risk | USD 10 |
| TP | 5R |
| M5 swing lookback | 12 bars |
| OB search | 20 M5 bars |
| Require OB retest | Yes |
| Opposite-color M1 pullback | 2–5 bars |
| Setup expiry | 30 M1 bars |
| BE / lock / trail | +1R / +1.7R at +2R / trail from +3R |
| Trail gap / floor | 1R / +2R |
| Minimum SL advance per broker modification | 2 ticks |

## What is and is not validated

- The C# source is compiled by the repository's Windows GitHub Actions workflow against the published `cTrader.Automate` package; inspect the latest run and its artifact before installing.
- Repository Node tests are static checks. They do not simulate broker fills or prove strategy profitability.
- A successful build does not prove a broker will accept every stop distance/order, that slippage will respect USD 10, or that the strategy makes money. USD 10 is an estimated **price-risk target**, not a guaranteed maximum realized loss; gaps, slippage, commissions, conversion movement and execution can change the final outcome.
- Exact LuxAlgo / Sideways Alarm outputs are not replicated. No backtest performance is claimed.
- Demo execution is required before Live use. Always check Trade Watch after `URM_LOCAL|CRITICAL`, `ORDER_REJECTED`, or `PROTECTION_WARNING` logs.
