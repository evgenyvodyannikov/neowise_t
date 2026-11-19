import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createAppServer } from "../server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };

async function startServer(t, options) {
  const server = createAppServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.match(response.headers.get("content-type"), /application\/json/);
    return { status: response.status, body: await response.json() };
  };
}

test("invalid input returns 400 without calling AI", async (t) => {
  let calls = 0;
  const post = await startServer(t, { classifyRequest: () => { calls++; } });
  const inputs = [
    "", "{broken", "null", "[]", "42", "true", '"text"', "{}",
    ...[null, 0, false, [], {}, "", " \n\t "].map((text) => JSON.stringify({ text })),
  ];
  for (const body of inputs) {
    await t.test(`body: ${JSON.stringify(body)}`, async () => {
      assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } });
    });
  }
  assert.equal(calls, 0);
});

test("valid mock output returns the expected topic and draft", async (t) => {
  const post = await startServer(t);
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"], ["Какая стоимость?", "pricing"], ["Здравствуйте", "other"],
  ]) {
    await t.test(topic, async () => {
      assert.deepEqual(await post(JSON.stringify({ text })), {
        status: 200,
        body: { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." },
      });
    });
  }
});

test("every mock failure returns manual review, including the 300 ms deadline", async (t) => {
  const post = await startServer(t);
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(marker, async () => {
      const start = performance.now();
      assert.deepEqual(await post(JSON.stringify({ text: marker })), { status: 200, body: manualReview });
      if (marker === "[timeout]") {
        const elapsed = performance.now() - start;
        // Leave room for CI scheduling, but reject waiting for the mock's 1,200 ms delay.
        assert.ok(elapsed >= 250 && elapsed < 1_000, `response took ${elapsed} ms`);
      }
    });
  }
  // A failed request must not prevent the next request from succeeding.
  assert.equal((await post(JSON.stringify({ text: "Доставка" }))).body.status, "ready");
});

test("invalid AI response shapes are rejected and extra fields cannot override status", async (t) => {
  let output;
  const post = await startServer(t, { classifyRequest: async () => output });
  const invalid = [
    undefined, { topic: "delivery", draft: "Ответ" }, "null", "[]", "42", '"text"',
    "{}", '{"topic":"delivery"}', '{"draft":"Ответ"}',
    '{"topic":null,"draft":"Ответ"}', '{"topic":"refund","draft":"Ответ"}',
    ...[null, 42, [], {}, "", " \n\t "].map((draft) => JSON.stringify({ topic: "delivery", draft })),
  ];
  for (const value of invalid) {
    await t.test(`output: ${JSON.stringify(value)}`, async () => {
      output = value;
      assert.deepEqual(await post('{"text":"Заявка"}'), { status: 200, body: manualReview });
    });
  }
  output = '{"status":"manual_review","topic":"delivery","draft":"  Ответ  ","extra":"ignore"}';
  assert.deepEqual(await post('{"text":"Заявка"}'), {
    status: 200, body: { status: "ready", topic: "delivery", draft: "Ответ" },
  });
});

test("deadline aborts the provider and also bounds a provider that ignores cancellation", { timeout: 2_000 }, async (t) => {
  let signal;
  const post = await startServer(t, {
    classifyRequest: (_text, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.deepEqual(await post('{"text":"Заявка"}'), { status: 200, body: manualReview });
  assert.equal(signal.aborted, true);
});

test("synchronous provider errors fall back to manual review", async (t) => {
  const post = await startServer(t, { classifyRequest: () => { throw new Error("unavailable"); } });
  assert.deepEqual(await post('{"text":"Заявка"}'), { status: 200, body: manualReview });
});

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function page(fetchImpl) {
  const nodes = Object.fromEntries([
    "form", "#message", "button", "#status", "#draft-result", "#topic", "#draft",
  ].map((selector) => [selector, {
    textContent: "", value: "", disabled: false, hidden: selector === "#draft-result",
    focus() { this.focused = true; },
    addEventListener(event, listener) { this[event] = listener; },
  }]));
  runInNewContext(script, {
    document: { querySelector: (selector) => nodes[selector] }, fetch: fetchImpl, AbortSignal,
  });
  return {
    nodes,
    submit(text = "Доставка") {
      nodes["#message"].value = text;
      return nodes.form.submit({ preventDefault() {} });
    },
  };
}

const ready = { status: "ready", topic: "delivery", draft: "Предыдущий черновик" };
const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test("page clears a previous draft and offers manual review on any failure", async (t) => {
  const failures = [
    ["manual review", async () => reply(manualReview)],
    ["HTTP error", async () => reply({ status: "server_error" }, 500)],
    ["network error", async () => { throw new TypeError("network unavailable"); }],
    ["client timeout", async () => { throw new DOMException("timeout", "TimeoutError"); }],
    ["bad JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } })],
    ["bad response", async () => reply({ status: "ready", topic: "refund", draft: "invalid" })],
    ["null response", async () => reply(null)],
  ];
  for (const [name, fail] of failures) {
    await t.test(name, async () => {
      let next = async () => reply(ready);
      const view = page((...args) => next(...args));
      await view.submit();
      assert.equal(view.nodes["#draft"].textContent, ready.draft);
      assert.equal(view.nodes["#topic"].textContent, "Доставка");
      next = fail;
      await view.submit();
      assert.equal(view.nodes["#draft"].textContent, "");
      assert.equal(view.nodes["#topic"].textContent, "");
      assert.equal(view.nodes["#draft-result"].hidden, true);
      assert.match(view.nodes["#status"].textContent, /вручную/);
      assert.equal(view.nodes.button.disabled, false);
      assert.equal(view.nodes["#message"].disabled, false);
      next = async () => reply(ready);
      await view.submit();
      assert.equal(view.nodes["#draft-result"].hidden, false);
    });
  }
});

test("page rejects blank input locally and clears a previous draft", async () => {
  let calls = 0;
  const view = page(async () => { calls++; return reply(ready); });
  await view.submit();
  await view.submit(" \n\t ");
  assert.equal(calls, 1);
  assert.equal(view.nodes["#draft"].textContent, "");
  assert.equal(view.nodes["#topic"].textContent, "");
  assert.match(view.nodes["#status"].textContent, /Введите/);
  assert.equal(view.nodes["#message"].focused, true);
});

test("page clears the old result while waiting and blocks duplicate submissions", async () => {
  let next = async () => reply(ready);
  let calls = 0;
  const view = page((...args) => { calls++; return next(...args); });
  await view.submit();
  let finish;
  next = () => new Promise((resolve) => { finish = resolve; });
  const pending = view.submit();
  assert.equal(view.nodes.button.disabled, true);
  assert.equal(view.nodes["#message"].disabled, true);
  assert.equal(view.nodes["#draft"].textContent, "");
  assert.equal(view.nodes["#draft-result"].hidden, true);
  await view.submit();
  assert.equal(calls, 2);
  finish(reply(manualReview));
  await pending;
  assert.match(view.nodes["#status"].textContent, /вручную/);
  assert.equal(view.nodes.button.disabled, false);
});
