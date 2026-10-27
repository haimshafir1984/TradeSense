//+------------------------------------------------------------------+
//| One-off read-only check: was each bot trade ever in profit?      |
//| No trading operations. Prints one line per closed bot trade.     |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs
input int Magic = 240014;

void OnStart()
{
   int n = OrdersHistoryTotal();
   int total = 0, everProfit = 0, nodata = 0;
   Print("MFE-CHECK start, history=", n);
   for (int i = 0; i < n; i++)
   {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      int type = OrderType();
      if (type > OP_SELL) continue;
      if (OrderMagicNumber() != Magic) continue;
      string s = OrderSymbol();
      datetime o = OrderOpenTime(), c = OrderCloseTime();
      double op = OrderOpenPrice(), cp = OrderClosePrice();
      int sO = iBarShift(s, PERIOD_M1, o, false);
      int sC = iBarShift(s, PERIOD_M1, c, false);
      total++;
      if (sO < 0 || sC < 0 || sO < sC)
      {
         nodata++;
         Print("MFE ", OrderTicket(), " ", s, " NODATA open=", TimeToString(o), " pl=", DoubleToString(OrderProfit(), 2));
         continue;
      }
      int cnt = sO - sC + 1;
      int minutes = 0;
      double best = op;
      for (int k = sC; k <= sO; k++)
      {
         double hi = iHigh(s, PERIOD_M1, k), lo = iLow(s, PERIOD_M1, k);
         if (type == OP_BUY) { if (hi > op) minutes++; if (hi > best) best = hi; }
         else                { if (lo < op) minutes++; if (lo < best) best = lo; }
      }
      double mfePct = (type == OP_BUY ? (best - op) : (op - best)) / op * 100.0;
      if (minutes > 0) everProfit++;
      Print("MFE ", OrderTicket(), " ", s, (type == OP_BUY ? " BUY" : " SELL"),
            " open=", DoubleToString(op, 2), " close=", DoubleToString(cp, 2),
            " pl=", DoubleToString(OrderProfit(), 2),
            " bestPx=", DoubleToString(best, 2), " mfe%=", DoubleToString(mfePct, 2),
            " minsInProfit=", minutes, "/", cnt, " ", TimeToString(o), "->", TimeToString(c));
   }
   Print("MFE-CHECK done trades=", total, " everInProfit=", everProfit, " nodata=", nodata);
}
