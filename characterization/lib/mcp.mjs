import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { baseEnv } from "./spawn.mjs";

/**
 * Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 against a spawned bundle.
 * One session per probe batch; callers must close().
 */
export class McpSession {
  constructor(bundlePath, { env = {}, cwd, startupTimeoutMs = 20_000 } = {}) {
    this.child = spawn(process.execPath, [bundlePath], {
      cwd,
      env: { ...baseEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.child.stderr.on("data", (d) => (this.stderr += d));
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // non-protocol stdout noise
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    this.startupTimeoutMs = startupTimeoutMs;
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ jsonrpc: "2.0", id, error: { code: -1, message: "PROBE_TIMEOUT" } });
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n");
  }

  async initialize() {
    const res = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "characterization-probe", version: "1.0.0" },
      },
      this.startupTimeoutMs,
    );
    this.notify("notifications/initialized");
    return res;
  }

  async listTools() {
    return this.request("tools/list", {});
  }

  async callTool(name, args, timeoutMs = 60_000) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  close() {
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
