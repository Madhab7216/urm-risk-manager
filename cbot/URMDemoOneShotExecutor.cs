// URM Demo One-Shot Executor v1.0
// Native cTrader Algo execution path. This is NOT wired to the WebView plugin.
// Hard Demo-only guard, explicit one-shot confirmation, fixed USD 10 price-risk,
// fresh tick timestamp, authoritative Symbol.TickSize, attached SL/TP, and
// server-confirmed absolute structural SL / 5R TP. Compile in cTrader Automate.
// Commission remains separate from the $10 price-risk target.

using System;
using System.Globalization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMDemoOneShotExecutor : Robot
    {
        private const double TargetRiskUsd = 10.0;
        private const double RiskToleranceUsd = 0.01;
        private const double TakeProfitR = 5.0;

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
            try
            {
                RunPreflightAndMaybeSubmit();
            }
            catch (Exception ex)
            {
                Print("URM_DEMO|BLOCK|UNHANDLED_PREFLIGHT_EXCEPTION|{0}", ex.GetType().Name);
                Stop();
            }
        }

        private void RunPreflightAndMaybeSubmit()
        {
            if (Account.IsLive)
            {
                Block("LIVE_ACCOUNT_NOT_ALLOWED", "This cBot only runs on a cTrader Demo account.");
                return;
            }
            if (!Server.IsConnected)
            {
                Block("SERVER_DISCONNECTED", "cTrader server is not connected.");
                return;
            }

            var accountType = Account.AccountType.ToString();
            if (!string.Equals(accountType, "Hedged", StringComparison.OrdinalIgnoreCase))
            {
                Block("ACCOUNT_MODEL_UNSUPPORTED", "Only HEDGED accounts are supported by this initial executor.");
                return;
            }
            if (Account.Asset == null || string.IsNullOrWhiteSpace(Account.Asset.Name))
            {
                Block("ACCOUNT_CURRENCY_UNKNOWN", "The account deposit currency is unavailable.");
                return;
            }

            var symbolName = (ExactSymbolName ?? string.Empty).Trim();
            if (symbolName.Length == 0)
            {
                Block("SYMBOL_NAME_REQUIRED", "Enter the exact symbol name shown by your broker.");
                return;
            }

            Symbol symbol;
            try { symbol = Symbols.GetSymbol(symbolName); }
            catch (Exception ex)
            {
                Block("SYMBOL_LOOKUP_FAILED", "Symbol lookup failed: " + ex.GetType().Name);
                return;
            }
            if (symbol == null || !string.Equals(symbol.Name, symbolName, StringComparison.OrdinalIgnoreCase))
            {
                Block("EXACT_SYMBOL_NOT_FOUND", "The exact broker symbol was not found. Check any suffix/prefix.");
                return;
            }
            if (!symbol.MarketHours.IsOpened())
            {
                Block("MARKET_CLOSED", "Broker-reported market hours say this symbol is closed.");
                return;
            }

            // This first execution slice deliberately blocks all pre-existing
            // positions/orders rather than claiming that portfolio max-exposure is solved.
            if (Positions.Count != 0)
            {
                Block("OPEN_POSITION_EXISTS", "Close/reconcile all existing account positions before using this one-shot executor.");
                return;
            }
            if (PendingOrders.Count != 0)
            {
                Block("PENDING_ORDER_EXISTS", "Cancel/reconcile all existing pending orders before using this one-shot executor.");
                return;
            }
            if (!FinitePositive(StructuralStopPrice))
            {
                Block("STRUCTURAL_SL_REQUIRED", "Enter a positive structural invalidation/stop price.");
                return;
            }
            if (!FinitePositive(symbol.TickSize) || !FinitePositive(symbol.PipSize))
            {
                Block("SYMBOL_TICK_OR_PIP_SIZE_INVALID", "Broker TickSize or PipSize is missing/invalid.");
                return;
            }

            Ticks ticks;
            try { ticks = MarketData.GetTicks(symbol.Name); }
            catch (Exception ex)
            {
                Block("TICK_STREAM_LOOKUP_FAILED", "Could not read cTrader tick history: " + ex.GetType().Name);
                return;
            }
            if (ticks == null || ticks.Count < 1)
            {
                Block("NO_TICK_AVAILABLE", "No platform tick timestamp is available; wait for a new market tick and restart preflight.");
                return;
            }

            var tick = ticks.LastTick;
            var tickTimeUtc = DateTime.SpecifyKind(tick.Time, DateTimeKind.Utc);
            var tickAgeSeconds = (Server.TimeInUtc - tickTimeUtc).TotalSeconds;
            if (tickAgeSeconds < 0 || tickAgeSeconds > MaxTickAgeSeconds)
            {
                Block("TICK_STALE_OR_FUTURE", string.Format(CultureInfo.InvariantCulture,
                    "Last tick age is {0:F2}s; permitted range is 0..{1}s.", tickAgeSeconds, MaxTickAgeSeconds));
                return;
            }

            var bid = tick.Bid;
            var ask = tick.Ask;
            if (!FinitePositive(bid) || !FinitePositive(ask) || ask < bid)
            {
                Block("TICK_BID_ASK_INVALID", "Last tick does not contain a valid positive Bid/Ask pair.");
                return;
            }

            var spreadTicks = (ask - bid) / symbol.TickSize;
            if (!FiniteNonNegative(spreadTicks) || spreadTicks > MaxSpreadTicks)
            {
                Block("SPREAD_TOO_WIDE", string.Format(CultureInfo.InvariantCulture,
                    "Spread is {0:F1} ticks; configured maximum is {1}.", spreadTicks, MaxSpreadTicks));
                return;
            }
            if (!IsOnTickGrid(StructuralStopPrice, symbol.TickSize))
            {
                Block("STRUCTURAL_SL_OFF_TICK_GRID", "Structural SL is not on the exact broker TickSize grid. SL is never auto-rounded.");
                return;
            }

            var isBuy = Direction == TradeType.Buy;
            var entryReference = isBuy ? ask : bid;
            if ((isBuy && StructuralStopPrice >= entryReference) ||
                (!isBuy && StructuralStopPrice <= entryReference))
            {
                Block("STRUCTURAL_SL_WRONG_SIDE", "BUY requires SL below Ask; SELL requires SL above Bid.");
                return;
            }

            double budgetInDeposit;
            try { budgetInDeposit = AssetConverter.Convert(TargetRiskUsd, "USD", Account.Asset.Name); }
            catch (Exception ex)
            {
                Block("USD_CONVERSION_FAILED", "Could not convert USD 10 into account currency: " + ex.GetType().Name);
                return;
            }
            if (!FinitePositive(budgetInDeposit))
            {
                Block("USD_CONVERSION_INVALID", "USD-to-deposit-currency conversion was not positive/finite.");
                return;
            }

            var stopDistancePrice = Math.Abs(entryReference - StructuralStopPrice);
            var stopDistancePips = stopDistancePrice / symbol.PipSize;
            if (!FinitePositive(stopDistancePips))
            {
                Block("STOP_DISTANCE_INVALID", "Structural stop distance is invalid.");
                return;
            }

            double rawVolume;
            try { rawVolume = symbol.VolumeForFixedRisk(budgetInDeposit, stopDistancePips, RoundingMode.Down); }
            catch (Exception ex)
            {
                Block("FIXED_RISK_CALCULATION_FAILED", "cTrader fixed-risk sizing failed: " + ex.GetType().Name);
                return;
            }
            if (!FinitePositive(rawVolume))
            {
                Block("FIXED_RISK_VOLUME_INVALID", "cTrader could not calculate a positive fixed-risk volume.");
                return;
            }

            var volume = symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);
            if (!FinitePositive(volume) || volume < symbol.VolumeInUnitsMin ||
                volume > symbol.VolumeInUnitsMax ||
                volume > rawVolume + Math.Max(1e-8, symbol.VolumeInUnitsStep * 1e-6))
            {
                Block("NORMALIZED_VOLUME_OUT_OF_BOUNDS", "Volume cannot be rounded down into broker min/max bounds.");
                return;
            }
            var volumeStepUnits = volume / symbol.VolumeInUnitsStep;
            if (!FiniteNonNegative(volumeStepUnits) ||
                Math.Abs(volumeStepUnits - Math.Round(volumeStepUnits)) > 1e-6)
            {
                Block("VOLUME_STEP_INVALID", "Normalized volume does not align to broker's volume step.");
                return;
            }

            var estimatedRiskDeposit = symbol.AmountRisked(volume, stopDistancePips);
            double estimatedRiskUsd;
            try { estimatedRiskUsd = AssetConverter.Convert(estimatedRiskDeposit, Account.Asset.Name, "USD"); }
            catch (Exception ex)
            {
                Block("RISK_USD_CONVERSION_FAILED", "Could not cross-check risk in USD: " + ex.GetType().Name);
                return;
            }
            if (!FiniteNonNegative(estimatedRiskUsd) || estimatedRiskUsd > TargetRiskUsd + RiskToleranceUsd)
            {
                Block("RISK_ABOVE_USD_10", string.Format(CultureInfo.InvariantCulture,
                    "Estimated price risk is {0:F4} USD; budget is {1:F2} USD.", estimatedRiskUsd, TargetRiskUsd));
                return;
            }

            double estimatedMargin;
            try { estimatedMargin = symbol.GetEstimatedMargin(Direction, volume); }
            catch (Exception ex)
            {
                Block("MARGIN_ESTIMATE_FAILED", "Broker margin estimate failed: " + ex.GetType().Name);
                return;
            }
            if (!FiniteNonNegative(estimatedMargin) || estimatedMargin > Account.FreeMargin)
            {
                Block("INSUFFICIENT_FREE_MARGIN", "Estimated margin exceeds current free margin.");
                return;
            }

            var targetRaw = isBuy
                ? entryReference + TakeProfitR * stopDistancePrice
                : entryReference - TakeProfitR * stopDistancePrice;
            var target = RoundTargetOutward(targetRaw, Direction, symbol.TickSize);
            if (!FinitePositive(target) || !IsOnTickGrid(target, symbol.TickSize) ||
                (isBuy && target <= entryReference) || (!isBuy && target >= entryReference))
            {
                Block("TP_TARGET_INVALID", "The outward-rounded 5R target is invalid.");
                return;
            }
            var takeProfitDistancePips = Math.Abs(target - entryReference) / symbol.PipSize;
            if (!FinitePositive(takeProfitDistancePips))
            {
                Block("TP_DISTANCE_INVALID", "The initial protective target distance is invalid.");
                return;
            }

            Print("URM_DEMO|PREFLIGHT_PASS|symbol={0}|side={1}|bid={2}|ask={3}|tickSize={4}|tickAgeSeconds={5:F2}|spreadTicks={6:F1}",
                symbol.Name, Direction, F(bid), F(ask), F(symbol.TickSize), tickAgeSeconds, spreadTicks);
            Print("URM_DEMO|RISK|targetUsd={0:F2}|estimateUsd={1:F4}|currency={2}|depositRisk={3}|volumeUnits={4}|stop={5}|target5R={6}|margin={7}",
                TargetRiskUsd, estimatedRiskUsd, Account.Asset.Name, F(estimatedRiskDeposit), F(volume),
                F(StructuralStopPrice), F(target), F(estimatedMargin));

            if (!ConfirmOneShotDemoOrder)
            {
                Print("URM_DEMO|PREFLIGHT_ONLY|No order was sent. Explicitly set Confirm one-shot DEMO order=true only after checking these parameters.");
                Stop();
                return;
            }

            // Re-check Live status, connection, market and exposure immediately before submission.
            if (Account.IsLive || !Server.IsConnected || !symbol.MarketHours.IsOpened() ||
                Positions.Count != 0 || PendingOrders.Count != 0)
            {
                Block("PRE_SUBMIT_GUARD_FAILED", "Account/connection/market/exposure changed after preflight.");
                return;
            }

            // Encode the exact structural SL into a persistent position label.
            // The separate R-ladder manager refuses to manage positions with a different schema.
            string orderLabel;
            try { orderLabel = BuildPositionLabel(StructuralStopPrice, symbol.Digits); }
            catch (Exception ex)
            {
                Block("POSITION_LABEL_BUILD_FAILED", "Could not encode the structural SL in the position label: " + ex.GetType().Name);
                return;
            }

            // Initial relative protection is attached in the same order request.
            // After fill, replace it with the exact structural SL and fill-anchored 5R TP.
            TradeResult orderResult;
            try
            {
                orderResult = ExecuteMarketOrder(Direction, symbol.Name, volume, orderLabel,
                    stopDistancePips, takeProfitDistancePips, "URM Demo one-shot fixed USD 10 risk",
                    false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                Block("ORDER_CALL_EXCEPTION", "cTrader order request threw: " + ex.GetType().Name + ". Verify Trade Watch before retrying.");
                return;
            }
            if (orderResult == null || !orderResult.IsSuccessful || orderResult.Position == null)
            {
                Block("ORDER_REJECTED", "cTrader did not confirm the market order: " + (orderResult?.Error?.ToString() ?? "unknown result"));
                return;
            }

            var position = orderResult.Position;
            var fill = position.EntryPrice;
            var filledStopDistance = Math.Abs(fill - StructuralStopPrice);
            var filledStopPips = filledStopDistance / symbol.PipSize;
            var fillStopOnCorrectSide = (isBuy && StructuralStopPrice < fill) || (!isBuy && StructuralStopPrice > fill);
            if (!FinitePositive(fill) || !fillStopOnCorrectSide || !IsOnTickGrid(fill, symbol.TickSize) ||
                !FinitePositive(filledStopPips))
            {
                CloseAfterProtectionProblem(position, "FILL_INVALID_OR_STRUCTURAL_STOP_WRONG_SIDE");
                return;
            }

            var filledRiskDeposit = symbol.AmountRisked(position.VolumeInUnits, filledStopPips);
            double filledRiskUsd;
            try { filledRiskUsd = AssetConverter.Convert(filledRiskDeposit, Account.Asset.Name, "USD"); }
            catch
            {
                CloseAfterProtectionProblem(position, "FILLED_RISK_CONVERSION_FAILED");
                return;
            }
            if (!FiniteNonNegative(filledRiskUsd) || filledRiskUsd > TargetRiskUsd + RiskToleranceUsd)
            {
                CloseAfterProtectionProblem(position, "FILL_SLIPPAGE_PUSHED_ESTIMATED_RISK_OVER_USD_10");
                return;
            }

            var filledRDistance = Math.Abs(fill - StructuralStopPrice);
            var absoluteTarget = RoundTargetOutward(
                isBuy ? fill + TakeProfitR * filledRDistance : fill - TakeProfitR * filledRDistance,
                Direction, symbol.TickSize);
            if (!FinitePositive(absoluteTarget) || !IsOnTickGrid(absoluteTarget, symbol.TickSize) ||
                (isBuy && absoluteTarget <= fill) || (!isBuy && absoluteTarget >= fill))
            {
                CloseAfterProtectionProblem(position, "FILL_ANCHORED_TP_INVALID");
                return;
            }

            TradeResult protectionResult;
            try
            {
                protectionResult = ModifyPosition(position, StructuralStopPrice, absoluteTarget,
                    ProtectionType.Absolute, false, StopTriggerMethod.Trade);
            }
            catch (Exception ex)
            {
                CloseAfterProtectionProblem(position, "ABSOLUTE_PROTECTION_UPDATE_EXCEPTION_" + ex.GetType().Name);
                return;
            }
            if (protectionResult == null || !protectionResult.IsSuccessful)
            {
                CloseAfterProtectionProblem(position, "ABSOLUTE_PROTECTION_UPDATE_REJECTED");
                return;
            }

            var current = Positions.FindById(position.Id) ?? position;
            var tolerance = Math.Max(symbol.TickSize * 0.5, 1e-9);
            var slConfirmed = current.StopLoss.HasValue &&
                Math.Abs(current.StopLoss.Value - StructuralStopPrice) <= tolerance;
            var tpConfirmed = current.TakeProfit.HasValue &&
                Math.Abs(current.TakeProfit.Value - absoluteTarget) <= tolerance;
            if (!slConfirmed || !tpConfirmed)
            {
                CloseAfterProtectionProblem(position, "SERVER_PROTECTION_READBACK_MISMATCH");
                return;
            }

            Print("URM_DEMO|ORDER_PROTECTED|positionId={0}|fill={1}|volumeUnits={2}|sl={3}|tp5R={4}|estimatedRiskUsd={5:F4}|label={6}",
                position.Id, F(fill), F(position.VolumeInUnits), F(StructuralStopPrice), F(absoluteTarget), filledRiskUsd, orderLabel);
            Print("URM_DEMO|NOTE|ONE_SHOT_ONLY|DEMO_ONLY|PRICE_RISK_USD_10_TARGET|COMMISSION_EXCLUDED|NO_AUTO_RETRY");
            Stop();
        }

        private static string BuildPositionLabel(double structuralStop, int digits)
        {
            if (!FinitePositive(structuralStop) || digits < 0 || digits > 10)
                throw new ArgumentOutOfRangeException(nameof(structuralStop));

            var clientOrderId = "URM-" + Guid.NewGuid().ToString("N").ToUpperInvariant();
            var stopText = structuralStop.ToString("F" + digits, CultureInfo.InvariantCulture);
            if (!double.TryParse(stopText, NumberStyles.Float, CultureInfo.InvariantCulture, out var encodedStop) ||
                Math.Abs(encodedStop - structuralStop) > Math.Max(1e-10, Math.Pow(10, -digits) * 1e-6))
                throw new InvalidOperationException("Structural SL cannot be represented at the broker's displayed precision.");

            var label = "URM1|ID=" + clientOrderId + "|SL=" + stopText;
            if (label.Length > 100)
                throw new InvalidOperationException("Position label exceeds cTrader's 100-character limit.");
            return label;
        }

        private void CloseAfterProtectionProblem(Position position, string reason)
        {
            Print("URM_DEMO|CRITICAL|{0}|Attempting immediate close; initial relative protection was included in the order request.", reason);
            try
            {
                var closeResult = ClosePosition(position);
                if (closeResult != null && closeResult.IsSuccessful)
                    Print("URM_DEMO|CLOSED_AFTER_PROTECTION_PROBLEM|positionId={0}|reason={1}", position.Id, reason);
                else
                    Print("URM_DEMO|CRITICAL_CLOSE_FAILED|positionId={0}|reason={1}|error={2}|MANUAL_TRADE_WATCH_CHECK_REQUIRED",
                        position.Id, reason, closeResult?.Error?.ToString() ?? "unknown");
            }
            catch (Exception ex)
            {
                Print("URM_DEMO|CRITICAL_CLOSE_EXCEPTION|positionId={0}|reason={1}|errorType={2}|MANUAL_TRADE_WATCH_CHECK_REQUIRED",
                    position.Id, reason, ex.GetType().Name);
            }
            Stop();
        }

        private void Block(string code, string reason)
        {
            Print("URM_DEMO|BLOCK|{0}|{1}", code, reason);
            Stop();
        }

        private static double RoundTargetOutward(double price, TradeType side, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return double.NaN;
            var rawUnits = price / tickSize;
            var units = side == TradeType.Buy
                ? Math.Ceiling(rawUnits - 1e-10)
                : Math.Floor(rawUnits + 1e-10);
            return units * tickSize;
        }

        private static bool IsOnTickGrid(double price, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return false;
            var units = price / tickSize;
            return Math.Abs(units - Math.Round(units)) <= 1e-6;
        }

        private static bool FinitePositive(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value) && value > 0;
        }

        private static bool FiniteNonNegative(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value) && value >= 0;
        }

        private static string F(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value)
                ? value.ToString("R", CultureInfo.InvariantCulture)
                : "NA";
        }
    }
}
