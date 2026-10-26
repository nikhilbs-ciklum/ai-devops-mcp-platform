import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeRun, listFailedRuns, readConfig, redact } from "./analysis.js";

const config = readConfig();
const server = new McpServer({ name: "pipeline-analysis", version: "1.0.0" });
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function toolHandler(action) {
  return async (args) => {
    try {
      const result = await action(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      console.error(`Pipeline MCP tool failed: ${message}`);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

server.registerTool("list_failed_runs", {
  description: `List recent failed GitHub Actions runs in ${config.repository}. Uses the local gh login.`,
  inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
  annotations: { ...annotations, idempotentHint: true },
}, toolHandler(({ limit }) => listFailedRuns(config, limit)));

server.registerTool("analyze_failed_run", {
  description: `Analyze completed failed jobs by run ID, including an in-progress workflow, in ${config.repository}. Sends up to 24,000 log characters plus 12,000 commit-patch characters, redacted best effort, to Azure OpenAI using Azure CLI authentication. Requires user consent; inference incurs usage. Never modifies code or runs.`,
  inputSchema: {
    runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    consentToSendLogs: z.literal(true).describe("Set true only after the user consents to sending log excerpts to Azure OpenAI."),
  },
  annotations,
}, toolHandler(({ runId }) => analyzeRun(config, runId)));

await server.connect(new StdioServerTransport());
