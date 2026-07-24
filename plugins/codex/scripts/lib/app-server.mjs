/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 * @typedef {import("./app-server-protocol").AppServerRequestParams<AppServerMethod>} AnyRequestParams
 * @typedef {import("./app-server-protocol").AppServerResponse<AppServerMethod>} AnyResponse
 * @typedef {{ id?: number, method?: string, params?: object, result?: AnyResponse, error?: { code?: number, message?: string, data?: unknown } }} JsonRpcMessage
 * @typedef {{ resolve: (value: AnyResponse) => void, reject: (error: Error) => void, method: AppServerMethod, sent: boolean }} PendingRequest
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  createOwnedProcessLaunch,
  inspectProcessIdentity,
  stopOwnedPosixSupervisorGroup
} from "./process.mjs";
import { DEFAULT_APP_SERVER_CLOSE_CONFIG } from "./runtime-config.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

/**
 * @param {string} message
 * @param {{ code?: number, [key: string]: unknown }} [data]
 * @returns {ProtocolError}
 */
function createProtocolError(message, data) {
  return Object.assign(new Error(message), {
    data,
    rpcCode: data?.code
  });
}

export class AppServerRequestError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AppServerRequestError";
    this.delivery = "unknown";
  }
}

/**
 * @param {unknown} message
 * @returns {message is { type: "owned-target-error", message: string }}
 */
function isOwnedTargetError(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "owned-target-error" &&
    "message" in message &&
    typeof message.message === "string"
  );
}

/**
 * @param {unknown} message
 * @returns {message is { type: "owned-target-exit", code: number | null, signal: string | null }}
 */
function isOwnedTargetExit(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "owned-target-exit" &&
    "code" in message &&
    (message.code === null || typeof message.code === "number") &&
    "signal" in message &&
    (message.signal === null || typeof message.signal === "string")
  );
}

/** @param {object} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {unknown} value */
function isJsonRpcId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {JsonRpcMessage} message
 * @returns {message is AppServerNotification}
 */
function isNotification(message) {
  return message.id === undefined && typeof message.method === "string";
}

/**
 * @param {unknown} value
 * @returns {value is JsonRpcMessage}
 */
function isJsonRpcMessage(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (hasOwn(value, "jsonrpc") && value.jsonrpc !== "2.0") {
    return false;
  }

  const hasId = hasOwn(value, "id");
  const hasMethod = hasOwn(value, "method");
  const hasParams = hasOwn(value, "params");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (
    hasParams &&
    (typeof value.params !== "object" ||
      value.params === null ||
      Array.isArray(value.params))
  ) {
    return false;
  }

  if (hasMethod) {
    return (
      typeof value.method === "string" &&
      value.method.length > 0 &&
      !hasResult &&
      !hasError &&
      (!hasId || isJsonRpcId(value.id))
    );
  }

  if (!hasId || !isJsonRpcId(value.id) || hasParams || hasResult === hasError) {
    return false;
  }

  if (!hasError) {
    return true;
  }

  return (
    isRecord(value.error) &&
    Number.isSafeInteger(value.error.code) &&
    typeof value.error.message === "string"
  );
}

class AppServerClientBase {
  /**
   * @param {string} cwd
   * @param {CodexAppServerClientOptions} [options]
   */
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitResolved = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";

    /** @type {Promise<void>} */
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** @param {AppServerNotificationHandler | null} handler */
  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed || this.exitResolved) {
      throw this.exitError ?? new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, method, sent: false };
      this.pending.set(id, pending);
      this.dispatchMessage({ id, method, params }, () => {
        pending.sent = true;
      });
    });
  }

  /** @param {string} method @param {object} [params] */
  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.dispatchMessage({ method, params });
  }

  /** @param {object} message @param {() => void} [onWritten] */
  dispatchMessage(message, onWritten = () => {}) {
    try {
      Promise.resolve(this.sendMessage(message, onWritten)).catch((error) => {
        this.handleTransportFailure(error);
      });
    } catch (error) {
      this.handleTransportFailure(error);
    }
  }

  /** @param {unknown} error */
  handleTransportFailure(error) {
    this.handleExit(error instanceof Error ? error : new Error(String(error)));
  }

  async waitForExit() {
    await this.exitPromise;
    if (this.exitError) {
      throw this.exitError;
    }
    if (!this.closed) {
      throw new Error("codex app-server connection closed unexpectedly.");
    }
  }

  /** @param {string} chunk */
  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  /** @param {string} line */
  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${getErrorMessage(error)}`, { line }));
      return;
    }

    if (!isJsonRpcMessage(message)) {
      this.handleExit(
        createProtocolError("Invalid codex app-server JSON-RPC envelope.", {
          line
        })
      );
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (this.notificationHandler && isNotification(message)) {
      try {
        this.notificationHandler(message);
      } catch (error) {
        this.handleExit(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** @param {JsonRpcMessage} message */
  handleServerRequest(message) {
    this.dispatchMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  /** @param {Error | null | undefined} error */
  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    const exitError = this.exitError ?? new Error("codex app-server connection closed.");
    for (const pending of this.pending.values()) {
      pending.reject(
        pending.sent
          ? new AppServerRequestError(
              `codex app-server ${pending.method} response was lost after the request was sent: ${exitError.message}`,
              { cause: exitError }
            )
          : exitError
      );
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  /** @param {object} _message @param {() => void} [_onWritten] @returns {void | Promise<void>} */
  sendMessage(_message, _onWritten = () => {}) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  /**
   * @param {string} cwd
   * @param {CodexAppServerClientOptions} [options]
   */
  constructor(cwd, options = {}) {
    super(cwd, options);
    /** @type {Promise<void> | null} */
    this.closePromise = null;
    this.processExitResolved = false;
    /** @type {Promise<void>} */
    this.processExitPromise = new Promise((resolve) => {
      this.resolveProcessExit = resolve;
    });
    /** @type {import("node:child_process").ChildProcess | null} */
    this.proc = null;
    /** @type {readline.Interface | null} */
    this.readline = null;
    this.handleParentTermination = () => {
      void this.close().catch((error) => {
        process.stderr.write(`Cannot close codex app-server: ${error.message}\n`);
      });
    };
    /** @type {import("./process.mjs").ProcessIdentity | null} */
    this.rootProcessIdentity = null;
  }

  markProcessExit() {
    if (this.processExitResolved) {
      return;
    }
    this.processExitResolved = true;
    this.resolveProcessExit(undefined);
  }

  async initialize() {
    process.on("SIGTERM", this.handleParentTermination);
    const launch = createOwnedProcessLaunch("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      token: randomUUID(),
      terminateWithOwner: true
    });
    const proc = spawn(launch.command, launch.args, launch.spawnOptions);
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("Codex app-server supervisor did not expose piped stdio.");
    }
    this.proc = proc;
    const supervisorPid = proc.pid;
    this.rootProcessIdentity =
      typeof supervisorPid === "number" && Number.isFinite(supervisorPid)
      ? inspectProcessIdentity(supervisorPid)
      : null;
    if (!this.rootProcessIdentity) {
      throw new Error("Cannot capture the codex app-server process generation.");
    }
    if (
      process.platform !== "win32" &&
      this.rootProcessIdentity.processGroupId !== this.rootProcessIdentity.pid
    ) {
      throw new Error("Codex app-server must lead its POSIX process group.");
    }
    if (process.platform !== "win32") {
      proc.on("message", (message) => {
        if (isOwnedTargetError(message)) {
          this.handleExit(new Error(message.message));
          return;
        }
        if (isOwnedTargetExit(message)) {
          const stderr = this.stderr.trim();
          const detail =
            message.code === 0
              ? null
              : createProtocolError(
                  `codex app-server exited unexpectedly (${message.signal ? `signal ${message.signal}` : `exit ${message.code}`}).${stderr ? `\n${stderr}` : ""}`
                );
          this.handleExit(detail);
        }
      });
    }

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    proc.stdin.on("error", (error) => {
      this.handleTransportFailure(error);
    });

    proc.on("error", (error) => {
      if (typeof proc.pid !== "number" || !Number.isFinite(proc.pid)) {
        this.markProcessExit();
      }
      this.handleExit(error);
    });

    proc.on("close", (code, signal) => {
      this.markProcessExit();
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  /** @param {number} timeoutMs */
  async waitForProcessExitWithin(timeoutMs) {
    if (this.processExitResolved) {
      return true;
    }

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeout = null;
    const exited = await Promise.race([
      this.processExitPromise.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return exited;
  }

  async closeOwnedProcess() {
    this.closed = true;
    try {
      const pid = this.proc?.pid;
      const proc = this.proc;
      if (!proc || typeof pid !== "number" || !Number.isFinite(pid)) {
        return;
      }
      const stdin = proc.stdin;
      if (stdin && !stdin.destroyed && !stdin.writableEnded) {
        stdin.end();
      }
      await this.waitForProcessExitWithin(
        DEFAULT_APP_SERVER_CLOSE_CONFIG.gracefulMs
      );
      if (process.platform !== "win32") {
        const identity = this.rootProcessIdentity;
        if (!identity || typeof identity.processGroupId !== "number") {
          throw new Error("Codex app-server POSIX supervisor identity is unavailable.");
        }
        await stopOwnedPosixSupervisorGroup({
          pid: identity.pid,
          processGroupId: identity.processGroupId,
          startKey: identity.startKey
        }, {
          graceMs: DEFAULT_APP_SERVER_CLOSE_CONFIG.termMs,
          killMs: DEFAULT_APP_SERVER_CLOSE_CONFIG.killMs
        });
        return;
      }
      if (!this.processExitResolved) {
        proc.kill("SIGKILL");
        if (
          !(await this.waitForProcessExitWithin(
            DEFAULT_APP_SERVER_CLOSE_CONFIG.killMs
          ))
        ) {
          throw new Error(
            `Codex app-server Job Object supervisor ${pid} did not stop.`
          );
        }
      }
    } finally {
      process.off("SIGTERM", this.handleParentTermination);
      this.readline?.close();
    }
  }

  async close() {
    this.closePromise ??= this.closeOwnedProcess();
    await this.closePromise;
  }

  /** @param {object} message @param {() => void} [onWritten] */
  sendMessage(message, onWritten = () => {}) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error("codex app-server stdin is not available."));
    }
    return new Promise((resolve, reject) => {
      try {
        stdin.write(line, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
        onWritten();
      } catch (error) {
        reject(error);
      }
    });
  }
}

export class CodexAppServerClient {
  /**
   * @param {string} cwd
   * @param {CodexAppServerClientOptions} [options]
   */
  static async connect(cwd, options = {}) {
    const client = new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (initializeError) {
      try {
        await client.close();
      } catch (closeError) {
        throw new AggregateError(
          [initializeError, closeError],
          "Codex app-server initialization failed and its process could not be closed."
        );
      }
      throw initializeError;
    }
  }
}
