#property strict
#property script_show_inputs
#property description "Isolated public HTTPS WebRequest diagnostic. No trading operations."

void OnStart()
  {
   string url = "https://example.com";

   // Signature 2: custom headers.
   char headerRequest[];
   char headerResponse[];
   string headerResponseHeaders = "";
   ResetLastError();
   int headerResult = WebRequest("GET", url, "", 5000, headerRequest, headerResponse, headerResponseHeaders);
   int headerError = GetLastError();
   PrintFormat("TradeSense public diagnostic [custom-headers]: URL=[%s] result=%d error=%d", url, headerResult, headerError);

   // Signature 1: cookie/referer form, with an empty request body.
   char simpleRequest[];
   char simpleResponse[];
   string simpleResponseHeaders = "";
   ResetLastError();
   int simpleResult = WebRequest("GET", url, "", "", 5000, simpleRequest, 0, simpleResponse, simpleResponseHeaders);
   int simpleError = GetLastError();
   PrintFormat("TradeSense public diagnostic [simple]: URL=[%s] result=%d error=%d", url, simpleResult, simpleError);
  }
