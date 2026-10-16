// Local-only TCP forwarder: 127.0.0.1:80 -> 127.0.0.1:4000
// Why: MT4 WebRequest rejects any URL that contains a port (error 5200); it only talks to 80/443.
// No dependencies. Works on Node 18+. Binds to loopback only, so it is not reachable from the network.
// Usage (PowerShell):  node mt4\tools\port80-forwarder.mjs
import net from 'node:net';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.FORWARD_LISTEN_PORT || 80);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.FORWARD_TARGET_PORT || 4000);

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
});

server.on('error', (err) => {
  if (err.code === 'EACCES') console.error(`No permission to bind port ${LISTEN_PORT}. Try an elevated PowerShell.`);
  else if (err.code === 'EADDRINUSE') console.error(`Port ${LISTEN_PORT} is already in use by another process.`);
  else console.error(err);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Forwarding http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT} (Ctrl+C to stop)`);
});
