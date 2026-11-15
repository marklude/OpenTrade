import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatWakePrompt } from "../scheduler/wake/prompt";
import type { InteractivePush, InteractivePushResult, WakeResult } from "../scheduler/wake/types";

interface NativeRow {
  type?: string;
  content?: unknown;
  status?: string;
  step_index?: unknown;
  created_at?: unknown;
  tool_calls?: unknown;
}
interface Snapshot { bytes: number; rows: NativeRow[]; complete: boolean }

/** AGY has no Claude channel or Codex app-server transport. Submit to its sole
 * live PTY, and advance the durable queue only after that exact native user turn.
 * A delayed acknowledgment must NEVER cause a second write of the same prompt.
 */
export interface AgyInteractiveDependencies {
  sessionId: string;
  isLive(): boolean;
  isIdle(): boolean;
  write(data: string): void;
  readTranscript(): Buffer;
  now?: () => number;
  sleep?: () => Promise<void>;
}

export function agyTranscriptPath(sessionId: string): string | undefined {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) return;
  const paths = ["antigravity-cli", "antigravity"]
    .map(root => join(homedir(), ".gemini", root, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"))
    .filter(path => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
  // Never borrow another conversation or pick one of two ambiguous sources.
  return paths.length === 1 ? paths[0] : undefined;
}

export function readAgyTranscript(sessionId: string): Buffer {
  const path = agyTranscriptPath(sessionId);
  if (!path) throw new Error("Exact Antigravity transcript unavailable");
  return readFileSync(path);
}

export function sanitizeAgyWake(prompt: string): string {
  // Keep text/newlines, but remove terminal control and bracketed-paste escape
  // injection. CR is text LF inside the bracketed paste, never an extra submit.
  return prompt.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function snapshot(raw: Buffer): Snapshot {
  if (raw.length > 16 * 1024 * 1024) throw new Error("Native transcript too large");
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  const complete = lines.pop() === "";
  const rows = lines.filter(Boolean).map(line => JSON.parse(line) as NativeRow);
  return { bytes: raw.length, rows, complete };
}

function userText(row: NativeRow): string | undefined {
  if (row.type !== "USER_INPUT" || typeof row.content !== "string" ||
      typeof row.step_index !== "number" || !Number.isInteger(row.step_index) || row.step_index < 0 ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) return;
  const text = row.content.replace(/\r\n?/g, "\n").trim();
  return text.startsWith("<USER_REQUEST>\n") && text.endsWith("\n</USER_REQUEST>")
    ? text.slice("<USER_REQUEST>\n".length, -"\n</USER_REQUEST>".length) : text;
}

function nativeIdle(value: Snapshot): boolean {
  if (!value.complete) return false;
  const last = value.rows.filter(row => row.type === "USER_INPUT" || row.type === "PLANNER_RESPONSE").at(-1);
  return last?.type === "PLANNER_RESPONSE" && (last.status === "DONE" || last.status === "ERROR") &&
    typeof last.content === "string" && last.content.trim().length > 0 &&
    (last.tool_calls == null || (Array.isArray(last.tool_calls) && last.tool_calls.length === 0));
}

/** Xterm also sends automatic device/status replies through onData. Only a
 * complete, recognized reply is exempt from the human-draft fence; unknown or
 * mixed input remains conservatively fenced. */
export function isTerminalReply(data: string): boolean {
  if (!data) return false;
  const reports = /(?:\x1b\[(?:[?>]?[0-9;]*c|[0-9]+n|[?]?[0-9]+;[0-9]+R|[IO])|\x1b\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\))/g;
  return data.replace(reports, "") === "";
}

export function createAgyInteractiveDelivery(deps: AgyInteractiveDependencies): {
  push: InteractivePush;
  onUserInput(data: string): void;
  dispose(): Promise<{ deliveryUncertain: boolean }>;
} {
  const sleep = deps.sleep ?? (() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  const now = deps.now ?? Date.now;
  let disposed = false;
  let humanFence: { cursor: number; prefix: Buffer; ignorePayload?: string; submissions: number; lastInputWasSubmit: boolean } | undefined;
  let pending: { raw: string; payload: string; cursor: number; prefix: Buffer; submittedAt: number; promise: Promise<InteractivePushResult> } | undefined;
  let deliveryUncertain = false;

  function after(cursor: number, prefix: Buffer): Snapshot {
    const raw = deps.readTranscript();
    if (raw.length < cursor || !raw.subarray(0, cursor).equals(prefix)) throw new Error("Native transcript was replaced or truncated");
    return snapshot(raw.subarray(cursor));
  }
  function draftPending(): boolean {
    if (!humanFence) return false;
    const fence = humanFence;
    const rows = after(fence.cursor, fence.prefix).rows;
    // A real user turn after the last input acknowledges that editor input.
    // Our pending wake does not acknowledge human typing that raced with it.
    const humanSteps = new Set(rows.filter(row => {
      const text = userText(row);
      return text !== undefined && text !== fence.ignorePayload;
    }).map(row => row.step_index));
    if (fence.lastInputWasSubmit && fence.submissions > 0 && humanSteps.size >= fence.submissions) humanFence = undefined;
    return humanFence !== undefined;
  }

  async function observeCompletion(task: { cursor: number; prefix: Buffer; payload: string }): Promise<WakeResult | undefined> {
    for (;;) {
      try {
        const rows = after(task.cursor, task.prefix).rows;
        const first = rows.findIndex(row => row.type === "USER_INPUT");
        if (first >= 0 && userText(rows[first]) === task.payload) {
          for (const row of rows.slice(first + 1)) {
            // A later user turn is not this wake's completion proof.
            if (row.type === "USER_INPUT") return;
            if (row.type !== "PLANNER_RESPONSE" || (row.status !== "DONE" && row.status !== "ERROR") ||
                typeof row.step_index !== "number" || !Number.isInteger(row.step_index) || row.step_index <= Number(rows[first].step_index) ||
                typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
                Date.parse(row.created_at) < Date.parse(String(rows[first].created_at)) || Date.parse(row.created_at) > now() ||
                typeof row.content !== "string" || !row.content.trim() ||
                !(row.tool_calls == null || (Array.isArray(row.tool_calls) && row.tool_calls.length === 0))) continue;
            return row.status === "ERROR" ? { outcome: "failed", failureReason: "api_error" } : { outcome: "succeeded" };
          }
        }
      } catch {
        // Missing/partial native data is not completion; normal hooks and exit
        // handling remain available. Never invent an outcome from elapsed time.
      }
      if (disposed || !deps.isLive()) return;
      await sleep();
    }
  }

  const push: InteractivePush = (raw) => {
    if (pending) return pending.raw === raw ? pending.promise : Promise.resolve(false);
    try {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(deps.sessionId) || disposed || !deps.isLive() || !deps.isIdle() || draftPending()) return Promise.resolve(false);
      const beforeRaw = deps.readTranscript();
      const before = snapshot(beforeRaw);
      if (!nativeIdle(before)) return Promise.resolve(false);
      const text = sanitizeAgyWake(raw).trim();
      if (!text.trim() || text.length > 256 * 1024) return Promise.resolve(false);
      const submittedAt = now();
      const payload = formatWakePrompt(text, submittedAt);
      // All checks + one atomic PTY write occur before yielding the event loop.
      // No Ctrl-U/Ctrl-C: a human draft or active native turn is never erased.
      const task = { raw, payload, cursor: before.bytes, prefix: Buffer.from(beforeRaw), submittedAt, promise: undefined as unknown as Promise<InteractivePushResult> };
      pending = task;
      try { deps.write("\x1b[200~" + payload + "\x1b[201~\r"); }
      catch {
        // A throwing PTY write may have fully or partially succeeded. Still
        // inspect native acknowledgment; never retransmit uncertain bytes.
        deliveryUncertain = true;
      }
      task.promise = (async () => {
        for (;;) {
          try {
            const rows = after(task.cursor, task.prefix).rows.filter(row => row.type === "USER_INPUT");
            const users = rows.map(userText);
            if (users.length > 0) {
              // Whole-second native timestamps represent an interval. Never
              // accept an older turn merely because its text matches.
              const created = Date.parse(String(rows[0].created_at));
              const timely = created >= Math.floor(task.submittedAt / 1000) * 1000 && created <= now();
              if (users[0] === payload && users.filter(value => value === payload).length === 1 && timely) {
                deliveryUncertain = false;
                return { accepted: true as const, completion: observeCompletion(task) };
              }
              deliveryUncertain = true;
            }
          } catch {
            // Written but unacknowledged is uncertain: keep the same in-flight
            // request; never retype it on a polling/read/parse failure.
          }
          if (disposed || !deps.isLive()) {
            deliveryUncertain = true;
            return false;
          }
          await sleep();
        }
      })();
      // Keep an unacknowledged written request cached even if the PTY dies or
      // native input differs; a same-session retry cannot write it twice.
      void task.promise.then(result => { if ((result === true || (typeof result === "object" && result.accepted)) && pending === task) pending = undefined; });
      return task.promise;
    } catch {
      return Promise.resolve(false); // no bytes were written
    }
  };

  return {
    push,
    onUserInput(data) {
      if (!data || isTerminalReply(data)) return;
      const submit = data === "\r" || data === "\n" || data === "\r\n";
      try {
        // Retain the first cursor until all observed explicit submissions are
        // acknowledged. Typing a new draft after Enter must not be cleared by
        // the previous submission's delayed native USER_INPUT record.
        draftPending();
        if (!humanFence) {
          const raw = deps.readTranscript();
          const cursor = raw.lastIndexOf(10) + 1;
          humanFence = { cursor, prefix: Buffer.from(raw.subarray(0, cursor)), ignorePayload: pending?.payload,
            submissions: 0, lastInputWasSubmit: false };
        }
        if (submit) humanFence.submissions++;
        humanFence.lastInputWasSubmit = submit;
      } catch {
        humanFence = { cursor: Number.MAX_SAFE_INTEGER, prefix: Buffer.alloc(0), ignorePayload: pending?.payload,
          submissions: 0, lastInputWasSubmit: false };
      }
    },
    async dispose() {
      disposed = true;
      // Let the queue's push acknowledgment settle before TerminalService reports
      // writer-down and the coordinator considers the headless route.
      await pending?.promise;
      return { deliveryUncertain };
    },
  };
}
