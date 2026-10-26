/**
 * A client that starts its turn before the daemon is up still gets the Reticle tools.
 *
 * The defect: a client started its turn about 1.5 s after it launched the MCP server, and it did not
 * wait for servers that were not ready. On a first start the daemon took longer than that to accept,
 * and the proxy answered `initialize` only after the daemon was up. So the agent had no Reticle
 * tools for the whole turn, and it verified the change with a mock instead.
 *
 * The proxy now answers `initialize` and `tools/list` at once while it starts its own daemon. The
 * tool list comes from the same code the daemon uses, so it is the same list. A tool call waits in
 * the queue, and the daemon answers it when it is up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SSE_PATH, STATUS_PATH } from '@reticlehq/core';
import { proxyLogPath, startMcpProxy } from './mcp-proxy.js';
import { createMcpServer, staticToolCatalog } from './mcp.js';
import {
  TOOL_SURFACE,
  resolveToolSurface,
  type ToolSurface,
} from '@/surface/tools/tool-surface.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { getTelemetry } from '@/telemetry/telemetry.js';

/** What the daemon itself lists, over a real MCP client. */
async function daemonTools(surface: ToolSurface): Promise<unknown[]> {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer({} as unknown as ToolDeps, surface);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe('the tool list the proxy serves before the daemon is up', () => {
  it.each([resolveToolSurface(), TOOL_SURFACE.DEFAULT, TOOL_SURFACE.ALL])(
    'is the list the daemon serves on the %s surface',
    async (surface) => {
      expect(await staticToolCatalog(surface)).toEqual(await daemonTools(surface));
    },
  );
});

const RECONNECTING_EVENT = 'reticle_mcp_proxy_reconnecting';

interface Reply {
  id?: unknown;
  result?: { tools?: unknown[]; instructions?: string; content?: unknown };
  error?: unknown;
}

/** A daemon that answers each request on its SSE stream. */
function startFakeDaemon(): Promise<{ port: number; close: () => Promise<void> }> {
  const streams: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"running":true}');
      return;
    }
    if ('POST' === req.method) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        res.writeHead(202).end();
        const msg = JSON.parse(body) as { id?: unknown };
        if (msg.id !== undefined) {
          const reply = { jsonrpc: '2.0', id: msg.id, result: { content: [], from: 'daemon' } };
          streams[0]?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        }
      });
      return;
    }
    if (!(req.url ?? '').startsWith(MCP_SSE_PATH)) {
      res.writeHead(404).end();
      return;
    }
    streams.push(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /session/cold\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) {
              stream.socket?.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

describe('a client that starts before the daemon is up', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Put the proxy on a fake stdin, and collect what it writes to stdout. */
  function attachClient(): { send: (msg: object) => boolean; replies: Reply[] } {
    vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-cold-start-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });
    const replies: Reply[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      for (const line of String(chunk).split('\n')) {
        if ('' === line.trim()) {
          continue;
        }
        try {
          replies.push(JSON.parse(line) as Reply);
        } catch {
          // not a JSON-RPC line
        }
      }
      return true;
    });
    const send = (msg: object): boolean =>
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    return { send, replies };
  }

  // The daemon died while it started, or just after. A dial to its port is refused, and the proxy
  // retried that dial and never started a new daemon. The tool call waited in the queue until the
  // queue expired, and the agent got an error for a call that a new daemon can answer.
  // Port 1: nothing listens there, so a dial to it is refused.
  it.each([
    ['fails', undefined],
    ['ends, and the daemon dies before the proxy dials it', 1],
  ])(
    'starts a new daemon for a waiting tool call when the first start %s',
    async (_, result) => {
      const { send, replies } = attachClient();
      let failed: () => void = () => undefined;
      const ready = new Promise<number | void>((resolve) => (failed = () => resolve(result)));
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());
      let wakes = 0;
      void startMcpProxy(
        1,
        () => {
          wakes++;
          return Promise.resolve(daemon.port);
        },
        undefined,
        undefined,
        {
          ready,
          spawning: Promise.resolve(),
          tools: async () => staticToolCatalog(resolveToolSurface()),
        },
      ).catch(() => undefined);

      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'reticle_look', arguments: {} } });
      await vi.waitFor(() => expect(replies.some((r) => 1 === r.id)).toBe(true), {
        timeout: 5_000,
      });
      failed();

      await vi.waitFor(() => expect(replies.some((r) => 2 === r.id)).toBe(true), {
        timeout: 10_000,
      });
      expect(replies.filter((r) => 2 === r.id)).toEqual([
        { jsonrpc: '2.0', id: 2, result: { content: [], from: 'daemon' } },
      ]);
      expect(wakes, 'one new start, not one for each retry').toBe(1);
    },
    30_000,
  );

  // The start found no daemon, but a process accepts on the port and then drops the stream. That is
  // a daemon that flaps, not a port with nothing on it. The proxy went dormant without one dial, so
  // it never retried and never logged a retry.
  it('retries with backoff, and logs each retry, when the start fails but the port accepts', async () => {
    attachClient();
    const flapper = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end();
    });
    await new Promise<void>((resolve) => flapper.listen(0, LOOPBACK_HOST, resolve));
    cleanups.push(() => new Promise<void>((done) => flapper.close(() => done())));
    let wakes = 0;
    const port = (flapper.address() as AddressInfo).port;
    void startMcpProxy(
      port,
      () => {
        wakes++;
        return Promise.resolve(undefined);
      },
      undefined,
      undefined,
      {
        ready: Promise.resolve(),
        spawning: Promise.resolve(),
        tools: async () => staticToolCatalog(resolveToolSurface()),
      },
    ).catch(() => undefined);

    await vi.waitFor(
      () =>
        expect(
          (existsSync(proxyLogPath()) ? readFileSync(proxyLogPath(), 'utf8') : '')
            .split('\n')
            .filter((line) => line.includes(RECONNECTING_EVENT))
            .map((line) => (JSON.parse(line) as { port?: unknown }).port),
        ).toContain(port),
      { timeout: 5_000 },
    );
    expect(wakes, 'a daemon that is there is retried, not replaced').toBe(0);
  });

  it('gets initialize and the tool list at once, and its tool call waits for the daemon', async () => {
    const { send, replies } = attachClient();
    // The daemon is being started, and it is not up until the test says so.
    let up: (port: number) => void = () => undefined;
    const ready = new Promise<number>((resolve) => (up = resolve));
    void startMcpProxy(1, undefined, undefined, undefined, {
      ready,
      spawning: Promise.resolve(),
      tools: async () => staticToolCatalog(resolveToolSurface()),
    }).catch(() => undefined);

    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'reticle_look', arguments: {} } });

    await vi.waitFor(() => expect(replies.some((r) => 2 === r.id)).toBe(true), { timeout: 5_000 });
    const init = replies.find((r) => 1 === r.id);
    expect(init?.result?.instructions ?? '', 'a cold start is not a degraded start').not.toContain(
      'DEGRADED',
    );
    expect(replies.find((r) => 2 === r.id)?.result?.tools).toEqual(
      await staticToolCatalog(resolveToolSurface()),
    );
    expect(
      replies.some((r) => 3 === r.id),
      'the tool call waits for the daemon',
    ).toBe(false);

    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    up(daemon.port);
    await vi.waitFor(() => expect(replies.some((r) => 3 === r.id)).toBe(true), { timeout: 10_000 });
    expect(replies.filter((r) => 3 === r.id)).toEqual([
      { jsonrpc: '2.0', id: 3, result: { content: [], from: 'daemon' } },
    ]);
    expect(
      replies.filter((r) => 1 === r.id),
      'initialize is answered once',
    ).toHaveLength(1);
  }, 30_000);
});
