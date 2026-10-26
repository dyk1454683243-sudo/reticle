import { LOOPBACK_HOST } from '@reticlehq/core';

/** One parsed Server-Sent-Events frame: the event name (defaulted to "message") and its data. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental SSE frame parser for the MCP front door.
 *
 * A single SSE field can split across TCP reads (`da` in one chunk, `ta: {...}` in the next), and a
 * server may send CRLF or bare CR line endings — so the framing is stateful and edge-case-prone, yet it
 * carried every MCP message the agent sends and was only ever exercised end-to-end. Pulled out of the
 * socket handler as a pure, chunk-fed parser so those boundaries are unit-testable: feed raw chunks,
 * get back each complete frame (a blank line terminates a frame; `event:` names it, `data:` lines
 * accumulate newline-joined; `id:`/`retry:`/comments are ignored — not needed for the bridge).
 */
export class SseFrameParser {
  #buffer = '';
  #event = '';
  #data = '';

  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    // Normalise CRLF/CR so the splitter only handles \n, then hold the trailing partial line for the
    // next chunk (it may complete later).
    const normalised = this.#buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalised.split('\n');
    this.#buffer = lines.pop() ?? '';
    const frames: SseFrame[] = [];
    for (const line of lines) {
      if ('' === line) {
        if (this.#data !== '') {
          frames.push({ event: this.#event !== '' ? this.#event : 'message', data: this.#data });
        }
        this.#event = '';
        this.#data = '';
      } else if (line.startsWith('event:')) {
        this.#event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const val = line.slice(5).trim();
        this.#data = this.#data !== '' ? `${this.#data}\n${val}` : val;
      }
    }
    return frames;
  }
}

/**
 * Turn an `endpoint` frame's data into a POST target, or null when there is nothing usable in it.
 *
 * An empty (or whitespace) data field is the shape a malformed daemon response takes, and it used to
 * be accepted: `postUrl` became `''`, which is not `null`, so the proxy considered itself CONNECTED
 * and posted every subsequent message to the empty string. Each one failed, the queue never armed
 * its deadline because nothing was ever queued, and the agent held a session that could not carry a
 * single call. Refusing the frame keeps the proxy in its disconnected path, which already knows how
 * to reconnect and how to answer what it cannot send.
 */
export function buildSessionUrl(rawData: string, port: number): string | null {
  const trimmed = rawData.trim();
  if ('' === trimmed) {
    return null;
  }
  return trimmed.startsWith('/') ? `http://${LOOPBACK_HOST}:${port}${trimmed}` : trimmed;
}
