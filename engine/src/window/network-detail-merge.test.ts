import { describe, expect, it } from 'vitest';
import { EventType, ResponseBodyReason, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from '../question/predicate/predicate-eval.js';
import { mergeNetworkDetail } from './network-detail-merge.js';

function request(id: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    sessionId: 'sse-test',
    t: 1,
    data: {
      id,
      method: 'POST',
      url: '/api/chat',
      status: 200,
      responseBodyReason: ResponseBodyReason.UNREADABLE,
      ...extra,
    },
  };
}

function detail(id: string, body: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_RESPONSE_BODY,
    sessionId: 'sse-test',
    t: 2,
    data: {
      id,
      method: 'POST',
      url: '/api/chat',
      responseBody: body,
      ...extra,
    },
  };
}

describe('SSE bodies enrich the completed request without duplicating it (#1848)', () => {
  it('removes the unavailable reason and stale truncation after a complete capture', () => {
    const merged = mergeNetworkDetail([
      request('n1', { responseBodyTruncated: true }),
      detail('n1', 'data: hello\n\n'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data['responseBody']).toBe('data: hello\n\n');
    expect(merged[0]?.data['responseBodyReason']).toBeUndefined();
    expect(merged[0]?.data['responseBodyTruncated']).toBeUndefined();
  });

  it('merges a wire detail carrying a response body without requiring an SDK id', () => {
    const headers = { 'content-type': 'text/event-stream' };
    const merged = mergeNetworkDetail([
      request('n1'),
      {
        type: EventType.NET_DETAIL,
        sessionId: 'sse-test',
        t: 2,
        data: {
          method: 'POST',
          url: '/api/chat',
          status: 200,
          headers,
          responseBody: 'data: wire\n\n',
        },
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data['headers']).toEqual(headers);
  });

  it('does not fall back to the URL when an SDK detail has no matching id', () => {
    const merged = mergeNetworkDetail([
      request('n1'),
      detail('missing', 'data: other\n\n', { headers: { etag: 'other' } }),
    ]);
    expect(merged).toHaveLength(2);
    expect(
      merged.find((event) => EventType.NET_REQUEST === event.type)?.data['headers'],
    ).toBeUndefined();
  });

  it('correlates overlapping streams by id, not only their shared URL', () => {
    const merged = mergeNetworkDetail([
      request('n1'),
      request('n2'),
      detail('n2', 'data: second\n\n'),
      detail('n1', 'data: first\n\n'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((event) => 'n1' === event.data['id'])?.data['responseBody']).toBe(
      'data: first\n\n',
    );
    expect(merged.find((event) => 'n2' === event.data['id'])?.data['responseBody']).toBe(
      'data: second\n\n',
    );
  });

  it.each([
    { id: 'other', fields: {} },
    { id: 'n1', fields: { url: '/api/other' } },
    { id: 'n1', fields: { method: 'GET' } },
  ])(
    'does not attach response data from an unmatched observation: $id $fields',
    ({ id, fields }) => {
      const merged = mergeNetworkDetail([request('n1'), detail(id, 'data: other\n\n', fields)]);
      expect(
        merged.find((event) => EventType.NET_REQUEST === event.type)?.data['responseBody'],
      ).toBeUndefined();
    },
  );

  it.each([false, true])('judges a body detail with truncated=$truncated', (truncated) => {
    const events = [
      request('n1'),
      detail('n1', 'data: hello\n\n', truncated ? { responseBodyTruncated: true } : {}),
    ];
    expect(
      evalNet(events, { kind: 'net', urlContains: '/api/chat', bodyContains: 'hello', count: 1 })
        .pass,
    ).toBe(true);
    const missed = evalNet(events, {
      kind: 'net',
      urlContains: '/api/chat',
      bodyContains: 'goodbye',
    });
    expect(missed.pass).toBe(false);
    expect(missed.inconclusive !== undefined).toBe(truncated);
    if (truncated) {
      expect(missed.failureReason).toBeUndefined();
    } else {
      expect(missed.failureReason).toBeDefined();
    }
  });
});
