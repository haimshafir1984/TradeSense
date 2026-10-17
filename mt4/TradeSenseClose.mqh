// Position commands from the server: close, partial_close and modify_stop. Runs only when EnableExecution is on
// and the account is demo. Which positions may be touched is decided by the server (dashboard clicks may target any
// position of the account, automatic commands only TradeSense-managed ones). Nothing here opens a trade.

string CloseKey(string requestId)
  {
   return "TradeSense.close." + IntegerToString(AccountNumber()) + "." + requestId;
  }

bool PostCloseStatus(string requestId, string status, string errorText, double closePrice, int remainingTicket)
  {
   string payload = "{\"status\":\"" + status + "\"";
   if(StringLen(errorText) > 0) payload += ",\"error\":\"" + JsonEscape(errorText) + "\"";
   if(closePrice > 0) payload += ",\"closePrice\":" + DoubleToString(closePrice, 8);
   if(remainingTicket > 0) payload += ",\"remainingTicket\":\"" + IntegerToString(remainingTicket) + "\"";
   payload += "}";
   string response = "";
   int code = HttpPost(ServerBaseUrl + "/api/execution/agent/close-requests/" + requestId + "/status", payload, response);
   return code >= 200 && code < 300;
  }

void RejectClose(string requestId, string reason)
  {
   PostCloseStatus(requestId, "rejected", reason, 0, 0);
  }

bool AmbiguousError(int errorCode)
  {
   return errorCode == 4 || errorCode == 128 || errorCode == 129 || errorCode == 135 || errorCode == 136 || errorCode == 137 || errorCode == 138 || errorCode == 146;
  }

// After a partial close MT4 keeps the remaining quantity under a NEW ticket whose comment says "from #<old ticket>".
int FindRemainingTicket(int oldTicket, string sym, int type)
  {
   string marker = "from #" + IntegerToString(oldTicket);
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderSymbol() != sym || OrderType() != type) continue;
      if(StringFind(OrderComment(), marker) >= 0) return OrderTicket();
     }
   return 0;
  }

void ProcessCloseObject(string objectJson)
  {
   string requestId, ticketText, commandType = "close";
   if(!JsonString(objectJson, "id", 0, requestId)) return;
   if(GlobalVariableCheck(CloseKey(requestId))) return;
   if(!JsonString(objectJson, "ticket", 0, ticketText)) return;
   JsonString(objectJson, "type", 0, commandType);
   double lotsRequested = 0, newStop = 0;
   JsonNumber(objectJson, "lots", 0, lotsRequested);
   JsonNumber(objectJson, "stopLoss", 0, newStop);
   if(!PostCloseStatus(requestId, "claimed", "", 0, 0)) return;
   GlobalVariableSet(CloseKey(requestId), 1);
   int ticket = (int)StringToInteger(ticketText);
   if(ticket <= 0 || !OrderSelect(ticket, SELECT_BY_TICKET)) { RejectClose(requestId, "position_not_found"); return; }
   if(OrderCloseTime() != 0) { RejectClose(requestId, "already_closed"); return; }
   int type = OrderType();
   if(type != OP_BUY && type != OP_SELL) { RejectClose(requestId, "not_an_open_market_position"); return; }
   string sym = OrderSymbol();
   double positionLots = OrderLots();
   int digits = (int)MarketInfo(sym, MODE_DIGITS);
   double point = MarketInfo(sym, MODE_POINT);
   double bid = MarketInfo(sym, MODE_BID);
   double ask = MarketInfo(sym, MODE_ASK);
   double price = type == OP_BUY ? bid : ask;
   if(price <= 0) { RejectClose(requestId, "market_price_unavailable"); return; }
   price = NormalizeDouble(price, digits);

   if(commandType == "modify_stop")
     {
      if(newStop <= 0) { RejectClose(requestId, "invalid_stop"); return; }
      newStop = NormalizeDouble(newStop, digits);
      double stopLevel = MarketInfo(sym, MODE_STOPLEVEL) * point;
      if(type == OP_BUY && (newStop >= bid || (bid - newStop) < stopLevel)) { RejectClose(requestId, "stop_not_valid_for_market"); return; }
      if(type == OP_SELL && (newStop <= ask || (newStop - ask) < stopLevel)) { RejectClose(requestId, "stop_not_valid_for_market"); return; }
      ResetLastError();
      if(!OrderModify(ticket, OrderOpenPrice(), newStop, OrderTakeProfit(), 0, clrNONE))
        {
         int modifyError = GetLastError();
         if(AmbiguousError(modifyError)) PostCloseStatus(requestId, "unknown", "order_modify_ambiguous_" + IntegerToString(modifyError), 0, 0);
         else RejectClose(requestId, "order_modify_rejected_" + IntegerToString(modifyError));
         return;
        }
      if(OrderSelect(ticket, SELECT_BY_TICKET) && MathAbs(OrderStopLoss() - newStop) > point / 2)
        { PostCloseStatus(requestId, "unknown", "stop_not_confirmed_by_mt4", 0, 0); return; }
      if(!PostCloseStatus(requestId, "closed", "", 0, 0)) Print("TradeSense: stop was modified but the report to the server failed.");
      return;
     }

   double lots = positionLots;
   if(commandType == "partial_close")
     {
      double minLot = MarketInfo(sym, MODE_MINLOT);
      double lotStep = MarketInfo(sym, MODE_LOTSTEP);
      if(minLot <= 0 || lotStep <= 0) { RejectClose(requestId, "contract_spec_unavailable"); return; }
      if(lotsRequested < minLot || lotsRequested >= positionLots) { RejectClose(requestId, "partial_quantity_invalid"); return; }
      if(MathAbs(lotsRequested / lotStep - MathRound(lotsRequested / lotStep)) > 0.000001) { RejectClose(requestId, "quantity_not_on_lot_step"); return; }
      if(positionLots - lotsRequested < minLot) { RejectClose(requestId, "remainder_below_min_lot"); return; }
      lots = lotsRequested;
     }
   ResetLastError();
   bool closed = OrderClose(ticket, lots, price, SlippagePoints, clrOrange);
   if(!closed)
     {
      int errorCode = GetLastError();
      if(AmbiguousError(errorCode)) PostCloseStatus(requestId, "unknown", "order_close_ambiguous_" + IntegerToString(errorCode), 0, 0);
      else RejectClose(requestId, "order_close_rejected_" + IntegerToString(errorCode));
      return;
     }
   double closePrice = price;
   if(OrderSelect(ticket, SELECT_BY_TICKET)) closePrice = OrderClosePrice();
   int remaining = 0;
   if(commandType == "partial_close") remaining = FindRemainingTicket(ticket, sym, type);
   if(!PostCloseStatus(requestId, "closed", "", closePrice, remaining)) Print("TradeSense: close succeeded but the report to the server failed.");
  }

void PollCloseRequests()
  {
   string body = "";
   int code = HttpGet(ServerBaseUrl + "/api/execution/agent/close-requests?accountId=" + BrokerAccountId, body);
   if(code < 200 || code >= 300) return;
   int cursor = StringFind(body, "\"requests\":[");
   if(cursor < 0) return;
   cursor += StringLen("\"requests\":[");
   while(cursor < StringLen(body))
     {
      int start = StringFind(body, "{", cursor);
      if(start < 0) break;
      int end = ObjectEnd(body, start);
      if(end < 0) break;
      ProcessCloseObject(StringSubstr(body, start, end - start + 1));
      cursor = end + 1;
     }
  }
