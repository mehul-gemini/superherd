import type { Command } from "commander";
import { StringDecoder } from "node:string_decoder";
import { releaseHerdrAgent, reportHerdrAgent } from "../herdr/cli";
import { readLatestSupersetManifest } from "../superset/manifest";

interface AttachOptions {
  workspace: string;
  terminal: string;
}

export function registerAttachTerminalCommand(program: Command): void {
  program
    .command("attach-terminal")
    .description("Attach stdio to a Superset terminal session")
    .requiredOption("--workspace <id>", "Superset workspace id")
    .requiredOption("--terminal <id>", "Superset terminal id")
    .action((options: AttachOptions) => attachTerminal(options));
}

function attachTerminal(options: AttachOptions): void {
  const { manifest } = readLatestSupersetManifest();
  const ws = new WebSocket(toTerminalWsUrl(manifest.endpoint, options.terminal, options.workspace, manifest.authToken));
  ws.binaryType = "arraybuffer";
  const forwardInput = makeInputForwarder(ws);
  const mouseFilter = makeMouseSequenceFilter();
  // Multi-byte UTF-8 characters in the remote output can straddle a WebSocket message
  // boundary. A stateful decoder carries any incomplete trailing bytes over to the next
  // message instead of re-decoding each chunk in isolation, which would otherwise emit
  // U+FFFD replacement characters into unrelated text.
  const outputDecoder = new StringDecoder("utf8");

  const paneId = process.env.HERDR_PANE_ID;
  let identifiedAgent: string | null = null;
  // Carries a short tail of prior output so an agent banner split across WebSocket
  // messages (e.g. "Co" / "dex") is still recognized once the rest arrives.
  let agentSniffBuffer = "";
  const AGENT_SNIFF_TAIL = 32;

  const sniffAgent = (text: string) => {
    if (!paneId || identifiedAgent) return;
    agentSniffBuffer = (agentSniffBuffer + text).slice(-AGENT_SNIFF_TAIL * 2);
    const agent = detectAgent(agentSniffBuffer);
    if (!agent) return;
    identifiedAgent = agent;
    try {
      reportHerdrAgent(paneId, "superherd", agent, "working");
    } catch {
      // best-effort: agent-tracking is not critical to the terminal bridge
    }
  };

  const sendResize = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "resize",
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 32,
    }));
  };

  ws.addEventListener("open", () => {
    // Defensive baseline: if a prior session crashed while the remote side had mouse
    // reporting turned on, the local terminal may still be stuck in that mode. Reset it
    // before we start forwarding anything.
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    sendResize();
  });

  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      const text = outputDecoder.write(Buffer.from(event.data));
      sniffAgent(text);
      process.stdout.write(mouseFilter.filter(text));
      return;
    }

    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then((buffer) => {
        const text = outputDecoder.write(Buffer.from(buffer));
        sniffAgent(text);
        process.stdout.write(mouseFilter.filter(text));
      });
      return;
    }

    const message = safeJsonParse(String(event.data));
    if (message?.type === "error") {
      process.stderr.write(`[superherd] terminal error: ${message.message ?? "unknown error"}\n`);
    }
  });

  ws.addEventListener("close", (event) => {
    const leftover = mouseFilter.flush();
    if (leftover) process.stdout.write(leftover);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    if (paneId && identifiedAgent) {
      try {
        releaseHerdrAgent(paneId, "superherd", identifiedAgent);
      } catch {
        // best-effort: don't block exit on agent-tracking cleanup failures
      }
    }
    process.exit(event.code === 1000 ? 0 : 1);
  });

  ws.addEventListener("error", () => {
    process.stderr.write("[superherd] terminal websocket error\n");
  });

  process.stdin.on("data", forwardInput);
  process.stdout.on("resize", sendResize);
}

function toTerminalWsUrl(
  endpoint: string,
  terminalId: string,
  workspaceId: string,
  token: string,
): string {
  const base = endpoint.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  const params = new URLSearchParams({ workspaceId, token });
  return `${base}/terminal/${encodeURIComponent(terminalId)}?${params.toString()}`;
}

function makeInputForwarder(ws: WebSocket): (chunk: Buffer) => void {
  let lineStart = true;
  let pendingExit = "";

  const sendInput = (data: string) => {
    if (ws.readyState !== WebSocket.OPEN || data.length === 0) return;
    ws.send(JSON.stringify({ type: "input", data }));
  };

  return (chunk) => {
    const text = chunk.toString("utf8");

    for (const char of text) {
      if (lineStart && pendingExit.length < 4) {
        const candidate = pendingExit + char;
        if ("exit".startsWith(candidate)) {
          pendingExit = candidate;
          if (pendingExit === "exit") lineStart = false;
          continue;
        }
      }

      if (pendingExit === "exit" && (char === "\r" || char === "\n")) {
        pendingExit = "";
        lineStart = true;
        ws.close(1000, "local-exit-command");
        return;
      }

      if (pendingExit.length > 0) {
        sendInput(pendingExit);
        pendingExit = "";
      }

      sendInput(char);
      lineStart = char === "\r" || char === "\n";
    }
  };
}

function detectAgent(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("codex") || lower.includes("gpt-5")) return "codex";
  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus")) return "claude";
  return null;
}

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// xterm mouse-tracking DECSET/DECRST mode numbers (x10, VT200/highlight, button-event,
// any-event, UTF-8, SGR, URXVT and SGR-pixels extended coordinates). Deliberately excludes
// 1004 (focus in/out reporting), which is not a mouse-tracking mode.
const MOUSE_TRACKING_MODES = new Set(["1000", "1001", "1002", "1003", "1005", "1006", "1015", "1016"]);

const DISABLE_MOUSE_TRACKING = [...MOUSE_TRACKING_MODES].map((mode) => `\x1b[?${mode}l`).join("");

// Strips CSI ?<modes>h / CSI ?<modes>l sequences that enable/disable mouse-tracking reporting
// so the local terminal is never told to enter mouse-reporting mode by the remote session.
// Mode numbers can be semicolon-separated in a single sequence (e.g. "?1000;1006h"), so each
// sequence is filtered code-by-code rather than matched/dropped as a whole, in case a mouse
// mode is ever combined with an unrelated private mode (e.g. cursor visibility).
//
// This only handles a sequence that arrives whole within a single decoded chunk. A sequence
// split across two WebSocket messages is buffered by makeMouseSequenceFilter below, which
// calls this function once the full sequence has been reassembled.
function stripMouseTrackingSequences(input: string): string {
  return input.replace(/\x1b\[\?([\d;]+)([hl])/g, (full, codes: string, suffix: string) => {
    const codeList = codes.split(";");
    const remaining = codeList.filter((code) => !MOUSE_TRACKING_MODES.has(code));
    if (remaining.length === codeList.length) return full;
    if (remaining.length === 0) return "";
    return `\x1b[?${remaining.join(";")}${suffix}`;
  });
}

// Trailing prefix of a DECSET/DECRST private-mode sequence that hasn't seen its terminating
// h/l yet, e.g. "\x1b", "\x1b[", "\x1b[?", "\x1b[?1000". Anchored to the end of the string so
// only a genuinely incomplete sequence at the tail is held back.
const INCOMPLETE_MOUSE_SEQUENCE = /\x1b(\[(\?[\d;]*)?)?$/;

// Wraps stripMouseTrackingSequences with a one-chunk buffer so a DECSET/DECRST sequence split
// across two WebSocket messages is still recognized: any incomplete trailing sequence is held
// back and prepended to the next chunk before filtering, instead of being written unfiltered.
function makeMouseSequenceFilter(): { filter: (chunk: string) => string; flush: () => string } {
  let pending = "";

  const filter = (chunk: string): string => {
    const combined = pending + chunk;
    const held = combined.match(INCOMPLETE_MOUSE_SEQUENCE)?.[0] ?? "";
    const safe = held ? combined.slice(0, combined.length - held.length) : combined;
    pending = held;
    return stripMouseTrackingSequences(safe);
  };

  const flush = (): string => {
    const remaining = pending;
    pending = "";
    return remaining;
  };

  return { filter, flush };
}
