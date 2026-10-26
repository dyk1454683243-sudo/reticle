/**
 * The agent link row of `reticle doctor`, as one pure decision (reticlehq/reticle#1710).
 *
 * The row used to be built inline from the attach record alone: once a client had attached,
 * enumerated and called, it stayed green forever, and a client that had started but never listed
 * was told to restart the client. Both answers are wrong when the port is held but `/status`
 * does not answer: the record cannot say whether the link works now, and the daemon row above
 * already names the one fix for the held port. So in that state this row only points back at
 * the daemon row. It never prints a second command, and it never says "the daemon", because
 * this state also covers a port held by a different program.
 *
 * The record and action strings below are copied verbatim from the inline row this replaces;
 * this module changes their priority, not their words.
 */

export interface AgentLinkInput {
  /** The split-brain sentence, when this project is served by another daemon. */
  split: string | undefined;
  /** The attach-record action, or undefined when the record says the link worked. */
  attachAction: string | undefined;
  /** True when the port is held but `/status` does not answer. */
  foreign: boolean;
}

/** The healthy-record sentence, word for word as doctor printed it before. */
const RECORD_HEALTHY =
  '✓ an MCP client attached here and called tools before (a record, not a live check)';

export function agentLinkText(input: AgentLinkInput): string {
  if (input.split !== undefined) {
    return `✗ ${input.split}`;
  }
  if (input.foreign) {
    return '✗ the agent link is not checked live here — follow the daemon row above.';
  }
  if (input.attachAction === undefined) {
    return RECORD_HEALTHY;
  }
  return `✗ ${input.attachAction}`;
}
