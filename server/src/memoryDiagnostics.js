function mb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function startMemoryDiagnostics() {
  if (process.env.MEMORY_DIAGNOSTICS === "false") return null;
  const log = () => {
    const usage = process.memoryUsage();
    console.log(
      `[memory] rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB heapTotal=${mb(
        usage.heapTotal,
      )}MB external=${mb(usage.external)}MB`,
    );
  };
  log();
  const timer = setInterval(log, 30000);
  timer.unref?.();
  return timer;
}

module.exports = { startMemoryDiagnostics };
