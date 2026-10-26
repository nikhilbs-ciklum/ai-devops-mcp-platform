import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, saveReport } from "../src/report.js";

const result = {
  run: { databaseId: 123 },
  deployment: "gpt-4.1-mini",
  excerpt: { charactersSent: 200, truncated: false },
  analysis: {
    summary: "SDK setup failed.",
    causes: [{
      title: "Missing tools",
      evidence: ["L10: package not found\n<script>alert(1)</script>\n[click](https://example.com)"],
      recommendedFix: "Use explicit packages.",
      confidence: "high",
    }],
    nextSteps: ["Rerun lint."],
  },
};

test("renders model content as inert code and preserves evidence", () => {
  const report = formatReport(result);
  assert.match(report, /Run: 123/);
  assert.match(report, /    <script>/);
  assert.match(report, /    \[click\]/);
  assert.match(report, /    Evidence: L10:/);
  assert.match(report, /not verified fixes/);
  assert.throws(() => formatReport({ ...result, analysis: {} }));
});

test("persists JSON and Markdown and appends the Actions summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-report-"));
  try {
    const summary = join(directory, "summary.md");
    const output = join(directory, "reports");
    await saveReport(result, output, summary);
    assert.deepEqual(JSON.parse(await readFile(join(output, "analysis.json"), "utf8")), result);
    assert.equal(await readFile(join(output, "analysis.md"), "utf8"), formatReport(result));
    assert.equal(await readFile(summary, "utf8"), formatReport(result));
  } finally {
    await rm(directory, { recursive: true });
  }
});
