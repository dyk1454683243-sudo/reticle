/**
 * What the panel's Harness controls asked for, narrowed at the boundary: the autonomous switch,
 * Run Harness (with an optional persona), or Stop. Keyed by the control's own wire kind.
 *
 * The switch carries `on`/`off` rather than meaning "toggle": a double-click on a flaky connection
 * sends two, and two toggles land back where they started while two `on`s are the same as one.
 */
import { EventType, HumanControlKind } from '@reticlehq/core';

export type HarnessRequest =
  | { kind: typeof HumanControlKind.HARNESS; enabled: boolean }
  | { kind: typeof HumanControlKind.HARNESS_RUN; persona?: string }
  | { kind: typeof HumanControlKind.HARNESS_STOP }
  | { kind: typeof HumanControlKind.HARNESS_LINK };

export function harnessRequest(event: {
  type: string;
  data: Record<string, unknown>;
}): HarnessRequest | undefined {
  if (event.type !== EventType.HUMAN_CONTROL) return undefined;
  const kind = event.data['kind'];
  const text = event.data['text'];
  if (HumanControlKind.HARNESS_STOP === kind || HumanControlKind.HARNESS_LINK === kind)
    return { kind };
  if (HumanControlKind.HARNESS_RUN === kind) {
    const persona = 'string' === typeof text ? text.trim() : '';
    return 0 < persona.length ? { kind, persona } : { kind };
  }
  if (HumanControlKind.HARNESS !== kind) return undefined;
  if ('on' === text) return { kind, enabled: true };
  if ('off' === text) return { kind, enabled: false };
  return undefined;
}

/** The flow name if this event is a panel ▶ replay request, else undefined. Pure boundary narrowing. */
export function replayRequest(event: {
  type: string;
  data: Record<string, unknown>;
}): string | undefined {
  if (event.type !== EventType.HUMAN_CONTROL) {
    return undefined;
  }
  if (event.data['kind'] !== HumanControlKind.REPLAY) {
    return undefined;
  }
  const name = event.data['text'];
  return 'string' === typeof name && name.length > 0 ? name : undefined;
}

/** True when this event is the panel's Sign in. Pure boundary narrowing, like the above. */
export function isSigninRequest(event: { type: string; data: Record<string, unknown> }): boolean {
  return event.type === EventType.HUMAN_CONTROL && event.data['kind'] === HumanControlKind.SIGNIN;
}

/** True when this event is the panel's "sync now" button. Pure boundary narrowing, like the above. */
export function isSyncRequest(event: { type: string; data: Record<string, unknown> }): boolean {
  return event.type === EventType.HUMAN_CONTROL && event.data['kind'] === HumanControlKind.SYNC;
}
