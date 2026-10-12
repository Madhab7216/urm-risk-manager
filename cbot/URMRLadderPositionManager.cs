// URM R-Ladder Position Manager v1.0
// LOCAL cTrader Automate cBot. Run one instance per account/symbol, on the same
// local cTrader installation as the order executor. Do NOT use Cloud storage here:
// cTrader documents LocalStorage.Flush as unsupported/no-op in Cloud.
// Manages only URM1|ID=...|SL=... positions for the chart symbol.
// Never changes TP, never closes a position, and never loosens a confirmed SL.
// Lost/corrupt high-water state, quote/grid/protection ambiguity or failed server
// modification is logged for manual reconciliation and stops management of that row.

using System;
using System.Collections.Generic;
using System.Globalization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMRLadderPositionManager : Robot
    {
        private const string LabelPrefix = "URM1|";
        private const string LegacyPrefix = "URM";
        private const double BreakEvenAtR = 1.0;
        private const double LockAtR = 2.0;
        private const double LockToR = 1.7;
        private const double TrailingAtR = 3.0;
        private const double TrailingGapR = 1.0;
        private const double MinimumTrailingLockR = 2.0;
        private const double TakeProfitR = 5.0;
        private const int MaximumTickAgeSeconds = 5;

        [Parameter("Log refresh interval (seconds)", DefaultValue = 5, MinValue = 1, MaxValue = 60)]
        public int LogRefreshSeconds { get; set; }

        private readonly Dictionary<int, double> _peakRByPosition = new Dictionary<int, double>();
        private readonly Dictionary<int, string> _lastLogSignature = new Dictionary<int, string>();
        private readonly Dictionary<int, DateTime> _lastLogAt = new Dictionary<int, DateTime>();
        private readonly HashSet<int> _loaded = new HashSet<int>();
        private readonly HashSet<int> _stateInvalid = new HashSet<int>();
        private readonly HashSet<int> _manualIntervention = new HashSet<int>();
        private readonly HashSet<int> _modifyInFlight = new HashSet<int>();
        private readonly HashSet<int> _dirtyPeakState = new HashSet<int>();
        private readonly HashSet<int> _foreignLabelLogged = new HashSet<int>();

        private long _startupAccountNumber;
        private long _startupUserId;
        private bool _accountContextInvalid;
        private bool _accountContextAlerted;

        protected override void OnStart()
        {
            if (Application.EnvironmentType != EnvironmentType.Desktop)
            {
                Print("URM_PM|BLOCK|DESKTOP_ENVIRONMENT_REQUIRED|Use local cTrader Desktop; Cloud/CLI storage durability is not supported.");
                Stop();
                return;
            }

            if (Account.IsLive)
            {
                Print("URM_PM|BLOCK|LIVE_ACCOUNT_NOT_ALLOWED|This manager is Demo-only.");
                Stop();
                return;
            }

            if (!string.Equals(Account.AccountType.ToString(), "Hedged", StringComparison.OrdinalIgnoreCase))
            {
                Print("URM_PM|BLOCK|ACCOUNT_MODEL_UNSUPPORTED|Only HEDGED accounts are supported.");
                Stop();
                return;
            }

            _startupAccountNumber = Convert.ToInt64(Account.Number, CultureInfo.InvariantCulture);
            _startupUserId = Account.UserId;

            Positions.Opened += OnPositionOpened;
            Positions.Modified += OnPositionModified;
            Positions.Closed += OnPositionClosed;
            Timer.Start(1);

            Print("URM_PM|STARTED|symbol={0}|account={1}|mode=DEMO_ONLY|policy=BE@1R,LOCK@2R_TO_1.7R,TRAIL@3R_GAP_1R_FLOOR_2R,TP_5R_RECONCILE",
                Symbol.Name, Account.Number);
            Print("URM_PM|IMPORTANT|Run exactly one manager instance per account/symbol. Start this manager BEFORE the one-shot executor. Existing positions without saved peak history are blocked for manual reconciliation.");

            foreach (var position in Positions)
            {
                if (string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                    Observe(position, "STARTUP_SCAN");
            }
        }

        protected override void OnTick()
        {
            if (!EnsureAccountContext("TICK"))
                return;

            // A chart-bound manager is intentionally single-symbol. This keeps the
            // executable Bid/Ask and platform tick timestamp specific to this symbol.
            var tickStatus = ReadFreshTick(out var tickBid, out var tickAsk);
            if (!tickStatus)
                return;

            foreach (var position in Positions)
            {
                if (string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                    Observe(position, "TICK", tickBid, tickAsk);
            }
        }

        protected override void OnTimer()
        {
            if (!EnsureAccountContext("TIMER"))
                return;
            FlushPendingPeakState("TIMER");
        }

        protected override void OnStop()
        {
            if (EnsureAccountContext("STOP"))
                FlushPendingPeakState("STOP");

            Timer.Stop();
            Positions.Opened -= OnPositionOpened;
            Positions.Modified -= OnPositionModified;
            Positions.Closed -= OnPositionClosed;
            Print("URM_PM|STOPPED|symbol={0}|managerStopped=true|Server-side SL/TP remain broker-managed.", Symbol.Name);
        }

        private void OnPositionOpened(PositionOpenedEventArgs args)
        {
            Observe(args.Position, "POSITION_OPENED");
        }

        private void OnPositionModified(PositionModifiedEventArgs args)
        {
            if (args.Position != null && _modifyInFlight.Contains(args.Position.Id))
                return;
            Observe(args.Position, "POSITION_MODIFIED");
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            if (!EnsureAccountContext("POSITION_CLOSED"))
                return;

            var position = args.Position;
            if (position == null || !string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                return;

            if (TryParseAnchorLabel(position.Label ?? string.Empty, out _, out _))
            {
                RemovePeakState(position.Id);
                Print("URM_PM|POSITION_CLOSED|positionId={0}|symbol={1}|reason={2}|netPnl={3}",
                    position.Id, position.SymbolName, args.Reason, position.NetProfit);
            }
            else if (!string.IsNullOrEmpty(position.Label) && position.Label.StartsWith(LegacyPrefix, StringComparison.Ordinal) &&
                     _foreignLabelLogged.Add(position.Id))
            {
                Print("URM_PM|WARNING|CLOSED_LABEL_NOT_OWNED|positionId={0}|Stored state was not removed because label schema was not recognized.", position.Id);
            }

            _peakRByPosition.Remove(position.Id);
            _loaded.Remove(position.Id);
            _stateInvalid.Remove(position.Id);
            _manualIntervention.Remove(position.Id);
            _modifyInFlight.Remove(position.Id);
            _lastLogSignature.Remove(position.Id);
            _lastLogAt.Remove(position.Id);
            _foreignLabelLogged.Remove(position.Id);
            _dirtyPeakState.Remove(position.Id);
        }

        private void Observe(Position position, string source, double suppliedBid = double.NaN, double suppliedAsk = double.NaN)
        {
            if (!EnsureAccountContext(source) || position == null ||
                !string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                return;

            if (_manualIntervention.Contains(position.Id) || _stateInvalid.Contains(position.Id) ||
                _modifyInFlight.Contains(position.Id))
                return;

            var label = position.Label ?? string.Empty;
            if (!label.StartsWith(LabelPrefix, StringComparison.Ordinal))
            {
                if (label.StartsWith(LegacyPrefix, StringComparison.Ordinal) && _foreignLabelLogged.Add(position.Id))
                    LogState(position, "LABEL_SCHEMA_UNSUPPORTED", "WARNING",
                        "This URM-like label is not the URM1 anchor format. No modification was attempted.");
                return;
            }

            if (!TryParseAnchorLabel(label, out var clientOrderId, out var structuralSL))
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "ANCHOR_UNREADABLE", "CRITICAL",
                    "Structural SL/client order ID could not be recovered from the position label. No modification was attempted.");
                return;
            }

            var entry = position.EntryPrice;
            var tickSize = Symbol.TickSize;
            var pipSize = Symbol.PipSize;
            if (!FinitePositive(entry) || !FinitePositive(tickSize) || !FinitePositive(pipSize))
            {
                LogState(position, "SYMBOL_DATA_INVALID", "BLOCKED", "Entry, TickSize or PipSize is unavailable.");
                return;
            }

            var isBuy = position.TradeType == TradeType.Buy;
            if ((isBuy && structuralSL >= entry) || (!isBuy && structuralSL <= entry))
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "ANCHOR_INVALID_AFTER_FILL", "CRITICAL",
                    "Structural SL is on the wrong side of actual fill. Manual reconciliation required.");
                return;
            }

            if (!IsOnTickGrid(structuralSL, tickSize))
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "ANCHOR_OFF_TICK_GRID", "CRITICAL",
                    "Encoded structural SL is not aligned to current broker TickSize. No rounding or modification attempted.");
                return;
            }

            var rDistance = Math.Abs(entry - structuralSL);
            if (!FinitePositive(rDistance) || rDistance < tickSize - 1e-10)
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "R_DISTANCE_INVALID", "CRITICAL",
                    "Original R distance is invalid or smaller than one broker tick.");
                return;
            }

            if (!EnsurePeakStateLoaded(position, source, clientOrderId, structuralSL, tickSize))
                return;

            double bid = suppliedBid;
            double ask = suppliedAsk;
            if (!FinitePositive(bid) || !FinitePositive(ask))
            {
                if (!ReadFreshTick(out bid, out ask))
                {
                    LogState(position, "QUOTE_STALE", "BLOCKED", "No fresh platform tick; stop management is paused.");
                    return;
                }
            }

            if (ask < bid)
            {
                LogState(position, "BID_ASK_INVALID", "BLOCKED", "Ask is below Bid; no target plan generated.");
                return;
            }

            // Verify target integrity before changing the SL. The manager never changes TP.
            var expectedTP = RoundTargetOutward(
                isBuy ? entry + TakeProfitR * rDistance : entry - TakeProfitR * rDistance,
                position.TradeType, tickSize);
            if (!position.TakeProfit.HasValue ||
                Math.Abs(position.TakeProfit.Value - expectedTP) > Math.Max(tickSize * 0.51, 1e-9))
            {
                LogState(position, "TP_ANCHOR_MISMATCH", "CRITICAL",
                    string.Format(CultureInfo.InvariantCulture,
                        "Server TP={0}; expected fill-anchored 5R={1}. TP mismatch prevents R-ladder SL changes.",
                        position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                        expectedTP.ToString("R", CultureInfo.InvariantCulture)));
                return;
            }

            if (!position.StopLoss.HasValue || !FinitePositive(position.StopLoss.Value))
            {
                LogState(position, "SERVER_SL_MISSING", "CRITICAL",
                    "Position has no readable server SL. No active manager changes can proceed.");
                return;
            }

            var executable = isBuy ? bid : ask;
            var currentR = isBuy ? (executable - entry) / rDistance : (entry - executable) / rDistance;
            if (double.IsNaN(currentR) || double.IsInfinity(currentR))
            {
                LogState(position, "CURRENT_R_INVALID", "BLOCKED", "Current R cannot be calculated safely.");
                return;
            }

            var oldPeak = _peakRByPosition[position.Id];
            var peak = Math.Max(oldPeak, currentR);
            if (peak > oldPeak + 1e-10)
            {
                // Persist each new high-water before any stop action. If storage fails,
                // do not trail using an in-memory-only peak that would be lost on restart.
                if (!WritePeakState(position, clientOrderId, structuralSL, peak, false))
                {
                    _stateInvalid.Add(position.Id);
                    LogState(position, "PEAK_STATE_WRITE_FAILED", "CRITICAL",
                        "High-water R could not be written to local storage. Stop changes are disabled for this position.");
                    return;
                }
                _peakRByPosition[position.Id] = peak;
            }

            var confirmedStop = position.StopLoss.Value;
            if (!IsOnTickGrid(confirmedStop, tickSize))
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "SERVER_SL_OFF_TICK_GRID", "CRITICAL",
                    "The server-reported SL is not on the current broker TickSize grid. Management paused.");
                return;
            }

            if (peak >= TakeProfitR || currentR >= TakeProfitR)
            {
                LogState(position, "TP_BOUNDARY_RECONCILIATION_REQUIRED", "CRITICAL",
                    string.Format(CultureInfo.InvariantCulture,
                        "peakR={0:F3}, currentR={1:F3}. Position is at/after 5R but still appears open; confirm server position/TP state manually. This manager will not close it.",
                        peak, currentR));
                return;
            }

            double targetStopR;
            string phase;
            if (peak >= TrailingAtR)
            {
                phase = "TRAILING";
                targetStopR = Math.Max(MinimumTrailingLockR, peak - TrailingGapR);
            }
            else if (peak >= LockAtR)
            {
                phase = "LOCK_1_7R";
                targetStopR = LockToR;
            }
            else if (peak >= BreakEvenAtR)
            {
                phase = "BREAK_EVEN";
                targetStopR = 0.0;
            }
            else
            {
                phase = "INITIAL_PROTECTION";
                targetStopR = -1.0;
            }

            var rawTargetSL = targetStopR < 0.0
                ? structuralSL
                : isBuy ? entry + targetStopR * rDistance : entry - targetStopR * rDistance;

            // Match the pure URM policy: round profit-lock stops away from the
            // executable quote (BUY down, SELL up); never round structural SL.
            var targetSL = targetStopR < 0.0
                ? structuralSL
                : RoundProtectiveStop(rawTargetSL, position.TradeType, tickSize);

            var stopIsImprovement = isBuy
                ? targetSL > confirmedStop + tickSize * 1e-6
                : targetSL < confirmedStop - tickSize * 1e-6;

            var signature = phase + "|" + targetSL.ToString("R", CultureInfo.InvariantCulture) +
                "|peak=" + peak.ToString("F4", CultureInfo.InvariantCulture);
            if (!stopIsImprovement)
            {
                LogState(position, signature, "INFO",
                    string.Format(CultureInfo.InvariantCulture,
                        "No change. currentR={0:F3}, peakR={1:F3}, confirmedSL={2}, policyTargetSL={3}; a confirmed stop is never loosened.",
                        currentR, peak, confirmedStop, targetSL));
                return;
            }

            // A stop target at/through the current executable exit price is not sent.
            if ((isBuy && targetSL >= bid - tickSize * 1e-6) ||
                (!isBuy && targetSL <= ask + tickSize * 1e-6) ||
                !IsOnTickGrid(targetSL, tickSize))
            {
                LogState(position, "STOP_TARGET_INVALID_OR_CROSSED", "CRITICAL",
                    string.Format(CultureInfo.InvariantCulture,
                        "Requested SL {0} is on/through the executable market or off TickSize grid. No modification sent.",
                        targetSL));
                return;
            }

            // Persist the exact high-water state to disk before any server SL
            // modification. This is the durable write-ahead guard for the R ladder.
            if (!WritePeakState(position, clientOrderId, structuralSL, peak, true))
            {
                _stateInvalid.Add(position.Id);
                _manualIntervention.Add(position.Id);
                LogState(position, "PEAK_STATE_DURABILITY_FAILED", "CRITICAL",
                    "Cannot flush the exact high-water state before SL modification. No broker modification sent.");
                return;
            }

            // One broker modification at a time per position. On a failed request,
            // halt changes for this row instead of retrying every tick.
            _modifyInFlight.Add(position.Id);
            TradeResult result;
            try
            {
                result = ModifyPosition(position, targetSL, position.TakeProfit, ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                _modifyInFlight.Remove(position.Id);
                _manualIntervention.Add(position.Id);
                LogState(position, "SL_MODIFY_EXCEPTION", "CRITICAL",
                    "cTrader protection modification threw " + ex.GetType().Name + ". Check Trade Watch manually.");
                return;
            }

            _modifyInFlight.Remove(position.Id);
            if (result == null || !result.IsSuccessful)
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "SL_MODIFY_REJECTED", "CRITICAL",
                    "cTrader rejected the SL update. No automatic retry. Check Trade Watch and the broker error manually.");
                return;
            }

            var updated = Positions.FindById(position.Id);
            var readBackSL = updated == null ? (double?)null : updated.StopLoss;
            var readBackTP = updated == null ? (double?)null : updated.TakeProfit;
            var tolerance = Math.Max(tickSize * 0.51, 1e-9);
            if (!readBackSL.HasValue || Math.Abs(readBackSL.Value - targetSL) > tolerance ||
                !readBackTP.HasValue || Math.Abs(readBackTP.Value - expectedTP) > tolerance)
            {
                _manualIntervention.Add(position.Id);
                LogState(position, "SL_SERVER_READBACK_MISMATCH", "CRITICAL",
                    "ModifyPosition returned success but fresh server position read-back does not match the requested SL and expected 5R TP. Management paused.");
                return;
            }

            LogState(updated, signature, "UPDATED",
                string.Format(CultureInfo.InvariantCulture,
                    "SL advanced and read back from cTrader. currentR={0:F3}, peakR={1:F3}, stopR={2:F3}, SL={3}, TP remains {4}.",
                    currentR, peak, targetStopR, readBackSL.Value, readBackTP.Value));
        }

        private bool EnsurePeakStateLoaded(Position position, string source, string clientOrderId, double structuralSL, double tickSize)
        {
            var id = position.Id;
            if (_stateInvalid.Contains(id) || _manualIntervention.Contains(id))
                return false;
            if (_loaded.Contains(id))
                return true;

            string stored;
            try { stored = LocalStorage.GetString(PeakStorageKey(id), LocalStorageScope.Type); }
            catch (Exception ex)
            {
                _stateInvalid.Add(id);
                LogState(position, "PEAK_STATE_READ_FAILED", "CRITICAL",
                    "LocalStorage read failed (" + ex.GetType().Name + "). Use local cTrader and reconcile manually.");
                return false;
            }

            if (!string.IsNullOrEmpty(stored))
            {
                if (!TryParsePeakRecord(stored, position, clientOrderId, structuralSL, tickSize, out var savedPeak))
                {
                    _stateInvalid.Add(id);
                    _manualIntervention.Add(id);
                    LogState(position, "PEAK_STATE_INVALID_OR_MISMATCHED", "CRITICAL",
                        "Saved high-water record is corrupt or does not match this exact position ID, symbol, side, entry and structural SL. Manual reconciliation is required.");
                    return false;
                }

                _peakRByPosition[id] = savedPeak;
                _loaded.Add(id);
                return true;
            }

            // Only an OPENED event proves the manager observed this new position
            // from inception. A position discovered after startup with no high-water
            // record may have had a prior favorable excursion; never initialize it to 0.
            if (string.Equals(source, "POSITION_OPENED", StringComparison.Ordinal))
            {
                _peakRByPosition[id] = 0.0;
                _loaded.Add(id);
                if (!WritePeakState(position, clientOrderId, structuralSL, 0.0, true))
                {
                    _loaded.Remove(id);
                    _stateInvalid.Add(id);
                    LogState(position, "INITIAL_PEAK_STATE_WRITE_FAILED", "CRITICAL",
                        "Could not durably initialise peak-R state. No active SL management is permitted.");
                    return false;
                }
                return true;
            }

            _manualIntervention.Add(id);
            LogState(position, "PEAK_STATE_MISSING", "CRITICAL",
                "This position was already open when the manager started and has no saved peak history. Start the manager before the URM executor, or reconcile manually; no guessed R phase is allowed.");
            return false;
        }

        private bool WritePeakState(Position position, string clientOrderId, double structuralSL, double peak, bool flushToDisk)
        {
            if (position == null || !FiniteNonNegative(peak) || !EnsureAccountContext("PEAK_PERSIST"))
                return false;
            try
            {
                var side = position.TradeType == TradeType.Buy ? "BUY" : "SELL";
                var value = "URMP1|ID=" + clientOrderId +
                    "|SYM=" + position.SymbolName +
                    "|SIDE=" + side +
                    "|ENTRY=" + position.EntryPrice.ToString("R", CultureInfo.InvariantCulture) +
                    "|SL=" + structuralSL.ToString("R", CultureInfo.InvariantCulture) +
                    "|PEAK=" + peak.ToString("R", CultureInfo.InvariantCulture);
                if (position.SymbolName.Contains("|"))
                    return false;

                LocalStorage.SetString(PeakStorageKey(position.Id), value, LocalStorageScope.Type);
                if (flushToDisk)
                {
                    LocalStorage.Flush(LocalStorageScope.Type);
                    _dirtyPeakState.Remove(position.Id);
                }
                else
                {
                    _dirtyPeakState.Add(position.Id);
                }
                return true;
            }
            catch (Exception ex)
            {
                Print("URM_PM|CRITICAL|PEAK_STATE_PERSIST_EXCEPTION|positionId={0}|error={1}|No SL change will be sent.", position.Id, ex.GetType().Name);
                return false;
            }
        }

        private void FlushPendingPeakState(string source)
        {
            if (_dirtyPeakState.Count == 0 || !EnsureAccountContext(source))
                return;

            var dirty = new List<int>(_dirtyPeakState);
            try
            {
                LocalStorage.Flush(LocalStorageScope.Type);
                _dirtyPeakState.Clear();
            }
            catch (Exception ex)
            {
                foreach (var id in dirty)
                {
                    _stateInvalid.Add(id);
                    _manualIntervention.Add(id);
                    Print("URM_PM|CRITICAL|PEAK_STATE_FLUSH_FAILED|positionId={0}|source={1}|error={2}|Management paused; inspect Trade Watch and restart only after manual reconciliation.",
                        id, source, ex.GetType().Name);
                }
                _dirtyPeakState.Clear();
            }
        }

        private static bool TryParsePeakRecord(string stored, Position position, string clientOrderId,
            double structuralSL, double tickSize, out double peak)
        {
            peak = double.NaN;
            if (string.IsNullOrEmpty(stored) || position == null)
                return false;

            var fields = stored.Split('|');
            if (fields.Length != 7 || fields[0] != "URMP1" ||
                fields[1] != "ID=" + clientOrderId ||
                fields[2] != "SYM=" + position.SymbolName ||
                fields[3] != "SIDE=" + (position.TradeType == TradeType.Buy ? "BUY" : "SELL") ||
                !fields[4].StartsWith("ENTRY=", StringComparison.Ordinal) ||
                !fields[5].StartsWith("SL=", StringComparison.Ordinal) ||
                !fields[6].StartsWith("PEAK=", StringComparison.Ordinal))
                return false;

            if (!double.TryParse(fields[4].Substring(6), NumberStyles.Float, CultureInfo.InvariantCulture, out var savedEntry) ||
                !double.TryParse(fields[5].Substring(3), NumberStyles.Float, CultureInfo.InvariantCulture, out var savedSL) ||
                !double.TryParse(fields[6].Substring(5), NumberStyles.Float, CultureInfo.InvariantCulture, out var savedPeak) ||
                !FinitePositive(savedEntry) || !FinitePositive(savedSL) || !FiniteNonNegative(savedPeak))
                return false;

            var tolerance = Math.Max(tickSize * 1e-6, Math.Abs(position.EntryPrice) * 1e-12);
            if (Math.Abs(savedEntry - position.EntryPrice) > tolerance ||
                Math.Abs(savedSL - structuralSL) > tolerance)
                return false;

            peak = savedPeak;
            return true;
        }

        private void RemovePeakState(int positionId)
        {
            _dirtyPeakState.Remove(positionId);
            try
            {
                LocalStorage.Remove(PeakStorageKey(positionId), LocalStorageScope.Type);
                LocalStorage.Flush(LocalStorageScope.Type);
            }
            catch (Exception ex)
            {
                Print("URM_PM|WARNING|PEAK_STATE_CLEANUP_FAILED|positionId={0}|error={1}", positionId, ex.GetType().Name);
            }
        }

        private bool EnsureAccountContext(string source)
        {
            if (_accountContextInvalid)
                return false;

            var currentAccount = Convert.ToInt64(Account.Number, CultureInfo.InvariantCulture);
            var currentUser = Account.UserId;
            if (currentAccount == _startupAccountNumber && currentUser == _startupUserId)
                return true;

            _accountContextInvalid = true;
            _peakRByPosition.Clear();
            _dirtyPeakState.Clear();
            _loaded.Clear();
            _stateInvalid.Clear();
            _manualIntervention.Clear();

            if (!_accountContextAlerted)
            {
                _accountContextAlerted = true;
                Print("URM_PM|CRITICAL|ACCOUNT_CONTEXT_CHANGED|source={0}|expectedAccount={1}|currentAccount={2}|The manager has halted and will not read/write new account state.",
                    source, _startupAccountNumber, currentAccount);
            }
            return false;
        }

        private bool ReadFreshTick(out double bid, out double ask)
        {
            bid = double.NaN;
            ask = double.NaN;
            try
            {
                var ticks = MarketData.GetTicks(Symbol.Name);
                if (ticks == null || ticks.Count < 1)
                    return false;

                var tick = ticks.LastTick;
                var ageSeconds = (Server.TimeInUtc - DateTime.SpecifyKind(tick.Time, DateTimeKind.Utc)).TotalSeconds;
                if (ageSeconds < 0 || ageSeconds > MaximumTickAgeSeconds)
                    return false;

                bid = tick.Bid;
                ask = tick.Ask;
                return FinitePositive(bid) && FinitePositive(ask) && ask >= bid;
            }
            catch
            {
                return false;
            }
        }

        private string PeakStorageKey(int positionId)
        {
            // cTrader LocalStorage key constraints: <=50 chars, alphanumeric/spaces only.
            var key = string.Format(CultureInfo.InvariantCulture, "URMP {0} {1} {2}",
                ToBase36(_startupAccountNumber), ToBase36(_startupUserId), ToBase36(positionId));
            if (key.Length > 50)
                throw new InvalidOperationException("LocalStorage key exceeds 50 characters.");
            return key;
        }

        private static string ToBase36(long value)
        {
            const string digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value));
            if (value == 0)
                return "0";

            var buffer = new char[13];
            var index = buffer.Length;
            while (value > 0)
            {
                var remainder = (int)(value % 36);
                buffer[--index] = digits[remainder];
                value /= 36;
            }
            return new string(buffer, index, buffer.Length - index);
        }

        private void LogState(Position position, string signature, string severity, string detail)
        {
            var now = Server.Time;
            _lastLogSignature.TryGetValue(position.Id, out var previousSignature);
            _lastLogAt.TryGetValue(position.Id, out var previousAt);
            var changed = !string.Equals(signature, previousSignature, StringComparison.Ordinal);
            if (!changed && previousAt != default(DateTime) && (now - previousAt).TotalSeconds < LogRefreshSeconds)
                return;

            _lastLogSignature[position.Id] = signature;
            _lastLogAt[position.Id] = now;
            Print("URM_PM|{0}|positionId={1}|symbol={2}|side={3}|SL={4}|TP={5}|{6}",
                severity, position.Id, position.SymbolName, position.TradeType,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                detail);
        }

        private static bool TryParseAnchorLabel(string label, out string clientOrderId, out double structuralSL)
        {
            clientOrderId = null;
            structuralSL = double.NaN;
            if (string.IsNullOrEmpty(label) || label.Length > 100 || !label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                return false;

            var parts = label.Split('|');
            if (parts.Length != 3 || parts[0] != "URM1" ||
                !parts[1].StartsWith("ID=URM-", StringComparison.Ordinal) ||
                !parts[2].StartsWith("SL=", StringComparison.Ordinal))
                return false;

            var id = parts[1].Substring(3);
            if (id.Length < 5 || id.Length > 50 || !id.StartsWith("URM-", StringComparison.Ordinal))
                return false;
            for (var i = 0; i < id.Length; i++)
            {
                var ch = id[i];
                if (!(char.IsLetterOrDigit(ch) || ch == '-'))
                    return false;
            }

            if (!double.TryParse(parts[2].Substring(3), NumberStyles.AllowDecimalPoint,
                CultureInfo.InvariantCulture, out var sl) || !FinitePositive(sl))
                return false;

            clientOrderId = id;
            structuralSL = sl;
            return true;
        }

        private static double RoundTargetOutward(double price, TradeType side, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize))
                return double.NaN;
            var units = price / tickSize;
            var rounded = side == TradeType.Buy
                ? Math.Ceiling(units - 1e-10)
                : Math.Floor(units + 1e-10);
            return Math.Round(rounded * tickSize, 10, MidpointRounding.AwayFromZero);
        }

        private static double RoundProtectiveStop(double price, TradeType side, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize))
                return double.NaN;
            var units = price / tickSize;
            var rounded = side == TradeType.Buy
                ? Math.Floor(units + 1e-10)
                : Math.Ceiling(units - 1e-10);
            return Math.Round(rounded * tickSize, 10, MidpointRounding.AwayFromZero);
        }

        private static bool IsOnTickGrid(double price, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize))
                return false;
            var units = price / tickSize;
            return Math.Abs(units - Math.Round(units)) <= 1e-6;
        }

        private static bool FinitePositive(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value) && value > 0.0;
        }

        private static bool FiniteNonNegative(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value) && value >= 0.0;
        }
    }
}
