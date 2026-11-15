import { describe, expect, test } from "bun:test";
import { createAgyInteractiveDelivery, isTerminalReply, sanitizeAgyWake } from "./agy-interactive";

const SID = "c7228f22-85bb-49d1-9de4-b2c8c16505a0";
const NOW = Date.parse("2026-10-29T15:37:43.750Z");
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 3));
const row = (type: string, content: string, step: number, extra = {}) => JSON.stringify({ type, content, step_index: step,
  created_at: "2026-10-29T15:37:43Z", ...extra }) + "\n";
const done = (step = 1, extra = {}) => row("PLANNER_RESPONSE", "Completed.", step, { status: "DONE", ...extra });

function fixture(options: { autoAck?: boolean; throwWrite?: boolean; initial?: string; sid?: string } = {}) {
  let buffer = Buffer.from(options.initial ?? done());
  let live = true;
  let idle = true;
  let readable = true;
  let count = 1;
  const writes: string[] = [];
  const append = (value: string) => { buffer = Buffer.concat([buffer, Buffer.from(value)]); };
  const user = (content: string, extra = {}) => append(row("USER_INPUT", content, ++count, extra));
  const payload = () => writes.at(-1)!.slice("\x1b[200~".length, -"\x1b[201~\r".length);
  const delivery = createAgyInteractiveDelivery({
    sessionId: options.sid ?? SID,
    isLive: () => live,
    isIdle: () => idle,
    now: () => NOW,
    sleep: () => new Promise<void>(resolve => setTimeout(resolve, 1)),
    readTranscript: () => { if (!readable) throw Error("native read unavailable"); return buffer; },
    write: data => { writes.push(data); if (options.autoAck) user(payload()); if (options.throwWrite) throw Error("partial write"); },
  });
  return { delivery, writes, append, user, payload,
    final: () => append(done(++count)),
    setLive: (value: boolean) => { live = value; },
    setIdle: (value: boolean) => { idle = value; },
    setReadable: (value: boolean) => { readable = value; },
    replace: (value: string) => { buffer = Buffer.from(value); } };
}

describe("Antigravity interactive native acknowledgment", () => {
  test("does not advance before exact native USER_INPUT, then accepts wrapped native input", async () => {
    const f = fixture(); let settled = false;
    const p = f.delivery.push("scheduled work").then(value => { settled = true; return value; });
    await tick(); expect(settled).toBe(false); expect(f.writes).toHaveLength(1);
    f.user("<USER_REQUEST>\n" + f.payload() + "\n</USER_REQUEST>");
    expect(await p).toMatchObject({ accepted: true }); expect((await f.delivery.dispose()).deliveryUncertain).toBe(false);
  });
  test("native DONE already logged before ACK supplies exact completion proof", async () => {
    const f = fixture(); const p = f.delivery.push("fast wake"); f.user(f.payload()); f.final();
    const result = await p;
    expect(result).toMatchObject({ accepted: true });
    if (typeof result !== "object") throw Error("native accepted receipt expected");
    expect(await result.completion).toEqual({ outcome: "succeeded" }); await f.delivery.dispose();
  });
  test("native ERROR logged after early ACK supplies a failed completion", async () => {
    const f = fixture(); const p = f.delivery.push("fast error"); f.user(f.payload()); const result = await p;
    if (typeof result !== "object") throw Error("native accepted receipt expected");
    f.append(row("PLANNER_RESPONSE", "Provider quota exhausted", 3, { status: "ERROR" }));
    expect(await result.completion).toEqual({ outcome: "failed", failureReason: "api_error" }); await f.delivery.dispose();
  });
  test("native DONE with tool calls is not task completion", async () => {
    const f = fixture(); const p = f.delivery.push("work"); f.user(f.payload());
    f.append(done(3, { tool_calls: [{ id: "unfinished" }] })); const result = await p;
    if (typeof result !== "object") throw Error("native accepted receipt expected");
    let ended = false; void result.completion?.then(() => { ended = true; }); await tick(); expect(ended).toBe(false);
    f.final(); expect(await result.completion).toEqual({ outcome: "succeeded" }); await f.delivery.dispose();
  });
  test("a later human turn's final response is not completion for this wake", async () => {
    const f = fixture(); const p = f.delivery.push("work"); f.user(f.payload()); const result = await p;
    if (typeof result !== "object") throw Error("native accepted receipt expected");
    f.user("a new human turn"); f.final(); expect(await result.completion).toBeUndefined(); await f.delivery.dispose();
  });
  test("malformed, stale or future final responses cannot certify native completion", async () => {
    for (const extra of [{ step_index: 2 }, { step_index: false }, { step_index: 3.5 },
        { created_at: "2026-10-29T15:37:42Z" }, { created_at: "2026-10-29T15:37:44Z" }, { created_at: "invalid" }]) {
      const f = fixture(); const p = f.delivery.push("work"); f.user(f.payload()); const result = await p;
      if (typeof result !== "object") throw Error("native accepted receipt expected");
      f.append(done(3, extra)); let ended = false; void result.completion?.then(() => { ended = true; });
      await tick(); expect(ended).toBe(false); f.final();
      expect(await result.completion).toEqual({ outcome: "succeeded" }); await f.delivery.dispose();
    }
  });
  test("same in-flight retry reuses one write and promise", async () => {
    const f = fixture(); const a = f.delivery.push("wake"); const b = f.delivery.push("wake");
    expect(a).toBe(b); expect(f.writes).toHaveLength(1); f.user(f.payload());
    expect(await a).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("a different queued prompt cannot write while acknowledgment is pending", async () => {
    const f = fixture(); const p = f.delivery.push("first");
    expect(await f.delivery.push("second")).toBe(false); expect(f.writes).toHaveLength(1);
    f.user(f.payload()); expect(await p).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("successive identical scheduled text runs again after native completion", async () => {
    const f = fixture({ autoAck: true });
    expect(await f.delivery.push("same recurring wake")).toMatchObject({ accepted: true }); f.final();
    expect(await f.delivery.push("same recurring wake")).toMatchObject({ accepted: true });
    expect(f.writes).toHaveLength(2); await f.delivery.dispose();
  });
  test("a write exception may still receive a real native acknowledgment", async () => {
    const f = fixture({ throwWrite: true }); const p = f.delivery.push("wake");
    await tick(); f.user(f.payload()); expect(await p).toMatchObject({ accepted: true });
    expect(f.writes).toHaveLength(1); expect((await f.delivery.dispose()).deliveryUncertain).toBe(false);
  });
  test("partial write without acknowledgment is uncertain on exit and never retransmitted", async () => {
    const f = fixture({ throwWrite: true }); const p = f.delivery.push("wake");
    expect(f.delivery.push("wake")).toBe(p); f.setLive(false);
    expect((await f.delivery.dispose()).deliveryUncertain).toBe(true); expect(await p).toBe(false);
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(1);
  });
  test("late native acknowledgment before exit settlement prevents a false duplicate", async () => {
    const f = fixture(); const p = f.delivery.push("wake");
    f.setLive(false); f.user(f.payload());
    expect(await p).toMatchObject({ accepted: true }); expect((await f.delivery.dispose()).deliveryUncertain).toBe(false);
  });
  test("a normal PTY exit before any write remains safe for headless rerouting", async () => {
    const f = fixture(); expect((await f.delivery.dispose()).deliveryUncertain).toBe(false);
    expect(f.writes).toHaveLength(0);
  });
  test("unavailable native reads after writing never cause another write", async () => {
    const f = fixture(); const p = f.delivery.push("wake"); f.setReadable(false); await tick();
    expect(f.delivery.push("wake")).toBe(p); f.setLive(false);
    expect((await f.delivery.dispose()).deliveryUncertain).toBe(true); expect(f.writes).toHaveLength(1);
  });
  test("replaced native transcript cannot acknowledge a previous submission", async () => {
    const f = fixture(); const p = f.delivery.push("wake");
    f.replace(done(100) + row("USER_INPUT", f.payload(), 101)); await tick(); f.setLive(false);
    expect(await p).toBe(false); expect((await f.delivery.dispose()).deliveryUncertain).toBe(true);
  });
  test("mismatched, duplicated or old native input is never an acknowledgment", async () => {
    for (const mode of ["mismatched", "duplicate", "old"]) {
      const f = fixture(); const p = f.delivery.push("wake");
      if (mode === "mismatched") f.user("different human input");
      else if (mode === "duplicate") { f.user(f.payload()); f.user(f.payload()); }
      else f.user(f.payload(), { created_at: "2026-10-29T15:37:42Z" });
      await tick(); f.setLive(false); expect(await p).toBe(false);
      expect((await f.delivery.dispose()).deliveryUncertain).toBe(true); expect(f.writes).toHaveLength(1);
    }
  });
});

describe("Antigravity draft and idle safeguards", () => {
  test("an ended native ERROR permits a later wake without changing approval or draft guards", async () => {
    const f = fixture({ autoAck: true, initial: done(1, { status: "ERROR" }) });
    f.setIdle(false); expect(await f.delivery.push("retry after recovery")).toBe(false);
    f.setIdle(true); expect(await f.delivery.push("retry after recovery")).toMatchObject({ accepted: true });
    expect(f.writes).toHaveLength(1); await f.delivery.dispose();
  });
  test("preserves human drafts until an actual human submission completed", async () => {
    const f = fixture({ autoAck: true }); f.delivery.onUserInput("my draft");
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(0);
    f.delivery.onUserInput("\r"); f.user("my draft"); f.final(); expect(await f.delivery.push("wake")).toMatchObject({ accepted: true });
    await f.delivery.dispose();
  });
  test("native wake acknowledgment does not clear human input racing after its write", async () => {
    const f = fixture(); const p = f.delivery.push("first"); f.delivery.onUserInput("human draft");
    f.user(f.payload()); expect(await p).toMatchObject({ accepted: true }); f.final();
    expect(await f.delivery.push("second")).toBe(false); expect(f.writes).toHaveLength(1);
    f.delivery.onUserInput("\r"); f.user("human draft"); f.final(); const next = f.delivery.push("second"); f.user(f.payload());
    expect(await next).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("human fence starts at a full JSONL boundary even during partial native output", async () => {
    const f = fixture({ autoAck: true }); f.append('{"type":"TOOL_OUTPUT","content":');
    f.delivery.onUserInput("draft"); f.delivery.onUserInput("\r"); f.append('"result"}\n'); f.user("draft"); f.final();
    expect(await f.delivery.push("wake")).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("previous Enter acknowledgment cannot clear a newer unsubmitted human draft", async () => {
    const f = fixture();
    f.delivery.onUserInput("first human turn"); f.delivery.onUserInput("\r");
    f.delivery.onUserInput("second draft"); f.user("first human turn"); f.final();
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(0);
    f.delivery.onUserInput("\r"); f.user("second draft"); f.final();
    const p = f.delivery.push("wake"); f.user(f.payload()); expect(await p).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("two human submissions queued before logging require both acknowledgments", async () => {
    const f = fixture();
    f.delivery.onUserInput("first"); f.delivery.onUserInput("\r");
    f.delivery.onUserInput("second"); f.delivery.onUserInput("\r");
    f.user("first"); f.final();
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(0);
    f.user("second"); f.final(); const p = f.delivery.push("wake"); f.user(f.payload());
    expect(await p).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("a newline inside a pasted packet does not acknowledge the editor", async () => {
    const f = fixture(); f.delivery.onUserInput("\x1b[200~my\r\npaste\x1b[201~");
    f.user("prior unrelated turn"); f.final();
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(0); await f.delivery.dispose();
  });
  test("terminal query responses do not create a false human draft", async () => {
    const f = fixture({ autoAck: true });
    for (const reply of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n", "\x1b[12;34R", "\x1b[?12;34R", "\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\", "\x1b[I", "\x1b[O"])
      f.delivery.onUserInput(reply);
    expect(await f.delivery.push("wake")).toMatchObject({ accepted: true }); await f.delivery.dispose();
  });
  test("mixed report and human text stays fenced", async () => {
    const f = fixture(); f.delivery.onUserInput("\x1b[0nmy draft");
    expect(await f.delivery.push("wake")).toBe(false); expect(f.writes).toHaveLength(0); await f.delivery.dispose();
  });
  test("busy, pending approval, nonnative idle and malformed state cannot write", async () => {
    const f = fixture(); f.setIdle(false); expect(await f.delivery.push("wake")).toBe(false); await f.delivery.dispose();
    for (const initial of [row("USER_INPUT", "active", 1), done(1, { tool_calls: [{ id: "pending" }] }), done(1, { status: "STREAMING" }), done().trimEnd(), "bad json\n", ""])
    { const q = fixture({ initial }); expect(await q.delivery.push("wake")).toBe(false); expect(q.writes).toHaveLength(0); await q.delivery.dispose(); }
  });
  test("invalid conversation identity and no transcript fail closed", async () => {
    const f = fixture({ sid: "other" }); expect(await f.delivery.push("wake")).toBe(false); await f.delivery.dispose();
    const q = fixture(); q.setReadable(false); expect(await q.delivery.push("wake")).toBe(false); expect(q.writes).toHaveLength(0); await q.delivery.dispose();
  });
  test("terminal escape injection cannot terminate paste or submit extra commands", async () => {
    const f = fixture({ autoAck: true });
    expect(await f.delivery.push("hello\x1b[201~\r\n\x00\x03world\x9bmore")).toMatchObject({ accepted: true });
    const write = f.writes[0]; expect(write.match(/\x1b\[200~/g)).toHaveLength(1);
    expect(write.match(/\x1b\[201~/g)).toHaveLength(1); expect(write.match(/\r/g)).toHaveLength(1);
    expect(write.endsWith("\x1b[201~\r")).toBe(true); await f.delivery.dispose();
  });
  test("only whole recognized terminal replies bypass human fencing", () => {
    expect(isTerminalReply("\x1b[0n\x1b[?1;2c")).toBe(true);
    expect(isTerminalReply("\x1b[A")).toBe(false); expect(isTerminalReply("normal text")).toBe(false);
    expect(isTerminalReply("\x1b[0nmanual")).toBe(false); expect(isTerminalReply("")).toBe(false);
    expect(sanitizeAgyWake("a\r\nb\rc\x1b\x03")).toBe("a\nb\nc");
  });
});
