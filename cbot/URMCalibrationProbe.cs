// URM Stage G — Demo-only, read-only cTrader Algo calibration probe.
// It DOES NOT submit, modify, close, or cancel trades.
// Paste this file into a new cBot in cTrader Automate and compile there.
// Local source review cannot substitute for compilation against the installed cAlgo API.

using System;
using System.Globalization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class URMCalibrationProbe : Robot
    {
        private const double TargetRiskUsd = 10.0;
        private const double RiskToleranceUsd = 0.01;

        [Parameter("Symbol to inspect", DefaultValue = "XAUUSD")]
        public string ProbeSymbolName { get; set; }

        [Parameter("Side for sizing preview (BUY/SELL)", DefaultValue = "BUY")]
        public string SideForSizing { get; set; }

        [Parameter("Structural SL price (0 = skip sizing)", DefaultValue = 0.0, MinValue = 0.0)]
        public double StructuralStopPrice { get; set; }

        protected override void OnStart()
        {
            var snapshotId = Guid.NewGuid().ToString("N");
            var startUtc = Server.TimeInUtc;

            // Guard against accidentally running diagnostics on a live account.
            if (Account.IsLive)
            {
                Print("URM_CAL_V1|BLOCK|LIVE_ACCOUNT_NOT_ALLOWED");
                Stop();
                return;
            }

            if (!Server.IsConnected)
            {
                Print("URM_CAL_V1|BLOCK|SERVER_DISCONNECTED");
                Stop();
                return;
            }

            Symbol probeSymbol;
            try
            {
                probeSymbol = Symbols.GetSymbol((ProbeSymbolName ?? string.Empty).Trim());
            }
            catch (Exception ex)
            {
                Print("URM_CAL_V1|BLOCK|SYMBOL_LOOKUP_FAILED|{0}", Encode(ex.GetType().Name));
                Stop();
                return;
            }

            if (probeSymbol == null)
            {
                Print("URM_CAL_V1|BLOCK|SYMBOL_NOT_FOUND|{0}", Encode(ProbeSymbolName));
                Stop();
                return;
            }

            var side = ParseSide(SideForSizing);
            var snapshotTime = startUtc.ToString("O", CultureInfo.InvariantCulture);
            var rawBrokerName = Account.BrokerName ?? "NA";
            var rawAccountNumber = Account.Number.ToString(CultureInfo.InvariantCulture);
            var rawCurrency = (Account.Asset == null ? "" : Account.Asset.Name ?? "").Trim().ToUpperInvariant();
            var initialAccountType = Account.AccountType.ToString();
            var initialIsLive = Account.IsLive;
            var broker = Encode(rawBrokerName);
            var maskedAccount = MaskAccount(rawAccountNumber);
            var currency = rawCurrency;

            Print("URM_CAL_V1|BEGIN|{0}", snapshotId);
            Emit("META", snapshotId, snapshotTime, broker, maskedAccount, currency,
                initialIsLive.ToString().ToLowerInvariant(), Encode(initialAccountType),
                F(Account.Balance), F(Account.Equity), FSigned(Account.FreeMargin),
                Server.IsConnected.ToString().ToLowerInvariant());

            Emit("SYMBOL", snapshotId, Encode(probeSymbol.Name), F(probeSymbol.Digits),
                F(probeSymbol.TickSize), F(probeSymbol.PipSize), F(probeSymbol.PipValue),
                F(probeSymbol.TickValue), F(probeSymbol.LotSize), F(probeSymbol.VolumeInUnitsMin),
                F(probeSymbol.VolumeInUnitsStep), F(probeSymbol.VolumeInUnitsMax),
                F(probeSymbol.Bid), F(probeSymbol.Ask), F(probeSymbol.Spread),
                SafeMarketOpen(probeSymbol));

            EmitRiskPreview(snapshotId, probeSymbol, side);

            var positionCount = 0;
            foreach (var position in Positions)
            {
                positionCount++;
                var positionSymbol = SafeGetSymbol(position.SymbolName);
                var margin = positionSymbol == null ? "NA" : SafeMargin(positionSymbol, position.TradeType, position.VolumeInUnits);
                Emit("POSITION", snapshotId, position.Id.ToString(CultureInfo.InvariantCulture),
                    Encode(position.SymbolName), position.TradeType.ToString().ToUpperInvariant(),
                    F(position.VolumeInUnits), F(position.EntryPrice), F(position.StopLoss),
                    F(position.TakeProfit), IsUrmLabel(position.Label), margin);
            }

            var pendingCount = 0;
            foreach (var order in PendingOrders)
            {
                pendingCount++;
                var orderSymbol = SafeGetSymbol(order.SymbolName);
                var margin = orderSymbol == null ? "NA" : SafeMargin(orderSymbol, order.TradeType, order.VolumeInUnits);
                Emit("PENDING", snapshotId, order.Id.ToString(CultureInfo.InvariantCulture),
                    Encode(order.SymbolName), order.TradeType.ToString().ToUpperInvariant(),
                    Encode(order.OrderType.ToString().ToUpperInvariant()), F(order.VolumeInUnits),
                    F(order.TargetPrice), F(order.StopLossPips), F(order.TakeProfitPips),
                    IsUrmLabel(order.Label), margin);
            }

            // The cBot snapshot is not an atomic server transaction. Refuse to
            // emit a parseable END if connection or account identity changed mid-run.
            var currentCurrency = (Account.Asset == null ? "" : Account.Asset.Name ?? "").Trim().ToUpperInvariant();
            var accountChanged = !string.Equals(rawBrokerName, Account.BrokerName ?? "NA", StringComparison.Ordinal) ||
                !string.Equals(rawAccountNumber, Account.Number.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal) ||
                !string.Equals(rawCurrency, currentCurrency, StringComparison.Ordinal) ||
                !string.Equals(initialAccountType, Account.AccountType.ToString(), StringComparison.Ordinal) ||
                initialIsLive != Account.IsLive;
            if (!Server.IsConnected || accountChanged)
            {
                Print("URM_CAL_V1|BLOCK|{0}|{1}", snapshotId, accountChanged ? "ACCOUNT_CONTEXT_CHANGED_DURING_SNAPSHOT" : "SERVER_DISCONNECTED_DURING_SNAPSHOT");
                Stop();
                return;
            }

            Emit("END", snapshotId, Server.TimeInUtc.ToString("O", CultureInfo.InvariantCulture),
                positionCount.ToString(CultureInfo.InvariantCulture), pendingCount.ToString(CultureInfo.InvariantCulture));
            Print("URM_CAL_V1|NOTE|{0}|DIAGNOSTIC_ONLY|NOT_AUTHENTICATED|EXECUTION_DISABLED", snapshotId);
            Stop();
        }

        private void EmitRiskPreview(string snapshotId, Symbol symbol, TradeType? side)
        {
            var entryReference = side.HasValue
                ? (side.Value == TradeType.Buy ? symbol.Ask : symbol.Bid)
                : double.NaN;
            var stop = StructuralStopPrice;

            double budgetInDeposit;
            try
            {
                budgetInDeposit = ConvertMoney(TargetRiskUsd, "USD", Account.Asset.Name);
            }
            catch (Exception ex)
            {
                Emit("RISK", snapshotId, side.HasValue ? side.Value.ToString().ToUpperInvariant() : "INVALID",
                    F(stop), F(entryReference), "NA", F(TargetRiskUsd), "NA", "NA", "NA", "NA", "NA", "NA",
                    "BLOCK_FX_CONVERSION_FAILED_" + ex.GetType().Name.ToUpperInvariant());
                return;
            }

            if (!FinitePositive(budgetInDeposit))
            {
                Emit("RISK", snapshotId, side.HasValue ? side.Value.ToString().ToUpperInvariant() : "INVALID",
                    F(stop), F(entryReference), "NA", F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA",
                    "BLOCK_FX_CONVERSION_INVALID");
                return;
            }

            if (!side.HasValue)
            {
                Emit("RISK", snapshotId, "INVALID", F(stop), F(entryReference), "NA", F(TargetRiskUsd), F(budgetInDeposit),
                    "NA", "NA", "NA", "NA", "NA", "BLOCK_SIDE_INVALID");
                return;
            }

            if (!FinitePositive(stop))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), "NA",
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "SKIPPED_NO_STOP_PRICE");
                return;
            }

            if (!FinitePositive(symbol.PipSize) || !FinitePositive(symbol.TickSize) || !FinitePositive(entryReference) || !FinitePositive(symbol.Bid) || !FinitePositive(symbol.Ask))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), "NA",
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "BLOCK_INVALID_QUOTE_PIP_OR_TICK_SIZE");
                return;
            }

            if (!IsOnTickGrid(stop, symbol.TickSize))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), "NA",
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "BLOCK_STOP_OFF_TICK_GRID");
                return;
            }

            if (!IsOnTickGrid(entryReference, symbol.TickSize) || !IsOnTickGrid(symbol.Bid, symbol.TickSize) || !IsOnTickGrid(symbol.Ask, symbol.TickSize))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), "NA",
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "BLOCK_QUOTE_OFF_TICK_GRID");
                return;
            }

            var isBuy = side.Value == TradeType.Buy;
            if ((isBuy && stop >= entryReference) || (!isBuy && stop <= entryReference))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), "NA",
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "BLOCK_STOP_WRONG_SIDE");
                return;
            }

            var stopDistancePips = Math.Abs(entryReference - stop) / symbol.PipSize;
            if (!FinitePositive(stopDistancePips))
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), F(stopDistancePips),
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA", "BLOCK_STOP_DISTANCE_INVALID");
                return;
            }

            double rawVolume;
            double normalizedVolume;
            double riskDeposit;
            double riskUsd;
            double margin;
            string status;
            try
            {
                rawVolume = symbol.VolumeForFixedRisk(budgetInDeposit, stopDistancePips, RoundingMode.Down);
                if (!FinitePositive(rawVolume))
                {
                    Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), F(stopDistancePips),
                        F(TargetRiskUsd), F(budgetInDeposit), F(rawVolume), "NA", "NA", "NA", "NA", "BLOCK_VOLUME_FOR_FIXED_RISK_INVALID");
                    return;
                }

                normalizedVolume = symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);
                status = "READY_DIAGNOSTIC_PREVIEW";
                if (!FinitePositive(normalizedVolume)) status = "BLOCK_NORMALIZED_VOLUME_INVALID";

                if (normalizedVolume > symbol.VolumeInUnitsMax && FinitePositive(symbol.VolumeInUnitsMax))
                {
                    normalizedVolume = symbol.NormalizeVolumeInUnits(symbol.VolumeInUnitsMax, RoundingMode.Down);
                    status = "CAPPED_TO_SYMBOL_MAX_DIAGNOSTIC_ONLY";
                }

                if (normalizedVolume < symbol.VolumeInUnitsMin || normalizedVolume > symbol.VolumeInUnitsMax)
                    status = "BLOCK_MIN_MAX_VOLUME";

                if (!FinitePositive(normalizedVolume) || status == "BLOCK_MIN_MAX_VOLUME" || status == "BLOCK_NORMALIZED_VOLUME_INVALID")
                {
                    Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), F(stopDistancePips),
                        F(TargetRiskUsd), F(budgetInDeposit), F(rawVolume), F(normalizedVolume), "NA", "NA", "NA", status);
                    return;
                }

                riskDeposit = symbol.AmountRisked(normalizedVolume, stopDistancePips);
                riskUsd = ConvertMoney(riskDeposit, Account.Asset.Name, "USD");
                margin = symbol.GetEstimatedMargin(side.Value, normalizedVolume);

                if (!FiniteNonNegative(riskDeposit) || !FiniteNonNegative(riskUsd))
                    status = "BLOCK_ESTIMATED_RISK_INVALID";
                else if (riskUsd > TargetRiskUsd + RiskToleranceUsd)
                    status = "BLOCK_ESTIMATED_RISK_OVER_USD_10_TARGET";

                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), F(stopDistancePips),
                    F(TargetRiskUsd), F(budgetInDeposit), F(rawVolume), F(normalizedVolume), F(riskDeposit), F(riskUsd), F(margin), status);
            }
            catch (Exception ex)
            {
                Emit("RISK", snapshotId, side.Value.ToString().ToUpperInvariant(), F(stop), F(entryReference), F(stopDistancePips),
                    F(TargetRiskUsd), F(budgetInDeposit), "NA", "NA", "NA", "NA", "NA",
                    "BLOCK_PLATFORM_CALCULATION_FAILED_" + ex.GetType().Name.ToUpperInvariant());
            }
        }

        private double ConvertMoney(double amount, string fromCurrency, string toCurrency)
        {
            if (!FiniteNonNegative(amount)) throw new ArgumentOutOfRangeException("amount");
            if (string.Equals(fromCurrency, toCurrency, StringComparison.OrdinalIgnoreCase)) return amount;
            return AssetConverter.Convert(amount, fromCurrency, toCurrency);
        }

        private Symbol SafeGetSymbol(string name)
        {
            try { return Symbols.GetSymbol(name); }
            catch { return null; }
        }

        private string SafeMargin(Symbol symbol, TradeType tradeType, double volume)
        {
            try
            {
                var amount = symbol.GetEstimatedMargin(tradeType, volume);
                return FiniteNonNegative(amount) ? F(amount) : "NA";
            }
            catch { return "NA"; }
        }

        private string SafeMarketOpen(Symbol symbol)
        {
            try { return symbol.MarketHours.IsOpened().ToString().ToLowerInvariant(); }
            catch { return "NA"; }
        }

        private static TradeType? ParseSide(string raw)
        {
            if (string.Equals((raw ?? string.Empty).Trim(), "BUY", StringComparison.OrdinalIgnoreCase)) return TradeType.Buy;
            if (string.Equals((raw ?? string.Empty).Trim(), "SELL", StringComparison.OrdinalIgnoreCase)) return TradeType.Sell;
            return null;
        }

        private static string IsUrmLabel(string label)
        {
            return !string.IsNullOrEmpty(label) && label.StartsWith("URM", StringComparison.OrdinalIgnoreCase) ? "true" : "false";
        }

        private static string MaskAccount(string value)
        {
            if (string.IsNullOrEmpty(value)) return "NA";
            if (value.Length <= 3) return new string('*', value.Length);
            return new string('*', value.Length - 3) + value.Substring(value.Length - 3);
        }

        private static bool IsOnTickGrid(double price, double tickSize)
        {
            if (!FinitePositive(price) || !FinitePositive(tickSize)) return false;
            var nearestTick = Math.Round(price / tickSize, MidpointRounding.AwayFromZero);
            var snappedPrice = nearestTick * tickSize;
            var tolerance = Math.Max(tickSize * 1e-6, Math.Abs(price) * 1e-12);
            return Math.Abs(price - snappedPrice) <= tolerance;
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
            return FiniteNonNegative(value) ? value.ToString("R", CultureInfo.InvariantCulture) : "NA";
        }

        private static string F(double? value)
        {
            return value.HasValue ? F(value.Value) : "NA";
        }

        private static string FSigned(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value)
                ? value.ToString("R", CultureInfo.InvariantCulture)
                : "NA";
        }

        private static string Encode(string value)
        {
            return Uri.EscapeDataString(value ?? "NA");
        }

        private void Emit(string type, params string[] fields)
        {
            var all = new string[fields.Length + 2];
            all[0] = "URM_CAL_V1";
            all[1] = type;
            Array.Copy(fields, 0, all, 2, fields.Length);
            Print("{0}", string.Join("|", all));
        }
    }
}
