import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { saveReport } from "./report.js";
import { redact } from "./analysis.js";

const [runIdText, consent, outputFlag, directory, ...extra] = process.argv.slice(2);
const runId = Number(runIdText);
const validOutput = outputFlag === undefined ||
  (outputFlag === "--output" && Boolean(directory) && extra.length === 0);
if (!Number.isSafeInteger(runId) || runId <= 0 || consent !== "--allow-azure-log-upload" || !validOutput) {
  console.error("Usage: npm run analyze -- <run-id> --allow-azure-log-upload [--output <directory>]");
  process.exitCode = 1;
} else {
  const client = new Client({ name: "pipeline-analysis-cli", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.js", import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "analyze_failed_run",
      arguments: { runId, consentToSendLogs: true },
    }, undefined, { timeout: 480000 });
    if (result.isError) {
      console.error(JSON.stringify(result.content));
      process.exitCode = 1;
    } else {
      if (directory) {
        const text = result.content.find((content) => content.type === "text")?.text;
        if (!text) throw new Error("MCP analysis did not contain a JSON report.");
        await saveReport(JSON.parse(text), directory);
      }
      for (const content of result.content) {
        if (content.type === "text") console.log(content.text);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown client failure";
    console.error(`AI analysis unavailable: ${redact(detail)}`);
    process.exitCode = 1;
  } finally {
    await client.close();
    await transport.close();
  }
}
