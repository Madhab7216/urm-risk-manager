# Stage F Source Audit — 10 October 2026

## Findings addressed

1. Account/group data were read only once; a user account switch during the async chain could mix old and new identity/currency context. Stage F performs two sequential account/group reads and compares the broker/login/account type/limited-risk flag and deposit currency before accepting the context.
2. The second group-info error path previously only nulled one state value; it now uses the common invalidation path to clear prior account display, currency, balance/equity and manual evidence.
3. The account-display helper previously required both balance and equity in the same response object, which could hide a valid balance when equity is not supplied. It now clears old values first, reads balance separately, and only reads equity if supplied.
4. Pip-value and commission freshness fields previously inferred observation age as zero at checkbox time. Stage F asks for source observation age in minutes/hours and uses that age in the attestation object.
5. Explicitly disabled account groups were not rejected, and impossible `pipPosition > digits` metadata was not blocked. Stage F rejects both.
6. Broker `slDistance`/`tpDistance` metadata was not used. Stage F checks the documented minimum point distances against the fresh close-side quote.
7. TickSize and aggregate maxExposure are still not authoritative in this UI path. These are explicitly represented as unresolved and execution is still hard-locked.

## Remaining material risks

- Manual evidence is user-attested, not source-authenticated; a false or poorly chosen source can still produce a false estimate.
- Two sequential account reads are not an atomic server snapshot. Host switching behaviour has to be tested.
- Symbol tick-grid is not verified; `digits` alone is not TickSize.
- Aggregate maxExposure cannot be checked without a complete position/order exposure snapshot.
- `maxVolume`/`minVolume`/`stepVolume` values are parsed as protocol values and covered by unit tests but need verification against real broker payload units in Demo.
- The current open/active symbol payload may use optional fields; the UI intentionally fails closed if `enabled` is missing.
- C# source has not been compiled; no cTrader host or broker Demo test exists.

## Release decision

Preview-only. No order submission. See `RELEASE_GATES.md` for the complete blocker list.
