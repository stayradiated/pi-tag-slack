/** Resolve the configured pi executable for supported POSIX platforms. */
export function resolvePiSpawn(piBin: string, args: string[]): { bin: string; args: string[] } {
  return { bin: piBin, args };
}
