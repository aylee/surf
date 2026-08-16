import assert from "node:assert/strict";
import test from "node:test";
import {
  readBoundedResponseJson,
  readBoundedResponseText
} from "../lib/bounded-http-response.mjs";

test("bounded response readers accept small text and JSON bodies", async () => {
  assert.equal(
    await readBoundedResponseText(new Response("ok"), {
      maxBytes: 2,
      label: "test response"
    }),
    "ok"
  );
  assert.deepEqual(
    await readBoundedResponseJson(new Response('{"ok":true}'), {
      maxBytes: 32,
      label: "test JSON"
    }),
    { ok: true }
  );
  assert.equal(
    await readBoundedResponseText(new Response(null), {
      maxBytes: 1,
      label: "empty response"
    }),
    ""
  );
});

test("bounded response readers reject declared and streamed overflow", async () => {
  await assert.rejects(
    readBoundedResponseText(
      new Response("x", { headers: { "content-length": "100" } }),
      { maxBytes: 10, label: "declared response" }
    ),
    /exceeded/
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    }
  });
  await assert.rejects(
    readBoundedResponseText(new Response(stream), {
      maxBytes: 10,
      label: "streamed response"
    }),
    /exceeded/
  );
});

test("bounded JSON parsing rejects malformed bodies without echoing them", async () => {
  await assert.rejects(
    readBoundedResponseJson(new Response("secret-not-json"), {
      maxBytes: 32,
      label: "private response"
    }),
    (error) =>
      error instanceof Error &&
      /malformed JSON/.test(error.message) &&
      !error.message.includes("secret-not-json")
  );
});
