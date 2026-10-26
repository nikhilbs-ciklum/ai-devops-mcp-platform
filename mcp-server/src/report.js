import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analysisSchema } from "./analysis.js";

export function formatReport(result) {
  const analysis = analysisSchema.parse(result.analysis);
  // Keep model/log content inert: no Markdown links, HTML, or active formatting.
  const lines = [
    "# AI pipeline failure analysis",
    "",
    "AI-generated suggestions, not verified fixes. Treat quoted logs and model output as untrusted.",
    "",
    `Run: ${result.run.databaseId}`,
    `Deployment: ${result.deployment}`,
    "",
    "## Diagnosis and evidence",
    ...[
      ...(result.failedJobs ?? []).flatMap((job) => [
        `Failed job: ${job.name}`,
        ...job.steps.map((step) => `Failed step: ${step.name} (${step.number})`),
      ]),
      "",
      `Run URL: ${result.run.url ?? "unavailable"}`,
      "Failure summary:",
      analysis.summary,
      ...analysis.causes.flatMap((cause, index) => [
        "",
        `Cause ${index + 1}: ${cause.title} (confidence: ${cause.confidence})`,
        `Confidence reason: ${cause.confidenceReason}`,
        ...cause.evidence.map((evidence) => `Evidence: ${evidence}`),
        ...(cause.evidence.length ? [] : ["Evidence: no verified log quote available."]),
        `Location: ${cause.file ?? "unavailable"}${cause.line ? `:${cause.line}` : ""}`,
        `Recommended fix: ${cause.recommendedFix}`,
      ]),
      "",
      "Next steps:",
      ...analysis.nextSteps,
      "",
      "Missing evidence:",
      ...(analysis.missingEvidence.length ? analysis.missingEvidence : ["None reported."]),
    ].join("\n").split(/\r?\n/).map((line) =>
      `    ${line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")}`),
    "",
    `Excerpt: ${result.excerpt.charactersSent} characters; truncated: ${result.excerpt.truncated}.`,
    "",
    "Analysis does not change the original failed run or automatically apply fixes.",
    "",
  ];
  return lines.join("\n");
}

export async function saveReport(result, directory, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  const markdown = formatReport(result);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "analysis.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "analysis.md"), markdown, "utf8");
  if (summaryPath) await appendFile(summaryPath, markdown, "utf8");
}
