// Read-only reporting helpers for TradeSenseExecutionEA. Included right after PostStatus().
// Nothing here opens, modifies or closes a trade; it only reads the account and reports it.

bool PostFilled(string orderId, int ticket, double filledQuantity)
  {
   double price = 0;
   if(OrderSelect(ticket, SELECT_BY_TICKET)) price = OrderOpenPrice();
   string payload = "{\"status\":\"filled\",\"agentId\":\"" + JsonEscape(AgentId) + "\",\"brokerOrderId\":\"" + IntegerToString(ticket) + "\",\"filledQuantity\":" + DoubleToString(filledQuantity, 8);
   if(price > 0) payload += ",\"averagePrice\":" + DoubleToString(price, 8);
   payload += "}";
   string response = "";
   int code = HttpPost(ServerBaseUrl + "/api/execution/agent/orders/" + orderId + "/status", payload, response);
   return code >= 200 && code < 300;
  }

// Realized result of positions closed since the start of the current server day (needs account history loaded in MT4).
double ClosedToday()
  {
   datetime dayStart = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
   double sum = 0;
   for(int i = OrdersHistoryTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      if(OrderType() != OP_BUY && OrderType() != OP_SELL) continue;
      if(OrderCloseTime() < dayStart) continue;
      sum += OrderProfit() + OrderSwap() + OrderCommission();
     }
   return sum;
  }

void ReportPositions()
  {
   if(StringLen(ExecutionToken) == 0 || StringLen(BrokerAccountId) == 0) return;
   string items = "";
   int total = OrdersTotal();
   int sent = 0;
   for(int i = 0; i < total && sent < 100; i++)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      int type = OrderType();
      if(type != OP_BUY && type != OP_SELL) continue;
      string sym = OrderSymbol();
      int digits = (int)MarketInfo(sym, MODE_DIGITS);
      if(digits < 0 || digits > 8) digits = 2;
      double current = MarketInfo(sym, type == OP_BUY ? MODE_BID : MODE_ASK);
      double profit = OrderProfit() + OrderSwap() + OrderCommission();
      string item = "{\"ticket\":\"" + IntegerToString(OrderTicket()) + "\"";
      item += ",\"symbol\":\"" + JsonEscape(sym) + "\"";
      item += ",\"side\":\"" + (type == OP_BUY ? "buy" : "sell") + "\"";
      item += ",\"lots\":" + DoubleToString(OrderLots(), 2);
      item += ",\"openPrice\":" + DoubleToString(OrderOpenPrice(), digits);
      if(current > 0) item += ",\"currentPrice\":" + DoubleToString(current, digits);
      if(OrderStopLoss() > 0) item += ",\"stopLoss\":" + DoubleToString(OrderStopLoss(), digits);
      if(OrderTakeProfit() > 0) item += ",\"takeProfit\":" + DoubleToString(OrderTakeProfit(), digits);
      item += ",\"profit\":" + DoubleToString(profit, 2);
      item += ",\"minLot\":" + DoubleToString(MarketInfo(sym, MODE_MINLOT), 4);
      item += ",\"lotStep\":" + DoubleToString(MarketInfo(sym, MODE_LOTSTEP), 4);
      item += ",\"openedAt\":\"" + TimeToString(OrderOpenTime(), TIME_DATE | TIME_SECONDS) + "\"";
      item += ",\"managed\":" + (OrderMagicNumber() == MagicNumber ? "true" : "false") + "}";
      if(sent > 0) items += ",";
      items += item;
      sent++;
     }
   string payload = "{\"accountId\":\"" + JsonEscape(BrokerAccountId) + "\",\"isDemo\":" + (IsDemo() ? "true" : "false");
   payload += ",\"currency\":\"" + JsonEscape(AccountCurrency()) + "\"";
   payload += ",\"balance\":" + DoubleToString(AccountBalance(), 2);
   payload += ",\"equity\":" + DoubleToString(AccountEquity(), 2);
   payload += ",\"profit\":" + DoubleToString(AccountProfit(), 2);
   payload += ",\"closedToday\":" + DoubleToString(ClosedToday(), 2);
   payload += ",\"positions\":[" + items + "]}";
   string response = "";
   int code = HttpPost(ServerBaseUrl + "/api/execution/agent/positions", payload, response);
   if(code < 200 || code >= 300) PrintFormat("TradeSense: positions report returned HTTP %d.", code);
  }
