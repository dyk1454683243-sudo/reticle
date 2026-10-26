/**
 * The daemon that `reticle mcp` starts beside the proxy. `ready` settles when the start is done,
 * with the port to dial. `spawning` resolves when a new daemon process is started: the port was
 * free, so no stranger holds it, and the proxy can answer the handshake at once with `tools()`,
 * the daemon's own tool list built in this process.
 */
export interface ProxyBoot {
  readonly ready: Promise<number | void>;
  readonly spawning: Promise<void>;
  readonly tools: () => Promise<unknown[]>;
}
