#property strict
#property script_show_inputs
#property description "Isolated WebRequest diagnostic. No trading operations."

void OnStart()
  {
   string url = "http://127.0.0.1";
   char request[];
   char response[];
   string responseHeaders = "";

   ResetLastError();
   PrintFormat("TradeSense diagnostic: GET URL=[%s]", url);

   int code = WebRequest("GET", url, "", 5000, request, response, responseHeaders);
   int errorCode = GetLastError();

   PrintFormat("TradeSense diagnostic: WebRequest result=%d", code);
   if(code < 0)
      PrintFormat("TradeSense diagnostic: GetLastError()=%d", errorCode);
   else
      PrintFormat("TradeSense diagnostic: HTTP response received; GetLastError()=%d", errorCode);
  }
