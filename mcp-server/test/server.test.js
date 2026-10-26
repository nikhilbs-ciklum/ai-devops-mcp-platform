import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP stdio handshake, tool discovery, and argument validation", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "pipeline-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["analyze_failed_run", "list_failed_runs"]);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
    for (const args of [{ runId: -1, consentToSendLogs: true }, { runId: 123 }]) {
      const result = await client.callTool({ name: "analyze_failed_run", arguments: args });
      assert.equal(result.isError, true);
    }
  } finally {
    await client.close();
    await transport.close();
  }
});
