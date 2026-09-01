import type { Command } from "commander";
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
      process.stdout.write(stripMouseTrackingSequences(Buffer.from(event.data).toString("utf8")));
      return;
    }

    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then((buffer) =>
        process.stdout.write(stripMouseTrackingSequences(Buffer.from(buffer).toString("utf8"))),
      );
      return;
    }

    const message = safeJsonParse(String(event.data));
    if (message?.type === "error") {
      process.stderr.write(`[superherd] terminal error: ${message.message ?? "unknown error"}\n`);
    }
  });

  ws.addEventListener("close", (event) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
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

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// xterm mouse-tracking DECSET/DECRST mode numbers (x10, VT200, button-event, any-event,
// UTF-8, SGR, URXVT extended coordinates).
const MOUSE_TRACKING_MODES = new Set(["1000", "1001", "1002", "1003", "1004", "1005", "1006", "1015", "1016"]);

const DISABLE_MOUSE_TRACKING = [...MOUSE_TRACKING_MODES].map((mode) => `\x1b[?${mode}l`).join("");

// Strips CSI ?<modes>h / CSI ?<modes>l sequences that enable/disable mouse-tracking reporting
// so the local terminal is never told to enter mouse-reporting mode by the remote session.
// Mode numbers can be semicolon-separated in a single sequence (e.g. "?1000;1006h"), so each
// sequence is filtered code-by-code rather than matched/dropped as a whole, in case a mouse
// mode is ever combined with an unrelated private mode (e.g. cursor visibility).
//
// This operates on the decoded string per WebSocket message rather than a byte-level stream
// parser. For this bridge, each message is a self-contained terminal-output chunk, so a
// DECSET/DECRST escape sequence won't be split across two messages in practice — a full
// streaming parser would be overkill for the problem this is fixing.
function stripMouseTrackingSequences(input: string): string {
  return input.replace(/\x1b\[\?([\d;]+)([hl])/g, (full, codes: string, suffix: string) => {
    const codeList = codes.split(";");
    const remaining = codeList.filter((code) => !MOUSE_TRACKING_MODES.has(code));
    if (remaining.length === codeList.length) return full;
    if (remaining.length === 0) return "";
    return `\x1b[?${remaining.join(";")}${suffix}`;
  });
}
