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

        [Parameter("Block entries with foreign exposure", Group = "01. Execution", DefaultValue = true)]
        public bool BlockEntriesWithForeignExposure { get; set; }

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

        [Parameter("Minimum SL advance (ticks)", Group = "05. Protection", DefaultValue = 2, MinValue = 1, MaxValue = 1000)]
        public int MinimumStopAdvanceTicks { get; set; }

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

        private bool _entryConfigurationValid = true;
        private bool _ladderConfigurationValid = true;

        private TabControl _panelTabs;
        private TextBox _ticketStopBox;
        private TextBox _ticketRiskBox;
        private TextBlock _ticketPreviewText;
        private TextBlock _ticketStatusText;
        private TextBlock _positionStatusText;
        private TextBlock _strategyStatusText;
        private CheckBox _ticketOrderConfirm;
        private CheckBox _liveExecutionConsent;
        private CheckBox _autoEntryToggle;
        private CheckBox _ladderToggle;
        private CheckBox _candleTrailToggle;
        private bool _runtimeAutoEntryEnabled;
        private bool _runtimeLadderEnabled;
        private bool _runtimeCandleTrailEnabled;
        private DateTime _lastPanelRefreshUtc = DateTime.MinValue;

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
                _entryConfigurationValid = MinPullbackBars <= MaxPullbackBars;
                _ladderConfigurationValid =
                    BreakEvenAtR <= LockAtR &&
                    LockAtR <= TrailStartsAtR &&
                    LockToR <= LockAtR &&
                    TrailFloorR <= TrailStartsAtR &&
                    TakeProfitR > TrailStartsAtR &&
                    TakeProfitR > TrailFloorR;

                _runtimeAutoEntryEnabled = EnableNewEntries;
                _runtimeLadderEnabled = EnableRLadder;
                _runtimeCandleTrailEnabled = EnableCandleFlipTrail;

                if (!_entryConfigurationValid)
                    Print("URM_LOCAL|CONFIG_ERROR|M1_PULLBACK_MIN_EXCEEDS_MAX|entries_blocked=true");
                if (!_ladderConfigurationValid)
                    Print("URM_LOCAL|CONFIG_ERROR|R_LADDER_THRESHOLDS_INCONSISTENT|automatic_SL_ladder_disabled=true");

                if (!FinitePositive(Symbol.TickSize) || !FinitePositive(Symbol.PipSize))
                {
                    Print("URM_LOCAL|FATAL|INVALID_TICK_OR_PIP_SIZE");
                    Stop();
                    return;
                }

                BuildTradingPanel();
                Timer.Start(TimeSpan.FromSeconds(1));

                _m1 = MarketData.GetBars(TimeFrame.Minute, Symbol.Name);
                _m5 = MarketData.GetBars(TimeFrame.Minute5, Symbol.Name);

                if (_m1 == null || _m5 == null)
                {
                    Print("URM_LOCAL|WAIT|M1_M5_DATA_UNAVAILABLE|manual_ticket_remains_available=true");
                    return;
                }

                // Startup is non-retroactive: never enter on an old historical signal.
                if (_m1.Count >= 2)
                {
                    _lastM1CurrentOpen = _m1.OpenTimes.LastValue;
                    _lastM1ClosedOpen = _m1.OpenTimes[_m1.Count - 2];
                }
                if (_m5.Count >= 2)
                    _lastM5ClosedOpen = _m5.OpenTimes[_m5.Count - 2];

                if (_m1.Count < 10 || _m5.Count < M5SwingLookback + 3)
                    Print("URM_LOCAL|WAIT|NOT_ENOUGH_M1_M5_HISTORY|symbol={0}|manual_ticket_remains_available=true", Symbol.Name);

                Print("URM_LOCAL|STARTED|symbol={0}|live={1}|autoEntriesParam={2}|autoEntriesRuntime={3}|liveEntriesAllowed={4}|riskUSD={5:F2}|TP_R={6:F2}|m5Lookback={7}|OBRequired={8}|ticketUI=OPEN",
                    Symbol.Name, Account.IsLive, EnableNewEntries, _runtimeAutoEntryEnabled, AllowLiveEntries,
                    FixedRiskUsd, TakeProfitR, M5SwingLookback, RequireOrderBlockRetest);
                Print("URM_LOCAL|RULES|M5 close beyond prior swing; M1 opposite-color pullback then close-break; SL=pullback extreme+buffer; BE@{0}R; lock +{1}R at {2}R; trail@{3}R gap={4}R floor={5}R; candle-color flip is a native proxy, not Sideways Alarm output.",
                    BreakEvenAtR, LockToR, LockAtR, TrailStartsAtR, TrailGapR, TrailFloorR);
                Print("URM_LOCAL|SAFETY|Only one URM instance per account/symbol; stop old URM managers before starting this bot.");
                RefreshTradingPanel();
            }
            catch (Exception ex)
            {
                Print("URM_LOCAL|FATAL|START_EXCEPTION|{0}", ex.GetType().Name);
                Stop();
            }
        }

        protected override void OnTimer()
        {
            RefreshTradingPanel();
        }

        protected override void OnTick()
        {
            RefreshTradingPanelIfDue();
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
            if (!_entryConfigurationValid)
            {
                ResetSetup("INVALID_ENTRY_CONFIGURATION");
                return;
            }

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

            if (oppositeColor)
            {
                AddPullbackBar(high, low);
                return;
            }

            if (!_pullbackActive)
                return;

            var breakConfirmed = _setupSide == TradeType.Buy
                ? close > _pullbackHigh + buffer
                : close < _pullbackLow - buffer;

            if (!breakConfirmed)
            {
                // A same-direction candle whose close did not clear the pullback range
                // becomes part of the micro-structure. Include its wick so later bars
                // cannot trigger against a range that ignored an intervening candle.
                _pullbackHigh = Math.Max(_pullbackHigh, high);
                _pullbackLow = Math.Min(_pullbackLow, low);
                if (_obValid && high >= _obLow && low <= _obHigh)
                    _pullbackTouchedOb = true;
                return;
            }

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

            if (_pullbackCount >= MaxPullbackBars)
            {
                // Start a rolling bounded window with the newest opposite candle.
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

        private void SubmitProtectedMarketOrder(TradeType side, double rawSwing, bool manualTicket = false, double? riskOverrideUsd = null)
        {
            var riskUsd = riskOverrideUsd.HasValue ? riskOverrideUsd.Value : FixedRiskUsd;
            if (!FinitePositive(riskUsd))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|RISK_BUDGET_INVALID");
                SetTicketStatus("Blocked: risk amount must be positive.");
                return;
            }

            if (!manualTicket && !_entryConfigurationValid)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|INVALID_ENTRY_CONFIGURATION");
                return;
            }

            if (!manualTicket && !_runtimeAutoEntryEnabled)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|AUTO_STRATEGY_ENTRIES_DISABLED");
                return;
            }

            if (Account.IsLive && (!AllowLiveEntries || _liveExecutionConsent == null || _liveExecutionConsent.IsChecked != true))
            {
                Print("URM_LOCAL|ENTRY_BLOCK|LIVE_REQUIRES_PARAMETER_AND_UI_CONFIRMATION");
                SetTicketStatus("Blocked: Live needs the cBot parameter plus the Live confirmation checkbox.");
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

            if (HasLegacyUrmPositionOrPendingOrder() ||
                CountUrmPositions() >= MaxUrmPositionsAccountWide || HasUrmPendingOrder())
            {
                Print("URM_LOCAL|ENTRY_BLOCK|URM_EXPOSURE_OR_PENDING_ORDER_EXISTS");
                return;
            }

            if (BlockEntriesWithForeignExposure && HasForeignExposure())
            {
                Print("URM_LOCAL|ENTRY_BLOCK|FOREIGN_ACCOUNT_EXPOSURE_EXISTS");
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
            double structuralStop;
            if (manualTicket)
            {
                if (!IsOnTickGrid(rawSwing, Symbol.TickSize))
                {
                    Block("TICKET_SL_OFF_TICK_GRID", "Entered structural SL is not aligned to exact broker TickSize.");
                    SetTicketStatus("Blocked: entered SL does not align to broker TickSize.");
                    return;
                }
                structuralStop = rawSwing;
            }
            else
            {
                var stopCandidate = side == TradeType.Buy
                    ? rawSwing - StopBufferTicks * Symbol.TickSize
                    : rawSwing + StopBufferTicks * Symbol.TickSize;
                structuralStop = side == TradeType.Buy
                    ? RoundDownToTick(stopCandidate)
                    : RoundUpToTick(stopCandidate);
            }

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

            if (Symbol.MinDistanceType != SymbolMinDistanceType.Pips)
            {
                Block("UNSUPPORTED_MIN_DISTANCE_UNIT", "Broker minimum SL/TP distance is not reported in pips; fail closed rather than guess.");
                SetTicketStatus("Blocked: broker minimum distance unit is not supported by this cBot version.");
                return;
            }

            var minSlPriceDistance = Symbol.MinStopLossDistance * Symbol.PipSize;
            var minSlExecutableDistance = side == TradeType.Buy ? bid - structuralStop : structuralStop - ask;
            if (minSlExecutableDistance < minSlPriceDistance - Symbol.TickSize * 0.01)
            {
                Block("BROKER_MIN_SL_DISTANCE", "SL is closer to executable price than broker minimum.");
                SetTicketStatus("Blocked: SL breaches broker minimum distance.");
                return;
            }

            double depositRiskBudget;
            try
            {
                depositRiskBudget = AssetConverter.Convert(riskUsd, "USD", Account.Asset.Name);
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

            if (!FiniteNonNegative(estimatedRiskUsd) || estimatedRiskUsd > riskUsd + RiskToleranceUsd)
            {
                Print("URM_LOCAL|ENTRY_BLOCK|ESTIMATED_RISK_OVER_BUDGET|riskUsd={0:F4}|budgetUsd={1:F2}",
                    estimatedRiskUsd, riskUsd);
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

            var previewTP = side == TradeType.Buy
                ? RoundUpToTick(entryReference + TakeProfitR * Math.Abs(entryReference - structuralStop))
                : RoundDownToTick(entryReference - TakeProfitR * Math.Abs(entryReference - structuralStop));
            var minTpPriceDistance = Symbol.MinTakeProfitDistance * Symbol.PipSize;
            var minTpExecutableDistance = side == TradeType.Buy ? previewTP - bid : ask - previewTP;
            if (!FinitePositive(previewTP) || minTpExecutableDistance < minTpPriceDistance - Symbol.TickSize * 0.01)
            {
                Block("BROKER_MIN_TP_DISTANCE", "Calculated TP is closer to executable price than the broker minimum.");
                SetTicketStatus("Blocked: calculated TP breaches broker minimum distance.");
                return;
            }

            Print("URM_LOCAL|PREFLIGHT_PASS|symbol={0}|side={1}|volumeUnits={2}|lots={3:F4}|entryRef={4}|structuralSL={5}|estimatedRiskUSD={6:F4}|riskBudgetUSD={7:F2}|margin={8}",
                Symbol.Name, side, volume, Symbol.VolumeInUnitsToQuantity(volume), entryReference, structuralStop, estimatedRiskUsd, riskUsd, estimatedMargin);
            if (manualTicket)
                SetTicketStatus(string.Format(CultureInfo.InvariantCulture,
                    "Sending {0} {1:F4} lots on {2}; estimated price risk ${3:F2}. Awaiting protection confirmation...",
                    side, Symbol.VolumeInUnitsToQuantity(volume), Symbol.Name, estimatedRiskUsd));

            TradeResult order;
            try
            {
                order = ExecuteMarketOrder(side, Symbol.Name, volume, label, stopPips,
                    stopPips * TakeProfitR,
                    manualTicket ? "URM Local Pro Trade Ticket" : "URM Local Pro M5-M1",
                    false, StopTriggerMethod.Trade);
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

            if (!FiniteNonNegative(filledRiskUsd) || filledRiskUsd > riskUsd + RiskToleranceUsd)
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
            if (manualTicket)
                SetTicketStatus(string.Format(CultureInfo.InvariantCulture,
                    "ORDER PROTECTED: {0} {1:F4} lots | fill {2} | server SL {3} | TP {4} | estimated risk ${5:F2}",
                    side, Symbol.VolumeInUnitsToQuantity(position.VolumeInUnits), fill, structuralStop, target, filledRiskUsd));
            RefreshTradingPanel();
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

                if (!EnableRLadder || !_runtimeLadderEnabled || !_ladderConfigurationValid)
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

                if (applyCandleFlip && EnableCandleFlipTrail && _runtimeCandleTrailEnabled && rNow >= TrailStartsAtR &&
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
                var minimumAdvance = Math.Max(1, MinimumStopAdvanceTicks) * Symbol.TickSize;
                var improves = isBuy
                    ? targetStop >= currentStop + minimumAdvance - Symbol.TickSize * 1e-6
                    : targetStop <= currentStop - minimumAdvance + Symbol.TickSize * 1e-6;

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

        private bool HasLegacyUrmPositionOrPendingOrder()
        {
            for (var i = 0; i < Positions.Count; i++)
            {
                var p = Positions[i];
                if (p != null && !string.IsNullOrEmpty(p.Label) &&
                    p.Label.StartsWith("URM1|", StringComparison.Ordinal))
                    return true;
            }

            foreach (var pending in PendingOrders)
            {
                if (pending != null && !string.IsNullOrEmpty(pending.Label) &&
                    pending.Label.StartsWith("URM1|", StringComparison.Ordinal))
                    return true;
            }

            return false;
        }

        private bool HasForeignExposure()
        {
            for (var i = 0; i < Positions.Count; i++)
            {
                var p = Positions[i];
                if (p != null && (string.IsNullOrEmpty(p.Label) ||
                    !p.Label.StartsWith(LabelPrefix, StringComparison.Ordinal)))
                    return true;
            }

            foreach (var pending in PendingOrders)
            {
                if (pending != null && (string.IsNullOrEmpty(pending.Label) ||
                    !pending.Label.StartsWith(LabelPrefix, StringComparison.Ordinal)))
                    return true;
            }

            return false;
        }


        private void BuildTradingPanel()
        {
            var tradePanel = new StackPanel { Orientation = Orientation.Vertical, Width = 350, Margin = 8 };
            tradePanel.AddChild(new TextBlock { Text = "URM TRADE TICKET — LOCAL DESKTOP", Margin = 3 });
            tradePanel.AddChild(new TextBlock { Text = "Symbol: " + Symbol.Name + " | Account: " + (Account.IsLive ? "LIVE" : "DEMO"), Margin = 3 });
            tradePanel.AddChild(new TextBlock { Text = "Automatic volume uses cTrader native fixed-risk API and broker volume rules.", Margin = 3 });

            var slRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = 2 };
            slRow.AddChild(new TextBlock { Text = "Structural SL price:", Width = 128, Margin = 2 });
            _ticketStopBox = new TextBox { Text = "", Width = 180, Margin = 2 };
            slRow.AddChild(_ticketStopBox);
            tradePanel.AddChild(slRow);

            var riskRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = 2 };
            riskRow.AddChild(new TextBlock { Text = "Risk budget USD:", Width = 128, Margin = 2 });
            _ticketRiskBox = new TextBox { Text = FixedRiskUsd.ToString("F2", CultureInfo.InvariantCulture), Width = 180, Margin = 2 };
            riskRow.AddChild(_ticketRiskBox);
            tradePanel.AddChild(riskRow);

            var previewRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = 2 };
            var previewBuy = new Button { Text = "Preview BUY", Width = 150, Margin = 2 };
            var previewSell = new Button { Text = "Preview SELL", Width = 150, Margin = 2 };
            previewBuy.Click += args => PreviewTicket(TradeType.Buy);
            previewSell.Click += args => PreviewTicket(TradeType.Sell);
            previewRow.AddChild(previewBuy);
            previewRow.AddChild(previewSell);
            tradePanel.AddChild(previewRow);

            _ticketPreviewText = new TextBlock
            {
                Text = "Enter structural SL, then preview BUY or SELL. Preview never sends an order.",
                Margin = 4
            };
            tradePanel.AddChild(_ticketPreviewText);

            _ticketOrderConfirm = new CheckBox
            {
                Text = "Confirm this ONE order (auto-clears after click)",
                IsChecked = false,
                Margin = 3
            };
            tradePanel.AddChild(_ticketOrderConfirm);

            _liveExecutionConsent = new CheckBox
            {
                Text = "I explicitly allow this panel to send LIVE orders",
                IsChecked = false,
                Margin = 3
            };
            tradePanel.AddChild(_liveExecutionConsent);

            var orderRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = 2 };
            var buy = new Button { Text = "PLACE BUY", Width = 150, Margin = 2 };
            var sell = new Button { Text = "PLACE SELL", Width = 150, Margin = 2 };
            buy.Click += args => PlaceTicketOrder(TradeType.Buy);
            sell.Click += args => PlaceTicketOrder(TradeType.Sell);
            orderRow.AddChild(buy);
            orderRow.AddChild(sell);
            tradePanel.AddChild(orderRow);

            _ticketStatusText = new TextBlock
            {
                Text = "No order sent. Preview first and review all inputs.",
                Margin = 4
            };
            tradePanel.AddChild(_ticketStatusText);
            tradePanel.AddChild(new TextBlock
            {
                Text = "Preview does not send an order. Order placement recalculates risk/volume and checks quote, tick grid, spread, broker minimum distances, margin and exposure. A critical protection/close log requires immediate Trade Watch inspection.",
                Margin = 3
            });

            var positionsPanel = new StackPanel { Orientation = Orientation.Vertical, Width = 350, Margin = 8 };
            positionsPanel.AddChild(new TextBlock { Text = "POSITION MANAGER", Margin = 3 });
            _ladderToggle = new CheckBox { Text = "Enable automatic R-ladder SL management", IsChecked = EnableRLadder, Margin = 3 };
            _ladderToggle.Click += args =>
            {
                _runtimeLadderEnabled = _ladderToggle.IsChecked == true;
                SetTicketStatus(_runtimeLadderEnabled ? "Automatic SL ladder enabled." : "Automatic SL ladder paused; server-side protection remains unchanged.");
                Print("URM_LOCAL|UI|R_LADDER_ENABLED|value={0}", _runtimeLadderEnabled);
                RefreshTradingPanel();
            };
            positionsPanel.AddChild(_ladderToggle);

            _candleTrailToggle = new CheckBox { Text = "Enable M1 candle-flip trail proxy", IsChecked = EnableCandleFlipTrail, Margin = 3 };
            _candleTrailToggle.Click += args =>
            {
                _runtimeCandleTrailEnabled = _candleTrailToggle.IsChecked == true;
                Print("URM_LOCAL|UI|CANDLE_FLIP_TRAIL_ENABLED|value={0}", _runtimeCandleTrailEnabled);
                RefreshTradingPanel();
            };
            positionsPanel.AddChild(_candleTrailToggle);

            var refreshPositions = new Button { Text = "Refresh position / SL / TP status", Margin = 3 };
            refreshPositions.Click += args => RefreshTradingPanel();
            positionsPanel.AddChild(refreshPositions);

            _positionStatusText = new TextBlock { Text = "Waiting for account position snapshot...", Margin = 4 };
            positionsPanel.AddChild(_positionStatusText);
            positionsPanel.AddChild(new TextBlock
            {
                Text = "This tab manages only URMSTRAT|V1| positions on this chart symbol. Stop legacy URM managers first. Inspect Trade Watch immediately after any CRITICAL or PROTECTION_WARNING log.",
                Margin = 3
            });

            var strategyPanel = new StackPanel { Orientation = Orientation.Vertical, Width = 350, Margin = 8 };
            strategyPanel.AddChild(new TextBlock { Text = "AUTOMATED STRATEGY", Margin = 3 });
            _autoEntryToggle = new CheckBox { Text = "Enable M5 breakout → M1 confirmation entries", IsChecked = EnableNewEntries, Margin = 3 };
            _autoEntryToggle.Click += args =>
            {
                _runtimeAutoEntryEnabled = _autoEntryToggle.IsChecked == true;
                Print("URM_LOCAL|UI|AUTO_ENTRY_ENABLED|value={0}", _runtimeAutoEntryEnabled);
                RefreshTradingPanel();
            };
            strategyPanel.AddChild(_autoEntryToggle);
            _strategyStatusText = new TextBlock { Text = "Starting strategy state...", Margin = 4 };
            strategyPanel.AddChild(_strategyStatusText);
            strategyPanel.AddChild(new TextBlock
            {
                Text = "Rules: M5 close beyond prior swing, identify the last opposing M5 candle as OB range, wait for a 2–5 bar opposite-colour M1 pullback to retest it, then require an M1 close-break. This is an explicit native price-action proxy, not copied LuxAlgo/Sideways Alarm code.",
                Margin = 3
            });
            strategyPanel.AddChild(new TextBlock
            {
                Text = "Live trading requires BOTH the Allow Live entries (explicit) cBot parameter and the Live confirmation checkbox on Trade Ticket. Automated entries also require the strategy toggle above.",
                Margin = 3
            });

            _panelTabs = new TabControl
            {
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                Width = 375,
                Height = 600,
                Margin = 8
            };
            _panelTabs.AddTab(new TabItem { Header = new TextBlock { Text = "Trade Ticket" }, Content = tradePanel });
            _panelTabs.AddTab(new TabItem { Header = new TextBlock { Text = "Positions / Trail" }, Content = positionsPanel });
            _panelTabs.AddTab(new TabItem { Header = new TextBlock { Text = "Strategy" }, Content = strategyPanel });
            Chart.AddControl(_panelTabs);
        }

        private void PreviewTicket(TradeType side)
        {
            double stop;
            double riskUsd;
            if (!TryReadTicketInputs(out stop, out riskUsd))
            {
                _ticketPreviewText.Text = "Blocked: enter a valid positive SL price and USD risk amount.";
                SetTicketStatus(_ticketPreviewText.Text);
                return;
            }

            double volume;
            double entry;
            double estimatedRiskUsd;
            double takeProfit;
            string reason;
            if (!TryCalculateTicket(side, stop, riskUsd, out volume, out entry, out estimatedRiskUsd, out takeProfit, out reason))
            {
                _ticketPreviewText.Text = "NOT READY — " + reason;
                SetTicketStatus("Preview blocked: " + reason);
                Print("URM_LOCAL|TICKET_PREVIEW_BLOCKED|side={0}|reason={1}", side, reason);
                RefreshTradingPanel();
                return;
            }

            var lots = Symbol.VolumeInUnitsToQuantity(volume);
            _ticketPreviewText.Text = string.Format(CultureInfo.InvariantCulture,
                "{0} {1} | entry≈{2} | SL={3} | TP={4} ({5:F1}R) | {6:F4} lots / {7:F0} units | risk estimate = ${8:F2}. Commission/slippage/gaps are separate.",
                side, Symbol.Name, entry, stop, takeProfit, TakeProfitR, lots, volume, estimatedRiskUsd);
            SetTicketStatus("Preview ready only. No order sent. Review side, SL, volume, risk, spread and account before arming one order.");
            Print("URM_LOCAL|TICKET_PREVIEW|side={0}|entry={1}|SL={2}|TP={3}|lots={4:F4}|units={5}|riskUSD={6:F4}|budgetUSD={7:F2}",
                side, entry, stop, takeProfit, lots, volume, estimatedRiskUsd, riskUsd);
        }

        private void PlaceTicketOrder(TradeType side)
        {
            if (_ticketOrderConfirm == null || _ticketOrderConfirm.IsChecked != true)
            {
                SetTicketStatus("Order blocked: tick the one-shot confirmation checkbox after checking the preview. It clears after every placement attempt.");
                return;
            }

            // Consume confirmation before validation or broker call; no automatic retry.
            _ticketOrderConfirm.IsChecked = false;

            double stop;
            double riskUsd;
            if (!TryReadTicketInputs(out stop, out riskUsd))
            {
                SetTicketStatus("Order blocked: SL/risk input is invalid.");
                return;
            }

            double volume;
            double entry;
            double estimatedRiskUsd;
            double takeProfit;
            string reason;
            if (!TryCalculateTicket(side, stop, riskUsd, out volume, out entry, out estimatedRiskUsd, out takeProfit, out reason))
            {
                SetTicketStatus("Order blocked: " + reason);
                Print("URM_LOCAL|TICKET_ORDER_BLOCKED|side={0}|reason={1}", side, reason);
                return;
            }

            // Re-run every execution check inside the protected order method; this preview is not trusted as execution authority.
            SubmitProtectedMarketOrder(side, stop, true, riskUsd);
        }

        private bool TryReadTicketInputs(out double stop, out double riskUsd)
        {
            stop = double.NaN;
            riskUsd = double.NaN;
            if (_ticketStopBox == null || _ticketRiskBox == null)
                return false;

            return double.TryParse(_ticketStopBox.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out stop) &&
                   FinitePositive(stop) &&
                   double.TryParse(_ticketRiskBox.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out riskUsd) &&
                   FinitePositive(riskUsd);
        }

        private bool TryCalculateTicket(
            TradeType side, double stop, double riskUsd,
            out double volume, out double entry, out double estimatedRiskUsd, out double takeProfit, out string reason)
        {
            volume = double.NaN;
            entry = double.NaN;
            estimatedRiskUsd = double.NaN;
            takeProfit = double.NaN;
            reason = "UNKNOWN";

            if (Account.IsLive && (!AllowLiveEntries || _liveExecutionConsent == null || _liveExecutionConsent.IsChecked != true))
            {
                reason = "LIVE_ENTRY_REQUIRES_PARAMETER_AND_PANEL_CONFIRMATION";
                return false;
            }
            if (!Account.IsLive && !AllowDemoEntries)
            {
                reason = "DEMO_ENTRIES_DISABLED_IN_CBOT_PARAMETERS";
                return false;
            }
            if (RequireHedgedAccount &&
                Account.AccountType.ToString().IndexOf("Hedg", StringComparison.OrdinalIgnoreCase) < 0)
            {
                reason = "HEDGED_ACCOUNT_REQUIRED";
                return false;
            }
            if (!Server.IsConnected || !Symbol.MarketHours.IsOpened() || !Symbol.IsTradingEnabled)
            {
                reason = "SERVER_DISCONNECTED_MARKET_CLOSED_OR_SYMBOL_DISABLED";
                return false;
            }
            if (HasLegacyUrmPositionOrPendingOrder() ||
                CountUrmPositions() >= MaxUrmPositionsAccountWide ||
                HasUrmPendingOrder() ||
                (BlockEntriesWithForeignExposure && HasForeignExposure()))
            {
                reason = "OPEN_POSITION_PENDING_ORDER_OR_UNRESOLVED_ACCOUNT_EXPOSURE_EXISTS";
                return false;
            }
            if (Symbol.MinDistanceType != SymbolMinDistanceType.Pips)
            {
                reason = "BROKER_MIN_DISTANCE_UNIT_NOT_PIPS_FAIL_CLOSED";
                return false;
            }

            double bid;
            double ask;
            if (!ReadFreshQuote(out bid, out ask))
            {
                reason = "QUOTE_MISSING_OR_STALE";
                return false;
            }
            var spreadTicks = (ask - bid) / Symbol.TickSize;
            if (!FiniteNonNegative(spreadTicks) || spreadTicks > MaxSpreadTicks)
            {
                reason = string.Format(CultureInfo.InvariantCulture, "SPREAD_TOO_WIDE_{0:F1}_TICKS", spreadTicks);
                return false;
            }
            if (!IsOnTickGrid(stop, Symbol.TickSize))
            {
                reason = "SL_OFF_BROKER_TICK_GRID";
                return false;
            }

            entry = side == TradeType.Buy ? ask : bid;
            if (!FinitePositive(stop) ||
                (side == TradeType.Buy && stop >= entry) ||
                (side == TradeType.Sell && stop <= entry))
            {
                reason = "SL_ON_WRONG_SIDE_OF_ENTRY";
                return false;
            }

            var stopPips = Math.Abs(entry - stop) / Symbol.PipSize;
            if (!FinitePositive(stopPips))
            {
                reason = "SL_DISTANCE_INVALID";
                return false;
            }
            var minSl = Symbol.MinStopLossDistance * Symbol.PipSize;
            var slFromExecutable = side == TradeType.Buy ? bid - stop : stop - ask;
            if (!FiniteNonNegative(slFromExecutable) || slFromExecutable + Symbol.TickSize * 0.01 < minSl)
            {
                reason = "SL_BREACHES_BROKER_MINIMUM_DISTANCE";
                return false;
            }

            double riskDeposit;
            try { riskDeposit = AssetConverter.Convert(riskUsd, "USD", Account.Asset.Name); }
            catch { reason = "USD_TO_DEPOSIT_CURRENCY_CONVERSION_FAILED"; return false; }
            if (!FinitePositive(riskDeposit))
            {
                reason = "USD_RISK_CONVERSION_INVALID";
                return false;
            }

            double rawVolume;
            try { rawVolume = Symbol.VolumeForFixedRisk(riskDeposit, stopPips, RoundingMode.Down); }
            catch { reason = "CTRADER_FIXED_RISK_VOLUME_CALCULATION_FAILED"; return false; }
            if (!FinitePositive(rawVolume))
            {
                reason = "CALCULATED_VOLUME_NOT_POSITIVE";
                return false;
            }

            volume = Symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);
            if (!FinitePositive(volume) || volume < Symbol.VolumeInUnitsMin ||
                volume > Symbol.VolumeInUnitsMax ||
                volume > rawVolume + Math.Max(1e-8, Symbol.VolumeInUnitsStep * 1e-6))
            {
                reason = "NORMALIZED_VOLUME_OUTSIDE_BROKER_LIMITS";
                return false;
            }
            var step = volume / Symbol.VolumeInUnitsStep;
            if (!FiniteNonNegative(step) || Math.Abs(step - Math.Round(step)) > 1e-6)
            {
                reason = "NORMALIZED_VOLUME_OFF_BROKER_STEP";
                return false;
            }

            try
            {
                var riskDepositEstimate = Symbol.AmountRisked(volume, stopPips);
                estimatedRiskUsd = AssetConverter.Convert(riskDepositEstimate, Account.Asset.Name, "USD");
            }
            catch { reason = "RISK_CROSSCHECK_USD_CONVERSION_FAILED"; return false; }
            if (!FiniteNonNegative(estimatedRiskUsd) || estimatedRiskUsd > riskUsd + RiskToleranceUsd)
            {
                reason = string.Format(CultureInfo.InvariantCulture,
                    "ESTIMATED_RISK_{0:F2}_EXCEEDS_BUDGET_{1:F2}_USD", estimatedRiskUsd, riskUsd);
                return false;
            }

            double estimatedMargin;
            try { estimatedMargin = Symbol.GetEstimatedMargin(side, volume); }
            catch { reason = "MARGIN_ESTIMATE_FAILED"; return false; }
            if (!FiniteNonNegative(estimatedMargin) || Account.FreeMargin <= 0 ||
                estimatedMargin > Account.FreeMargin * 0.90)
            {
                reason = "INSUFFICIENT_FREE_MARGIN";
                return false;
            }

            takeProfit = side == TradeType.Buy
                ? RoundUpToTick(entry + TakeProfitR * Math.Abs(entry - stop))
                : RoundDownToTick(entry - TakeProfitR * Math.Abs(entry - stop));
            var minTp = Symbol.MinTakeProfitDistance * Symbol.PipSize;
            var tpFromExecutable = side == TradeType.Buy ? takeProfit - bid : ask - takeProfit;
            if (!FinitePositive(takeProfit) || !FiniteNonNegative(tpFromExecutable) ||
                tpFromExecutable + Symbol.TickSize * 0.01 < minTp)
            {
                reason = "TP_BREACHES_BROKER_MINIMUM_DISTANCE";
                return false;
            }

            reason = "OK";
            return true;
        }

        private void RefreshTradingPanel()
        {
            if (_panelTabs == null)
                return;

            double bid;
            double ask;
            var quoteReady = ReadFreshQuote(out bid, out ask);
            var liveText = Account.IsLive ? "LIVE" : "DEMO";

            if (_positionStatusText != null)
            {
                var lines = new List<string>();
                lines.Add(string.Format(CultureInfo.InvariantCulture,
                    "Account: {0} | Symbol: {1} | Deposit currency: {2}",
                    liveText, Symbol.Name, Account.Asset == null ? "UNKNOWN" : Account.Asset.Name));
                lines.Add(string.Format(CultureInfo.InvariantCulture,
                    "Open URM positions: {0} | Auto ladder: {1} | Candle flip: {2}",
                    CountUrmPositions(), _runtimeLadderEnabled && EnableRLadder, _runtimeCandleTrailEnabled && EnableCandleFlipTrail));

                for (var i = 0; i < Positions.Count; i++)
                {
                    var p = Positions[i];
                    if (p == null || p.SymbolName != Symbol.Name || string.IsNullOrEmpty(p.Label) ||
                        !p.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                        continue;

                    double initialSL;
                    if (!TryParseOriginalStop(p.Label, out initialSL))
                    {
                        lines.Add(string.Format(CultureInfo.InvariantCulture,
                            "Position {0}: label anchor unreadable — MANUAL RECONCILIATION REQUIRED", p.Id));
                        continue;
                    }

                    var rDistance = Math.Abs(p.EntryPrice - initialSL);
                    var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
                    var rNow = rDistance > 0
                        ? (p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price) / rDistance
                        : double.NaN;
                    lines.Add(string.Format(CultureInfo.InvariantCulture,
                        "ID {0} {1} | Units {2:F0} ({3:F4} lots) | Entry {4} | R {5:F2} | SL {6} | TP {7} | Net P/L {8:F2}",
                        p.Id, p.TradeType, p.VolumeInUnits, Symbol.VolumeInUnitsToQuantity(p.VolumeInUnits),
                        p.EntryPrice, rNow, p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture) : "MISSING",
                        p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture) : "MISSING",
                        p.NetProfit));
                }

                if (lines.Count == 2)
                    lines.Add("No open URMSTRAT|V1| position on this symbol.");
                _positionStatusText.Text = string.Join(Environment.NewLine, lines);
            }

            if (_strategyStatusText != null)
            {
                _strategyStatusText.Text = string.Format(CultureInfo.InvariantCulture,
                    "Symbol {0} | {1} | quote {2} | auto entry {3} | M5 setup {4} | OB found {5} | M1 pullback bars {6}/{7} | risk ${8:F2} | TP {9:F1}R",
                    Symbol.Name, liveText, quoteReady ? "fresh" : "STALE / UNAVAILABLE",
                    _runtimeAutoEntryEnabled, _setupActive ? "ACTIVE" : "none",
                    _obValid, _pullbackCount, MaxPullbackBars, FixedRiskUsd, TakeProfitR);
            }
        }

        private void RefreshTradingPanelIfDue()
        {
            if (_panelTabs == null)
                return;
            if (_lastPanelRefreshUtc != DateTime.MinValue &&
                (Server.TimeInUtc - _lastPanelRefreshUtc).TotalMilliseconds < 750)
                return;
            _lastPanelRefreshUtc = Server.TimeInUtc;
            RefreshTradingPanel();
        }

        private void SetTicketStatus(string message)
        {
            if (_ticketStatusText != null)
                _ticketStatusText.Text = message;
            Print("URM_LOCAL|PANEL_STATUS|{0}", message);
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

        private void Block(string code, string reason)
        {
            Print("URM_LOCAL|ENTRY_BLOCK|{0}|{1}", code, reason);
        }

        private static bool IsOnTickGrid(double price, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize))
                return false;

            var ticks = price / tickSize;
            return double.IsFinite(ticks) &&
                   Math.Abs(ticks - Math.Round(ticks)) <= 1e-6;
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