import assert from "node:assert/strict";
import { test } from "node:test";

import { AdapterError } from "#adapter-sdk";
import { reduceYonWorkSse, YonWorkSseReducer } from "../../adapters/yonwork-adapter/src/protocol.ts";

const opts = { expectedRunId: "run-1", expectedSessionKey: "session-1" };

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("only matching Gateway terminal frames prove remote completion", () => {
  const result = reduceYonWorkSse(
    [
      sse("chat.run-id", { runId: "run-1", result: "run-1" }),
      sse("chat.complete", { runId: "run-1" }),
      sse("chat.error", { runId: "run-1", message: "host failure" }),
      sse("chat.message", {
        runId: "other",
        sessionKey: "session-1",
        state: "final",
        role: "assistant",
        content: [{ type: "text", text: "wrong" }],
      }),
      sse("chat.message", {
        runId: "run-1",
        sessionKey: "session-1",
        state: "final",
        role: "assistant",
        content: [{ type: "text", text: "ok" }, { type: "reasoning", text: "private" }],
      }),
      sse("gateway:chat-message", {
        runId: "run-1",
        sessionKey: "session-1",
        state: "error",
        role: "assistant",
        content: [{ type: "text", text: "late" }],
      }),
    ],
    opts,
  );

  assert.equal(result.terminal?.state, "final");
  assert.equal(result.finalText, "ok");
});

test("streaming parser handles split utf8 and wrapper envelopes", () => {
  const bytes = new TextEncoder().encode(
    sse("gateway:chat-message", {
      message: {
        runId: "run-1",
        sessionKey: "session-1",
        state: "final",
        role: "assistant",
        content: [{ type: "text", text: "通过 ✅" }],
      },
    }),
  );
  const reducer = new YonWorkSseReducer(opts);

  const events = [
    ...reducer.push(bytes.slice(0, 17)),
    ...reducer.push(bytes.slice(17, 31)),
    ...reducer.push(bytes.slice(31)),
  ];
  reducer.finish();

  assert.equal(events.at(-1)?.kind, "terminal");
  assert.equal(reducer.result.finalText, "通过 ✅");
});

test("actual Host and Gateway envelopes keep transport metadata separate from assistant message", () => {
  const json = JSON.stringify({ status: "completed" });
  for (const payload of [
    {
      runId: "run-1",
      sessionKey: "session-1",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: json }, { type: "reasoning", text: "private" }],
      },
    },
    {
      message: {
        runId: "run-1",
        sessionKey: "session-1",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: json }],
        },
      },
    },
  ]) {
    const result = reduceYonWorkSse([sse("gateway:chat-message", payload)], opts);
    assert.equal(result.terminal?.state, "final");
    assert.equal(result.finalText, json);
  }
});

test("ambiguous conflicting wrapper identity is rejected", () => {
  assert.throws(
    () =>
      reduceYonWorkSse(
        [
          sse("chat.message", {
            runId: "run-1",
            sessionKey: "session-1",
            state: "final",
            message: { runId: "run-2", sessionKey: "session-1", state: "final" },
          }),
        ],
        opts,
      ),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_AMBIGUOUS",
  );
});

test("frame and total bounds fail closed without transcript bodies", () => {
  assert.throws(
    () => reduceYonWorkSse([`event: chat.message\ndata: ${"x".repeat(30)}\n\n`], { ...opts, maxFrameBytes: 24 }),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_FRAME_TOO_LARGE" && !err.message.includes("xxx"),
  );
  assert.throws(
    () => reduceYonWorkSse(["event: ping\n\n", "event: ping\n\n"], { ...opts, maxTotalBytes: 20 }),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_TOTAL_TOO_LARGE",
  );
});

test("frame bound and UTF-8 decode errors fail during push without raw bytes", () => {
  assert.throws(
    () => new YonWorkSseReducer({ ...opts, maxFrameBytes: 10 }).push("event: chat.message\ndata: "),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_FRAME_TOO_LARGE",
  );
  assert.throws(
    () => new YonWorkSseReducer(opts).push(Uint8Array.from([0xff])),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_INVALID_UTF8" && !err.message.includes("255"),
  );
});

test("malformed JSON is rejected as sanitized protocol error", () => {
  assert.throws(
    () => reduceYonWorkSse(["event: chat.message\ndata: {not-json}\n\n"], opts),
    (err) => err instanceof AdapterError && err.code === "YONWORK_PROTOCOL_INVALID" && !err.message.includes("not-json"),
  );
});
