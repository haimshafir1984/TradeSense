function mb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}
let latestRss = 0;
let belowRestartThreshold = 0;
let optionalPaused = false;
let sipPaused = false;

function samplePressure() {
  latestRss = process.memoryUsage().rss;
  if (latestRss >= 350 * 1024 * 1024) optionalPaused = true;
  if (latestRss >= 300 * 1024 * 1024) sipPaused = true;
  if (latestRss < 280 * 1024 * 1024) {
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
