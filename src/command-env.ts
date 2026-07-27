import { delimiter } from 'node:path';
import { config } from './config.js';

/** Environment for commands launched by the gateway and its pi child process. */
export function commandEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathEntries = [...config.pathPrepend, ...(baseEnv.PATH ?? '').split(delimiter)].filter(
    Boolean,
  );
  const path = [...new Set(pathEntries)].join(delimiter);

  return {
    ...baseEnv,
    ...(path ? { PATH: path } : {}),
  };
}

export function commandPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return commandEnv(baseEnv).PATH ?? '';
}
