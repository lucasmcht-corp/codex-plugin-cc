// @ts-check

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import {
  isOwnedWorker,
  sameOwnedWorkerGeneration
} from "./job-lifecycle.mjs";
import { ensurePrivateRuntimeDirectory } from "./runtime-config.mjs";

/**
 * @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorker
 * @typedef {import("./reliability-contracts").SteeringDescriptor} SteeringDescriptor
 * @typedef {import("./reliability-contracts").SteeringRequest} SteeringRequest
 * @typedef {import("./reliability-contracts").SteeringResponse} SteeringResponse
 * @typedef {{
 *   socketRoot: string,
 *   directoryMode: number,
 *   socketMode: number,
 *   requestTimeoutMs: number,
 *   maxFrameBytes: number
 * }} SteeringConfig
 * @typedef {{ threadId: string, turnId: string }} SteeringResult
 * @typedef {{ endpointRemoved: boolean, errors: Error[] }} SteeringCleanupResult
 */

/** @param {string} workspaceRoot @param {string} jobId @param {string} workerToken */
function digestAddress(workspaceRoot, jobId, workerToken) {
  return createHash("sha256")
    .update(`${workspaceRoot}\0${jobId}\0${workerToken}`)
    .digest("hex")
    .slice(0, 32);
}

/** @param {string} filePath */
function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

/** @param {unknown} error @param {string} code */
function isErrorWithCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} error */
function isUnknownDelivery(error) {
  return isRecord(error) && error.delivery === "unknown";
}

/** @param {unknown} worker @returns {asserts worker is OwnedWorker} */
function validateWorker(worker) {
  if (!isOwnedWorker(worker)) {
    throw new Error("Steering requires an exact owned worker generation.");
  }
}

/** @param {unknown} descriptor @returns {descriptor is SteeringDescriptor} */
export function isSteeringDescriptor(descriptor) {
  return (
    isRecord(descriptor) &&
    descriptor.version === 1 &&
    (descriptor.kind === "unix" || descriptor.kind === "pipe") &&
    typeof descriptor.address === "string" &&
    Boolean(descriptor.address) &&
    isOwnedWorker(descriptor.worker) &&
    typeof descriptor.threadId === "string" &&
    Boolean(descriptor.threadId) &&
    typeof descriptor.turnId === "string" &&
    Boolean(descriptor.turnId)
  );
}

/** @param {unknown} descriptor @returns {asserts descriptor is SteeringDescriptor} */
function validateDescriptor(descriptor) {
  if (!isSteeringDescriptor(descriptor)) {
    throw new Error("Steering endpoint metadata is missing or invalid.");
  }
}

/** @param {unknown} request @returns {asserts request is SteeringRequest} */
function validateRequest(request) {
  if (
    !isRecord(request) ||
    request.version !== 1 ||
    typeof request.requestId !== "string" ||
    !request.requestId ||
    typeof request.jobId !== "string" ||
    !request.jobId ||
    !isOwnedWorker(request.worker) ||
    typeof request.threadId !== "string" ||
    !request.threadId ||
    typeof request.turnId !== "string" ||
    !request.turnId ||
    typeof request.instruction !== "string" ||
    !request.instruction.trim()
  ) {
    throw new Error("Steering request is missing required fields.");
  }
}

/** @param {unknown} response @returns {asserts response is SteeringResponse} */
function validateResponse(response) {
  if (
    !isRecord(response) ||
    typeof response.ok !== "boolean" ||
    (response.requestId !== null && typeof response.requestId !== "string")
  ) {
    throw new Error("Steering response is missing required fields.");
  }
  if (response.ok) {
    if (
      typeof response.requestId !== "string" ||
      !response.requestId ||
      typeof response.jobId !== "string" ||
      !response.jobId ||
      typeof response.threadId !== "string" ||
      !response.threadId ||
      typeof response.turnId !== "string" ||
      !response.turnId
    ) {
      throw new Error("Steering acknowledgement is missing required fields.");
    }
    return;
  }
  if (
    !isRecord(response.error) ||
    typeof response.error.message !== "string" ||
    !response.error.message ||
    (response.error.delivery !== "rejected" && response.error.delivery !== "unknown")
  ) {
    throw new Error("Steering rejection is missing an error message.");
  }
}

export class SteeringDeliveryError extends Error {
  /**
   * @param {string} message
   * @param {"rejected" | "unknown"} delivery
   * @param {string} requestId
   * @param {ErrorOptions} options
   */
  constructor(message, delivery, requestId, options = {}) {
    super(message, options);
    this.name = "SteeringDeliveryError";
    this.delivery = delivery;
    this.requestId = requestId;
  }
}

export function createSteeringRequestId() {
  return `steer-${randomUUID()}`;
}

/**
 * @template Result
 * @param {{
 *   steer: () => Promise<Result>,
 *   logAccepted: (result: Result) => void,
 *   logRejected: (error: unknown) => void,
 *   onLogError?: (error: unknown) => void
 * }} options
 * @returns {Promise<Result>}
 */
export async function resolveNativeSteer({
  steer,
  logAccepted,
  logRejected,
  onLogError = (_error) => {}
}) {
  /** @type {Result} */
  let result;
  try {
    result = await steer();
  } catch (error) {
    if (!isUnknownDelivery(error)) {
      try {
        logRejected(error);
      } catch (logError) {
        try {
          onLogError(logError);
        } catch {
          // Delivery classification must not depend on diagnostics.
        }
      }
    }
    throw error;
  }

  try {
    logAccepted(result);
  } catch (logError) {
    try {
      onLogError(logError);
    } catch {
      // An accepted steer stays accepted even if diagnostics fail.
    }
  }
  return result;
}

/**
 * @param {{
 *   workspaceRoot: string,
 *   jobId: string,
 *   worker: OwnedWorker,
 *   threadId: string,
 *   turnId: string,
 *   config: SteeringConfig
 * }} options
 * @returns {SteeringDescriptor}
 */
export function buildSteeringDescriptor({
  workspaceRoot,
  jobId,
  worker,
  threadId,
  turnId,
  config
}) {
  validateWorker(worker);
  const digest = digestAddress(workspaceRoot, jobId, worker.token);
  const kind = worker.platform === "win32" ? "pipe" : "unix";
  const address =
    kind === "pipe"
      ? `\\\\.\\pipe\\codex-companion-steer-${digest}`
      : path.join(config.socketRoot, `steer-${digest}.sock`);
  return {
    version: 1,
    kind,
    address,
    worker,
    threadId,
    turnId
  };
}

/** @param {SteeringDescriptor | null | undefined} left @param {SteeringDescriptor} right */
function sameDescriptor(left, right) {
  return (
    left?.version === right.version &&
    left?.kind === right.kind &&
    left?.address === right.address &&
    sameOwnedWorkerGeneration(left?.worker, right.worker) &&
    left?.threadId === right.threadId &&
    left?.turnId === right.turnId
  );
}

export function assertSteeringDescriptor(
  /** @type {unknown} */
  descriptor,
  /** @type {{ workspaceRoot: string, jobId: string, worker: OwnedWorker, threadId: string, turnId: string, config: SteeringConfig }} */
  { workspaceRoot, jobId, worker, threadId, turnId, config }
) {
  validateDescriptor(descriptor);
  const expected = buildSteeringDescriptor({
    workspaceRoot,
    jobId,
    worker,
    threadId,
    turnId,
    config
  });
  if (!sameDescriptor(descriptor, expected)) {
    throw new Error("Steering endpoint does not match the active worker generation and turn.");
  }
  return descriptor;
}

export function cleanupSteeringEndpoint(
  /** @type {unknown} */
  descriptor,
  /** @type {{ workspaceRoot: string, jobId: string, worker: OwnedWorker, config: SteeringConfig }} */
  { workspaceRoot, jobId, worker, config }
) {
  if (!descriptor) {
    return false;
  }
  validateDescriptor(descriptor);
  assertSteeringDescriptor(descriptor, {
    workspaceRoot,
    jobId,
    worker,
    threadId: descriptor.threadId,
    turnId: descriptor.turnId,
    config
  });
  if (descriptor.kind === "unix") {
    removeFileIfExists(descriptor.address);
  }
  return true;
}

/** @param {net.Socket} socket @param {SteeringResponse} payload */
function writeResponse(socket, payload) {
  if (socket.destroyed) {
    return;
  }
  socket.end(`${JSON.stringify(payload)}\n`);
}

/**
 * @param {{
 *   workspaceRoot: string,
 *   jobId: string,
 *   worker: OwnedWorker,
 *   threadId: string,
 *   turnId: string,
 *   config: SteeringConfig,
 *   handleSteer: (request: SteeringRequest) => Promise<SteeringResult>,
 *   onError?: (error: Error, descriptor: SteeringDescriptor, endpointRemoved: boolean) => void,
 *   removeFileIfExistsImpl?: (filePath: string) => void,
 *   chmodSyncImpl?: typeof fs.chmodSync,
 *   createServerImpl?: typeof net.createServer
 * }} options
 */
export async function openSteeringServer({
  workspaceRoot,
  jobId,
  worker,
  threadId,
  turnId,
  config,
  handleSteer,
  onError = (_error, _descriptor, _endpointRemoved) => {},
  removeFileIfExistsImpl = removeFileIfExists,
  chmodSyncImpl = fs.chmodSync,
  createServerImpl = net.createServer
}) {
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId,
    worker,
    threadId,
    turnId,
    config
  });
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  /** @type {Promise<void>} */
  let requestQueue = Promise.resolve();

  if (descriptor.kind === "unix") {
    ensurePrivateRuntimeDirectory(config.socketRoot, {
      mode: config.directoryMode,
      platform: worker.platform
    });
    removeFileIfExistsImpl(descriptor.address);
  }

  const server = createServerImpl((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(config.requestTimeoutMs);
    let buffer = "";
    let handled = false;

    /**
     * @param {string | null} requestId
     * @param {string} message
     * @param {"rejected" | "unknown"} [delivery]
     */
    const rejectRequest = (requestId, message, delivery = "rejected") => {
      writeResponse(socket, {
        requestId,
        ok: false,
        error: { message, delivery }
      });
    };

    socket.on("timeout", () => {
      handled = true;
      rejectRequest(null, "Steering request timed out.");
    });
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > config.maxFrameBytes) {
        handled = true;
        rejectRequest(null, "Steering request exceeds the maximum frame size.");
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      handled = true;
      const line = buffer.slice(0, newlineIndex);
      /** @type {unknown} */
      let request;
      try {
        request = JSON.parse(line);
        validateRequest(request);
        if (
          request.jobId !== jobId ||
          !sameOwnedWorkerGeneration(request.worker, descriptor.worker) ||
          request.threadId !== descriptor.threadId ||
          request.turnId !== descriptor.turnId
        ) {
          throw new Error("Steering request does not match this worker generation and active turn.");
        }
      } catch (error) {
        const requestId =
          request !== null &&
          typeof request === "object" &&
          "requestId" in request &&
          typeof request.requestId === "string"
            ? request.requestId
            : null;
        rejectRequest(requestId, error instanceof Error ? error.message : String(error));
        return;
      }
      socket.setTimeout(0);

      requestQueue = requestQueue
        .then(async () => {
          const result = await handleSteer(request);
          if (
            !result ||
            result.threadId !== descriptor.threadId ||
            result.turnId !== descriptor.turnId
          ) {
            throw new SteeringDeliveryError(
              "Codex acknowledged a different thread or turn.",
              "unknown",
              request.requestId
            );
          }
          writeResponse(socket, {
            requestId: request.requestId,
            ok: true,
            jobId,
            threadId: result.threadId,
            turnId: result.turnId
          });
        })
        .catch((error) => {
          rejectRequest(
            request.requestId,
            error instanceof Error ? error.message : String(error),
            isUnknownDelivery(error) ? "unknown" : "rejected"
          );
        });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  /** @type {Promise<SteeringCleanupResult> | null} */
  let cleanupPromise = null;
  const cleanup = () => {
    cleanupPromise ??= new Promise((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }

      /** @param {Error | null} serverError */
      const finish = (serverError = null) => {
        /** @type {Error[]} */
        const errors = serverError ? [serverError] : [];
        let endpointRemoved = descriptor.kind !== "unix" && serverError === null;
        try {
          if (descriptor.kind === "unix") {
            removeFileIfExistsImpl(descriptor.address);
            endpointRemoved = true;
          }
        } catch (endpointError) {
          errors.push(
            endpointError instanceof Error
              ? endpointError
              : new Error(String(endpointError))
          );
          endpointRemoved = false;
        }
        resolve({ endpointRemoved, errors });
      };

      try {
        server.close((error) => {
          finish(error ?? null);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return cleanupPromise;
  };
  const close = async () => {
    const result = await cleanup();
    if (result.errors.length === 1) {
      throw result.errors[0];
    }
    if (result.errors.length > 1) {
      throw new AggregateError(
        result.errors,
        "Steering server and endpoint cleanup both failed."
      );
    }
  };

  /** @type {Promise<void>} */
  const listening = new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(descriptor.address);
  });
  await listening;
  let runtimeErrorHandled = false;
  try {
    server.on("error", (error) => {
      if (runtimeErrorHandled) {
        return;
      }
      runtimeErrorHandled = true;
      void cleanup().then((result) => {
        const reportedError =
          result.errors.length > 0
            ? new AggregateError(
                [error, ...result.errors],
                "Steering server failed and cleanup did not complete."
              )
            : error;
        try {
          onError(reportedError, descriptor, result.endpointRemoved);
        } catch (callbackError) {
          process.stderr.write(
            `Steering failure callback failed: ${
              callbackError instanceof Error ? callbackError.message : String(callbackError)
            }\n`
          );
        }
      });
    });
    if (descriptor.kind === "unix") {
      chmodSyncImpl(descriptor.address, config.socketMode);
    }
  } catch (initializationError) {
    const cleanupResult = await cleanup();
    if (cleanupResult.errors.length > 0) {
      throw new AggregateError(
        [initializationError, ...cleanupResult.errors],
        "Steering server initialization and cleanup both failed."
      );
    }
    throw initializationError;
  }

  return { descriptor, close };
}

/**
 * @param {{ descriptor: unknown, request: unknown, config: SteeringConfig }} options
 */
export async function deliverSteeringRequest({ descriptor, request, config }) {
  validateDescriptor(descriptor);
  validateRequest(request);
  if (!sameOwnedWorkerGeneration(descriptor.worker, request.worker)) {
    throw new SteeringDeliveryError(
      `Steering request ${request.requestId} does not match the endpoint worker generation.`,
      "rejected",
      request.requestId
    );
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: descriptor.address });
    let connected = false;
    let written = false;
    let settled = false;
    let buffer = "";

    /**
     * @param {string} message
     * @param {"rejected" | "unknown"} delivery
     * @param {unknown} cause
     */
    const fail = (message, delivery, cause = null) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(
        new SteeringDeliveryError(
          message,
          delivery,
          request.requestId,
          cause ? { cause } : {}
        )
      );
    };

    socket.setEncoding("utf8");
    socket.setTimeout(config.requestTimeoutMs);
    socket.on("connect", () => {
      connected = true;
      written = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("timeout", () => {
      fail(
        written
          ? `Steering delivery unknown for request ${request.requestId}: timed out after sending.`
          : `Steering request ${request.requestId} timed out before delivery.`,
        written ? "unknown" : "rejected"
      );
    });
    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > config.maxFrameBytes) {
        fail(
          `Steering delivery unknown for request ${request.requestId}: response exceeded the maximum frame size.`,
          "unknown"
        );
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      /** @type {unknown} */
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newlineIndex));
        validateResponse(response);
      } catch (error) {
        fail(
          `Steering delivery unknown for request ${request.requestId}: invalid response.`,
          "unknown",
          error
        );
        return;
      }
      if (response.requestId !== request.requestId) {
        fail(
          `Steering delivery unknown for request ${request.requestId}: response id mismatch.`,
          "unknown"
        );
        return;
      }
      if (!response.ok) {
        fail(
          response.error.delivery === "unknown"
            ? `Steering delivery unknown for request ${request.requestId}: ${response.error.message}`
            : `Steering rejected for request ${request.requestId}: ${response.error.message}`,
          response.error.delivery
        );
        return;
      }
      if (
        response.jobId !== request.jobId ||
        response.threadId !== descriptor.threadId ||
        response.turnId !== descriptor.turnId
      ) {
        fail(
          `Steering delivery unknown for request ${request.requestId}: acknowledgement target mismatch.`,
          "unknown"
        );
        return;
      }
      settled = true;
      socket.end();
      resolve(response);
    });
    socket.on("error", (error) => {
      fail(
        written
          ? `Steering delivery unknown for request ${request.requestId}: transport failed after sending.`
          : `Steering request ${request.requestId} could not reach the worker endpoint.`,
        written ? "unknown" : "rejected",
        error
      );
    });
    socket.on("close", () => {
      if (!settled) {
        fail(
          written
            ? `Steering delivery unknown for request ${request.requestId}: transport closed before acknowledgement.`
            : `Steering request ${request.requestId} could not connect to the worker endpoint.`,
          written || connected ? "unknown" : "rejected"
        );
      }
    });
  });
}
