import assert from "node:assert/strict";
import test from "node:test";

import {
  getCodexAuthStatus,
  requestExternalAgentSessionImport,
  withAppServer
} from "../plugins/codex/scripts/lib/codex.mjs";

test("external session import deadline covers a request that never responds", { timeout: 1000 }, async () => {
  const originalHandler = () => {};
  const client = {
    notificationHandler: originalHandler,
    setNotificationHandler(handler) {
      this.notificationHandler = handler;
    },
    request() {
      this.notificationHandler({
        method: "externalAgentConfig/import/completed"
      });
      return new Promise(() => {});
    }
  };

  await assert.rejects(
    requestExternalAgentSessionImport(client, { migrationItems: [] }, 20),
    /timed out while importing/i
  );
  assert.equal(client.notificationHandler, originalHandler);
});

test("app-server lifecycle preserves operation and cleanup failures", async () => {
  const operationError = new Error("operation failed");
  const cleanupError = new Error("cleanup failed");
  const client = {
    async close() {
      throw cleanupError;
    }
  };

  await assert.rejects(
    withAppServer(
      "/workspace",
      async () => {
        throw operationError;
      },
      async () => client
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      return true;
    }
  );
});

test("app-server lifecycle propagates an operation failure after clean shutdown", async () => {
  const operationError = new Error("operation failed");
  const client = {
    async close() {}
  };

  await assert.rejects(
    withAppServer(
      "/workspace",
      async () => {
        throw operationError;
      },
      async () => client
    ),
    (error) => error === operationError
  );
});

test("app-server lifecycle propagates a cleanup failure after a successful operation", async () => {
  const cleanupError = new Error("cleanup failed");
  const client = {
    async close() {
      throw cleanupError;
    }
  };

  await assert.rejects(
    withAppServer(
      "/workspace",
      async () => "completed",
      async () => client
    ),
    (error) => error === cleanupError
  );
});

test("auth status propagates an invocation-owned app-server cleanup failure", async () => {
  const cleanupError = new Error("app-server cleanup failed");
  const client = {
    async request(method) {
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
          requiresOpenaiAuth: true
        };
      }
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
    },
    async close() {
      throw cleanupError;
    }
  };

  await assert.rejects(
    getCodexAuthStatus("/workspace", {
      availabilityImpl: () => ({ available: true, detail: "available" }),
      connectImpl: async () => client
    }),
    (error) => error === cleanupError
  );
});
