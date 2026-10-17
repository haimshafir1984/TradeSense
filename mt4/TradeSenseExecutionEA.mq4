#property strict
#property version   "1.000"
#property description "TradeSense execution bridge. Dry-run by default; demo accounts only."

// ServerBaseUrl must not contain a port: MT4 WebRequest only allows 80/443 (see mt4/tools/port80-forwarder.mjs).
input string ServerBaseUrl = "http://127.0.0.1";
input string ExecutionToken = "";
input string BrokerAccountId = "";
input string AgentId = "mt4-ea-1";
input bool EnableExecution = false;
input bool PollInDryRun = true;
input bool RequireStopLoss = true;
input int PollSeconds = 15;
input int MaxOpenPositions = 3;
input int SlippagePoints = 20;
input int MagicNumber = 240014;
input bool AllowSellOrders = true;
// Appended to the server symbol when it does not already end with it (the server rejects "#": e.g. "Apple" -> "Apple#").
input string SymbolSuffix = "#";

string BrokerSymbol(string serverSymbol)
  {
   int suffixLen = StringLen(SymbolSuffix);
   int len = StringLen(serverSymbol);
   if(suffixLen == 0 || len == 0) return serverSymbol;
   if(len >= suffixLen && StringSubstr(serverSymbol, len - suffixLen) == SymbolSuffix) return serverSymbol;
   return serverSymbol + SymbolSuffix;
  }

string QueueUrl()
  {
   return ServerBaseUrl + "/api/execution/agent/orders?accountId=" + BrokerAccountId;
  }

string JsonEscape(string value)
  {
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
  }

string LocalKey(string orderId)
  {
   // UUIDs are short enough for MT4 Global Variables and remain stable across restarts.
   return "TradeSense.order." + IntegerToString(AccountNumber()) + "." + orderId;
  }

bool AlreadyHandled(string orderId)
  {
   return GlobalVariableCheck(LocalKey(orderId));
  }

void MarkHandled(string orderId, double state)
  {
   GlobalVariableSet(LocalKey(orderId), state);
  }

bool DemoExecutionAllowed()
  {
   if(!EnableExecution) return false;
   if(StringLen(ExecutionToken) == 0 || StringLen(BrokerAccountId) == 0)
     {
      Print("TradeSense: execution disabled; token and BrokerAccountId are required.");
      return false;
     }
   if(!IsDemo())
     {
      Print("TradeSense: execution blocked because this is not a demo account.");
      return false;
     }
   return true;
  }

string Headers()
  {
   return "Content-Type: application/json\r\nX-Execution-Agent-Token: " + ExecutionToken + "\r\n";
  }

int HttpGet(string url, string &body)
  {
   char request[];
   char response[];
   string responseHeaders = "";
   ResetLastError();
   int code = WebRequest("GET", url, Headers(), 5000, request, response, responseHeaders);
   if(code < 0)
     {
      int errorCode = GetLastError();
      PrintFormat("TradeSense: GET request URL=[%s] length=%d failed (%d).", url, StringLen(url), errorCode);
      return -1;
     }
   body = CharArrayToString(response, 0, ArraySize(response), CP_UTF8);
   return code;
  }

int HttpPost(string url, string payload, string &body)
  {
   char request[];
   char response[];
   string responseHeaders = "";
   int bytes = StringToCharArray(payload, request, 0, WHOLE_ARRAY, CP_UTF8);
   if(bytes > 0) ArrayResize(request, bytes - 1);
   ResetLastError();
   int code = WebRequest("POST", url, Headers(), 5000, request, response, responseHeaders);
   if(code < 0)
     {
      int errorCode = GetLastError();
      PrintFormat("TradeSense: POST request URL=[%s] length=%d failed (%d).", url, StringLen(url), errorCode);
      return -1;
     }
   body = CharArrayToString(response, 0, ArraySize(response), CP_UTF8);
   return code;
  }

bool JsonString(string json, string key, int from, string &value)
  {
   string needle = "\"" + key + "\":\"";
   int start = StringFind(json, needle, from);
   if(start < 0) return false;
   start += StringLen(needle);
   int end = start;
   while(end < StringLen(json))
     {
      if(StringGetCharacter(json, end) == 34 && (end == start || StringGetCharacter(json, end - 1) != 92)) break;
      end++;
     }
   if(end >= StringLen(json)) return false;
   value = StringSubstr(json, start, end - start);
   return true;
  }

bool JsonNumber(string json, string key, int from, double &value)
  {
   string needle = "\"" + key + "\":";
   int start = StringFind(json, needle, from);
   if(start < 0) return false;
   start += StringLen(needle);
   int end = start;
   while(end < StringLen(json))
     {
      int c = StringGetCharacter(json, end);
      if(c == 44 || c == 125 || c == 93) break;
      end++;
     }
   string text = StringSubstr(json, start, end - start);
   StringTrimLeft(text);
   StringTrimRight(text);
   if(StringLen(text) == 0 || text == "null") return false;
   value = StringToDouble(text);
   return MathIsValidNumber(value);
  }

int ObjectEnd(string json, int start)
  {
   int depth = 0;
   bool quoted = false;
   for(int i = start; i < StringLen(json); i++)
     {
      int c = StringGetCharacter(json, i);
      if(c == 34 && (i == 0 || StringGetCharacter(json, i - 1) != 92)) quoted = !quoted;
      if(quoted) continue;
      if(c == 123) depth++;
      if(c == 125)
        {
         depth--;
         if(depth == 0) return i;
        }
     }
   return -1;
  }

int OpenPositions()
  {
   int count = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
       if(OrderMagicNumber() == MagicNumber && (OrderType() == OP_BUY || OrderType() == OP_SELL)) count++;
   return count;
  }

bool ValidTradeInputs(string symbol, string side, double quantity, double stopLoss, double takeProfit, string &reason)
  {
   if(StringLen(symbol) == 0 || StringLen(symbol) > 32) { reason = "invalid_symbol"; return false; }
   if(side != "buy" && side != "sell") { reason = "invalid_side"; return false; }
   if(side == "sell" && !AllowSellOrders) { reason = "sell_disabled"; return false; }
   if(quantity <= 0 || !MathIsValidNumber(quantity)) { reason = "invalid_quantity"; return false; }
   if(OpenPositions() >= MaxOpenPositions) { reason = "max_positions"; return false; }
   if(RequireStopLoss && stopLoss <= 0) { reason = "stop_loss_required"; return false; }
   double minLot = MarketInfo(symbol, MODE_MINLOT);
   double maxLot = MarketInfo(symbol, MODE_MAXLOT);
   double lotStep = MarketInfo(symbol, MODE_LOTSTEP);
   if(minLot <= 0 || maxLot <= 0 || lotStep <= 0) { reason = "contract_spec_unavailable"; return false; }
   if(quantity < minLot || quantity > maxLot) { reason = "quantity_outside_contract_limits"; return false; }
   double steps = quantity / lotStep;
   if(MathAbs(steps - MathRound(steps)) > 0.000001) { reason = "quantity_not_on_lot_step"; return false; }
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick) || tick.bid <= 0 || tick.ask <= 0) { reason = "market_price_unavailable"; return false; }
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   double point = MarketInfo(symbol, MODE_POINT);
   int stopLevel = (int)MarketInfo(symbol, MODE_STOPLEVEL);
   if(stopLoss > 0)
     {
      if(side == "buy" && stopLoss >= tick.ask) { reason = "buy_stop_not_below_market"; return false; }
      if(side == "sell" && stopLoss <= tick.bid) { reason = "sell_stop_not_above_market"; return false; }
      if(point <= 0 || (side == "buy" && (tick.ask - stopLoss) < stopLevel * point) || (side == "sell" && (stopLoss - tick.bid) < stopLevel * point))
        { reason = "stop_distance_too_small"; return false; }
     }
   if(takeProfit > 0)
     {
      if(side == "buy" && takeProfit <= tick.ask) { reason = "buy_target_not_above_market"; return false; }
      if(side == "sell" && takeProfit >= tick.bid) { reason = "sell_target_not_below_market"; return false; }
     }
   return true;
  }

bool PostStatus(string orderId, string status, string errorText, int ticket, double filledQuantity)
  {
   string brokerId = ticket > 0 ? IntegerToString(ticket) : "";
   string payload = "{\"status\":\"" + status + "\",\"agentId\":\"" + JsonEscape(AgentId) + "\"";
   if(StringLen(errorText) > 0) payload += ",\"error\":\"" + JsonEscape(errorText) + "\"";
   if(ticket > 0) payload += ",\"brokerOrderId\":\"" + brokerId + "\"";
   if(filledQuantity > 0) payload += ",\"filledQuantity\":" + DoubleToString(filledQuantity, 8);
   payload += "}";
   string response = "";
   int code = HttpPost(ServerBaseUrl + "/api/execution/agent/orders/" + orderId + "/status", payload, response);
   return code >= 200 && code < 300;
  }

#include "TradeSensePositions.mqh"
#include "TradeSenseClose.mqh"
void ReportHeartbeat()
  {
   if(StringLen(ExecutionToken) == 0 || StringLen(BrokerAccountId) == 0) return;
   string payload = "{\"agentId\":\"" + JsonEscape(AgentId) + "\",\"accountId\":\"" + JsonEscape(BrokerAccountId) + "\",\"isDemo\":" + (IsDemo() ? "true" : "false") + "}";
   string response = "";
   int code = HttpPost(ServerBaseUrl + "/api/execution/agent/heartbeat", payload, response);
   if(code < 200 || code >= 300) PrintFormat("TradeSense: heartbeat returned HTTP %d.", code);
  }

void Reject(string orderId, string reason)
  {
   if(PostStatus(orderId, "rejected", reason, -1, 0)) MarkHandled(orderId, 3);
   else MarkHandled(orderId, 9);
  }

void ExecuteObject(string objectJson)
  {
   string orderId, symbol, side;
   double quantity, stopLoss, takeProfit;
   if(!JsonString(objectJson, "id", 0, orderId) || AlreadyHandled(orderId)) return;
   if(!JsonString(objectJson, "symbol", 0, symbol) || !JsonString(objectJson, "side", 0, side) || !JsonNumber(objectJson, "quantity", 0, quantity))
     { Reject(orderId, "malformed_order"); return; }
      symbol = BrokerSymbol(symbol);
   SymbolSelect(symbol, true);
stopLoss = 0; takeProfit = 0;
   JsonNumber(objectJson, "stopLoss", 0, stopLoss);
   JsonNumber(objectJson, "takeProfit", 0, takeProfit);
   if(!PostStatus(orderId, "claimed", "", -1, 0)) return;
   string reason = "";
   if(!ValidTradeInputs(symbol, side, quantity, stopLoss, takeProfit, reason)) { Reject(orderId, reason); return; }
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) { Reject(orderId, "symbol_not_available"); return; }
   int type = side == "buy" ? OP_BUY : OP_SELL;
   double price = type == OP_BUY ? tick.ask : tick.bid;
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   price = NormalizeDouble(price, digits);
   stopLoss = stopLoss > 0 ? NormalizeDouble(stopLoss, digits) : 0;
   takeProfit = takeProfit > 0 ? NormalizeDouble(takeProfit, digits) : 0;
   ResetLastError();
   int ticket = OrderSend(symbol, type, quantity, price, SlippagePoints, stopLoss, takeProfit, "TradeSense", MagicNumber, 0, clrDodgerBlue);
   if(ticket < 0)
     {
      int errorCode = GetLastError();
      // A timeout, busy context or lost connection can hide whether the broker accepted the order.
      if(errorCode == 4 || errorCode == 128 || errorCode == 129 || errorCode == 135 || errorCode == 136 || errorCode == 137 || errorCode == 138 || errorCode == 146)
        {
         if(!PostStatus(orderId, "unknown", "order_send_ambiguous_" + IntegerToString(errorCode), -1, 0)) Print("TradeSense: unable to report unknown order state.");
         MarkHandled(orderId, 9);
        }
      else Reject(orderId, "order_send_rejected_" + IntegerToString(errorCode));
      return;
     }
   MarkHandled(orderId, 2);
   if(!PostStatus(orderId, "submitted", "", ticket, 0))
     {
      PostStatus(orderId, "unknown", "submitted_report_failed", ticket, 0);
      return;
     }
      if(PostFilled(orderId, ticket, quantity)) MarkHandled(orderId, 1);
   else PostStatus(orderId, "unknown", "filled_report_failed", ticket, quantity);
  }

void PullAndProcess()
  {
   string body = "";
   int code = HttpGet(QueueUrl(), body);
   if(code < 200 || code >= 300) { PrintFormat("TradeSense: queue returned HTTP %d.", code); return; }
   int cursor = StringFind(body, "\"orders\":[");
   if(cursor < 0) return;
   cursor += StringLen("\"orders\":[");
   while(cursor < StringLen(body))
     {
      int start = StringFind(body, "{", cursor);
      if(start < 0) break;
      int end = ObjectEnd(body, start);
      if(end < 0) break;
      ExecuteObject(StringSubstr(body, start, end - start + 1));
      cursor = end + 1;
     }
  }

void PollDryRun()
  {
   if(StringLen(ExecutionToken) == 0 || StringLen(BrokerAccountId) == 0) return;
   string body = "";
   int code = HttpGet(QueueUrl(), body);
   if(code < 200 || code >= 300) { PrintFormat("TradeSense dry-run: queue returned HTTP %d.", code); return; }
   int count = 0;
   int cursor = StringFind(body, "\"orders\":[");
   if(cursor >= 0)
     {
      cursor += StringLen("\"orders\":[");
      while(cursor < StringLen(body))
        {
         int start = StringFind(body, "{", cursor);
         if(start < 0) break;
         int end = ObjectEnd(body, start);
         if(end < 0) break;
         count++;
         cursor = end + 1;
        }
     }
   PrintFormat("TradeSense dry-run: %d pending order(s); no claim or trade was sent.", count);
  }

int OnInit()
  {
   if(PollSeconds < 5) { Print("TradeSense: PollSeconds must be at least 5."); return INIT_PARAMETERS_INCORRECT; }
   if(!IsDemo()) Print("TradeSense: attached to a non-demo account; execution will remain blocked.");
   EventSetTimer(PollSeconds);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   ReportHeartbeat();
   ReportPositions();
   if(!EnableExecution)
     {
      if(PollInDryRun) PollDryRun();
      return;
     }
   if(!DemoExecutionAllowed()) return;
   PullAndProcess();
   PollCloseRequests();
  }
