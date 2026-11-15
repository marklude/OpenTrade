import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OPENTRADE_HOME } from "../../db/client";
import { resolveHooksDir } from "../agents/paths";
import { agyConfigHasRobinhood } from "./robinhood-mcp";
import type { Harness, ProbeResult, SessionMode } from "./types";

const execFileAsync = promisify(execFile);

export function resolveAgyBin(): string {
  if (process.env.OPENTRADE_AGY_BIN) return process.env.OPENTRADE_AGY_BIN;
  if (process.env.NODE_ENV === "test") return "agy";
  const h = homedir();
  const candidates = [
    join(h, ".local", "bin", "agy"),
    join(h, "bin", "agy"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of candidates) {
    const p = dir.endsWith("agy") ? dir : join(dir, "agy");
    if (existsSync(p)) return p;
  }
  return "agy";
}

const AGY_BIN = resolveAgyBin();

export const AGY_DEFAULT_MODEL = "claude-sonnet-5-5-high";
export const AGY_MODEL = process.env.OPENTRADE_AGY_MODEL ?? AGY_DEFAULT_MODEL;

/** agy's auto-approve flag; OpenTrade's PreToolUse hook remains the order gate. */
export const AGY_SKIP_PERMISSIONS = "--dangerously-skip-permissions";

export function agyConversationExists(conversationId: string): boolean {
  if (!conversationId) return false;
  if (process.env.NODE_ENV === "test") return true;
  const h = homedir();
  return (
    existsSync(join(h, ".gemini", "antigravity", "brain", conversationId)) ||
    existsSync(join(h, ".gemini", "antigravity-cli", "brain", conversationId))
  );
}

export const AGY_SUBSCRIPTION_AUTH_STRIP = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

export const AGY_GATED_TOOL_MATCHER =
  "call_mcp_tool|mcp_robinhood_.*|mcp__robinhood__.*|mcp_robinhood_trading_.*|mcp__robinhood-trading__.*";

export function agyHooksJson(agentDir: string, agentId: string): string {
  const hookScript = join(agentDir, ".agents", "hooks", "agy-hook.py");
  const hookEnv = `OPENTRADE_AGENT_ID='${agentId}' OPENTRADE_HOME='${OPENTRADE_HOME}'`;
  return `${JSON.stringify(
    {
      opentrade: {
        SessionStart: [
          {
            type: "command",
            command: `${hookEnv} '${hookScript}' SessionStart`,
            timeout: 10,
          },
        ],
        PreToolUse: [
          {
            matcher: AGY_GATED_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${hookEnv} '${hookScript}' PreToolUse`,
                timeout: 600,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: AGY_GATED_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${hookEnv} '${hookScript}' PostToolUse`,
                timeout: 30,
              },
            ],
          },
        ],
        Stop: [
          {
            type: "command",
            command: `${hookEnv} '${hookScript}' Stop`,
            timeout: 10,
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Antigravity CLI (`agy`) harness.
 *
 * Uses `AGENTS.md` in the agent workspace and `.agents/hooks.json` for lifecycle
 * hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`). When `agy` starts a
 * new conversation (interactive or headless `-p`), the `SessionStart` and `Stop`
 * hooks report `conversationId` to `/hook/status` so subsequent `--conversation <id>`
 * runs resume the exact same conversation.
 */
export const agyHarness: Harness = {
  id: "agy",
  binary: AGY_BIN,
  instructionsFile: "AGENTS.md",
  instructionsPrefixFile: "AGENTS.prefix.agy.md",
  subscriptionAuthStrip: AGY_SUBSCRIPTION_AUTH_STRIP,
  generatesFullConfig: true,

  interactiveArgs(mode: SessionMode, sessionId: string, kickoff?: string | null): string[] {
    // Full-permission mode in BOTH interactive and headless sessions: agy's own
    // tool-permission prompts are skipped, so OpenTrade is the single order gate.
    // The `.agents/hooks.json` PreToolUse hook still runs under skip-permissions and
    // routes every Robinhood call through /hook/pretool-approval, which honors the
    // agent's approval mode ("auto" approves instantly; "approve" waits for the
    // user) and fails closed when OpenTrade is unreachable.
    const session =
      mode === "resume" && agyConversationExists(sessionId)
        ? ["--conversation", sessionId]
        : [];
    const model = ["--model", AGY_MODEL];
    if (session.length > 0) {
      return [...session, ...model, AGY_SKIP_PERMISSIONS];
    }
    // `agy` takes an initial interactive prompt via `-i` (`--prompt-interactive`).
    return kickoff
      ? [...model, AGY_SKIP_PERMISSIONS, "-i", kickoff]
      : [...model, AGY_SKIP_PERMISSIONS];
  },

  interactiveEnv(): Record<string, string> {
    return {
      OPENTRADE_HARNESS: "agy",
    };
  },

  writeConfig(agentDir: string, agentId: string): void {
    const agentsDir = join(agentDir, ".agents");
    const hooksDir = join(agentsDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(agentsDir, "hooks.json"), agyHooksJson(agentDir, agentId));

    const hooksSrc = resolveHooksDir();
    if (existsSync(hooksSrc)) {
      for (const file of readdirSync(hooksSrc, { withFileTypes: true })) {
        if (!file.isFile()) continue; // skip __pycache__ and other dirs
        const dest = join(hooksDir, file.name);
        copyFileSync(join(hooksSrc, file.name), dest);
        try {
          chmodSync(dest, 0o755);
        } catch {
          // best effort
        }
      }
    }
  },

  headlessArgs(mode: SessionMode, sessionId: string, wakePrompt: string): string[] {
    const session =
      mode === "resume" && agyConversationExists(sessionId)
        ? ["--conversation", sessionId]
        : [];
    return [...session, "--model", AGY_MODEL, AGY_SKIP_PERMISSIONS, "-p", wakePrompt];
  },

  async probe(env: Record<string, string>): Promise<ProbeResult> {
    try {
      const { stdout } = await execFileAsync(AGY_BIN, ["--version"], { env, timeout: 5000 });
      return { found: true, version: stdout.trim() };
    } catch {
      return { found: false, version: null };
    }
  },

  robinhoodMcpConfigured(): boolean {
    try {
      return agyConfigHasRobinhood(
        readFileSync(join(homedir(), ".gemini", "config", "mcp_config.json"), "utf8"),
      );
    } catch {
      return false;
    }
  },
};
