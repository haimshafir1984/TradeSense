function mb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}
let latestRss = 0;
let belowRestartThreshold = 0;
let optionalPaused = false;
let sipPaused = false;

// Limits (MB) are tuned for a 512MB host. A larger server can raise them with environment variables:
// MEMORY_PAUSE_OPTIONAL_MB (default 350), MEMORY_PAUSE_SIP_MB (default 300), MEMORY_RESUME_MB (default 280).
// Node's RSS rarely shrinks, so on a bigger host the defaults would pause the intraday scan for good.
function limitMb(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n * 1024 * 1024 : fallback * 1024 * 1024;
}

function samplePressure() {
  latestRss = process.memoryUsage().rss;
  const optionalLimit = limitMb("MEMORY_PAUSE_OPTIONAL_MB", 350);
  const sipLimit = limitMb("MEMORY_PAUSE_SIP_MB", 300);
  const resumeLimit = limitMb("MEMORY_RESUME_MB", 280);
  if (latestRss >= optionalLimit) optionalPaused = true;
  if (latestRss >= sipLimit) sipPaused = true;
  if (latestRss < resumeLimit) {
    belowRestartThreshold += 1;
    if (belowRestartThreshold >= 3) { optionalPaused = false; sipPaused = false; }
  } else belowRestartThreshold = 0;
  return { rssBytes: latestRss, optionalPaused, sipPaused, belowRestartThreshold };
}
function pressure() { return { rssBytes: latestRss, optionalPaused, sipPaused, belowRestartThreshold }; }

function logMemory(label = "") {
  if (process.env.MEMORY_DIAGNOSTICS === "false") return;
  const usage = process.memoryUsage();
  samplePressure();
  const phase = label ? ` phase=${label}` : "";
  console.log(
    `[memory]${phase} rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB heapTotal=${mb(
      usage.heapTotal,
    )}MB external=${mb(usage.external)}MB arrayBuffers=${mb(usage.arrayBuffers)}MB`,
  );
}

function startMemoryDiagnostics() {
  if (process.env.MEMORY_DIAGNOSTICS === "false") return null;
  samplePressure();
  logMemory();
  const timer = setInterval(logMemory, 30000);
  timer.unref?.();
  return timer;
}

module.exports = { logMemory, startMemoryDiagnostics, pressure };
