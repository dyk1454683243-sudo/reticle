import { describe, expect, it } from 'vitest';
import { EventType } from './constants/constants.js';
import { isHighValueEvent } from './event-priority.js';

describe('network body event priority', () => {
  it('reserves rate-cap budget for response bodies captured after headers', () => {
    expect(isHighValueEvent(EventType.NET_RESPONSE_BODY)).toBe(true);
  });
});
