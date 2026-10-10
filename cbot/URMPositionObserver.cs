// URM Position Observer v1.1 (carried into Stage F; read-only)
// IMPORTANT: This cBot is READ-ONLY. It never calls ModifyPosition, ClosePosition,
// ExecuteMarketOrder, or any other trading mutation. Use it for Demo observation only.
// High-water peak R is account-scoped in cTrader LocalStorage (Type scope). Existing
// positions without a valid persisted peak are blocked for manual reconciliation.
// Requires orders to carry an anchor label in this format:
// URM1|ID=URM-<alphanumeric-id>|SL=<structural-price>

using System;
using System.Collections.Generic;
using System.Globalization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMPositionObserver : Robot
    {
        private const string LabelPrefix = "URM1|";
        private const string LegacyUrmPrefix = "URM";
        private const double BreakEvenAtR = 1.0;
        private const double LockAtR = 2.0;
        private const double LockToR = 1.7;
        private const double TrailingAtR = 3.0;
        private const double TrailingGapR = 1.0;
        private const double MinimumTrailingLockR = 2.0;
        private const double TakeProfitR = 5.0;

        [Parameter("Log refresh interval (seconds)", DefaultValue = 5, MinValue = 1, MaxValue = 60)]
        public int LogRefreshSeconds { get; set; }

        private readonly Dictionary<int, double> _peakRByPosition = new Dictionary<int, double>();
        private readonly Dictionary<int, string> _lastSignatureByPosition = new Dictionary<int, string>();
        private readonly Dictionary<int, DateTime> _lastLogAtByPosition = new Dictionary<int, DateTime>();
        private readonly HashSet<int> _invalidLabelLogged = new HashSet<int>();
        private readonly HashSet<int> _peakStateLoaded = new HashSet<int>();
        private readonly HashSet<int> _peakStateNeedsReconciliation = new HashSet<int>();
        private readonly HashSet<int> _peakStateInvalid = new HashSet<int>();
        private readonly Dictionary<int, double> _dirtyPeakRByPosition = new Dictionary<int, double>();

        private int _startupAccountNumber;
        private long _startupUserId;
        private bool _accountContextInvalid;
        private bool _accountContextAlerted;
        private bool _storageWriteFaultLogged;

        protected override void OnStart()
        {
            _startupAccountNumber = Account.Number;
            _startupUserId = Account.UserId;
            Positions.Opened += OnPositionOpened;
            Positions.Modified += OnPositionModified;
            Positions.Closed += OnPositionClosed;
            Timer.Start(1);

            Print("URM Position Observer started on {0}, account={1}. MODE=READ_ONLY; no orders or protections will be modified.", Symbol.Name, _startupAccountNumber);
            Print("This instance observes only URM-labelled positions for its chart symbol. Start a separate observer instance per symbol.");

            foreach (var position in Positions)
                Observe(position, "STARTUP_SCAN");
        }

        protected override void OnTick()
        {
            if (!EnsureAccountContext("TICK"))
                return;

            // The bot is attached to a symbol chart. Filter the account-wide position
            // collection to this symbol so its tick stream is relevant to every managed row.
            foreach (var position in Positions)
            {
                if (string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                    Observe(position, "TICK");
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
            Print("URM Position Observer stopped on {0}. No trading operation was performed by this observer.", Symbol.Name);
        }

        private void OnPositionOpened(PositionOpenedEventArgs args)
        {
            Observe(args.Position, "POSITION_OPENED");
        }

        private void OnPositionModified(PositionModifiedEventArgs args)
        {
            Observe(args.Position, "POSITION_MODIFIED");
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            if (!EnsureAccountContext("POSITION_CLOSED"))
                return;

            var position = args.Position;
            if (!string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                return;

            if (TryParseAnchorLabel(position.Label ?? string.Empty, out var closedClientOrderId, out var closedStructuralSl, out var closeParseReason))
            {
                Print("POSITION_CLOSED id={0} symbol={1} clientOrderId={2} grossPnl={3}", position.Id, position.SymbolName, closedClientOrderId, position.GrossProfit);
                RemovePeakState(position.Id);
            }
            else if (!string.IsNullOrEmpty(position.Label) && position.Label.StartsWith(LegacyUrmPrefix, StringComparison.Ordinal))
            {
                // Preserve any existing journal record for a malformed/foreign URM-like label.
                // Do not delete state based on an untrusted label prefix alone.
                Print("WARNING CLOSED_LABEL_NOT_OWNED id={0} symbol={1} reason={2}. Stored state was not deleted automatically.", position.Id, position.SymbolName, closeParseReason);
            }

            _peakRByPosition.Remove(position.Id);
            _lastSignatureByPosition.Remove(position.Id);
            _lastLogAtByPosition.Remove(position.Id);
            _invalidLabelLogged.Remove(position.Id);
            _peakStateLoaded.Remove(position.Id);
            _peakStateNeedsReconciliation.Remove(position.Id);
            _peakStateInvalid.Remove(position.Id);
            _dirtyPeakRByPosition.Remove(position.Id);
        }

        private void Observe(Position position, string source)
        {
            if (!EnsureAccountContext(source))
                return;
            if (position == null || !string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                return;

            var label = position.Label ?? string.Empty;
            if (!label.StartsWith(LegacyUrmPrefix, StringComparison.Ordinal))
                return;

            if (!TryParseAnchorLabel(label, out var clientOrderId, out var structuralStopLoss, out var parseReason))
            {
                if (_invalidLabelLogged.Add(position.Id))
                    Print("CRITICAL ANCHOR_UNREADABLE positionId={0} symbol={1} label='{2}' reason='{3}'. READ ONLY: inspect this position manually; this observer did not change it.",
                        position.Id, position.SymbolName, label, parseReason);
                return;
            }

            if (!EnsurePeakStateLoaded(position, source))
                return;

            var entry = position.EntryPrice;
            var tick = Symbol.TickSize;
            if (!IsFinitePositive(entry) || !IsFinitePositive(tick) || !IsFinitePositive(Symbol.Bid) || !IsFinitePositive(Symbol.Ask))
            {
                LogSnapshot(position, source, "DATA_UNAVAILABLE", "BLOCKED", double.NaN, double.NaN, double.NaN,
                    "Entry, tick size or executable quote is unavailable.");
                return;
            }

            if ((position.TradeType == TradeType.Buy && structuralStopLoss >= entry) ||
                (position.TradeType == TradeType.Sell && structuralStopLoss <= entry))
            {
                LogSnapshot(position, source, "ANCHOR_INVALID_AFTER_FILL", "MANUAL_INTERVENTION", double.NaN, double.NaN, double.NaN,
                    "Structural SL is not on the protective side of actual fill. Do not infer R; inspect manually.");
                return;
            }

            var tickUnits = structuralStopLoss / tick;
            if (Math.Abs(tickUnits - Math.Round(tickUnits)) > 0.00001)
            {
                LogSnapshot(position, source, "ANCHOR_OFF_TICK_GRID", "MANUAL_INTERVENTION", double.NaN, double.NaN, double.NaN,
                    "Structural SL label is not aligned to the live symbol tick size. No automatic correction is attempted.");
                return;
            }

            var rDistance = Math.Abs(entry - structuralStopLoss);
            if (!IsFinitePositive(rDistance) || rDistance < tick - 1e-10)
            {
                LogSnapshot(position, source, "R_DISTANCE_INVALID", "MANUAL_INTERVENTION", double.NaN, double.NaN, double.NaN,
                    "R distance is zero, invalid, or smaller than one symbol tick.");
                return;
            }

            // Use the executable quote for the position side: Bid to close a BUY, Ask to close a SELL.
            var executablePrice = position.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
            var currentR = position.TradeType == TradeType.Buy
                ? (executablePrice - entry) / rDistance
                : (entry - executablePrice) / rDistance;

            double existingStopR = double.NegativeInfinity;
            double inferredPeak = 0.0;
            if (position.StopLoss.HasValue)
            {
                existingStopR = position.TradeType == TradeType.Buy
                    ? (position.StopLoss.Value - entry) / rDistance
                    : (entry - position.StopLoss.Value) / rDistance;

                // This is only a conservative clue from confirmed server protection, not a
                // substitute for durable peak-R state. A previously failed SL update can mean
                // the true peak was higher than can be inferred here.
                if (existingStopR >= MinimumTrailingLockR)
                    inferredPeak = existingStopR + TrailingGapR;
                else if (existingStopR >= LockToR)
                    inferredPeak = LockAtR;
                else if (existingStopR >= -1e-8)
                    inferredPeak = BreakEvenAtR;
            }

            _peakRByPosition.TryGetValue(position.Id, out var rememberedPeak);
            var peakR = Math.Max(Math.Max(currentR, rememberedPeak), inferredPeak);
            if (peakR > rememberedPeak + 1e-10)
            {
                _peakRByPosition[position.Id] = peakR;
                _dirtyPeakRByPosition[position.Id] = peakR;
            }
            else
            {
                _peakRByPosition[position.Id] = rememberedPeak;
            }

            var targetTakeProfit = RoundToTick(
                position.TradeType == TradeType.Buy ? entry + (TakeProfitR * rDistance) : entry - (TakeProfitR * rDistance),
                tick,
                position.TradeType == TradeType.Buy);

            if (peakR >= TakeProfitR || currentR >= TakeProfitR)
            {
                LogSnapshot(position, source, "TP_BOUNDARY_RECONCILIATION_REQUIRED", "CRITICAL", position.StopLoss ?? double.NaN,
                    targetTakeProfit, currentR,
                    string.Format(CultureInfo.InvariantCulture,
                        "peakR={0:F3}. Position is at/after 5R but still appears open. Reconcile server position and TP; this observer will not close or modify it. clientOrderId={1}", peakR, clientOrderId));
                return;
            }

            string phase;
            double requestedStopR;
            if (peakR >= TrailingAtR)
            {
                phase = "TRAILING";
                requestedStopR = Math.Max(MinimumTrailingLockR, peakR - TrailingGapR);
            }
            else if (peakR >= LockAtR)
            {
                phase = "LOCK_1_7R";
                requestedStopR = LockToR;
            }
            else if (peakR >= BreakEvenAtR)
            {
                phase = "BREAK_EVEN";
                requestedStopR = 0.0;
            }
            else
            {
                phase = "INITIAL_PROTECTION";
                requestedStopR = -1.0;
            }

            var effectiveStopR = position.StopLoss.HasValue ? Math.Max(requestedStopR, existingStopR) : requestedStopR;
            var rawTargetStop = effectiveStopR < 0.0
                ? structuralStopLoss
                : position.TradeType == TradeType.Buy
                    ? entry + (effectiveStopR * rDistance)
                    : entry - (effectiveStopR * rDistance);

            // Existing server SL is already more protective; preserve its exact price and never round it backwards.
            var roundStopUp = effectiveStopR < 0.0
                ? position.TradeType == TradeType.Buy // initial risk stop: round towards entry, never enlarge planned risk
                : position.TradeType == TradeType.Sell; // profit lock/trailing: round away from the executable quote
            var targetStop = position.StopLoss.HasValue && existingStopR > requestedStopR + 1e-9
                ? position.StopLoss.Value
                : RoundToTick(rawTargetStop, tick, roundStopUp);

            var stopStatus = !position.StopLoss.HasValue
                ? "SERVER_SL_MISSING"
                : effectiveStopR > existingStopR + 1e-6
                    ? "SL_ADVANCE_PROPOSED"
                    : "SERVER_SL_AT_OR_MORE_PROTECTIVE";
            var tpTolerance = tick * 0.25;
            var tpStatus = !position.TakeProfit.HasValue
                ? "SERVER_TP_MISSING"
                : Math.Abs(position.TakeProfit.Value - targetTakeProfit) > tpTolerance
                    ? "SERVER_TP_MISMATCH"
                    : "SERVER_TP_MATCHED";

            var targetCrossed = position.TradeType == TradeType.Buy
                ? targetStop >= executablePrice - (tick * 1e-6)
                : targetStop <= executablePrice + (tick * 1e-6);
            var actionStatus = targetCrossed ? "STOP_TARGET_CROSSED_BY_MARKET" : stopStatus;
            var detail = string.Format(CultureInfo.InvariantCulture,
                "clientOrderId={0}; currentR={1:F3}; peakR={2:F3}; rDistance={3}; existingSL={4}; proposedSL={5}; targetTP5R={6}; stopStatus={7}; tpStatus={8}; source={9}. READ ONLY: no modification request was sent.",
                clientOrderId, currentR, peakR, rDistance, position.StopLoss.HasValue ? position.StopLoss.Value.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture) : "NONE",
                targetStop.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture),
                targetTakeProfit.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture), actionStatus, tpStatus, source);

            var severity = targetCrossed || !position.StopLoss.HasValue || !position.TakeProfit.HasValue || tpStatus == "SERVER_TP_MISMATCH"
                ? "CRITICAL"
                : stopStatus == "SL_ADVANCE_PROPOSED" ? "NOTICE" : "INFO";
            LogSnapshot(position, source, phase + "|" + actionStatus + "|" + tpStatus, severity, targetStop, targetTakeProfit, currentR, detail);
        }

        private bool EnsureAccountContext(string source)
        {
            if (_accountContextInvalid)
                return false;

            if (Account.Number == _startupAccountNumber && Account.UserId == _startupUserId)
                return true;

            _accountContextInvalid = true;
            _dirtyPeakRByPosition.Clear();
            if (!_accountContextAlerted)
            {
                _accountContextAlerted = true;
                Print("CRITICAL ACCOUNT_CONTEXT_CHANGED source={0}; expectedAccount={1}/user={2}, currentAccount={3}/user={4}. Observer is fail-closed and will not read/write peak state under the new account.",
                    source, _startupAccountNumber, _startupUserId, Account.Number, Account.UserId);
            }
            return false;
        }

        private string PeakStorageKey(int positionId)
        {
            // LocalStorage keys allow only alphanumeric characters and internal spaces, max 50 chars.
            // Base-36 compresses numeric identifiers while preserving an unambiguous tuple.
            // It avoids relying on decimal digit counts for large account/user/position IDs.
            var key = string.Format(CultureInfo.InvariantCulture, "URMP {0} {1} {2}",
                ToBase36(Convert.ToInt64(_startupAccountNumber)),
                ToBase36(_startupUserId),
                ToBase36(Convert.ToInt64(positionId)));
            if (key.Length > 50)
                throw new InvalidOperationException("Generated LocalStorage key exceeds the documented 50-character limit.");
            return key;
        }

        private static string ToBase36(long value)
        {
            const string digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value), "Storage identifiers must be non-negative.");
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

        private bool EnsurePeakStateLoaded(Position position, string source)
        {
            var id = position.Id;
            if (_peakStateInvalid.Contains(id) || _peakStateNeedsReconciliation.Contains(id))
                return false;
            if (_peakStateLoaded.Contains(id))
                return true;

            var key = PeakStorageKey(id);
            string stored;
            try
            {
                stored = LocalStorage.GetString(key, LocalStorageScope.Type);
            }
            catch (Exception ex)
            {
                _peakStateInvalid.Add(id);
                Print("CRITICAL PEAK_STATE_READ_FAILED positionId={0} key='{1}' error='{2}'. Manual reconciliation is required; no target plan will be generated.", id, key, ex.Message);
                return false;
            }

            if (!string.IsNullOrEmpty(stored))
            {
                if (!double.TryParse(stored, NumberStyles.Float, CultureInfo.InvariantCulture, out var savedPeak) ||
                    double.IsNaN(savedPeak) || double.IsInfinity(savedPeak) || savedPeak < 0.0)
                {
                    _peakStateInvalid.Add(id);
                    Print("CRITICAL PEAK_STATE_CORRUPT positionId={0} key='{1}' value='{2}'. Manual reconciliation is required; no target plan will be generated.", id, key, stored);
                    return false;
                }

                _peakRByPosition[id] = savedPeak;
                _peakStateLoaded.Add(id);
                return true;
            }

            // A position observed for the first time via an OPENED event can start a fresh state.
            // Any existing position with no saved high-water state is ambiguous after restart.
            if (string.Equals(source, "POSITION_OPENED", StringComparison.Ordinal))
            {
                _peakRByPosition[id] = 0.0;
                _peakStateLoaded.Add(id);
                _dirtyPeakRByPosition[id] = 0.0;
                return true;
            }

            _peakStateNeedsReconciliation.Add(id);
            Print("CRITICAL PEAK_STATE_MISSING positionId={0} symbol={1} label='{2}'. This may be a pre-existing/restarted position with lost high-water history. The observer refuses to infer an active management phase; manually reconcile before any future active manager is allowed.",
                position.Id, position.SymbolName, position.Label);
            return false;
        }

        private void FlushPendingPeakState(string source)
        {
            if (!EnsureAccountContext(source) || _dirtyPeakRByPosition.Count == 0)
                return;

            var snapshot = new Dictionary<int, double>(_dirtyPeakRByPosition);
            try
            {
                foreach (var pair in snapshot)
                {
                    LocalStorage.SetString(PeakStorageKey(pair.Key),
                        pair.Value.ToString("R", CultureInfo.InvariantCulture), LocalStorageScope.Type);
                }

                LocalStorage.Flush(LocalStorageScope.Type);
                foreach (var pair in snapshot)
                {
                    if (_dirtyPeakRByPosition.TryGetValue(pair.Key, out var latest) && latest <= pair.Value + 1e-10)
                        _dirtyPeakRByPosition.Remove(pair.Key);
                }
                _storageWriteFaultLogged = false;
            }
            catch (Exception ex)
            {
                if (!_storageWriteFaultLogged)
                {
                    _storageWriteFaultLogged = true;
                    Print("CRITICAL PEAK_STATE_WRITE_FAILED source={0} error='{1}'. Dirty state remains queued; this observer has no trading mutation enabled.", source, ex.Message);
                }
            }
        }

        private void RemovePeakState(int positionId)
        {
            _dirtyPeakRByPosition.Remove(positionId);
            try
            {
                LocalStorage.Remove(PeakStorageKey(positionId), LocalStorageScope.Type);
                LocalStorage.Flush(LocalStorageScope.Type);
            }
            catch (Exception ex)
            {
                Print("WARNING PEAK_STATE_CLEANUP_FAILED positionId={0} error='{1}'. A stale, account-scoped peak record may remain.", positionId, ex.Message);
            }
        }

        private void LogSnapshot(Position position, string source, string signature, string severity,
            double proposedStop, double targetTakeProfit, double currentR, string detail)
        {
            var now = Server.Time;
            var previousSignature = _lastSignatureByPosition.ContainsKey(position.Id) ? _lastSignatureByPosition[position.Id] : null;
            var previousLogAt = _lastLogAtByPosition.ContainsKey(position.Id) ? _lastLogAtByPosition[position.Id] : DateTime.MinValue;
            var signatureChanged = !string.Equals(signature, previousSignature, StringComparison.Ordinal);
            if (!signatureChanged && (now - previousLogAt).TotalSeconds < LogRefreshSeconds)
                return;

            _lastSignatureByPosition[position.Id] = signature;
            _lastLogAtByPosition[position.Id] = now;
            Print("{0} positionId={1} symbol={2} state={3} currentR={4} proposedSL={5} targetTP={6} :: {7}",
                severity, position.Id, position.SymbolName, signature,
                double.IsNaN(currentR) ? "N/A" : currentR.ToString("F3", CultureInfo.InvariantCulture),
                double.IsNaN(proposedStop) ? "N/A" : proposedStop.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture),
                double.IsNaN(targetTakeProfit) ? "N/A" : targetTakeProfit.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture), detail);
        }

        private static bool TryParseAnchorLabel(string label, out string clientOrderId, out double structuralStopLoss, out string reason)
        {
            clientOrderId = null;
            structuralStopLoss = double.NaN;
            reason = "Label must exactly match URM1|ID=URM-...|SL=<positive-price>.";
            if (string.IsNullOrEmpty(label) || label.Length > 100 || !label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                return false;

            var parts = label.Split('|');
            if (parts.Length != 3 || parts[0] != "URM1" || !parts[1].StartsWith("ID=", StringComparison.Ordinal) || !parts[2].StartsWith("SL=", StringComparison.Ordinal))
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

            var slText = parts[2].Substring(3);
            if (!double.TryParse(slText, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var sl) || !IsFinitePositive(sl))
                return false;

            clientOrderId = id;
            structuralStopLoss = sl;
            reason = string.Empty;
            return true;
        }

        private static double RoundToTick(double price, double tickSize, bool roundUp)
        {
            var units = price / tickSize;
            var roundedUnits = roundUp
                ? Math.Ceiling(units - 1e-10)
                : Math.Floor(units + 1e-10);
            return Math.Round(roundedUnits * tickSize, 10, MidpointRounding.AwayFromZero);
        }

        private static bool IsFinitePositive(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value) && value > 0.0;
        }
    }
}
