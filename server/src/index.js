const path = require("path");
const dotenv = require("dotenv");

const rootEnvPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: rootEnvPath });

const app = require("./app");
const { startMemoryDiagnostics } = require("./memoryDiagnostics");

const port = Number(process.env.PORT || 4000);

console.log(`[startup] Loaded env from ${rootEnvPath}`);
console.log(
  `[startup] DATA_MODE=${process.env.DATA_MODE || "undefined"} FINNHUB_API_KEY=${process.env.FINNHUB_API_KEY ? "present" : "missing"} CLIENT_ORIGIN=${process.env.CLIENT_ORIGIN || "undefined"}`,
);
startMemoryDiagnostics();

let autopilotRetryTimer = null;
function startAutopilotSafely() {
  try {
    require("./autopilot/users").applyConfiguredReset();
  } catch (error) {
    console.error(`[startup] Access-code reset failed: ${error.message}`);
  }
  try {
    require("./autopilot/engine").start();
    console.log("[startup] Autopilot scheduler started");
  } catch (error) {
    console.error(`[startup] Autopilot scheduler failed to start: ${error.stack || error.message}`);
    if (!autopilotRetryTimer) {
      autopilotRetryTimer = setTimeout(() => {
        autopilotRetryTimer = null;
        startAutopilotSafely();
      }, 60000);
      autopilotRetryTimer.unref?.();
    }
  }
}

// The server owns the persistent v3 scheduler; browser visits never trigger monitoring.
app.listen(port, () => {
  console.log(`TradeSense API listening on port ${port}`);
  startAutopilotSafely();
});
process.on("SIGTERM", () => {
  if (autopilotRetryTimer) clearTimeout(autopilotRetryTimer);
  require("./autopilot/engine").stop();
  process.exit(0);
});
