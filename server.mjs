import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const AI_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function getDraft(text, classifyRequest) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("AI deadline exceeded"));
      }, AI_TIMEOUT_MS);
    });
    const output = await Promise.race([
      classifyRequest(text, { signal: controller.signal }),
      timeout,
    ]);
    if (typeof output !== "string") return null;
    const result = JSON.parse(output);
    if (
      result === null || typeof result !== "object" || Array.isArray(result) ||
      !TOPICS.has(result.topic) ||
      typeof result.draft !== "string" || !result.draft.trim()
    ) return null;
    return { topic: result.topic, draft: result.draft.trim() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, classifyRequest) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  const result = await getDraft(input.text.trim(), classifyRequest);
  return json(response, 200, result
    ? { status: "ready", ...result }
    : { status: "manual_review", topic: null, draft: null });
}

export function createAppServer({ classifyRequest = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifyRequest);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}