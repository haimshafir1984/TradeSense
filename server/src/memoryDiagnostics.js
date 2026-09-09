function mb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function logMemory(label = "") {
  if (process.env.MEMORY_DIAGNOSTICS === "false") return;
  const usage = process.memoryUsage();
  const phase = label ? ` phase=${label}` : "";
  console.log(
    `[memory]${phase} rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB heapTotal=${mb(
      usage.heapTotal,
    )}MB external=${mb(usage.external)}MB arrayBuffers=${mb(usage.arrayBuffers)}MB`,
  );
}

function startMemoryDiagnostics() {
  if (process.env.MEMORY_DIAGNOSTICS === "false") return null;
  logMemory();
  const timer = setInterval(logMemory, 30000);
  timer.unref?.();
  return timer;
}

module.exports = { logMemory, startMemoryDiagnostics };
