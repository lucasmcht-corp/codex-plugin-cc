import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import test from "node:test";

import { loadRuntimeConfig } from "../plugins/codex/scripts/lib/runtime-config.mjs";
import { AppServerRequestError } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  buildSteeringDescriptor,
  cleanupSteeringEndpoint,
  deliverSteeringRequest,
  openSteeringServer,
  resolveNativeSteer,
  SteeringDeliveryError
} from "../plugins/codex/scripts/lib/steering-channel.mjs";
import {
  makePosixWorker,
  makeTempDir,
  makeWindowsWorker
} from "./helpers.mjs";

function testWorker(token = "worker-token-123456") {
  return makePosixWorker({
    pid: process.pid,
    token,
    startKey: "worker-start-key"
  });
}

function buildRequest(descriptor, overrides = {}) {
  return {
    version: 1,
    requestId: "steer-request-1",
    jobId: "task-steer",
    worker: descriptor.worker,
    threadId: descriptor.threadId,
    turnId: descriptor.turnId,
    instruction: "Focus on the failing tests.",
    ...overrides
  };
}

test("an accepted native steer stays accepted when post-acceptance logging throws an unknown value", async () => {
  let steerCalls = 0;
  let rejectedLogs = 0;
  const loggingFailures = [];

  const result = await resolveNativeSteer({
    steer: async () => {
      steerCalls += 1;
      return {
        threadId: "thr_exact",
        turnId: "turn_exact"
      };
    },
    logAccepted: () => {
      throw { kind: "log-failure" };
    },
    logRejected: () => {
      rejectedLogs += 1;
    },
    onLogError: (error) => {
      loggingFailures.push(error);
    }
  });

  assert.deepEqual(result, {
    threadId: "thr_exact",
    turnId: "turn_exact"
  });
  assert.equal(steerCalls, 1);
  assert.equal(rejectedLogs, 0);
  assert.deepEqual(loggingFailures, [{ kind: "log-failure" }]);
});

test("an unknown native steer is never logged as rejected", async () => {
  let rejectedLogs = 0;
  const error = new AppServerRequestError(
    "turn/steer response was lost after the request was sent."
  );

  await assert.rejects(
    resolveNativeSteer({
      steer: async () => {
        throw error;
      },
      logAccepted: () => {},
      logRejected: () => {
        rejectedLogs += 1;
      }
    }),
    (caught) => caught === error
  );
  assert.equal(rejectedLogs, 0);
});

test("private steering channel authenticates one worker generation and acknowledges the exact turn", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const received = [];
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async (request) => {
      received.push(request);
      return {
        threadId: request.threadId,
        turnId: request.turnId
      };
    }
  });
  t.after(() => channel.close());

  if (channel.descriptor.kind === "unix") {
    assert.equal(fs.existsSync(channel.descriptor.address), true);
  } else {
    assert.equal(process.platform, "win32");
    assert.equal(channel.descriptor.kind, "pipe");
  }

  const response = await deliverSteeringRequest({
    descriptor: channel.descriptor,
    request: buildRequest(channel.descriptor),
    config
  });

  assert.deepEqual(response, {
    requestId: "steer-request-1",
    ok: true,
    jobId: "task-steer",
    threadId: "thr_exact",
    turnId: "turn_exact"
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].instruction, "Focus on the failing tests.");

  await channel.close();
  if (channel.descriptor.kind === "unix") {
    assert.equal(fs.existsSync(channel.descriptor.address), false);
  }
});

test("private steering channel returns the typed rejection shape for an unidentifiable request", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async () => ({
      threadId: "thr_exact",
      turnId: "turn_exact"
    })
  });
  t.after(() => channel.close());

  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: channel.descriptor.address });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("{}\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(error);
      }
    });
  });

  assert.deepEqual(response, {
    requestId: null,
    ok: false,
    error: {
      message: "Steering request is missing required fields.",
      delivery: "rejected"
    }
  });
});

test("the steering channel preserves unknown delivery and definitive rejection", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async (request) => {
      if (request.instruction === "unknown") {
        throw new AppServerRequestError(
          "turn/steer response was lost after the request was sent."
        );
      }
      if (request.instruction === "mismatched acknowledgement") {
        return {
          threadId: request.threadId,
          turnId: "turn_other"
        };
      }
      throw new Error("turn is no longer active");
    }
  });
  t.after(() => channel.close());

  await assert.rejects(
    deliverSteeringRequest({
      descriptor: channel.descriptor,
      request: buildRequest(channel.descriptor, {
        instruction: "unknown"
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "unknown" &&
      /response was lost after the request was sent/i.test(error.message)
  );

  await assert.rejects(
    deliverSteeringRequest({
      descriptor: channel.descriptor,
      request: buildRequest(channel.descriptor, {
        requestId: "steer-request-2",
        instruction: "mismatched acknowledgement"
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "unknown" &&
      /different thread or turn/i.test(error.message)
  );

  await assert.rejects(
    deliverSteeringRequest({
      descriptor: channel.descriptor,
      request: buildRequest(channel.descriptor, {
        requestId: "steer-request-3",
        instruction: "rejected"
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "rejected" &&
      /turn is no longer active/i.test(error.message)
  );
});

test("private steering channel rejects a stale generation without invoking the handler", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  let calls = 0;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async () => {
      calls += 1;
      return { threadId: "thr_exact", turnId: "turn_exact" };
    }
  });
  t.after(() => channel.close());

  await assert.rejects(
    deliverSteeringRequest({
      descriptor: channel.descriptor,
      request: buildRequest(channel.descriptor, {
        worker: testWorker("stale-worker-token")
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "rejected" &&
      /does not match the endpoint worker generation/i.test(error.message)
  );
  assert.equal(calls, 0);
});

test("steering delivery rejects a POSIX worker with another pid and process group", async () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot: makeTempDir() }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker: makePosixWorker({
      pid: 1234,
      processGroupId: 1234
    }),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });

  await assert.rejects(
    deliverSteeringRequest({
      descriptor,
      request: buildRequest(descriptor, {
        worker: makePosixWorker({
          pid: 4321,
          processGroupId: 4321
        })
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "rejected" &&
      /does not match the endpoint worker generation/i.test(error.message)
  );
});

test("steering delivery rejects a Windows worker with another pid and Job Object", async () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot: makeTempDir() }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker: makeWindowsWorker({ pid: 1234 }),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });

  await assert.rejects(
    deliverSteeringRequest({
      descriptor,
      request: buildRequest(descriptor, {
        worker: makeWindowsWorker({
          pid: 4321,
          token: "other-worker"
        })
      }),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "rejected" &&
      /does not match the endpoint worker generation/i.test(error.message)
  );
});

test("a post-dispatch steering timeout is delivery unknown even when execution continues", async () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 25
    }
  }).steering;
  let calls = 0;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { threadId: "thr_exact", turnId: "turn_exact" };
    }
  });

  try {
    await assert.rejects(
      deliverSteeringRequest({
        descriptor: channel.descriptor,
        request: buildRequest(channel.descriptor),
        config
      }),
      (error) =>
        error instanceof SteeringDeliveryError &&
        error.delivery === "unknown" &&
        /timed out after sending/i.test(error.message)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 1);
  } finally {
    await channel.close();
  }
});

test("steering close rejects when its endpoint cannot be removed", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  let removeCalls = 0;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config,
    handleSteer: async () => ({
      threadId: "thr_exact",
      turnId: "turn_exact"
    }),
    removeFileIfExistsImpl(filePath) {
      removeCalls += 1;
      if (removeCalls > 1) {
        throw Object.assign(new Error("cannot unlink endpoint"), { code: "EACCES" });
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
  t.after(() => {
    if (fs.existsSync(channel.descriptor.address)) {
      fs.unlinkSync(channel.descriptor.address);
    }
  });

  await assert.rejects(channel.close(), /cannot unlink endpoint/);
});

test("post-listen steering initialization failure closes the server and removes its endpoint", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket permissions are not available on Windows.");
    return;
  }
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-post-listen-failure",
    worker: testWorker(),
    threadId: "thr_post_listen",
    turnId: "turn_post_listen",
    config
  });
  /** @type {net.Server | null} */
  let observedServer = null;

  await assert.rejects(
    openSteeringServer({
      workspaceRoot,
      jobId: "task-post-listen-failure",
      worker: testWorker(),
      threadId: "thr_post_listen",
      turnId: "turn_post_listen",
      config,
      handleSteer: async () => ({
        threadId: "thr_post_listen",
        turnId: "turn_post_listen"
      }),
      createServerImpl(listener) {
        observedServer = net.createServer(listener);
        return observedServer;
      },
      chmodSyncImpl() {
        throw Object.assign(new Error("cannot secure endpoint"), {
          code: "EACCES"
        });
      }
    }),
    /cannot secure endpoint/
  );

  assert.ok(observedServer);
  assert.equal(observedServer.listening, false);
  assert.equal(fs.existsSync(descriptor.address), false);
});

test("post-listen steering initialization reports cleanup failures", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket permissions are not available on Windows.");
    return;
  }
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  let removeCalls = 0;

  await assert.rejects(
    openSteeringServer({
      workspaceRoot,
      jobId: "task-post-listen-cleanup-failure",
      worker: testWorker(),
      threadId: "thr_cleanup_failure",
      turnId: "turn_cleanup_failure",
      config,
      handleSteer: async () => ({
        threadId: "thr_cleanup_failure",
        turnId: "turn_cleanup_failure"
      }),
      chmodSyncImpl() {
        throw new Error("cannot secure endpoint");
      },
      removeFileIfExistsImpl(filePath) {
        removeCalls += 1;
        if (removeCalls > 1) {
          throw new Error("cannot remove failed endpoint");
        }
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((cause) => /cannot secure endpoint/.test(String(cause))) &&
      error.errors.some((cause) => /cannot remove failed endpoint/.test(String(cause)))
  );
});

test("Unix steering runtime errors close the server, sockets, and endpoint once", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix sockets are not available on Windows.");
    return;
  }
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  /** @type {net.Server | null} */
  let observedServer = null;
  const reports = [];
  let reportReady;
  const reportPromise = new Promise((resolve) => {
    reportReady = resolve;
  });
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-runtime-unix",
    worker: testWorker(),
    threadId: "thr_runtime_unix",
    turnId: "turn_runtime_unix",
    config,
    handleSteer: async () => ({
      threadId: "thr_runtime_unix",
      turnId: "turn_runtime_unix"
    }),
    createServerImpl(listener) {
      observedServer = net.createServer(listener);
      return observedServer;
    },
    onError(error, descriptor, endpointRemoved) {
      reports.push({ error, descriptor, endpointRemoved });
      reportReady();
    }
  });
  const client = net.createConnection({ path: channel.descriptor.address });
  const connected = new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const clientClosed = new Promise((resolve) => {
    client.once("close", resolve);
  });
  t.after(() => client.destroy());
  await connected;

  const runtimeError = new Error("runtime Unix server failure");
  observedServer.emit("error", runtimeError);
  observedServer.emit("error", new Error("duplicate runtime failure"));
  await reportPromise;
  await clientClosed;

  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, runtimeError);
  assert.equal(reports[0].descriptor, channel.descriptor);
  assert.equal(reports[0].endpointRemoved, true);
  assert.equal(observedServer.listening, false);
  assert.equal(fs.existsSync(channel.descriptor.address), false);
  await channel.close();
});

test("named-pipe steering runtime errors close the synthetic server once", async () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot: makeTempDir(), requestTimeoutMs: 1000 }
  }).steering;
  let observedServer;
  let closeCalls = 0;
  const reports = [];
  let reportReady;
  const reportPromise = new Promise((resolve) => {
    reportReady = resolve;
  });
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-runtime-pipe",
    worker: makeWindowsWorker(),
    threadId: "thr_runtime_pipe",
    turnId: "turn_runtime_pipe",
    config,
    handleSteer: async () => ({
      threadId: "thr_runtime_pipe",
      turnId: "turn_runtime_pipe"
    }),
    createServerImpl(listener) {
      const server = net.createServer(listener);
      server.listen = () => {
        queueMicrotask(() => server.emit("listening"));
        return server;
      };
      server.close = (callback) => {
        closeCalls += 1;
        queueMicrotask(() => callback());
        return server;
      };
      observedServer = server;
      return server;
    },
    onError(error, descriptor, endpointRemoved) {
      reports.push({ error, descriptor, endpointRemoved });
      reportReady();
    }
  });

  const runtimeError = new Error("runtime pipe server failure");
  observedServer.emit("error", runtimeError);
  observedServer.emit("error", new Error("duplicate pipe failure"));
  await reportPromise;

  assert.equal(channel.descriptor.kind, "pipe");
  assert.equal(closeCalls, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, runtimeError);
  assert.equal(reports[0].endpointRemoved, true);
  await channel.close();
  assert.equal(closeCalls, 1);
});

test("steering runtime errors aggregate close and unlink failures", async () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot: makeTempDir(), requestTimeoutMs: 1000 }
  }).steering;
  let observedServer;
  let removeCalls = 0;
  const reports = [];
  let reportReady;
  const reportPromise = new Promise((resolve) => {
    reportReady = resolve;
  });
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-runtime-cleanup-failure",
    worker: testWorker(),
    threadId: "thr_runtime_cleanup",
    turnId: "turn_runtime_cleanup",
    config,
    handleSteer: async () => ({
      threadId: "thr_runtime_cleanup",
      turnId: "turn_runtime_cleanup"
    }),
    createServerImpl(listener) {
      const server = net.createServer(listener);
      server.listen = () => {
        queueMicrotask(() => server.emit("listening"));
        return server;
      };
      server.close = (callback) => {
        queueMicrotask(() => callback(new Error("runtime close failed")));
        return server;
      };
      observedServer = server;
      return server;
    },
    chmodSyncImpl() {},
    removeFileIfExistsImpl() {
      removeCalls += 1;
      if (removeCalls > 1) {
        throw new Error("runtime unlink failed");
      }
    },
    onError(error, descriptor, endpointRemoved) {
      reports.push({ error, descriptor, endpointRemoved });
      reportReady();
    }
  });

  const runtimeError = new Error("runtime server failure");
  observedServer.emit("error", runtimeError);
  observedServer.emit("error", new Error("duplicate cleanup failure"));
  await reportPromise;

  assert.equal(reports.length, 1);
  assert.equal(reports[0].endpointRemoved, false);
  assert.ok(reports[0].error instanceof AggregateError);
  assert.deepEqual(
    reports[0].error.errors.map((error) => error.message),
    [
      "runtime server failure",
      "runtime close failed",
      "runtime unlink failed"
    ]
  );
  await assert.rejects(
    channel.close(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.map((cause) => cause.message).join(",") ===
        "runtime close failed,runtime unlink failed"
  );
});

test("transport close after one written request is delivery unknown and is never retried", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const worker = testWorker();
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker,
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });
  if (descriptor.kind === "unix") {
    fs.mkdirSync(config.socketRoot, { recursive: true });
  }

  let requests = 0;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", () => {
      requests += 1;
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.address, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );

  await assert.rejects(
    deliverSteeringRequest({
      descriptor,
      request: buildRequest(descriptor),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "unknown" &&
      error.requestId === "steer-request-1"
  );
  assert.equal(requests, 1);
});

test("an acknowledgement for another turn is delivery unknown", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });
  if (descriptor.kind === "unix") {
    fs.mkdirSync(config.socketRoot, { recursive: true });
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          requestId: "steer-request-1",
          ok: true,
          jobId: "task-steer",
          threadId: "thr_exact",
          turnId: "turn_other"
        })}\n`
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.address, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );

  await assert.rejects(
    deliverSteeringRequest({
      descriptor,
      request: buildRequest(descriptor),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "unknown" &&
      /acknowledgement target mismatch/i.test(error.message)
  );
});

test("a rejection using the obsolete string error shape is an invalid response", async (t) => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: {
      socketRoot: makeTempDir(),
      requestTimeoutMs: 1000
    }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });
  if (descriptor.kind === "unix") {
    fs.mkdirSync(config.socketRoot, { recursive: true });
  }

  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          requestId: "steer-request-1",
          ok: false,
          error: "obsolete rejection"
        })}\n`
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.address, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );

  await assert.rejects(
    deliverSteeringRequest({
      descriptor,
      request: buildRequest(descriptor),
      config
    }),
    (error) =>
      error instanceof SteeringDeliveryError &&
      error.delivery === "unknown" &&
      /invalid response/i.test(error.message)
  );
});

test("endpoint cleanup refuses metadata from another worker generation", () => {
  const workspaceRoot = makeTempDir();
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot: makeTempDir() }
  }).steering;
  const descriptor = buildSteeringDescriptor({
    workspaceRoot,
    jobId: "task-steer",
    worker: testWorker(),
    threadId: "thr_exact",
    turnId: "turn_exact",
    config
  });

  assert.throws(
    () =>
      cleanupSteeringEndpoint(descriptor, {
        workspaceRoot,
        jobId: "task-steer",
        worker: testWorker("different-worker-token"),
        config
      }),
    /does not match the active worker generation/i
  );
});

test("steering creates only its owned leaf privately without chmodding a supplied parent", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not available on Windows.");
    return;
  }
  const workspaceRoot = makeTempDir();
  const suppliedParent = makeTempDir();
  fs.chmodSync(suppliedParent, 0o755);
  const socketRoot = `${suppliedParent}/owned-steering`;
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot, requestTimeoutMs: 1000 }
  }).steering;
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: "task-private-root",
    worker: testWorker(),
    threadId: "thr_private",
    turnId: "turn_private",
    config,
    handleSteer: async () => ({
      threadId: "thr_private",
      turnId: "turn_private"
    })
  });

  try {
    assert.equal(fs.statSync(suppliedParent).mode & 0o777, 0o755);
    assert.equal(fs.statSync(socketRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(channel.descriptor.address).mode & 0o777, 0o600);
  } finally {
    await channel.close();
  }
});

test("steering rejects an existing runtime root with public permissions without changing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not available on Windows.");
    return;
  }
  const workspaceRoot = makeTempDir();
  const socketRoot = makeTempDir();
  fs.chmodSync(socketRoot, 0o755);
  const config = loadRuntimeConfig(process.env, {
    steering: { socketRoot, requestTimeoutMs: 1000 }
  }).steering;

  await assert.rejects(
    openSteeringServer({
      workspaceRoot,
      jobId: "task-insecure-root",
      worker: testWorker(),
      threadId: "thr_insecure",
      turnId: "turn_insecure",
      config,
      handleSteer: async () => ({
        threadId: "thr_insecure",
        turnId: "turn_insecure"
      })
    }),
    /must use mode 700/i
  );
  assert.equal(fs.statSync(socketRoot).mode & 0o777, 0o755);
});
