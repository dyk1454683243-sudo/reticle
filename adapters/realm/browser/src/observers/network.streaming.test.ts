import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventType, parseEventPayload } from '@reticlehq/core';
import { installNetwork } from './network.js';
import { setNetworkBodyMaxChars } from './net-detail/network-body.js';
import type { Emit, Teardown } from './types.js';

/**
 * Body capture must never make the app's own `fetch` wait.
 *
 * The observer reads a CLONE of the response so the app's stream stays untouched — but it awaited that
 * clone BEFORE returning the response. A clone of a stream only settles when the stream ends, and an
 * SSE stream does not end, so `await fetch('/api/chat')` never resolved. `text/event-stream` matches
 * `text/` in CAPTURABLE_CONTENT, so simply enabling body capture hung every streaming endpoint: a
 * permanently loading UI, and no reason for the developer to suspect the observability SDK.
 *
 * These tests assert the host app's control flow, not the emitted event — the app resolving is the
 * property that matters.
 */

const teardowns: Teardown[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) {
    t();
  }
  setNetworkBodyMaxChars(8192);
  vi.unstubAllGlobals();
});

function collect(): { emit: Emit; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { emit: (type, data) => events.push({ type, data }), events };
}

/** Body capture finishes in a detached promise. Let its event land. */
const flushBody = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Both branches use the real Streams tee, including its asynchronous cancellation behavior. */
function controlledSse(status = 200) {
  const encoder = new TextEncoder();
  let write = (_text: string): void => undefined;
  let close = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      write = (text) => controller.enqueue(encoder.encode(text));
      close = () => controller.close();
    },
  });
  const [body, observed] = stream.tee();
  const res = {
    body,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
    clone: () => ({ body: observed }),
  } as unknown as Response;
  return { res, write, close };
}

async function readAppBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error('response has no body');
  }
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return text + decoder.decode();
    }
    text += decoder.decode(next.value, { stream: true });
  }
}

describe('SSE response body capture (#1848)', () => {
  beforeEach(() => vi.stubGlobal('TextDecoder', TextDecoder));

  it('completes the pending request at headers while capturing an idle SSE body', async () => {
    const stream = controlledSse();
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    teardowns.push(teardown);
    await window.fetch('/api/chat');
    stream.write('data: ready\n\n');
    await flushBody();
    const pending = events.find((event) => EventType.NET_PENDING === event.type);
    const completed = events.find(
      (event) => EventType.NET_REQUEST === event.type && event.data['id'] === pending?.data['id'],
    );
    teardown();
    stream.close();
    expect(completed).toBeDefined();
  });

  it('returns headers first, then records a finished stream exactly once', async () => {
    const stream = controlledSse();
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    const res = await window.fetch('/api/chat');
    expect(res).toBe(stream.res);
    const appBody = readAppBody(res);
    stream.write('data: hello\n\n');
    await flushBody();
    expect(events.filter((e) => e.type === EventType.NET_REQUEST)).toHaveLength(1);
    expect(events.filter((e) => e.type === EventType.NET_RESPONSE_BODY)).toHaveLength(0);
    stream.write('data: world\n\n');
    stream.close();
    expect(await appBody).toBe('data: hello\n\ndata: world\n\n');
    await flushBody();
    const requests = events.filter((event) => EventType.NET_RESPONSE_BODY === event.type);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data['responseBody']).toBe('data: hello\n\ndata: world\n\n');
    expect(requests[0]?.data['responseBodyTruncated']).toBeUndefined();
    expect(requests[0]?.data['responseBodyReason']).toBeUndefined();
    expect(parseEventPayload(EventType.NET_RESPONSE_BODY, requests[0]?.data)).toMatchObject({
      success: true,
      data: requests[0]?.data,
    });
    // SSE does not enter the generic settle watcher, even with capture on.
    expect(events.filter((e) => e.type === EventType.NET_STREAM)).toHaveLength(0);
  });

  it('does not emit a body detail when cloning fails', async () => {
    const stream = controlledSse();
    stream.res.clone = () => {
      throw new Error('locked');
    };
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    const res = await window.fetch('/api/chat');
    stream.write('data: app only\n\n');
    stream.close();
    expect(await readAppBody(res)).toBe('data: app only\n\n');
    await flushBody();
    expect(events.filter((event) => EventType.NET_REQUEST === event.type)).toHaveLength(1);
    expect(events.filter((event) => EventType.NET_RESPONSE_BODY === event.type)).toHaveLength(0);
  });

  it('does not emit a body detail when teardown interrupts an empty stream', async () => {
    const stream = controlledSse();
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    teardowns.push(teardown);
    const res = await window.fetch('/api/chat');
    teardown();
    await flushBody();
    expect(events.filter((event) => EventType.NET_RESPONSE_BODY === event.type)).toHaveLength(0);
    stream.write('data: app only\n\n');
    stream.close();
    expect(await readAppBody(res)).toBe('data: app only\n\n');
  });

  it('emits a truncated prefix without waiting for the app branch to finish', async () => {
    setNetworkBodyMaxChars(256);
    const stream = controlledSse();
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    const res = await window.fetch('/api/chat');
    const appBody = readAppBody(res);
    const prefix = 'data: ' + 'x'.repeat(2000) + '\n\n';
    stream.write(prefix);
    await flushBody();
    const requests = events.filter((event) => EventType.NET_RESPONSE_BODY === event.type);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data['responseBody']).toBe('data: ' + 'x'.repeat(250));
    expect(requests[0]?.data['responseBodyTruncated']).toBe(true);
    stream.write('data: final\n\n');
    stream.close();
    expect(await appBody).toBe(prefix + 'data: final\n\n');
    await flushBody();
    expect(events.filter((e) => e.type === EventType.NET_REQUEST)).toHaveLength(1);
  });

  it('stops observing on teardown while the app can still finish reading', async () => {
    const stream = controlledSse();
    vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
    const { emit, events } = collect();
    const teardown = installNetwork(emit, { captureBodies: true });
    teardowns.push(teardown);
    const res = await window.fetch('/api/chat');
    const appBody = readAppBody(res);
    stream.write('data: first\n\n');
    await flushBody();
    teardown();
    await flushBody();
    const requests = events.filter((event) => EventType.NET_RESPONSE_BODY === event.type);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data['responseBody']).toBe('data: first\n\n');
    expect(requests[0]?.data['responseBodyTruncated']).toBe(true);
    stream.write('data: final\n\n');
    stream.close();
    expect(await appBody).toBe('data: first\n\ndata: final\n\n');
  });

  it.each([200, 500])(
    'does not capture SSE with general capture off, status %s',
    async (status) => {
      const stream = controlledSse(status);
      vi.stubGlobal('fetch', () => Promise.resolve(stream.res));
      const { emit, events } = collect();
      teardowns.push(installNetwork(emit));
      const res = await window.fetch('/api/chat');
      stream.write('data: private\n\n');
      stream.close();
      expect(await readAppBody(res)).toBe('data: private\n\n');
      const requests = events.filter((e) => e.type === EventType.NET_REQUEST);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.data['responseBody']).toBeUndefined();
      expect(requests[0]?.data['responseBodyReason']).toBeUndefined();
    },
  );
});

/** A response whose body never completes — an SSE endpoint held open by the server. */
function neverEndingResponse(contentType: string): Response {
  const res = {
    headers: { get: (k: string) => ('content-type' === k.toLowerCase() ? contentType : null) },
    status: 200,
    ok: true,
    clone: () => ({ text: () => new Promise<string>(() => undefined) }),
  };
  return res as unknown as Response;
}

/**
 * A chunked response whose body is readable — so the stream watcher actually emits.
 *
 * `application/json` with NO `content-length` is the chunked case `isStreamingBody` exists for; a
 * `text/event-stream` would be skipped outright as ENDLESS_BY_DESIGN and never reach the watcher.
 */
function readableStreamResponse(): Response {
  const bodyOf = (): { getReader: () => { read: () => Promise<{ done: boolean }> } } => ({
    getReader: () => ({ read: () => Promise.resolve({ done: true }) }),
  });
  return {
    headers: {
      get: (k: string) => ('content-type' === k.toLowerCase() ? 'application/json' : null),
    },
    status: 200,
    ok: true,
    body: bodyOf(),
    clone: () => ({ body: bodyOf() }),
  } as unknown as Response;
}

/**
 * A stream record has to carry the SAME two URL fields the pending record does.
 *
 * Redaction rewrites a sensitive path segment at emit time and keeps the original in `urlRaw`, and
 * every consumer that CLASSIFIES a URL reads `urlForMatch` — the pending record, `urlContains`, the
 * contradiction rules' `netCall`. The stream record was the one place the raw copy was dropped: the
 * fetch path passed `urlFields.url` alone to the watcher, while the WebSocket and EventSource paths
 * spread the whole object. So a declared background endpoint whose path was redacted came back into
 * the settle count through the stream half, and `settled` stayed false with the request excluded
 * everywhere else — the defect the two settle paths were just made to agree on, re-entered by a
 * third field.
 */
describe('the stream record carries the raw url alongside the displayed one', () => {
  it('keeps urlRaw on NET_STREAM, so a redacted endpoint stays classifiable', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(readableStreamResponse()));
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));

    await window.fetch('/verify/refresh-token');
    await flushBody();

    const stream = events.find((e) => EventType.NET_STREAM === e.type);
    expect(stream?.data['url']).toContain('[REDACTED]');
    expect(stream?.data['urlRaw']).toContain('refresh-token');
  });

  it('omits urlRaw entirely when nothing was redacted, so an ordinary stream pays nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(readableStreamResponse()));
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));

    await window.fetch('/api/chat');
    await flushBody();

    const stream = events.find((e) => EventType.NET_STREAM === e.type);
    expect(stream?.data['url']).toBe('/api/chat');
    expect('urlRaw' in (stream?.data ?? {})).toBe(false);
  });
});

describe('body capture must not block the host app', () => {
  it('returns an SSE response to the app instead of waiting for the stream to end', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(neverEndingResponse('text/event-stream')));
    const { emit } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));

    // If the observer awaits the clone, this never settles and the test times out — which is exactly
    // what the host app experiences.
    const res = await Promise.race([
      window.fetch('/api/chat'),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1000)),
    ]);
    expect(res).not.toBe('HUNG');
  });

  it('returns a chunked JSON response promptly too (token-streaming model APIs)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(neverEndingResponse('application/json')));
    const { emit } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    const res = await Promise.race([
      window.fetch('/api/completions'),
      // Bounded, not unbounded: a content-type-less stream costs the app the body deadline once,
      // never the lifetime of the stream.
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1500)),
    ]);
    expect(res).not.toBe('HUNG');
  });

  it('still captures a normal, complete JSON body', async () => {
    const body = JSON.stringify({ ok: true });
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        headers: { get: () => 'application/json' },
        status: 200,
        ok: true,
        clone: () => ({ text: () => Promise.resolve(body) }),
      } as unknown as Response),
    );
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/thing');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(String(withBody?.data['responseBody'])).toContain('ok');
  });
});

/**
 * Work must not scale with body size.
 *
 * The 500ms deadline bounds how long the SDK WAITS for a body, but everything after it was synchronous
 * and unbounded: JSON.parse over the whole text, a deep sanitising walk, a re-stringify, then two global
 * regexes — with the 8 KB cap applied last. A 30 MB CSV export or a large HTML error page resolves fast,
 * so the deadline never fires, and the app freezes on the main thread instead. That is the same class of
 * host-app damage as the hang, with the SDK still the cause.
 */
describe('body projection is bounded by input size, not just output size', () => {
  const hugeBody = (chars: number, contentType: string): void => {
    const body = 'x'.repeat(chars);
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        headers: { get: () => contentType },
        status: 200,
        ok: true,
        clone: () => ({ text: () => Promise.resolve(body) }),
      } as unknown as Response),
    );
  };

  /**
   * Bounded by INPUT size, proven without a wall-clock assertion.
   *
   * This used to assert `Date.now() - started < 1000`, which is a statement about the machine, not
   * about the code. It passed alone and failed reproducibly when the rest of the suite ran in
   * parallel under load — and it cost a commit through a red gate before it was identified. Its own
   * comment already said the point was that "cost is FIXED, not that it is fast here", so the
   * assertion contradicted the thing it was written to check.
   *
   * The regression it guards is UNBOUNDED work: without the input cap, 4 MB gets parsed and
   * regex-swept in full, which does not merely get slow, it exceeds any sane budget by orders of
   * magnitude (the same pass costs ~2s at 64 KB — this input is 60x that). A generous per-test
   * timeout catches exactly that and is immune to how loaded the machine is; the output-size
   * assertion below carries the rest.
   */
  it('projects a very large text body without scanning all of it', async () => {
    hugeBody(4_000_000, 'text/csv');
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/export.csv');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(String(withBody?.data['responseBody']).length).toBeLessThanOrEqual(8192);
    expect(withBody?.data['responseBodyTruncated']).toBe(true);
  }, 10_000);

  it('marks an over-large body as truncated — never reports a clipped read as complete', async () => {
    hugeBody(4_000_000, 'text/plain');
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, { captureBodies: true }));
    await window.fetch('/api/big.txt');
    await flushBody();
    const withBody = events.find((e) => e.data['responseBody'] !== undefined);
    expect(withBody?.data['responseBodyTruncated']).toBe(true);
  });
});
