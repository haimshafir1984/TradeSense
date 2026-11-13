// setInterval for polling that does nothing while the browser tab is hidden, and refreshes immediately when the tab
// becomes visible again. Every open tab used to ask the server for several endpoints every 10-20 seconds even in the
// background, which costs server CPU for nobody. Returns the cleanup function.
export function pollWhileVisible(load, ms) {
  const timer = setInterval(() => {
    if (!document.hidden) load();
  }, ms);
  const onVisible = () => {
    if (!document.hidden) load();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
