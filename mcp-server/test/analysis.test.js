import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, analyzeWithAzure, listFailedRuns, prepareExcerpt, readConfig, redact } from "../src/analysis.js";

const config = readConfig({ AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/" });
const validAnalysis = {
  summary: "SDK setup failed.",
  causes: [{
    title: "Retired package",
    evidence: ["L1: Error: Failed to find package 'tools'"],
    recommendedFix: "Install explicit SDK packages.",
    confidence: "high",
  }],
  nextSteps: ["Rerun CI after updating SDK setup."],
};

test("validates Azure endpoint and repository before credential acquisition", () => {
  for (const endpoint of [
    "http://example.openai.azure.com", "https://attacker.example",
    "https://example.openai.azure.com.evil.example", "https://user:pass@example.openai.azure.com",
    "https://example.openai.azure.com/path", "https://example.openai.azure.com?key=value",
  ]) {
    assert.throws(() => readConfig({ AZURE_OPENAI_ENDPOINT: endpoint }));
  }
  assert.throws(() => readConfig({
    AZURE_OPENAI_ENDPOINT: config.endpoint,
    GITHUB_REPOSITORY: "--malicious",
  }));
  assert.equal(config.deployment, "gpt-4.1-mini");
});

test("redacts common credentials and URLs with embedded passwords", () => {
  const input = 'api-key: abc123 password="hunter2" Authorization: Bearer token123 ghp_abcdefghijklmnop https://user:pass@example.com eyJhbGci.eyJzdWI.signature';
  const output = redact(input);
  for (const secret of ["abc123", "hunter2", "token123", "abcdefghijklmnop", "user:pass", "eyJhbGci"]) {
    assert.ok(!output.includes(secret), `Leaked ${secret}`);
  }
});

test("bounds large excerpts and retains errors with line labels", () => {
  const excerpt = prepareExcerpt("Error: failure\n".repeat(8000));
  assert.ok(excerpt.text.length <= 24000);
  assert.equal(excerpt.truncated, true);
  assert.match(excerpt.text, /L1: Error/);
  assert.match(excerpt.text, /excerpt truncated/);
  assert.throws(() => prepareExcerpt(""), /No failed-job logs/);
  assert.throws(() => prepareExcerpt("x".repeat(3000001)), /3 MB/);
});

test("lists failures only in the configured repository with bounded limits", async () => {
  const result = await listFailedRuns(config, 3, async (args) => {
    assert.ok(args.includes(config.repository));
    assert.equal(args[args.indexOf("--status") + 1], "failure");
    assert.equal(args[args.indexOf("--limit") + 1], "3");
    return "[]";
  });
  assert.deepEqual(result, []);
  await assert.rejects(listFailedRuns(config, 11), /limit/);
});

test("rejects invalid IDs and successful or incomplete runs before log access", async () => {
  for (const runId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(analyzeRun(config, runId), /runId/);
  }
  for (const run of [
    { status: "completed", conclusion: "success" },
    { status: "in_progress", conclusion: null },
  ]) {
    let calls = 0;
    await assert.rejects(analyzeRun(config, 123, {
      github: async () => { calls++; return JSON.stringify(run); },
    }), /Only completed runs/);
    assert.equal(calls, 1);
  }
});

test("sends only redacted excerpts and validates returned analysis", async () => {
  const dependencies = {
    github: async (args) => args.includes("--log-failed")
      ? "Error: Failed to find package 'tools'\napi_key=secret123"
      : JSON.stringify({ databaseId: 123, status: "completed", conclusion: "failure" }),
    analyze: async (_config, _run, text) => {
      assert.ok(!text.includes("secret123"));
      assert.match(text, /L1:/);
      return validAnalysis;
    },
  };
  const result = await analyzeRun(config, 123, dependencies);
  assert.equal(result.analysis.causes[0].confidence, "high");
  assert.ok(result.excerpt.charactersSent <= 24000);
  await assert.rejects(analyzeRun(config, 123, {
    ...dependencies, analyze: async () => ({ summary: "missing causes" }),
  }));
  await assert.rejects(analyzeRun(config, 123, {
    ...dependencies, analyze: async () => { throw new Error("Azure unavailable"); },
  }), /Azure unavailable/);
});

test("Azure request uses Entra authentication and strict structured output", async () => {
  const result = await analyzeWithAzure(config, { databaseId: 123, name: "Android CI" }, "L1: Error", {
    getToken: async () => "test-token",
    fetch: async (url, options) => {
      assert.equal(new URL(url).hostname, "example.openai.azure.com");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      const body = JSON.parse(options.body);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
      assert.ok(!JSON.stringify(body.response_format.json_schema.schema).includes("minLength"));
      assert.ok(!JSON.stringify(body.response_format.json_schema.schema).includes("minItems"));
      assert.match(body.messages[0].content, /untrusted/);
      return Response.json({ choices: [{
        finish_reason: "stop", message: { content: JSON.stringify(validAnalysis) },
      }] });
    },
  });
  assert.deepEqual(result, validAnalysis);
});

test("Azure authentication, HTTP errors, refusals, and incomplete output fail explicitly", async () => {
  const dependencies = { getToken: async () => "test-token" };
  await assert.rejects(analyzeWithAzure(config, {}, "Error", {
    getToken: async () => { throw new Error("Please run az login"); },
  }), /az login/);
  await assert.rejects(analyzeWithAzure(config, {}, "Error", {
    ...dependencies,
    fetch: async () => new Response('{"error":{"code":"PermissionDenied"}}', { status: 401 }),
  }), /HTTP 401.*PermissionDenied/);
  for (const choice of [
    { finish_reason: "length", message: { content: "{}" } },
    { finish_reason: "stop", message: { refusal: "No" } },
  ]) {
    await assert.rejects(analyzeWithAzure(config, {}, "Error", {
      ...dependencies, fetch: async () => Response.json({ choices: [choice] }),
    }), /complete analysis/);
  }
});
