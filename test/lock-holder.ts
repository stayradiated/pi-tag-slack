import { acquireGatewayLock, gatewayPaths } from '../src/paths.js';

const lock = acquireGatewayLock(gatewayPaths(process.argv[2]));
process.send?.({ type: 'acquired', pid: process.pid });
process.on('SIGTERM', () => {
  lock.release();
  process.exit(0);
});
setInterval(() => undefined, 1_000);
