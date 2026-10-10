# URM Execution Authority Decision — Stage G v1.0

## Decision

The Web Plugin and cBot must not be treated as sharing a verified in-memory state, authenticated event stream, or command channel. No order execution is enabled in Stage G.

## Evidence and constraints

- The cTrader Web Plugin SDK connects a web-based plugin client to the cTrader host and supports host-mediated data, trading operations and event delivery.
- The documented public Plugin symbol model includes price precision/point metadata, volume constraints, broker minimum SL/TP distances and `maxExposure`, but it does not expose the Algo `Symbol.TickSize` property.
- The cTrader Algo runtime exposes `Symbol.TickSize`, platform-calculated risk helpers, asset conversion, and the current account's `Positions` and `PendingOrders` collections.
- The reviewed public Plugin SDK message list does not provide a documented authoritative request to enumerate the full current position/order inventory at plugin startup. Event-associated order/position data is not the same as a complete inventory snapshot.
- The Stage G report is copied plain text; it can be edited or stale. Parsing/hashing does not authenticate the originating cTrader runtime.
- No official, supported and secured Plugin-to-cBot control bridge has been implemented or tested here.

## Options

### A — Keep the Plugin preview-only; use cBot/native Algo as later execution authority (preferred for safe iteration)

The plugin may calculate and explain a proposal, but the cBot/native Algo execution runtime independently re-reads current account, symbol, quote, stop, risk, volume, exposure and margin before any order. It must not trust a pasted/stale plugin preview. This option may require a native Algo UI/workflow rather than an unsupported web-to-cBot bridge.

### B — Plugin-originated execution with plugin-only management

The Plugin SDK can submit/manage its own trades, but complete inventory and restart recovery must be solved inside the plugin architecture. Do not have a separate cBot independently manage the same positions unless ownership and synchronization are proven.

### C — Explicit external bridge

A separately researched bridge would need authenticated commands, per-account scoping, expiry/nonce/replay prevention, durable order-intent journaling, secure credential handling, status reconciliation and defined outage behaviour. Local HTTP/WebSocket or copied report must not be presumed secure/supported by default.

## Current recommendation

Use Option A for calibration and safe iteration. Keep Web Plugin preview-only and use the Stage G Demo-only cBot to collect platform-calculated diagnostic evidence. Do not unlock order submission until cBot compilation, Demo evidence collection, final execution ownership, exposure aggregation, initial-R persistence, partial-fill protection, server-confirmed SL/TP and restart/account-switch recovery are tested.

## Stage G non-goals

- Does not approve or trigger a trade.
- Does not authenticate pasted calibration logs.
- Does not guarantee exactly $10 realized loss.
- Does not declare C# compiled or broker-Demo validated.
