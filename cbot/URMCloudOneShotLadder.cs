// URM Cloud One-Shot + R-Ladder Manager v0.1
// Cloud-compatible design: no Desktop-only guards, LocalStorage, filesystem, or external DLLs.
// DEMO ONLY; order submission is disabled by default.
// State recovery uses the broker-confirmed server SL plus structural SL encoded in the position label.
// IMPORTANT: server SL cannot encode every unconfirmed price excursion. Test only on Demo.

using System;
using System.Globalization;
using System.Collections.Generic;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMCloudOneShotLadder : Robot
    {
        private const double RiskUsd = 10.0;
        private const double RiskToleranceUsd = 0.01;
        private const double TakeProfitR = 5.0;
        private const double BreakEvenAtR = 1.0;
        private const double LockAtR = 2.0;
        private const double LockToR = 1.7;
        private const double TrailAtR = 3.0;
        private const double TrailGapR = 1.0;
        private const double TrailFloorR = 2.0;
        private const int MaxTickAgeSeconds = 5;

        private readonly HashSet<int> _haltedPositions = new HashSet<int>();
        private bool _submittingOrder;

        [Parameter("Exact broker symbol", DefaultValue = "XAUUSD")]
        public string ExactSymbolName { get; set; }

        [Parameter("Direction", DefaultValue = TradeType.Buy)]
        public TradeType Direction { get; set; }

        [Parameter("Structural SL price", DefaultValue = 0.0, MinValue = 0.0)]
        public double StructuralStopPrice { get; set; }

        [Parameter("Confirm one-shot DEMO order", DefaultValue = false)]
        public bool ConfirmOneShotDemoOrder { get; set; }

        [Parameter("Maximum tick age (seconds)", DefaultValue = 5, MinValue = 1, MaxValue = 30)]
        public int MaxTickAgeSeconds { get; set; }

        [Parameter("Maximum spread (ticks)", DefaultValue = 100, MinValue = 1, MaxValue = 100000)]
        public int MaxSpreadTicks { get; set; }

        protected override void OnStart()
        {
            if (Account.IsLive)
            {
                Block("LIVE_ACCOUNT_NOT_ALLOWED", "This cBot is Demo-only.");
                return;
            }

            if (!string.Equals(Account.AccountType.ToString(), "Hedged", StringComparison.OrdinalIgnoreCase))
            {
                Block("ACCOUNT_MODEL_UNSUPPORTED", "Only HEDGED accounts are supported.");
                return;
            }

            Positions.Opened += OnPositionOpened;
            Positions.Closed += OnPositionClosed;
            Timer.Start(1);

            Print("URM_CLOUD|STARTED|account={0}|symbol={1}|demoOnly=true|confirmOrder={2}|storage=NONE|stateRecovery=SERVER_SL_PLUS_LABEL",
                Account.Number, Symbol.Name, ConfirmOneShotDemoOrder);
            Print("URM_CLOUD|NOTICE|Use one Cloud instance per Demo account. This cBot manages only URM1 labels on its chart symbol. No LocalStorage.Flush or filesystem is used.");

            // Existing labelled positions are observed, but no unknown position is modified.
            if (ReadFreshTick(out var bid, out var ask))
                ManageSymbolPositions(bid, ask, "STARTUP");

            if (ConfirmOneShotDemoOrder)
                SubmitOneShotDemoOrder();
            else
                Print("URM_CLOUD|PREFLIGHT_ONLY|No new order will be submitted because confirmation is false.");
        }

        protected override void OnTick()
        {
            if (Account.IsLive || !string.Equals(Account.AccountType.ToString(), "Hedged", StringComparison.OrdinalIgnoreCase))
                return;

            if (ReadFreshTick(out var bid, out var ask))
                ManageSymbolPositions(bid, ask, "TICK");
        }

        protected override void OnTimer()
        {
            if (Account.IsLive || !string.Equals(Account.AccountType.ToString(), "Hedged", StringComparison.OrdinalIgnoreCase))
                return;

            if (ReadFreshTick(out var bid, out var ask))
                ManageSymbolPositions(bid, ask, "TIMER");
        }

        protected override void OnStop()
        {
            Timer.Stop();
            Positions.Opened -= OnPositionOpened;
            Positions.Closed -= OnPositionClosed;
            Print("URM_CLOUD|STOPPED|Any broker-side SL/TP already attached remains server-side; no local storage was used.");
        }

        private void OnPositionOpened(PositionOpenedEventArgs args)
        {
            if (_submittingOrder || args.Position == null ||
                !string.Equals(args.Position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                return;

            if (ReadFreshTick(out var bid, out var ask))
                ManagePosition(args.Position, bid, ask, "POSITION_OPENED");
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            if (args.Position != null)
                _haltedPositions.Remove(args.Position.Id);
        }

        private void ManageSymbolPositions(double bid, double ask, string source)
        {
            foreach (var position in Positions)
            {
                if (string.Equals(position.SymbolName, Symbol.Name, StringComparison.Ordinal))
                    ManagePosition(position, bid, ask, source);
            }
        }

        private void ManagePosition(Position position, double bid, double ask, string source)
        {
            if (position == null || _haltedPositions.Contains(position.Id))
                return;

            string clientOrderId;
            double structuralSL;
            if (!TryParseLabel(position.Label ?? string.Empty, out clientOrderId, out structuralSL))
                return; // Never touch positions not explicitly labelled by this URM cBot.

            var tickSize = Symbol.TickSize;
            var pipSize = Symbol.PipSize;
            var entry = position.EntryPrice;
            var isBuy = position.TradeType == TradeType.Buy;

            if (!FinitePositive(entry) || !FinitePositive(tickSize) || !FinitePositive(pipSize) ||
                !FinitePositive(bid) || !FinitePositive(ask) || ask < bid)
            {
                LogPosition(position, "BLOCKED_INVALID_MARKET_DATA", "Entry/tick/pip/bid/ask invalid.");
                return;
            }

            if ((isBuy && structuralSL >= entry) || (!isBuy && structuralSL <= entry) ||
                !IsOnTickGrid(structuralSL, tickSize))
            {
                HaltPosition(position, "STRUCTURAL_SL_INVALID", "Structural SL is wrong-side or off TickSize grid.");
                return;
            }

            var rDistance = Math.Abs(entry - structuralSL);
            if (!FinitePositive(rDistance) || rDistance < tickSize - 1e-10)
            {
                HaltPosition(position, "R_DISTANCE_INVALID", "Original R distance is invalid.");
                return;
            }

            var expectedTP = RoundTargetOutward(
                isBuy ? entry + TakeProfitR * rDistance : entry - TakeProfitR * rDistance,
                position.TradeType, tickSize);

            if (!position.TakeProfit.HasValue ||
                Math.Abs(position.TakeProfit.Value - expectedTP) > Math.Max(tickSize * 0.51, 1e-9))
            {
                LogPosition(position, "BLOCKED_TP_ANCHOR_MISMATCH",
                    "Server TP does not match fill-anchored 5R; no SL modification attempted.");
                return;
            }

            if (!position.StopLoss.HasValue || !FinitePositive(position.StopLoss.Value))
            {
                HaltPosition(position, "SERVER_SL_MISSING", "No confirmed server-side SL; manual reconciliation required.");
                return;
            }

            var executable = isBuy ? bid : ask;
            var currentR = isBuy ? (executable - entry) / rDistance : (entry - executable) / rDistance;
            if (!FiniteNonNegative(Math.Abs(currentR)))
            {
                LogPosition(position, "BLOCKED_CURRENT_R_INVALID", "Current R is invalid.");
                return;
            }

            var confirmedStop = position.StopLoss.Value;
            if (!IsOnTickGrid(confirmedStop, tickSize))
            {
                HaltPosition(position, "SERVER_SL_OFF_TICK_GRID", "Server SL is off the current TickSize grid.");
                return;
            }

            // Recover conservative progress from broker-confirmed SL. This survives a
            // Cloud restart without relying on LocalStorage, which is not durable in Cloud.
            var stopR = isBuy ? (confirmedStop - entry) / rDistance : (entry - confirmedStop) / rDistance;
            double inferredPeak;
            if (stopR >= TrailFloorR - 1e-6)
                inferredPeak = stopR + TrailGapR;
            else if (stopR >= LockToR - 1e-6)
                inferredPeak = LockAtR;
            else if (stopR >= -1e-6)
                inferredPeak = BreakEvenAtR;
            else
                inferredPeak = Math.Max(0.0, currentR);

            var peakR = Math.Max(inferredPeak, Math.Max(0.0, currentR));
            if (peakR >= TakeProfitR || currentR >= TakeProfitR)
            {
                LogPosition(position, "TP_BOUNDARY_RECONCILIATION_REQUIRED",
                    "Position is at/after 5R but remains open; check broker Trade Watch. This cBot never closes positions.");
                return;
            }

            double targetStopR;
            string phase;
            if (peakR >= TrailAtR)
            {
                phase = "TRAILING";
                targetStopR = Math.Max(TrailFloorR, peakR - TrailGapR);
            }
            else if (peakR >= LockAtR)
            {
                phase = "LOCK_1_7R";
                targetStopR = LockToR;
            }
            else if (peakR >= BreakEvenAtR)
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
            var targetSL = targetStopR < 0.0
                ? structuralSL
                : RoundProtectiveStop(rawTargetSL, position.TradeType, tickSize);

            var improves = isBuy
                ? targetSL > confirmedStop + tickSize * 1e-6
                : targetSL < confirmedStop - tickSize * 1e-6;

            if (!improves)
                return;

            if ((isBuy && targetSL >= bid - tickSize * 1e-6) ||
                (!isBuy && targetSL <= ask + tickSize * 1e-6) ||
                !IsOnTickGrid(targetSL, tickSize))
            {
                HaltPosition(position, "STOP_TARGET_INVALID_OR_CROSSED", "Target SL is crossed by executable quote or off-grid.");
                return;
            }

            var oldTP = position.TakeProfit.Value;
            TradeResult result;
            try
            {
                result = ModifyPosition(position, targetSL, oldTP, ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                HaltPosition(position, "SL_MODIFY_EXCEPTION_" + ex.GetType().Name, "Check broker Trade Watch manually.");
                return;
            }

            if (result == null || !result.IsSuccessful)
            {
                HaltPosition(position, "SL_MODIFY_REJECTED", "No automatic retry in this running instance; check Trade Watch.");
                return;
            }

            var updated = Positions.FindById(position.Id);
            var tolerance = Math.Max(tickSize * 0.51, 1e-9);
            if (updated == null || !updated.StopLoss.HasValue ||
                Math.Abs(updated.StopLoss.Value - targetSL) > tolerance ||
                !updated.TakeProfit.HasValue || Math.Abs(updated.TakeProfit.Value - oldTP) > tolerance)
            {
                HaltPosition(position, "SERVER_READBACK_MISMATCH", "Server SL/TP read-back mismatch; manual reconciliation required.");
                return;
            }

            Print("URM_CLOUD|SL_UPDATED|source={0}|positionId={1}|symbol={2}|phase={3}|currentR={4:F3}|recoveredPeakR={5:F3}|SL={6}|TP={7}",
                source, position.Id, position.SymbolName, phase, currentR, peakR,
                updated.StopLoss.Value.ToString("R", CultureInfo.InvariantCulture),
                updated.TakeProfit.Value.ToString("R", CultureInfo.InvariantCulture));
        }

        private void SubmitOneShotDemoOrder()
        {
            if (Account.IsLive || !string.Equals(Account.AccountType.ToString(), "Hedged", StringComparison.OrdinalIgnoreCase))
            {
                Block("ACCOUNT_GUARD_FAILED", "Demo Hedged account required.");
                return;
            }

            if (Positions.Count != 0 || PendingOrders.Count != 0)
            {
                Block("ACCOUNT_NOT_FLAT", "This one-shot executor requires no open positions or pending orders anywhere on the account.");
                return;
            }

            var symbolName = (ExactSymbolName ?? string.Empty).Trim();
            if (symbolName.Length == 0 || !string.Equals(symbolName, Symbol.Name, StringComparison.OrdinalIgnoreCase))
            {
                Block("CHART_SYMBOL_MISMATCH", "Set the instance chart symbol and Exact broker symbol to the same exact broker symbol.");
                return;
            }

            Symbol targetSymbol;
            try { targetSymbol = Symbols.GetSymbol(symbolName); }
            catch (Exception ex) { Block("SYMBOL_LOOKUP_FAILED_" + ex.GetType().Name, "Symbol lookup failed."); return; }

            if (targetSymbol == null || !string.Equals(targetSymbol.Name, symbolName, StringComparison.OrdinalIgnoreCase) ||
                !targetSymbol.MarketHours.IsOpened())
            {
                Block("SYMBOL_MISSING_OR_MARKET_CLOSED", "Exact symbol not found or broker market is closed.");
                return;
            }

            if (!FinitePositive(StructuralStopPrice) || !FinitePositive(targetSymbol.TickSize) || !FinitePositive(targetSymbol.PipSize))
            {
                Block("STRUCTURAL_SL_OR_SYMBOL_DATA_INVALID", "Enter a valid structural SL and confirm symbol tick/pip sizes.");
                return;
            }

            if (!ReadFreshTick(out var bid, out var ask))
            {
                Block("NO_FRESH_TICK", "Wait for a fresh platform tick and restart the preflight.");
                return;
            }

            var spreadTicks = (ask - bid) / targetSymbol.TickSize;
            if (!FiniteNonNegative(spreadTicks) || spreadTicks > MaxSpreadTicks)
            {
                Block("SPREAD_TOO_WIDE", "Current spread exceeds configured maximum.");
                return;
            }

            if (!IsOnTickGrid(StructuralStopPrice, targetSymbol.TickSize))
            {
                Block("STRUCTURAL_SL_OFF_TICK_GRID", "Structural SL is not on exact broker TickSize grid.");
                return;
            }

            var isBuy = Direction == TradeType.Buy;
            var entryRef = isBuy ? ask : bid;
            if ((isBuy && StructuralStopPrice >= entryRef) || (!isBuy && StructuralStopPrice <= entryRef))
            {
                Block("STRUCTURAL_SL_WRONG_SIDE", "BUY needs SL below Ask; SELL needs SL above Bid.");
                return;
            }

            double riskDeposit;
            try { riskDeposit = AssetConverter.Convert(RiskUsd, "USD", Account.Asset.Name); }
            catch (Exception ex) { Block("USD_CONVERSION_FAILED_" + ex.GetType().Name, "Cannot convert USD 10 to deposit currency."); return; }

            if (!FinitePositive(riskDeposit))
            {
                Block("RISK_CONVERSION_INVALID", "USD risk conversion is not positive/finite.");
                return;
            }

            var stopPips = Math.Abs(entryRef - StructuralStopPrice) / targetSymbol.PipSize;
            if (!FinitePositive(stopPips))
            {
                Block("STOP_DISTANCE_INVALID", "Stop distance is invalid.");
                return;
            }

            double rawVolume;
            try { rawVolume = targetSymbol.VolumeForFixedRisk(riskDeposit, stopPips, RoundingMode.Down); }
            catch (Exception ex) { Block("VOLUME_CALCULATION_FAILED_" + ex.GetType().Name, "Fixed-risk sizing failed."); return; }

            var volume = targetSymbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);
            if (!FinitePositive(volume) || volume < targetSymbol.VolumeInUnitsMin ||
                volume > targetSymbol.VolumeInUnitsMax ||
                volume > rawVolume + Math.Max(1e-8, targetSymbol.VolumeInUnitsStep * 1e-6))
            {
                Block("VOLUME_OUT_OF_BOUNDS", "Volume cannot be safely rounded down into broker limits.");
                return;
            }

            var estimateDeposit = targetSymbol.AmountRisked(volume, stopPips);
            double estimateUsd;
            try { estimateUsd = AssetConverter.Convert(estimateDeposit, Account.Asset.Name, "USD"); }
            catch (Exception ex) { Block("RISK_CROSSCHECK_FAILED_" + ex.GetType().Name, "Cannot cross-check estimated risk in USD."); return; }

            if (!FiniteNonNegative(estimateUsd) || estimateUsd > RiskUsd + RiskToleranceUsd)
            {
                Block("RISK_ABOVE_USD_10", "Estimated price risk exceeds the USD 10 budget.");
                return;
            }

            var targetRaw = isBuy
                ? entryRef + TakeProfitR * Math.Abs(entryRef - StructuralStopPrice)
                : entryRef - TakeProfitR * Math.Abs(entryRef - StructuralStopPrice);
            var target = RoundTargetOutward(targetRaw, Direction, targetSymbol.TickSize);
            var tpPips = Math.Abs(target - entryRef) / targetSymbol.PipSize;
            if (!FinitePositive(tpPips))
            {
                Block("TP_DISTANCE_INVALID", "Initial TP distance is invalid.");
                return;
            }

            var label = BuildLabel(StructuralStopPrice, targetSymbol.Digits);
            Print("URM_CLOUD|PREFLIGHT_PASS|symbol={0}|side={1}|volumeUnits={2}|estimatedRiskUsd={3:F4}|SL={4}|estimated5R={5}",
                targetSymbol.Name, Direction, volume, estimateUsd,
                StructuralStopPrice.ToString("R", CultureInfo.InvariantCulture),
                target.ToString("R", CultureInfo.InvariantCulture));

            _submittingOrder = true;
            TradeResult order;
            try
            {
                order = ExecuteMarketOrder(Direction, targetSymbol.Name, volume, label,
                    stopPips, tpPips, "URM Cloud Demo USD10 price-risk", false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                _submittingOrder = false;
                Block("ORDER_EXCEPTION_" + ex.GetType().Name, "Check Trade Watch before any retry.");
                return;
            }
            _submittingOrder = false;

            if (order == null || !order.IsSuccessful || order.Position == null)
            {
                Block("ORDER_REJECTED", "cTrader did not confirm the market order. Do not retry until Trade Watch is checked.");
                return;
            }

            var position = order.Position;
            var fill = position.EntryPrice;
            var filledStopPips = Math.Abs(fill - StructuralStopPrice) / targetSymbol.PipSize;
            var correctSide = isBuy ? StructuralStopPrice < fill : StructuralStopPrice > fill;
            if (!FinitePositive(fill) || !correctSide || !IsOnTickGrid(fill, targetSymbol.TickSize) ||
                !FinitePositive(filledStopPips))
            {
                CloseAfterProtectionProblem(position, "FILL_OR_STRUCTURAL_SL_INVALID");
                return;
            }

            var filledRiskDeposit = targetSymbol.AmountRisked(position.VolumeInUnits, filledStopPips);
            double filledRiskUsd;
            try { filledRiskUsd = AssetConverter.Convert(filledRiskDeposit, Account.Asset.Name, "USD"); }
            catch { CloseAfterProtectionProblem(position, "FILLED_RISK_CONVERSION_FAILED"); return; }

            if (!FiniteNonNegative(filledRiskUsd) || filledRiskUsd > RiskUsd + RiskToleranceUsd)
            {
                CloseAfterProtectionProblem(position, "FILL_RISK_EXCEEDS_USD_10");
                return;
            }

            var rDistance = Math.Abs(fill - StructuralStopPrice);
            var fillTP = RoundTargetOutward(
                isBuy ? fill + TakeProfitR * rDistance : fill - TakeProfitR * rDistance,
                Direction, targetSymbol.TickSize);

            TradeResult protection;
            try
            {
                protection = ModifyPosition(position, StructuralStopPrice, fillTP,
                    ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                CloseAfterProtectionProblem(position, "PROTECTION_EXCEPTION_" + ex.GetType().Name);
                return;
            }

            if (protection == null || !protection.IsSuccessful)
            {
                CloseAfterProtectionProblem(position, "PROTECTION_UPDATE_REJECTED");
                return;
            }

            var readBack = Positions.FindById(position.Id);
            var tolerance = Math.Max(targetSymbol.TickSize * 0.51, 1e-9);
            if (readBack == null || !readBack.StopLoss.HasValue ||
                Math.Abs(readBack.StopLoss.Value - StructuralStopPrice) > tolerance ||
                !readBack.TakeProfit.HasValue || Math.Abs(readBack.TakeProfit.Value - fillTP) > tolerance)
            {
                CloseAfterProtectionProblem(position, "PROTECTION_READBACK_MISMATCH");
                return;
            }

            Print("URM_CLOUD|ORDER_PROTECTED|positionId={0}|symbol={1}|side={2}|fill={3}|volumeUnits={4}|SL={5}|TP5R={6}|estimatedRiskUsd={7:F4}",
                position.Id, targetSymbol.Name, Direction,
                fill.ToString("R", CultureInfo.InvariantCulture),
                position.VolumeInUnits.ToString("R", CultureInfo.InvariantCulture),
                StructuralStopPrice.ToString("R", CultureInfo.InvariantCulture),
                fillTP.ToString("R", CultureInfo.InvariantCulture), filledRiskUsd);

            if (ReadFreshTick(out bid, out ask))
                ManagePosition(readBack, bid, ask, "AFTER_ORDER_PROTECTION");
        }

        private void CloseAfterProtectionProblem(Position position, string reason)
        {
            Print("URM_CLOUD|CRITICAL|{0}|Attempting immediate close. Check Trade Watch manually.", reason);
            try
            {
                var close = ClosePosition(position);
                if (close == null || !close.IsSuccessful)
                    Print("URM_CLOUD|CRITICAL_CLOSE_FAILED|positionId={0}|reason={1}|MANUAL_ACTION_REQUIRED", position.Id, reason);
            }
            catch (Exception ex)
            {
                Print("URM_CLOUD|CRITICAL_CLOSE_EXCEPTION|positionId={0}|reason={1}|error={2}|MANUAL_ACTION_REQUIRED",
                    position.Id, reason, ex.GetType().Name);
            }
            _haltedPositions.Add(position.Id);
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

        private static string BuildLabel(double structuralSL, int digits)
        {
            if (!FinitePositive(structuralSL) || digits < 0 || digits > 10)
                throw new ArgumentOutOfRangeException(nameof(structuralSL));

            var id = "URM-" + Guid.NewGuid().ToString("N").ToUpperInvariant();
            var sl = structuralSL.ToString("F" + digits, CultureInfo.InvariantCulture);
            if (!double.TryParse(sl, NumberStyles.Float, CultureInfo.InvariantCulture, out var encoded) ||
                Math.Abs(encoded - structuralSL) > Math.Max(1e-10, Math.Pow(10, -digits) * 1e-6))
                throw new InvalidOperationException("Structural SL cannot be represented at broker precision.");

            var label = "URM1|ID=" + id + "|SL=" + sl;
            if (label.Length > 100)
                throw new InvalidOperationException("Label exceeds cTrader limit.");
            return label;
        }

        private static bool TryParseLabel(string label, out string id, out double structuralSL)
        {
            id = null;
            structuralSL = double.NaN;
            if (string.IsNullOrEmpty(label) || label.Length > 100)
                return false;

            var parts = label.Split('|');
            if (parts.Length != 3 || parts[0] != "URM1" ||
                !parts[1].StartsWith("ID=URM-", StringComparison.Ordinal) ||
                !parts[2].StartsWith("SL=", StringComparison.Ordinal))
                return false;

            var parsedId = parts[1].Substring(3);
            if (parsedId.Length < 5 || parsedId.Length > 50)
                return false;

            if (!double.TryParse(parts[2].Substring(3), NumberStyles.AllowDecimalPoint,
                CultureInfo.InvariantCulture, out var sl) || !FinitePositive(sl))
                return false;

            id = parsedId;
            structuralSL = sl;
            return true;
        }

        private void HaltPosition(Position position, string code, string reason)
        {
            _haltedPositions.Add(position.Id);
            LogPosition(position, code, reason + " This position is halted from further automatic modifications in this instance.");
        }

        private void LogPosition(Position position, string code, string reason)
        {
            Print("URM_CLOUD|{0}|positionId={1}|symbol={2}|side={3}|SL={4}|TP={5}|{6}",
                code, position.Id, position.SymbolName, position.TradeType,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("R", CultureInfo.InvariantCulture) : "MISSING",
                reason);
        }

        private void Block(string code, string reason)
        {
            Print("URM_CLOUD|BLOCK|{0}|{1}", code, reason);
            Stop();
        }

        private static double RoundTargetOutward(double price, TradeType side, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return double.NaN;
            var units = price / tickSize;
            var rounded = side == TradeType.Buy ? Math.Ceiling(units - 1e-10) : Math.Floor(units + 1e-10);
            return Math.Round(rounded * tickSize, 10, MidpointRounding.AwayFromZero);
        }

        private static double RoundProtectiveStop(double price, TradeType side, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return double.NaN;
            var units = price / tickSize;
            var rounded = side == TradeType.Buy ? Math.Floor(units + 1e-10) : Math.Ceiling(units - 1e-10);
            return Math.Round(rounded * tickSize, 10, MidpointRounding.AwayFromZero);
        }

        private static bool IsOnTickGrid(double price, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return false;
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
