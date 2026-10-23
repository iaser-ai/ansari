import {defaultOperationLogger, listen} from './http-server.js';
import {writeOperationLog} from '../server/operation-log.js';
import {releaseFromEnv} from '../server/runtime-config.js';
const service = await listen();
writeOperationLog({event: 'startup', port: service.port}, defaultOperationLogger, releaseFromEnv(process.env));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void service.close().then(() => process.exit(0)); });
}
