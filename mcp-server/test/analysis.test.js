import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, analyzeWithAzure, listFailedRuns, prepareExcerpt, readConfig, redact } from "../src/analysis.js";

const config = readConfig({ AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/" });
const validAnalysis = {
  summary: "SDK setup failed.",
  causes: [{
    title: "Retired package",
    evidence: ["L1: 2026-10-26T10:00:01Z Error: Failed to find package 'tools'"],
    recommendedFix: "Install explicit SDK packages.",
    confidence: "high",
    confidenceReason: "The failed-step log directly reports the missing package.",
    file: null,
    line: null,
  }],
  nextSteps: ["Rerun CI after updating SDK setup."],
  missingEvidence: [],
};

function mockGithub({ status = "in_progress", conclusion = null, jobs, log, commit } = {}) {
  return async (args) => {
    if (args[0] === "run") return JSON.stringify({
      databaseId: 123, headSha: "a".repeat(40), name: "Android CI", status, conclusion,
      url: "https://github.com/example/repo/actions/runs/123",
    });
    if (args[1].includes("/jobs?")) return JSON.stringify([{ jobs: jobs ?? [{
      id: 456, name: "Build, lint, and unit tests", status: "completed", conclusion: "failure",
      steps: [{ name: "Build, lint, and test", number: 7, conclusion: "failure",
        started_at: "2026-10-26T10:00:00Z", completed_at: "2026-10-26T10:01:00Z" }],
    }] }]);
    if (args[1].endsWith("/logs")) return log ??
      "2026-10-26T10:00:01Z Error: Failed to find package 'tools'\n2026-10-26T10:00:02Z api_key=secret123";
    if (args[1].includes("/commits/")) return JSON.stringify(commit ?? {
      files: [{ filename: "app/build.gradle.kts", patch: "+api_key=diffsecret" }],
    });
    throw new Error("Unexpected test API call");
  };
}

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

test("rejects invalid IDs and successful or cancelled runs before log access", async () => {
  for (const runId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(analyzeRun(config, runId), /runId/);
  }
  for (const run of [
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "cancelled" },
  ]) {
    let calls = 0;
    await assert.rejects(analyzeRun(config, 123, {
      github: async () => {
        calls++;
        return JSON.stringify({ databaseId: 123, headSha: "a".repeat(40), name: "CI", ...run });
      },
    }), /Run must be/);
    assert.equal(calls, 1);
  }
});

test("sends only redacted excerpts and validates returned analysis", async () => {
  const dependencies = {
    github: mockGithub(),
    analyze: async (_config, run, evidence) => {
      assert.equal(run.status, "in_progress");
      assert.ok(!JSON.stringify(evidence).includes("secret123"));
      assert.ok(!JSON.stringify(evidence).includes("diffsecret"));
      assert.match(evidence.logExcerpt, /L1:/);
      assert.equal(evidence.failedJobs[0].steps[0].number, 7);
      return validAnalysis;
    },
  };
  const result = await analyzeRun(config, 123, dependencies);
  assert.equal(result.analysis.causes[0].confidence, "high");
  assert.ok(result.excerpt.charactersSent <= 24000);
  await assert.rejects(analyzeRun(config, 123, {
    ...dependencies, analyze: async () => ({ summary: "missing causes" }),
  }), /required report structure/);
  await assert.rejects(analyzeRun(config, 123, {
    ...dependencies, analyze: async () => { throw new Error("Azure unavailable"); },
  }), /Azure unavailable/);
});

test("retries completed job logs three times with ten-second waits", async () => {
  const base = mockGithub();
  let attempts = 0;
  const waits = [];
  const result = await analyzeRun(config, 123, {
    github: async (args) => {
      if (args[1]?.endsWith("/logs")) { attempts++; throw new Error("Not ready"); }
      return base(args);
    },
    sleep: async (delay) => { waits.push(delay); },
    analyze: async (_config, _run, evidence) => {
      assert.equal(evidence.logExcerpt, "");
      assert.ok(evidence.missingEvidence.some((item) => item.includes("3 attempts")));
      return { ...validAnalysis, causes: [{ ...validAnalysis.causes[0], evidence: [] }] };
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10000, 10000]);
  assert.equal(result.analysis.causes[0].confidence, "low");
});

test("recovers when completed job logs become available on the third request", async () => {
  const base = mockGithub({ status: "completed", conclusion: "failure" });
  let attempts = 0;
  const result = await analyzeRun(config, 123, {
    github: async (args) => {
      if (args[1]?.endsWith("/logs") && ++attempts < 3) throw new Error("Not yet ready");
      return base(args);
    },
    sleep: async () => {},
    analyze: async () => validAnalysis,
  });
  assert.equal(attempts, 3);
  assert.equal(result.run.databaseId, 123);
});

test("job log download allows terminal escapes but removes them before model evidence", async () => {
  const base = mockGithub({
    log: "2026-10-26T10:00:01Z \u001b[31mError: failure\u001b[0m",
  });
  let downloaded = false;
  await analyzeRun(config, 123, {
    github: async (args) => {
      if (args[1]?.endsWith("/logs")) {
        assert.ok(args.includes("--allow-escape-sequences"));
        downloaded = true;
      }
      return base(args);
    },
    analyze: async (_config, _run, evidence) => {
      assert.match(evidence.logExcerpt, /L1: .*Error: failure/);
      assert.ok(!evidence.logExcerpt.includes("\u001b"));
      return validAnalysis;
    },
  });
  assert.equal(downloaded, true);
});

test("redacts opaque configured token values before sending evidence", () => {
  const previous = process.env.AZURE_OPENAI_API_KEY;
  process.env.AZURE_OPENAI_API_KEY = "opaque-example-value";
  try {
    assert.equal(redact("Error opaque-example-value"), "Error [REDACTED]");
  } finally {
    if (previous === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = previous;
  }
});

test("bounds commit patches and reports truncation without sending full files", async () => {
  await analyzeRun(config, 123, {
    github: mockGithub({ commit: { files: [{ filename: "app.kt", patch: "+change\n".repeat(3000) }] } }),
    analyze: async (_config, _run, evidence) => {
      assert.equal(evidence.commitDiff.length, 12000);
      assert.ok(evidence.missingEvidence.some((item) => item.includes("truncated")));
      return validAnalysis;
    },
  });
});

test("does not analyze running, skipped, or cancelled jobs or send unrelated step logs", async () => {
  for (const conclusion of ["success", "skipped", "cancelled", null]) {
    await assert.rejects(analyzeRun(config, 123, {
      github: mockGithub({ jobs: [{ id: 456, name: "build", status: "completed", conclusion }] }),
    }), /No completed failed build jobs/);
  }
  const result = await analyzeRun(config, 123, {
    github: mockGithub({ log: "2026-10-26T09:00:00Z unrelated-source\n2026-10-26T10:00:01Z Error: broken" }),
    analyze: async (_config, _run, evidence) => {
      assert.ok(!evidence.logExcerpt.includes("unrelated-source"));
      return validAnalysis;
    },
  });
  assert.equal(result.failedJobs[0].id, 456);
});

test("reports unavailable diff and missing timestamp-matched evidence explicitly", async () => {
  const base = mockGithub();
  const result = await analyzeRun(config, 123, {
    github: async (args) => {
      if (args[1]?.includes("/commits/")) throw new Error("Denied");
      return base(args);
    },
    analyze: async () => validAnalysis,
  });
  assert.ok(result.analysis.missingEvidence.some((item) => item.includes("Commit diff unavailable")));
  const missing = await analyzeRun(config, 123, {
    github: mockGithub({ log: "Error: no timestamps" }),
    analyze: async (_config, _run, evidence) => {
      assert.equal(evidence.logExcerpt, "");
      assert.ok(evidence.missingEvidence.some((item) => item.includes("No timestamp-matched")));
      return { ...validAnalysis, causes: [{ ...validAnalysis.causes[0], evidence: [] }] };
    },
  });
  assert.equal(missing.analysis.causes[0].confidence, "low");
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
      assert.ok(!JSON.stringify(body.response_format.json_schema.schema).includes("exclusiveMinimum"));
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
  }), /HTTP 401/);
  for (const choice of [
    { finish_reason: "length", message: { content: "{}" } },
    { finish_reason: "stop", message: { refusal: "No" } },
  ]) {
    await assert.rejects(analyzeWithAzure(config, {}, "Error", {
      ...dependencies, fetch: async () => Response.json({ choices: [choice] }),
    }), /complete analysis/);
  }
});

test("rejects malformed GitHub metadata safely before contacting Azure", async () => {
  for (const malformed of ["not JSON with api_key=private-value", "null", "{}", '["bad"]']) {
    await assert.rejects(analyzeRun(config, 123, { github: async () => malformed }),
      (error) => error.message.includes("malformed workflow run details") && !error.message.includes("private-value"));
  }
  const base = mockGithub();
  await assert.rejects(analyzeRun(config, 123, {
    github: async (args) => args[1]?.includes("/jobs?") ? '[{"jobs":[{}]}]' : base(args),
  }), /malformed workflow jobs/);
  await assert.rejects(analyzeRun(config, 123, {
    github: async () => { throw new Error("GitHub unavailable"); },
  }), /GitHub unavailable/);
});

test("configuration evidence limits may be lowered but never silently enlarged", () => {
  const env = { AZURE_OPENAI_ENDPOINT: config.endpoint };
  assert.deepEqual(readConfig({ ...env, AI_MAX_LOG_CHARS: "1000", AI_MAX_DIFF_CHARS: "2000" }).limits,
    { log: 1000, diff: 2000 });
  for (const value of ["", "-1", "999", "24001", "abc"]) {
    assert.throws(() => readConfig({ ...env, AI_MAX_LOG_CHARS: value }), /AI_MAX_LOG_CHARS/);
  }
});

test("preserves original log line numbers and full final timestamp second", async () => {
  await analyzeRun(config, 123, {
    github: mockGithub({
      log: "\uFEFF2026-10-26T09:00:00Z unrelated\n2026-10-26T10:01:00.800Z Error: last message",
    }),
    analyze: async (_config, _run, evidence) => {
      assert.match(evidence.logExcerpt, /L2: .*Error: last message/);
      assert.ok(!evidence.logExcerpt.includes("unrelated"));
      return validAnalysis;
    },
  });
});

test("partial job evidence survives a missing log and malformed commit response", async () => {
  const base = mockGithub();
  const pages = JSON.parse(await base(["api", "/jobs?"]));
  pages[0].jobs.push({ ...pages[0].jobs[0], id: 789 });
  const result = await analyzeRun(config, 123, {
    github: async (args) => {
      if (args[1]?.includes("/jobs?")) return JSON.stringify(pages);
      if (args[1]?.includes("/789/logs")) return "";
      if (args[1]?.includes("/commits/")) return '{"files":null}';
      return base(args);
    },
    sleep: async () => {},
    analyze: async (_config, _run, evidence) => {
      assert.match(evidence.logExcerpt, /Job 456:/);
      assert.ok(evidence.missingEvidence.some((item) => item.includes("789 logs unavailable")));
      assert.equal(evidence.commitDiff, "");
      return validAnalysis;
    },
  });
  assert.equal(result.failedJobs.length, 2);
  assert.ok(result.analysis.missingEvidence.some((item) => item.includes("diff unavailable")));
});

test("missing timestamps and oversized logs are explicit missing evidence", async () => {
  for (const options of [
    { jobs: [{ id: 456, name: "build", status: "completed", conclusion: "failure",
      steps: [{ name: "test", number: 1, conclusion: "failure" }] }] },
    { log: "x".repeat(3000001) },
  ]) {
    const result = await analyzeRun(config, 123, {
      github: mockGithub(options),
      analyze: async (_config, _run, evidence) => {
        assert.equal(evidence.logExcerpt, "");
        return { ...validAnalysis, causes: [{ ...validAnalysis.causes[0], evidence: [] }] };
      },
    });
    assert.equal(result.analysis.causes[0].confidence, "low");
    assert.ok(result.analysis.missingEvidence.length > 0);
  }
});

test("Azure retries transient errors with bounded Retry-After and then succeeds", async () => {
  let attempts = 0;
  const waits = [];
  const result = await analyzeWithAzure(config, { databaseId: 123 }, {}, {
    getToken: async () => "fake-token",
    sleep: async (delay) => { waits.push(delay); },
    fetch: async () => {
      attempts++;
      if (attempts < 3) return new Response("no sensitive body", {
        status: attempts === 1 ? 429 : 503, headers: { "retry-after": "3600" },
      });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validAnalysis) } }] });
    },
  });
  assert.equal(result.summary, validAnalysis.summary);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10000, 10000]);
});

test("Azure network retries are bounded and do not expose request details", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(analyzeWithAzure(config, {}, {}, {
    getToken: async () => "fake-token",
    sleep: async (delay) => { waits.push(delay); },
    fetch: async () => { calls++; throw new Error("network sensitive token"); },
  }), (error) => error.message.includes("3 attempts") && !error.message.includes("sensitive token"));
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("Azure does not retry auth/deployment errors or malformed responses", async () => {
  for (const response of [
    new Response("secret body", { status: 401 }),
    new Response("secret body", { status: 403 }),
    new Response("secret body", { status: 404 }),
    new Response("not JSON"),
    Response.json(null),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "secret not JSON" } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }),
  ]) {
    let calls = 0;
    await assert.rejects(analyzeWithAzure(config, {}, {}, {
      getToken: async () => "fake-token",
      fetch: async () => { calls++; return response; },
      sleep: async () => assert.fail("Must not retry"),
    }), (error) => !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
});

test("unsupported model quotes are removed and confidence lowered rather than presented as evidence", async () => {
  const result = await analyzeRun(config, 123, {
    github: mockGithub(),
    analyze: async () => ({
      ...validAnalysis,
      causes: [{ ...validAnalysis.causes[0], evidence: ["invented error that is not in logs"] }],
    }),
  });
  assert.deepEqual(result.analysis.causes[0].evidence, []);
  assert.equal(result.analysis.causes[0].confidence, "low");
  assert.ok(result.analysis.missingEvidence.some((item) => item.includes("did not exactly match")));
});
