import { describe, expect, test } from "bun:test";
import { harnessLabel } from "@shared/agent";
import { AGY_GATED_TOOL_MATCHER, AGY_SKIP_PERMISSIONS, agyHarness, agyHooksJson } from "./agy";
import { harnessFor } from "./index";
import { agyConfigHasRobinhood } from "./robinhood-mcp";

const SKIP = "--dangerously-skip-permissions";

test("skip-permissions flag constant matches agy's CLI flag", () => {
  expect(AGY_SKIP_PERMISSIONS).toBe(SKIP);
});

describe("agyHarness argv builders", () => {
  test("interactive start with kickoff: full-permission mode, kickoff via -i", () => {
    expect(agyHarness.interactiveArgs("start", "sid-1", "hello agent")).toEqual([
      "--model",
      "claude-sonnet-5-5-high",
      SKIP,
      "-i",
      "hello agent",
    ]);
  });

  test("interactive start without kickoff still runs in full-permission mode", () => {
    expect(agyHarness.interactiveArgs("start", "sid-1")).toEqual([
      "--model",
      "claude-sonnet-5-5-high",
      SKIP,
    ]);
    expect(agyHarness.interactiveArgs("start", "sid-1", null)).toEqual([
      "--model",
      "claude-sonnet-5-5-high",
      SKIP,
    ]);
  });

  test("interactive resume targets the conversation id in full-permission mode", () => {
    expect(agyHarness.interactiveArgs("resume", "conv-2")).toEqual([
      "--conversation",
      "conv-2",
      "--model",
      "claude-sonnet-5-5-high",
      SKIP,
    ]);
  });

  test("headless resume: skip-permissions one-shot with the wake prompt", () => {
    expect(agyHarness.headlessArgs("resume", "conv-3", "[OPENTRADE WAKE t] go")).toEqual([
      "--conversation",
      "conv-3",
      "--model",
      "claude-sonnet-5-5-high",
      "--dangerously-skip-permissions",
      "-p",
      "[OPENTRADE WAKE t] go",
    ]);
  });

  test("headless start mints a fresh conversation", () => {
    expect(agyHarness.headlessArgs("start", "ignored", "p")).toEqual([
      "--model",
      "claude-sonnet-5-5-high",
      "--dangerously-skip-permissions",
      "-p",
      "p",
    ]);
  });

  test("interactive env flags the harness so agent-mcp skips the wake poller", () => {
    expect(agyHarness.interactiveEnv()).toEqual({ OPENTRADE_HARNESS: "agy" });
  });

  test("uses AGENTS.md and is registered", () => {
    expect(agyHarness.instructionsFile).toBe("AGENTS.md");
    expect(harnessFor("agy")).toBe(agyHarness);
    expect(harnessLabel("agy")).toBe("Antigravity");
  });

  test("API-key billing env vars are stripped", () => {
    expect(agyHarness.subscriptionAuthStrip).toContain("GEMINI_API_KEY");
    expect(agyHarness.subscriptionAuthStrip).toContain("GOOGLE_API_KEY");
  });
});

describe("agyHooksJson", () => {
  const parsed = JSON.parse(agyHooksJson("/tmp/agent", "agent-123"));
  const hooks = parsed.opentrade;

  test("top-level key is a named hook, not `hooks`", () => {
    expect(Object.keys(parsed)).toEqual(["opentrade"]);
  });

  test("SessionStart and Stop are flat handler lists", () => {
    for (const ev of ["SessionStart", "Stop"]) {
      expect(hooks[ev][0].type).toBe("command");
      expect(hooks[ev][0].matcher).toBeUndefined();
      expect(hooks[ev][0].command).toContain(`' ${ev}`);
      expect(hooks[ev][0].command).toContain("OPENTRADE_AGENT_ID='agent-123'");
    }
  });

  test("Pre/PostToolUse are grouped and gate lazy-loaded MCP calls", () => {
    for (const ev of ["PreToolUse", "PostToolUse"]) {
      expect(hooks[ev][0].matcher).toBe(AGY_GATED_TOOL_MATCHER);
      expect(hooks[ev][0].hooks[0].command).toContain(`' ${ev}`);
    }
    expect(AGY_GATED_TOOL_MATCHER).toContain("call_mcp_tool");
    // The approval gate must outlast a human reviewing the order.
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThanOrEqual(600);
  });
});

describe("agyConfigHasRobinhood", () => {
  test("finds a server by URL regardless of its name", () => {
    const cfg = JSON.stringify({
      mcpServers: { robinhood: { serverUrl: "https://agent.robinhood.com/mcp/trading" } },
    });
    expect(agyConfigHasRobinhood(cfg)).toBe(true);
  });

  test("other servers / empty / malformed are a no", () => {
    expect(
      agyConfigHasRobinhood(
        JSON.stringify({ mcpServers: { posthog: { url: "https://mcp.posthog.com/mcp" } } }),
      ),
    ).toBe(false);
    expect(agyConfigHasRobinhood(JSON.stringify({ mcpServers: {} }))).toBe(false);
    expect(agyConfigHasRobinhood("")).toBe(false);
    expect(agyConfigHasRobinhood("{ nope")).toBe(false);
  });
});
