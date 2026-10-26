import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseBodyReason } from '@reticlehq/core';
import { setNetworkBodyMaxChars } from './network-body.js';
import { captureResponseBody, isEventStream } from './network-response-body.js';

// Use the test clock at the native timer boundary, not the app's clock.
vi.mock('@/timers/native/native-timers.js', () => ({
  nativeSetTimeout: (cb: () => void, ms: number) => globalThis.setTimeout(cb, ms),
  nativeClearTimeout: (id: number) => globalThis.clearTimeout(id),
}));

const SSE = 'text/event-stream';
const encoder = new TextEncoder();

/** The clone uses a real stream. The app's branch is covered by observer integration tests. */
function response(body: ReadableStream<Uint8Array>): Response {
  return { clone: () => ({ body }) } as unknown as Response;
}

function chunks(parts: string[]): Response {
  return response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    }),
  );
}

function capture(res: Response, signal = new AbortController().signal) {
  return captureResponseBody(res, SSE, true, signal);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('TextDecoder', TextDecoder);
});

afterEach(() => {
  setNetworkBodyMaxChars(8192);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded SSE body capture (#1848)', () => {
  it.each(['text/event-stream', 'TEXT/EVENT-STREAM; charset=utf-8'])('recognizes %s', (type) => {
    expect(isEventStream(type)).toBe(true);
  });

  it.each([null, 'application/json', 'application/x-ndjson', 'text/plain'])(
    'does not classify %s as SSE',
    (type) => {
      expect(isEventStream(type)).toBe(false);
    },
  );

  it('records all chunks of a finished stream', async () => {
    expect(await capture(chunks(['data: hello\n\n', 'data: world\n\n']))).toEqual({
      responseBody: 'data: hello\n\ndata: world\n\n',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records an empty finished stream as complete', async () => {
    expect(await capture(chunks([]))).toEqual({ responseBody: '' });
  });

  it('decodes a UTF-8 character split across byte chunks', async () => {
    const bytes = encoder.encode('data: 你好\n\n');
    const res = response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 7));
          controller.enqueue(bytes.subarray(7, 8));
          controller.enqueue(bytes.subarray(8));
          controller.close();
        },
      }),
    );
    expect(await capture(res)).toEqual({ responseBody: 'data: 你好\n\n' });
  });

  it('caps a large chunk before decoding or retaining all of it', async () => {
    setNetworkBodyMaxChars(256);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const result = await capture(chunks(['data: ' + 'x'.repeat(1_000_000)]));
    expect(result).toEqual({
      responseBody: 'data: ' + 'x'.repeat(250),
      responseBodyTruncated: true,
    });
    for (const [input] of decode.mock.calls) {
      expect(input?.byteLength ?? 0).toBeLessThanOrEqual(2048);
    }
  });

  it('stops pulling an endless stream when the input budget is full', async () => {
    setNetworkBodyMaxChars(256);
    let cancelled = false;
    const res = response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode('data: chunk\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const result = await capture(res);
    expect(String(result['responseBody']).length).toBeLessThanOrEqual(256);
    expect(result['responseBodyTruncated']).toBe(true);
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts JSON credentials inside SSE data lines, including quoted spaces', async () => {
    const result = await capture(
      chunks(['data: {"password":"private value","apiKey":"local-key","answer":"hello"}\n\n']),
    );
    expect(result['responseBody']).toBe(
      'data: {"password":"[REDACTED]","apiKey":"[REDACTED]","answer":"hello"}\n\n',
    );
  });

  it('keeps the prefix when an idle stream reaches the deadline', async () => {
    const pending = capture(
      response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: hello\n\n'));
          },
        }),
      ),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ responseBody: 'data: hello\n\n', responseBodyTruncated: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'abort'])(
    'does not retain a chunk delivered after %s wins the read race',
    async (reason) => {
      const abort = new AbortController();
      let write = (_text: string): void => undefined;
      let finish = (): void => undefined;
      let first = true;
      // Keep the read promises in this realm so the test controls their exact microtask order.
      const reader = {
        read(): Promise<ReadableStreamReadResult<Uint8Array>> {
          if (first) {
            first = false;
            return Promise.resolve({ done: false, value: encoder.encode('data: first\n\n') });
          }
          return new Promise((resolve) => {
            write = (text) => resolve({ done: false, value: encoder.encode(text) });
            finish = () => resolve({ done: true, value: undefined });
          });
        },
        cancel() {
          finish();
          return Promise.resolve();
        },
        releaseLock: () => undefined,
      };
      const res = { clone: () => ({ body: { getReader: () => reader } }) } as unknown as Response;
      const pending = capture(res, abort.signal);
      await vi.advanceTimersByTimeAsync(0);

      // Resolve the stop and the pending read in one turn, before promise continuations run.
      if ('deadline' === reason) {
        vi.advanceTimersByTime(10_000);
      } else {
        abort.abort();
      }
      write('data: too late\n\n');

      expect(await pending).toEqual({
        responseBody: 'data: first\n\n',
        responseBodyTruncated: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    {
      input: '{"recoveryCodes":["first-code","second-code"],"answer":"hello"}',
      output: '{"answer":"hello","recoveryCodes":"[REDACTED]"}',
    },
    {
      input: '{"token":{"value":"private-value"},"answer":"hello"}',
      output: '{"answer":"hello","token":"[REDACTED]"}',
    },
    {
      input: '{"pass\\u0077ord":"private-value","answer":"hello"}',
      output: '{"password":"[REDACTED]","answer":"hello"}',
    },
  ])('redacts structured credentials in $input', async ({ input, output }) => {
    expect(await capture(chunks([`data: ${input}\n\n`]))).toEqual({
      responseBody: `data: ${output}\n\n`,
    });
  });

  it('redacts JSON joined from multiple data lines in the same event', async () => {
    const text =
      'event: reply\r\ndata: {\r\ndata: "token":{"value":"private-value"},\r\ndata: "answer":"hello"}\r\n\r\n';
    expect(await capture(chunks([text]))).toEqual({
      responseBody: 'event: reply\ndata: {"answer":"hello","token":"[REDACTED]"}\n\n',
    });
  });

  it('does not retain credential values from incomplete JSON data', async () => {
    expect(await capture(chunks(['data: {"token":{"value":"private-value"']))).toEqual({
      responseBody: 'data: [REDACTED]',
      responseBodyTruncated: true,
    });
  });

  it('declares structured redaction depth loss instead of reporting a complete body', async () => {
    const nested = '{"reply":'.repeat(30) + '"hello"' + '}'.repeat(30);
    const result = await capture(chunks([`data: ${nested}\n\n`]));
    expect(result['responseBodyTruncated']).toBe(true);
    expect(String(result['responseBody'])).not.toContain('hello');
  });

  it('keeps plain text markers without treating them as JSON arrays', async () => {
    expect(await capture(chunks(['data: [DONE]\n\n']))).toEqual({
      responseBody: 'data: [DONE]\n\n',
    });
  });

  it('marks an idle stream with no chunks as unreadable', async () => {
    const pending = capture(response(new ReadableStream<Uint8Array>()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ responseBodyReason: ResponseBodyReason.UNREADABLE });
  });

  it('keeps a partial body when the stream errors after a chunk', async () => {
    let first = true;
    const res = response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(encoder.encode('data: hello\n\n'));
          } else {
            controller.error(new Error('connection closed'));
          }
        },
      }),
    );
    expect(await capture(res)).toEqual({
      responseBody: 'data: hello\n\n',
      responseBodyTruncated: true,
    });
  });

  it('stops on abort without awaiting a pending branch cancellation', async () => {
    const abort = new AbortController();
    let cancelled = false;
    const res = response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: hello\n\n'));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }),
    );
    const pending = capture(res, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await pending).toEqual({ responseBody: 'data: hello\n\n', responseBodyTruncated: true });
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start reading for an already aborted observation', async () => {
    const abort = new AbortController();
    abort.abort();
    const res = chunks(['data: hello\n\n']);
    const clone = vi.spyOn(res, 'clone');
    expect(await capture(res, abort.signal)).toEqual({
      responseBodyReason: ResponseBodyReason.UNREADABLE,
    });
    expect(clone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an unreadable clone rather than rejecting', async () => {
    const res = {
      clone: () => {
        throw new Error('locked');
      },
    } as unknown as Response;
    expect(await capture(res)).toEqual({ responseBodyReason: ResponseBodyReason.UNREADABLE });
  });

  it('preserves ordinary JSON body capture', async () => {
    const res = {
      clone: () => ({ text: () => Promise.resolve('{"answer":"hello"}') }),
    } as unknown as Response;
    expect(
      await captureResponseBody(res, 'application/json', true, new AbortController().signal),
    ).toEqual({
      responseBody: '{"answer":"hello"}',
    });
  });

  it('preserves the smaller error-only body cap and its reason', async () => {
    const res = {
      clone: () => ({ text: () => Promise.resolve('x'.repeat(5000)) }),
    } as unknown as Response;
    const result = await captureResponseBody(
      res,
      'text/plain',
      false,
      new AbortController().signal,
    );
    expect(String(result['responseBody']).length).toBe(4096);
    expect(result['responseBodyTruncated']).toBe(true);
    expect(result['responseBodyReason']).toBe(ResponseBodyReason.ERROR_STATUS);
  });
});
