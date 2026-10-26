import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [runIdText, consent] = process.argv.slice(2);
const runId = Number(runIdText);
if (!Number.isSafeInteger(runId) || runId <= 0 || consent !== "--allow-azure-log-upload") {
  console.error("Usage: npm run analyze -- <run-id> --allow-azure-log-upload");
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
    }, undefined, { timeout: 180000 });
    if (result.isError) {
      console.error(JSON.stringify(result.content));
      process.exitCode = 1;
    } else {
      for (const content of result.content) {
        if (content.type === "text") console.log(content.text);
      }
    }
  } finally {
    await client.close();
    await transport.close();
  }
}
