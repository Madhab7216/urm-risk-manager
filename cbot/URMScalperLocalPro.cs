// URM Scalper Local Pro v1.0
// Local cTrader Desktop cBot. Price-action equivalent of the user's described
// M5 breakout -> M1 opposite pullback -> pullback break, Order Block retest,
// USD fixed-risk sizing, fill-anchored 5R TP and R-ladder + candle-flip trailing.
// LuxAlgo / Sideways Alarm proprietary TradingView outputs are NOT read by this cBot.

using System;
using System.Collections.Generic;
using System.Globalization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMScalperLocalPro : Robot
    {
        private const string LabelPrefix = "URMSTRAT|V1|";
        private const double RiskToleranceUsd = 0.02;

        [Parameter("Enable new entries", Group = "01. Execution", DefaultValue = false)]
        public bool EnableNewEntries { get; set; }

        [Parameter("Allow Demo entries", Group = "01. Execution", DefaultValue = true)]
        public bool AllowDemoEntries { get; set; }

        [Parameter("Allow Live entries (explicit)", Group = "01. Execution", DefaultValue = false)]
        public bool AllowLiveEntries { get; set; }

        [Parameter("Require Hedged account", Group = "01. Execution", DefaultValue = true)]
        public bool RequireHedgedAccount { get; set; }

        [Parameter("Max URM positions account-wide", Group = "01. Execution", DefaultValue = 1, MinValue = 1, MaxValue = 10)]
        public int MaxUrmPositionsAccountWide { get; set; }

        [Parameter("Fixed price risk USD", Group = "02. Risk", DefaultValue = 10.0, MinValue = 1.0, MaxValue = 10000.0)]
        public double FixedRiskUsd { get; set; }

        [Parameter("Take profit R", Group = "02. Risk", DefaultValue = 5.0, MinValue = 1.0, MaxValue = 20.0)]
        public double TakeProfitR { get; set; }

        [Parameter("Max spread (ticks)", Group = "02. Risk", DefaultValue = 100, MinValue = 1, MaxValue = 100000)]
        public int MaxSpreadTicks { get; set; }

        [Parameter("Max tick age seconds", Group = "02. Risk", DefaultValue = 5, MinValue = 1, MaxValue = 60)]
        public int MaxTickAgeSeconds { get; set; }

        [Parameter("M5 swing lookback bars", Group = "03. M5 Breakout", DefaultValue = 12, MinValue = 3, MaxValue = 100)]
        public int M5SwingLookback { get; set; }

        [Parameter("M5 breakout buffer ticks", Group = "03. M5 Breakout", DefaultValue = 1, MinValue = 0, MaxValue = 1000)]
        public int M5BreakoutBufferTicks { get; set; }

        [Parameter("M5 Order Block search bars", Group = "03. M5 Breakout", DefaultValue = 20, MinValue = 2, MaxValue = 100)]
        public int OrderBlockLookback { get; set; }

        [Parameter("Require OB retest", Group = "04. M1 Confirmation", DefaultValue = true)]
        public bool RequireOrderBlockRetest { get; set; }

        [Parameter("M1 pullback min bars", Group = "04. M1 Confirmation", DefaultValue = 2, MinValue = 1, MaxValue = 5)]
        public int MinPullbackBars { get; set; }

        [Parameter("M1 pullback max bars", Group = "04. M1 Confirmation", DefaultValue = 5, MinValue = 2, MaxValue = 10)]
        public int MaxPullbackBars { get; set; }

        [Parameter("M1 confirmation buffer ticks", Group = "04. M1 Confirmation", DefaultValue = 1, MinValue = 0, MaxValue = 1000)]
        public int M1BreakoutBufferTicks { get; set; }

        [Parameter("Setup expiry M1 bars", Group = "04. M1 Confirmation", DefaultValue = 30, MinValue = 5, MaxValue = 240)]
        public int SetupExpiryM1Bars { get; set; }

        [Parameter("Structural SL buffer ticks", Group = "05. Protection", DefaultValue = 2, MinValue = 0, MaxValue = 1000)]
        public int StopBufferTicks { get; set; }

        [Parameter("R ladder enabled", Group = "05. Protection", DefaultValue = true)]
        public bool EnableRLadder { get; set; }

        [Parameter("M1 candle-flip trail enabled", Group = "05. Protection", DefaultValue = true)]
        public bool EnableCandleFlipTrail { get; set; }

        [Parameter("BE trigger R", Group = "05. Protection", DefaultValue = 1.0, MinValue = 0.1, MaxValue = 10.0)]
        public double BreakEvenAtR { get; set; }

        [Parameter("Lock trigger R", Group = "05. Protection", DefaultValue = 2.0, MinValue = 0.2, MaxValue = 20.0)]
        public double LockAtR { get; set; }

        [Parameter("Lock to R", Group = "05. Protection", DefaultValue = 1.7, MinValue = 0.0, MaxValue = 19.0)]
        public double LockToR { get; set; }

        [Parameter("Trail starts R", Group = "05. Protection", DefaultValue = 3.0, MinValue = 0.5, MaxValue = 20.0)]
        public double TrailStartsAtR { get; set; }

        [Parameter("Trail gap R", Group = "05. Protection", DefaultValue = 1.0, MinValue = 0.1, MaxValue = 10.0)]
        public double TrailGapR { get; set; }

        [Parameter("Trail minimum lock R", Group = "05. Protection", DefaultValue = 2.0, MinValue = 0.0, MaxValue = 19.0)]
        public double TrailFloorR { get; set; }

        private Bars _m1;
        private Bars _m5;
        private DateTime _lastM1CurrentOpen = DateTime.MinValue;
        private DateTime _lastM1ClosedOpen = DateTime.MinValue;
        private DateTime _lastM5ClosedOpen = DateTime.MinValue;

        private bool _setupActive;
        private TradeType _setupSide;
        private DateTime _setupCloseTime = DateTime.MinValue;
        private int _setupAgeBars;
        private bool _obValid;
        private double _obLow;
        private double _obHigh;

        private bool _pullbackActive;
        private int _pullbackCount;
        private double _pullbackHigh;
        private double _pullbackLow;
        private bool _pullbackTouchedOb;

        private readonly Dictionary<long, DateTime> _lastModifyFailureLog = new Dictionary<long, DateTime>();
        private readonly HashSet<long> _haltedPositionIds = new HashSet<long>();

        protected override void OnStart()
        {
            try
            {
                if (!FinitePositive(Symbol.TickSize) || !FinitePositive(Symbol.PipSize))
                {
                    Print("URM_LOCAL|FATAL|INVALID_TICK_OR_PIP_SIZE");
                    Stop();
                    return;
                }

                _m1 = MarketData.GetBars(TimeFrame.Minute, Symbol.Name);
                _m5 = MarketData.GetBars(TimeFrame.Minute5, Symbol.Name);

                if (_m1 == null || _m5 == null || _m1.Count < 10 || _m5.Count < M5SwingLookback + 3)
                {
                    Print("URM_LOCAL|WAIT|NOT_ENOUGH_M1_M5_HISTORY|symbol={0}", Symbol.Name);
                    Stop();
                    return;
                }

                // Startup is deliberately non-retroactive: never enter from an old historical signal.
                _lastM1CurrentOpen = _m1.OpenTimes.LastValue;
                _lastM1ClosedOpen = _m1.OpenTimes[_m1.Count - 2];
                _lastM5ClosedOpen = _m5.OpenTimes[_m5.Count - 2];

                Print("URM_LOCAL|STARTED|symbol={0}|account={1}|live={2}|entriesEnabled={3}|liveEntriesAllowed={4}|riskUSD={5:F2}|TP_R={6:F2}|m5Lookback={7}|OBRequired={8}",
                    Symbol.Name, Account.Number, Account.IsLive, EnableNewEntries, AllowLiveEntries,
                    FixedRiskUsd, TakeProfitR, M5SwingLookback, RequireOrderBlockRetest);
                Print("URM_LOCAL|RULES|M5 close beyond prior swing; M1 opposite-color pullback then close-break; SL=pullback extreme+buffer; BE@{0}R; lock +{1}R at {2}R; trail@{3}R gap={4}R floor={5}R; candle-color flip is a native proxy, not Sideways Alarm output.",
                    BreakEvenAtR, LockToR, LockAtR, TrailStartsAtR, TrailGapR, TrailFloorR);
                Print("URM_LOCAL|SAFETY|Only one URM instance per account/symbol; stop old URM managers before starting this bot.");
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|FATAL|START_EXCEPTION|{0}", ex.GetType().Name);
                Stop();
            }
        }

        protected override void OnTick()
        {
            if (_m1 == null || _m5 == null || _m1.Count < 3 || _m5.Count < M5SwingLookback + 3)
                return;

            ProcessNewM5Close();

            var currentM1Open = _m1.OpenTimes.LastValue;
            if (currentM1Open != _lastM1CurrentOpen)
            {
                _lastM1CurrentOpen = currentM1Open;
                var closedIndex = _m1.Count - 2;
                var closedOpen = _m1.OpenTimes[closedIndex];

                if (closedOpen != _lastM1ClosedOpen)
                {
                    _lastM1ClosedOpen = closedOpen;
                    var closedAt = closedOpen.AddMinutes(1);
                    var staleMinutes = (Server.TimeInUtc - closedAt).TotalMinutes;

                    if (staleMinutes > 2.0 || staleMinutes < -0.25)
                    {
                        ResetSetup("STALE_M1_DATA");
                    }
                    else
                    {
                        ProcessClosedM1Bar(closedIndex);
                        ManagePositions(true, closedIndex - 1, closedIndex);
                        return;
                    }
                }
            }

            ManagePositions(false, -1, -1);
        }

        private void ProcessNewM5Close()
        {
            var index = _m5.Count - 2;
            if (index < M5SwingLookback + 1)
                return;

            var closedOpen = _m5.OpenTimes[index];
            if (closedOpen == _lastM5ClosedOpen)
                return;

            _lastM5ClosedOpen = closedOpen;
            var closedAt = closedOpen.AddMinutes(5);
            var staleMinutes = (Server.TimeInUtc - closedAt).TotalMinutes;
            if (staleMinutes > 2.0 || staleMinutes < -0.25)
            {
                ResetSetup("STALE_M5_DATA");
                Print("URM_LOCAL|NO_SIGNAL|STALE_M5_CLOSE|time={0:O}", closedOpen);
                return;
            }

            var priorHigh = double.NegativeInfinity;
            var priorLow = double.PositiveInfinity;
            for (var i = index - M5SwingLookback; i <= index - 1; i++)
            {
                priorHigh = Math.Max(priorHigh, _m5.HighPrices[i]);
                priorLow = Math.Min(priorLow, _m5.LowPrices[i]);
            }

            var close = _m5.ClosePrices[index];
            var buffer = M5BreakoutBufferTicks * Symbol.TickSize;
            TradeType? side = null;

            if (close > priorHigh + buffer)
                side = TradeType.Buy;
            else if (close < priorLow - buffer)
                side = TradeType.Sell;

            if (!side.HasValue)
                return;

            double obLow;
            double obHigh;
            var obFound = TryFindOrderBlock(index, side.Value, out obLow, out obHigh);

            if (RequireOrderBlockRetest && !obFound)
            {
                ResetSetup("M5_BREAKOUT_WITHOUT_OPPOSING_OB");
                Print("URM_LOCAL|SIGNAL_BLOCK|NO_ORDER_BLOCK|side={0}|m5Close={1:O}", side.Value, closedAt);
                return;
            }

            _setupActive = true;
            _setupSide = side.Value;
            _setupCloseTime = closedAt;
            _setupAgeBars = 0;
            _obValid = obFound;
            _obLow = obFound ? obLow : double.NaN;
            _obHigh = obFound ? obHigh : double.NaN;
            ResetPullback();

            Print("URM_LOCAL|M5_BREAKOUT|side={0}|close={1}|priorHigh={2}|priorLow={3}|ob={4}|obLow={5}|obHigh={6}|setupTime={7:O}",
                _setupSide, close, priorHigh, priorLow, _obValid, _obLow, _obHigh, _setupCloseTime);
        }

        private bool TryFindOrderBlock(int breakoutIndex, TradeType side, out double low, out double high)
        {
            low = double.NaN;
            high = double.NaN;
            var first = Math.Max(0, breakoutIndex - OrderBlockLookback);

            for (var i = breakoutIndex - 1; i >= first; i--)
            {
                var open = _m5.OpenPrices[i];
                var close = _m5.ClosePrices[i];
                var bearish = close < open;
                var bullish = close > open;
                var opposing = side == TradeType.Buy ? bearish : bullish;

                if (!opposing)
                    continue;

                // Mechanical ICT-style proxy: full range of the last opposing M5 candle before breakout.
                low = _m5.LowPrices[i];
                high = _m5.HighPrices[i];
                return FinitePositive(low) && FinitePositive(high) && high >= low;
            }

            return false;
        }

        private void ProcessClosedM1Bar(int index)
        {
            if (!_setupActive)
                return;

            var barOpen = _m1.OpenTimes[index];
            if (barOpen < _setupCloseTime)
                return;

            _setupAgeBars++;
            if (_setupAgeBars > SetupExpiryM1Bars)
            {
                ResetSetup("SETUP_EXPIRED");
                Print("URM_LOCAL|SETUP_EXPIRED|symbol={0}", Symbol.Name);
                return;
            }

            var open = _m1.OpenPrices[index];
            var close = _m1.ClosePrices[index];
            var high = _m1.HighPrices[index];
            var low = _m1.LowPrices[index];
            var oppositeColor = _setupSide == TradeType.Buy ? close < open : close > open;
            var buffer = M1BreakoutBufferTicks * Symbol.TickSize;

            // A fresh structural extreme invalidates the active micro-pullback; the current
            // opposite candle may start a new pullback immediately.
            if (_pullbackActive)
            {
                var structureBroken = _setupSide == TradeType.Buy
                    ? low < _pullbackLow - Symbol.TickSize * 0.1
                    : high > _pullbackHigh + Symbol.TickSize * 0.1;
                if (structureBroken)
                    ResetPullback();
            }

            if (oppositeColor)
            {
                AddPullbackBar(high, low);

                if (_obValid && high >= _obLow && low <= _obHigh)
                    _pullbackTouchedOb = true;

                if (_pullbackCount >= MaxPullbackBars)
                {
                    // Keep a bounded micro-pattern window rather than letting it drift indefinitely.
                    var touched = _pullbackTouchedOb;
                    _pullbackHigh = high;
                    _pullbackLow = low;
                    _pullbackCount = 1;
                    _pullbackTouchedOb = touched || (_obValid && high >= _obLow && low <= _obHigh);
                }

                return;
            }

            if (!_pullbackActive)
                return;

            var breakConfirmed = _setupSide == TradeType.Buy
                ? close > _pullbackHigh + buffer
                : close < _pullbackLow - buffer;

            if (!breakConfirmed)
                return;

            if (_pullbackCount < MinPullbackBars)
            {
                Print("URM_LOCAL|SIGNAL_REJECTED|PULLBACK_TOO_SHORT|bars={0}", _pullbackCount);
                ResetPullback();
                return;
            }

            if (RequireOrderBlockRetest && (!_obValid || !_pullbackTouchedOb))
            {
                Print("URM_LOCAL|SIGNAL_REJECTED|ORDER_BLOCK_NOT_RETESTED|side={0}", _setupSide);
                ResetPullback();
                return;
            }

            var swing = _setupSide == TradeType.Buy ? _pullbackLow : _pullbackHigh;
            var entrySide = _setupSide;
            Print("URM_LOCAL|M1_CONFIRM|side={0}|bars={1}|pullbackHigh={2}|pullbackLow={3}|obTouched={4}|time={5:O}",
                entrySide, _pullbackCount, _pullbackHigh, _pullbackLow, _pullbackTouchedOb, barOpen);

            // One order attempt per confirmed setup, successful or blocked.
            ResetSetup("ENTRY_ATTEMPT");
            SubmitProtectedMarketOrder(entrySide, swing);
        }

        private void AddPullbackBar(double high, double low)
        {
            if (!_pullbackActive)
            {
                _pullbackActive = true;
                _pullbackCount = 1;
                _pullbackHigh = high;
                _pullbackLow = low;
                _pullbackTouchedOb = _obValid && high >= _obLow && low <= _obHigh;
                return;
            }

            _pullbackCount++;
            _pullbackHigh = Math.Max(_pullbackHigh, high);
            _pullbackLow = Math.Min(_pullbackLow, low);
            if (_obValid && high >= _obLow && low <= _obHigh)
                _pullbackTouchedOb = true;
        }

        private void SubmitProtectedMarketOrder(TradeType side, double rawSwing)
        {
            if (!EnableNewEntries)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|NEW_ENTRIES_DISABLED");
                return;
            }

            if (Account.IsLive && !AllowLiveEntries)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|LIVE_ENTRIES_NOT_EXPLICITLY_ALLOWED");
                return;
            }

            if (!Account.IsLive && !AllowDemoEntries)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|DEMO_ENTRIES_DISABLED");
                return;
            }

            if (RequireHedgedAccount &&
                Account.AccountType.ToString().IndexOf("Hedg", StringComparison.OrdinalIgnoreCase) < 0)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|HEDGED_ACCOUNT_REQUIRED|accountType={0}", Account.AccountType);
                return;
            }

            if (!Server.IsConnected || !Symbol.MarketHours.IsOpened())
            {
                Print("URM_LOCAL|ENTRY_BLOCK|SERVER_DISCONNECTED_OR_MARKET_CLOSED");
                return;
            }

            if (CountUrmPositions() >= MaxUrmPositionsAccountWide || HasUrmPendingOrder())
            {
                Print("URM_LOCAL|ENTRY_BLOCK|URM_EXPOSURE_OR_PENDING_ORDER_EXISTS");
                return;
            }

            double bid;
            double ask;
            if (!ReadFreshQuote(out bid, out ask))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|NO_FRESH_QUOTE");
                return;
            }

            var spreadTicks = (ask - bid) / Symbol.TickSize;
            if (!FiniteNonNegative(spreadTicks) || spreadTicks > MaxSpreadTicks)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|SPREAD_TOO_WIDE|ticks={0:F1}|max={1}", spreadTicks, MaxSpreadTicks);
                return;
            }

            var entryReference = side == TradeType.Buy ? ask : bid;
            var stopCandidate = side == TradeType.Buy
                ? rawSwing - StopBufferTicks * Symbol.TickSize
                : rawSwing + StopBufferTicks * Symbol.TickSize;
            var structuralStop = side == TradeType.Buy
                ? RoundDownToTick(stopCandidate)
                : RoundUpToTick(stopCandidate);

            if (!FinitePositive(entryReference) || !FinitePositive(structuralStop) ||
                (side == TradeType.Buy && structuralStop >= entryReference) ||
                (side == TradeType.Sell && structuralStop <= entryReference))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|STRUCTURAL_STOP_WRONG_SIDE|entry={0}|SL={1}", entryReference, structuralStop);
                return;
            }

            var stopDistancePrice = Math.Abs(entryReference - structuralStop);
            var stopPips = stopDistancePrice / Symbol.PipSize;
            if (!FinitePositive(stopPips))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|STOP_DISTANCE_INVALID");
                return;
            }

            double depositRiskBudget;
            try
            {
                depositRiskBudget = AssetConverter.Convert(FixedRiskUsd, "USD", Account.Asset.Name);
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|USD_CONVERSION_FAILED|{0}", ex.GetType().Name);
                return;
            }

            if (!FinitePositive(depositRiskBudget))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|USD_CONVERSION_INVALID");
                return;
            }

            double rawVolume;
            try
            {
                rawVolume = Symbol.VolumeForFixedRisk(depositRiskBudget, stopPips, RoundingMode.Down);
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|FIXED_RISK_SIZING_FAILED|{0}", ex.GetType().Name);
                return;
            }

            if (!FinitePositive(rawVolume))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|RAW_VOLUME_INVALID");
                return;
            }

            var volume = Symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);
            if (!FinitePositive(volume) || volume < Symbol.VolumeInUnitsMin ||
                volume > Symbol.VolumeInUnitsMax ||
                volume > rawVolume + Math.Max(1e-8, Symbol.VolumeInUnitsStep * 1e-6))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|BROKER_VOLUME_LIMITS|raw={0}|normalised={1}", rawVolume, volume);
                return;
            }

            double estimatedRiskDeposit;
            double estimatedRiskUsd;
            try
            {
                estimatedRiskDeposit = Symbol.AmountRisked(volume, stopPips);
                estimatedRiskUsd = AssetConverter.Convert(estimatedRiskDeposit, Account.Asset.Name, "USD");
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|RISK_CROSSCHECK_FAILED|{0}", ex.GetType().Name);
                return;
            }

            if (!FiniteNonNegative(estimatedRiskUsd) || estimatedRiskUsd > FixedRiskUsd + RiskToleranceUsd)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|ESTIMATED_RISK_OVER_BUDGET|riskUsd={0:F4}|budgetUsd={1:F2}",
                    estimatedRiskUsd, FixedRiskUsd);
                return;
            }

            double estimatedMargin;
            try
            {
                estimatedMargin = Symbol.GetEstimatedMargin(side, volume);
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|MARGIN_ESTIMATE_FAILED|{0}", ex.GetType().Name);
                return;
            }

            if (!FiniteNonNegative(estimatedMargin) || Account.FreeMargin <= 0 ||
                estimatedMargin > Account.FreeMargin * 0.90)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|INSUFFICIENT_FREE_MARGIN|estimated={0}|free={1}",
                    estimatedMargin, Account.FreeMargin);
                return;
            }

            var label = BuildPositionLabel(structuralStop);
            if (label.Length > 100)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|LABEL_TOO_LONG");
                return;
            }

            Print("URM_LOCAL|PREFLIGHT_PASS|symbol={0}|side={1}|volumeUnits={2}|entryRef={3}|structuralSL={4}|estimatedRiskUSD={5:F4}|margin={6}",
                Symbol.Name, side, volume, entryReference, structuralStop, estimatedRiskUsd, estimatedMargin);

            TradeResult order;
            try
            {
                order = ExecuteMarketOrder(side, Symbol.Name, volume, label, stopPips,
                    stopPips * TakeProfitR, "URM Local Pro M5-M1", false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|ORDER_EXCEPTION|{0}|CHECK_TRADE_WATCH_BEFORE_RETRY", ex.GetType().Name);
                return;
            }

            if (order == null || !order.IsSuccessful || order.Position == null)
            {
                Print("URM_LOCAL|ORDER_REJECTED|doNotBlindlyRetry=true");
                return;
            }

            var position = order.Position;
            var fill = position.EntryPrice;
            var actualRiskPrice = Math.Abs(fill - structuralStop);
            var fillStopOnCorrectSide = side == TradeType.Buy ? structuralStop < fill : structuralStop > fill;
            if (!FinitePositive(fill) || !fillStopOnCorrectSide || !FinitePositive(actualRiskPrice))
            {
                EmergencyClose(position, "FILL_INVALID_OR_STOP_CROSSED");
                return;
            }

            var actualStopPips = actualRiskPrice / Symbol.PipSize;
            double filledRiskUsd;
            try
            {
                var riskDeposit = Symbol.AmountRisked(position.VolumeInUnits, actualStopPips);
                filledRiskUsd = AssetConverter.Convert(riskDeposit, Account.Asset.Name, "USD");
            }
            catch (Exception ex)
            {
                EmergencyClose(position, "FILL_RISK_CONVERSION_FAILED_" + ex.GetType().Name);
                return;
            }

            if (!FiniteNonNegative(filledRiskUsd) || filledRiskUsd > FixedRiskUsd + RiskToleranceUsd)
            {
                EmergencyClose(position, "FILLED_ESTIMATED_RISK_OVER_BUDGET_" + filledRiskUsd.ToString("F4", CultureInfo.InvariantCulture));
                return;
            }

            var target = side == TradeType.Buy
                ? RoundUpToTick(fill + TakeProfitR * actualRiskPrice)
                : RoundDownToTick(fill - TakeProfitR * actualRiskPrice);

            TradeResult protection;
            try
            {
                protection = ModifyPosition(position, structuralStop, target,
                    ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                EmergencyClose(position, "PROTECTION_EXCEPTION_" + ex.GetType().Name);
                return;
            }

            if (protection == null || !protection.IsSuccessful)
            {
                EmergencyClose(position, "PROTECTION_UPDATE_REJECTED");
                return;
            }

            var readBack = Positions.FindById(position.Id);
            var tolerance = Math.Max(Symbol.TickSize * 0.51, 1e-9);
            if (readBack == null || !readBack.StopLoss.HasValue ||
                Math.Abs(readBack.StopLoss.Value - structuralStop) > tolerance ||
                !readBack.TakeProfit.HasValue ||
                Math.Abs(readBack.TakeProfit.Value - target) > tolerance)
            {
                EmergencyClose(position, "PROTECTION_READBACK_MISMATCH");
                return;
            }

            Print("URM_LOCAL|ORDER_PROTECTED|id={0}|symbol={1}|side={2}|fill={3}|units={4}|SL={5}|TP5R={6}|estimatedRiskUSD={7:F4}",
                position.Id, Symbol.Name, side, fill, position.VolumeInUnits, structuralStop, target, filledRiskUsd);
        }

        private void ManagePositions(bool applyCandleFlip, int previousClosedIndex, int closedIndex)
        {
            for (var i = 0; i < Positions.Count; i++)
            {
                var position = Positions[i];
                if (position == null || position.SymbolName != Symbol.Name ||
                    string.IsNullOrEmpty(position.Label) ||
                    !position.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                    continue;

                if (_haltedPositionIds.Contains(position.Id))
                    continue;

                double originalStop;
                if (!TryParseOriginalStop(position.Label, out originalStop))
                {
                    PrintPositionCritical(position, "UNPARSEABLE_URM_LABEL");
                    continue;
                }

                var initialRisk = Math.Abs(position.EntryPrice - originalStop);
                if (!FinitePositive(initialRisk))
                {
                    PrintPositionCritical(position, "INITIAL_RISK_INVALID");
                    continue;
                }

                var isBuy = position.TradeType == TradeType.Buy;
                var favourablePrice = isBuy ? Symbol.Bid : Symbol.Ask;
                var rNow = isBuy
                    ? (favourablePrice - position.EntryPrice) / initialRisk
                    : (position.EntryPrice - favourablePrice) / initialRisk;

                // If server protection is missing, repair it immediately or close as a last resort.
                if (!position.StopLoss.HasValue)
                {
                    var repairTp = position.TakeProfit.HasValue
                        ? position.TakeProfit.Value
                        : (isBuy
                            ? RoundUpToTick(position.EntryPrice + TakeProfitR * initialRisk)
                            : RoundDownToTick(position.EntryPrice - TakeProfitR * initialRisk));
                    var repair = SafeModifyProtection(position, originalStop, repairTp);
                    if (!repair)
                        EmergencyClose(position, "SERVER_STOP_LOSS_MISSING");
                    continue;
                }

                if (!position.TakeProfit.HasValue)
                {
                    var restoreTp = isBuy
                        ? RoundUpToTick(position.EntryPrice + TakeProfitR * initialRisk)
                        : RoundDownToTick(position.EntryPrice - TakeProfitR * initialRisk);
                    if (!SafeModifyProtection(position, position.StopLoss.Value, restoreTp))
                        LogModifyFailure(position, "SERVER_TAKE_PROFIT_MISSING");
                    continue;
                }

                if (!EnableRLadder)
                    continue;

                var targetStop = double.NaN;
                var stage = string.Empty;

                if (rNow >= BreakEvenAtR)
                {
                    targetStop = position.EntryPrice;
                    stage = "BREAK_EVEN";
                }

                if (rNow >= LockAtR)
                {
                    var lockPrice = isBuy
                        ? position.EntryPrice + LockToR * initialRisk
                        : position.EntryPrice - LockToR * initialRisk;
                    targetStop = isBuy
                        ? (FinitePositive(targetStop) ? Math.Max(targetStop, lockPrice) : lockPrice)
                        : (FinitePositive(targetStop) ? Math.Min(targetStop, lockPrice) : lockPrice);
                    stage = "LOCK";
                }

                if (rNow >= TrailStartsAtR)
                {
                    var floor = isBuy
                        ? position.EntryPrice + TrailFloorR * initialRisk
                        : position.EntryPrice - TrailFloorR * initialRisk;
                    var gap = isBuy
                        ? favourablePrice - TrailGapR * initialRisk
                        : favourablePrice + TrailGapR * initialRisk;
                    var trail = isBuy ? Math.Max(floor, gap) : Math.Min(floor, gap);

                    targetStop = isBuy
                        ? (FinitePositive(targetStop) ? Math.Max(targetStop, trail) : trail)
                        : (FinitePositive(targetStop) ? Math.Min(targetStop, trail) : trail);
                    stage = "R_TRAIL";
                }

                if (applyCandleFlip && EnableCandleFlipTrail && rNow >= TrailStartsAtR &&
                    previousClosedIndex >= 0 && closedIndex >= 1)
                {
                    var prevOpen = _m1.OpenPrices[previousClosedIndex];
                    var prevClose = _m1.ClosePrices[previousClosedIndex];
                    var currentOpen = _m1.OpenPrices[closedIndex];
                    var currentClose = _m1.ClosePrices[closedIndex];

                    // Native candle-colour proxy for the described Sideways Alarm flip:
                    // buy: bearish candle -> bullish candle; sell: bullish -> bearish.
                    if (isBuy && prevClose < prevOpen && currentClose > currentOpen)
                    {
                        var flipStop = _m1.LowPrices[previousClosedIndex];
                        targetStop = FinitePositive(targetStop) ? Math.Max(targetStop, flipStop) : flipStop;
                        stage = "R_TRAIL_PLUS_BEAR_TO_BULL_FLIP";
                    }
                    else if (!isBuy && prevClose > prevOpen && currentClose < currentOpen)
                    {
                        var flipStop = _m1.HighPrices[previousClosedIndex];
                        targetStop = FinitePositive(targetStop) ? Math.Min(targetStop, flipStop) : flipStop;
                        stage = "R_TRAIL_PLUS_BULL_TO_BEAR_FLIP";
                    }
                }

                if (!FinitePositive(targetStop))
                    continue;

                targetStop = isBuy ? RoundDownToTick(targetStop) : RoundUpToTick(targetStop);
                var currentStop = position.StopLoss.Value;
                var improves = isBuy
                    ? targetStop > currentStop + Symbol.TickSize * 0.5
                    : targetStop < currentStop - Symbol.TickSize * 0.5;

                if (!improves)
                    continue;

                // Never send a stop at/through the current executable quote.
                if ((isBuy && targetStop >= Symbol.Bid - Symbol.TickSize * 0.1) ||
                    (!isBuy && targetStop <= Symbol.Ask + Symbol.TickSize * 0.1))
                    continue;

                if (SafeModifyProtection(position, targetStop, position.TakeProfit.Value))
                    Print("URM_LOCAL|SL_ADVANCED|id={0}|stage={1}|R={2:F2}|oldSL={3}|newSL={4}|TP_unchanged={5}",
                        position.Id, stage, rNow, currentStop, targetStop, position.TakeProfit.Value);
                else
                    LogModifyFailure(position, "SL_MODIFY_FAILED_" + stage);
            }
        }

        private bool SafeModifyProtection(Position position, double stopLoss, double takeProfit)
        {
            TradeResult result;
            try
            {
                result = ModifyPosition(position, stopLoss, takeProfit,
                    ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                LogModifyFailure(position, "MODIFY_EXCEPTION_" + ex.GetType().Name);
                return false;
            }

            if (result == null || !result.IsSuccessful)
                return false;

            var readBack = Positions.FindById(position.Id);
            var tolerance = Math.Max(Symbol.TickSize * 0.51, 1e-9);
            return readBack != null && readBack.StopLoss.HasValue && readBack.TakeProfit.HasValue &&
                   Math.Abs(readBack.StopLoss.Value - stopLoss) <= tolerance &&
                   Math.Abs(readBack.TakeProfit.Value - takeProfit) <= tolerance;
        }

        private bool ReadFreshQuote(out double bid, out double ask)
        {
            bid = double.NaN;
            ask = double.NaN;
            try
            {
                var ticks = MarketData.GetTicks(Symbol.Name);
                if (ticks == null || ticks.Count < 1)
                    return false;

                var tick = ticks.LastTick;
                var tickTime = DateTime.SpecifyKind(tick.Time, DateTimeKind.Utc);
                var age = (Server.TimeInUtc - tickTime).TotalSeconds;
                if (age < 0 || age > MaxTickAgeSeconds)
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

        private int CountUrmPositions()
        {
            var count = 0;
            for (var i = 0; i < Positions.Count; i++)
            {
                var p = Positions[i];
                if (p != null && !string.IsNullOrEmpty(p.Label) &&
                    p.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                    count++;
            }
            return count;
        }

        private bool HasUrmPendingOrder()
        {
            foreach (var pending in PendingOrders)
            {
                if (pending != null && !string.IsNullOrEmpty(pending.Label) &&
                    pending.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                    return true;
            }
            return false;
        }

        private string BuildPositionLabel(double structuralStop)
        {
            var id = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture).Substring(0, 8).ToUpperInvariant();
            return LabelPrefix + "SL=" + structuralStop.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture) +
                   "|ID=" + id;
        }

        private bool TryParseOriginalStop(string label, out double originalStop)
        {
            originalStop = double.NaN;
            if (string.IsNullOrEmpty(label) || label.Length > 100 ||
                !label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                return false;

            var start = label.IndexOf("SL=", StringComparison.Ordinal);
            var end = label.IndexOf("|ID=", StringComparison.Ordinal);
            if (start < 0 || end <= start + 3)
                return false;

            var text = label.Substring(start + 3, end - (start + 3));
            return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out originalStop) &&
                   FinitePositive(originalStop);
        }

        private void EmergencyClose(Position position, string reason)
        {
            _haltedPositionIds.Add(position.Id);
            Print("URM_LOCAL|CRITICAL|{0}|id={1}|symbol={2}|IMMEDIATE_CLOSE_ATTEMPT|check_Trade_Watch=true",
                reason, position.Id, position.SymbolName);
            try
            {
                var close = ClosePosition(position);
                if (close == null || !close.IsSuccessful)
                    Print("URM_LOCAL|CRITICAL_CLOSE_FAILED|id={0}|reason={1}|MANUAL_ACTION_REQUIRED",
                        position.Id, reason);
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|CRITICAL_CLOSE_EXCEPTION|id={0}|reason={1}|error={2}|MANUAL_ACTION_REQUIRED",
                    position.Id, reason, ex.GetType().Name);
            }
        }

        private void LogModifyFailure(Position position, string reason)
        {
            DateTime last;
            if (_lastModifyFailureLog.TryGetValue(position.Id, out last) &&
                (Server.TimeInUtc - last).TotalSeconds < 10.0)
                return;

            _lastModifyFailureLog[position.Id] = Server.TimeInUtc;
            Print("URM_LOCAL|PROTECTION_WARNING|id={0}|symbol={1}|reason={2}|SL={3}|TP={4}|check_Trade_Watch=true",
                position.Id, position.SymbolName, reason,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING");
        }

        private void PrintPositionCritical(Position position, string reason)
        {
            _haltedPositionIds.Add(position.Id);
            Print("URM_LOCAL|CRITICAL|id={0}|reason={1}|position_management_halted_for_instance=true|manual_reconciliation_required=true",
                position.Id, reason);
        }

        private void ResetPullback()
        {
            _pullbackActive = false;
            _pullbackCount = 0;
            _pullbackHigh = double.NegativeInfinity;
            _pullbackLow = double.PositiveInfinity;
            _pullbackTouchedOb = false;
        }

        private void ResetSetup(string reason)
        {
            if (_setupActive)
                Print("URM_LOCAL|SETUP_RESET|reason={0}", reason);
            _setupActive = false;
            _setupCloseTime = DateTime.MinValue;
            _setupAgeBars = 0;
            _obValid = false;
            _obLow = double.NaN;
            _obHigh = double.NaN;
            ResetPullback();
        }

        private double RoundDownToTick(double price)
        {
            if (!FinitePositive(price) || !FinitePositive(Symbol.TickSize))
                return double.NaN;
            var ticks = Math.Floor(price / Symbol.TickSize + 1e-10);
            return Math.Round(ticks * Symbol.TickSize, Symbol.Digits, MidpointRounding.AwayFromZero);
        }

        private double RoundUpToTick(double price)
        {
            if (!FinitePositive(price) || !FinitePositive(Symbol.TickSize))
                return double.NaN;
            var ticks = Math.Ceiling(price / Symbol.TickSize - 1e-10);
            return Math.Round(ticks * Symbol.TickSize, Symbol.Digits, MidpointRounding.AwayFromZero);
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