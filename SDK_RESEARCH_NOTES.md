# SDK Research Notes — Stage G v1.0

Research date: 10 October 2026.

## Official cTrader sources reviewed

- Plugin SDK basics: https://help.ctrader.com/plugins/developers/web-based/sdk-basics/
- Plugin public server messages: https://help.ctrader.com/plugins/developers/web-based/sdk-references/public-server-message/
- Algo Symbol: https://help.ctrader.com/ctrader-algo/references/MarketData/Symbols/Symbol/
- Algo Positions: https://help.ctrader.com/ctrader-algo/references/Trading/Positions/Positions/
- Algo Position: https://help.ctrader.com/ctrader-algo/references/Trading/Positions/Position/
- Algo PendingOrders: https://help.ctrader.com/ctrader-algo/references/Trading/Orders/PendingOrders/
- Algo PendingOrder: https://help.ctrader.com/ctrader-algo/references/Trading/Orders/PendingOrder/
- Asset converter: https://help.ctrader.com/ctrader-algo/references/MarketData/IAssetConverter/
- Algo Robot/Account: https://help.ctrader.com/ctrader-algo/references/General/Account/

## Verified capabilities relevant to Stage G

1. In Algo/cBot, `Symbol.TickSize` and `Symbol.PipSize` are directly available.
2. The Algo `Symbol` API includes `VolumeForFixedRisk`, `NormalizeVolumeInUnits`, `AmountRisked`, and estimated-margin support. Fixed-risk estimates are not guaranteed realized loss; price and conversion rates move.
3. `IAssetConverter` offers conversion APIs, including currency-name examples in the docs. These are platform-side conversion estimates, not guaranteed future rates.
4. A cBot has access to the account's `Positions` and `PendingOrders` collections; this is suitable for a diagnostic inventory snapshot from that cBot runtime.
5. The plugin public `ProtoSymbol` provides digit/pip-position, volume constraints, minimum SL/TP distances and `maxExposure`, but does not expose the Algo `Symbol.TickSize` property as an authoritative field.
6. The documented Plugin API can submit trades and receive execution events, but events associated with orders/deals/positions do not, by themselves, constitute an authoritative complete account-wide inventory snapshot at plugin startup. The public message list reviewed did not show a general positions/pending-orders enumeration request.
7. No supported authenticated Web Plugin-to-cBot bridge has been implemented or tested in this project. A pasted cBot log is not a secure runtime bridge, even if a local parser validates it.

## Design consequence

Stage G adds a Demo-only read-only Algo calibration probe and a local report parser. The report remains `authenticated:false`, `executionAllowed:false`, and cannot unlock a Plugin execution gate. Do not copy values from a report into a live request without re-reading current values inside the authoritative execution runtime.

## Risk calculation note

The cBot diagnostic uses current Bid/Ask as a reference entry, plus the user-entered structural stop. That is a preview, not the eventual fill price. `VolumeForFixedRisk` and `AmountRisked` can differ from realized cash loss because of actual fill, slippage, gaps, conversion changes and costs. Commission remains separate from the $10 price-risk budget by the approved policy.
