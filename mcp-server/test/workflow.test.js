import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

const execFileAsync = promisify(execFile);
const android = await readFile(new URL("../../.github/workflows/android.yml", import.meta.url), "utf8");
const reusable = (await readFile(new URL("../../.github/workflows/ai-failure-analysis.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const caller = android.slice(android.indexOf("  ai-failure-analysis:"));
const callerCondition = caller.match(/if: \$\{\{ (.+) \}\}/)[1];
const analysisCondition = reusable.match(/  analyze:\r?\n    if: >-\r?\n([\s\S]*?)    runs-on:/)[1].trim();
const skipCondition = reusable.match(/  skipped:\r?\n    if: >-\r?\n([\s\S]*?)    runs-on:/)[1].trim();

function context(result, { cancelled = false, enabled = "true", ref = "refs/heads/develop", event = "push" } = {}) {
  return {
    always: () => true,
    cancelled: () => cancelled,
    needs: { build: { result } },
    vars: { AI_FAILURE_ANALYSIS_ENABLED: enabled },
    github: { ref, event_name: event },
  };
}

test("actual caller condition admits failure only, never green/skipped/cancelled", () => {
  for (const result of ["success", "skipped", "cancelled", "failure"]) {
    assert.equal(runInNewContext(callerCondition, context(result)), result === "failure");
    assert.equal(runInNewContext(callerCondition, context(result, { cancelled: true })), false);
  }
  assert.match(caller, /needs: build/);
  assert.match(caller, /run-id: \$\{\{ github.run_id \}\}/);
  assert.ok(!android.includes("continue-on-error"));
});

test("actual reusable gates exclude PRs, forks, unauthorized refs, and disabled analysis", () => {
  for (const options of [
    { event: "push" }, { event: "workflow_dispatch" },
    { event: "pull_request", ref: "refs/pull/1/merge" },
    { event: "pull_request", ref: "refs/heads/develop" },
    { ref: "refs/heads/feature/demo" }, { enabled: "false" }, { enabled: "" },
  ]) {
    const eligible = ["push", "workflow_dispatch"].includes(options.event ?? "push") &&
      (options.ref ?? "refs/heads/develop") === "refs/heads/develop" &&
      (options.enabled ?? "true") === "true";
    assert.equal(runInNewContext(analysisCondition, context("failure", options)), eligible);
    assert.equal(runInNewContext(skipCondition, context("failure", options)), !eligible);
  }
  assert.ok(!reusable.includes("workflow_run:"));
  assert.match(reusable, /workflow_call:/);
  const build = android.slice(android.indexOf("  build:"), android.indexOf("  ai-failure-analysis:"));
  assert.ok(!build.includes("id-token:"));
  assert.match(build, /run: \.\/gradlew --no-daemon --stacktrace lintDebug testDebugUnitTest assembleDebug/);
  const skipped = reusable.slice(reusable.indexOf("  skipped:"), reusable.indexOf("  analyze:"));
  assert.match(skipped, /permissions: \{\}/);
  assert.ok(!/uses:|GH_TOKEN|az login|node src/.test(skipped));
  assert.match(reusable, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.ok(!/continue-on-error|pull_request_target|issues: write|pull-requests: write/.test(reusable));
});

test("fallback shell publishes a useful note without a client report or credentials", async (t) => {
  const bash = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "bash";
  if (process.platform === "win32" && !existsSync(bash)) {
    t.skip("Git Bash is unavailable; run this fallback shell test on Linux CI.");
    return;
  }
  const fallback = reusable.slice(reusable.indexOf("      - name: Report analyzer failure"));
  assert.match(fallback, /if: failure\(\)/);
  assert.ok(fallback.includes("        run: |\n"));
  const script = fallback.slice(fallback.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const directory = await mkdtemp(join(tmpdir(), "mcp-fallback-"));
  try {
    for (const stage of ["CHECKOUT", "CONFIGURATION", "NODE", "DEPENDENCIES", "LOGIN", "ANALYSIS", "UPLOAD"]) {
      const summary = join(directory, `${stage}.md`);
      const outcomes = Object.fromEntries(
        ["CHECKOUT", "CONFIGURATION", "NODE", "DEPENDENCIES", "LOGIN", "ANALYSIS"]
          .map((name) => [name, name === stage ? "failure" : "success"]),
      );
      await execFileAsync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
        env: {
          ...process.env, ...outcomes,
          GH_TOKEN: "test-sensitive-token",
          GITHUB_STEP_SUMMARY: summary.replaceAll("\\", "/"),
        },
      });
      const text = await readFile(summary, "utf8");
      assert.match(text, /AI analysis unavailable/);
      assert.match(text, /original Android build remains failed/);
      assert.match(text, stage === "UPLOAD" ? /Report publication failed/ : new RegExp(`Failure stage: ${stage}`));
      assert.ok(!text.includes("test-sensitive-token"));
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
