#property strict
#property script_show_inputs
#property description "WebRequest URL-form matrix diagnostic. GET only. No trading operations."

string urls[] =
  {
   "http://127.0.0.1",
   "http://127.0.0.1/",
   "http://localhost",
   "http://localhost/",
   "http://127.0.0.1:4000/api/health",
   "http://127.0.0.1/api/health",
   "http://example.com/",
   "https://example.com",
   "https://example.com/",
   "https://www.google.com/"
  };

void OnStart()
  {
   PrintFormat("TradeSense matrix: build=%d connected=%d dllsAllowed=%d",
               TerminalInfoInteger(TERMINAL_BUILD),
               (int)TerminalInfoInteger(TERMINAL_CONNECTED),
               (int)TerminalInfoInteger(TERMINAL_DLLS_ALLOWED));

   for(int i = 0; i < ArraySize(urls); i++)
     {
      char req[];
      char res[];
      string resHeaders = "";
      ulong t0 = GetMicrosecondCount();
      ResetLastError();
      int code = WebRequest("GET", urls[i], "", 5000, req, res, resHeaders);
      int err = GetLastError();
      ulong ms = (GetMicrosecondCount() - t0) / 1000;
      PrintFormat("TradeSense matrix [%d] URL=[%s] http=%d err=%d elapsed_ms=%I64u bytes=%d",
                  i, urls[i], code, err, ms, ArraySize(res));
     }
   Print("TradeSense matrix: done");
  }
