# URM Stage F — Symbol and Account Evidence Contract

> **Stage G addendum:** The Algo calibration probe can report the runtime TickSize and account positions/pending orders, but copied report text is untrusted diagnostic evidence. It must not be used as a Plugin-to-cBot bridge or to unlock execution. See `CALIBRATION_PROBE_GUIDE.md` and `integration/EXECUTION_AUTHORITY_DECISION.md`.

## Account context key

`lowercase broker name | login | account-type enum | standard/limited | uppercase deposit currency`

Required from the SDK account/group response:
- Broker name and positive safe-integer login.
- Known account-type enum (HEDGED, NETTED, SPREAD_BETTING).
- Explicit boolean limited-risk flag.
- Three-letter deposit currency from the current account-group response.

Stage F preview supports only confirmed standard HEDGED accounts. Other/unknown models fail closed because NETTED positions and guaranteed-stop requirements need separate position-level logic and explicit validation.

## Observation windows

| Evidence | Binding | Declared maximum source-observation age | Important limitation |
|---|---|---:|---|
| Pip value per lot | Account key + exact symbol ID + exact numeric value + source string | 15 min | Manual attestation; source not independently authenticated |
| USD→deposit FX | Account key + currency context + exact numeric value + source string | 15 min | Manual attestation; source not independently authenticated |
| Round-turn commission per lot | Account key + exact symbol ID + exact numeric value + source string | 24 h | Estimate; minimums, tiers, taxes, conversion fees may be missing |
| Live quote | Exact selected symbol ID + source timestamp + local receipt timestamp | 10 sec for both | Does not prove order fills at that price |
| Account/group profile | Broker/login/type/limited-risk + same deposit currency observed twice | 120 sec after verification | Two reads are not an atomic snapshot |
| Symbol metadata | Exact symbol ID + explicit `enabled=true` + required volume/min-distance fields | Current selected `getSymbol` response | Public ProtoSymbol lacks TickSize; maxExposure aggregate cannot be validated without positions |

## Broker constraint calculations

- BUY exits occur against Bid; SELL exits occur against Ask.
- BUY SL must be below current close-side quote; BUY TP above it. SELL is mirrored.
- `slDistance`/`tpDistance` field values are documented as price points. Convert these min-distance values with the symbol’s decimal point unit (`10^-digits`) only for this constraint check.
- Do not infer a valid tick grid from decimal digits. A symbol may display two decimals yet use a 0.25 tick increment.
- `maxExposure` is a symbol/account USD-cent cap. Without current authoritative aggregate exposure, report it as unchecked.

## UI and evidence changes that invalidate prior attestations

Any change to the broker/account context, account currency, selected symbol, pip value, declared source age, source string, FX rate/age/source, commission/age/source invalidates its corresponding attestation. An account refresh failure or inconsistency clears all account-scoped manual evidence and prior balance/equity display values.

## Non-negotiable gate

These checks are for risk preview only. Order execution remains locked until trusted TickSize and P/L conversion, complete exposure data, cTrader host schema verification, durable execution journal, real event/protection reconciliation, cBot compilation and broker Demo validation are demonstrated.
