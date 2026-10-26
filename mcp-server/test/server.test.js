import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("client reports MCP startup failure safely and writes no success report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-client-"));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../src/analyze.js", import.meta.url)),
      "123", "--allow-azure-log-upload", "--output", directory,
    ], {
      env: { ...process.env, AZURE_OPENAI_ENDPOINT: "invalid-sensitive-endpoint-value" },
      timeout: 15000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /AI analysis unavailable/);
      assert.ok(!error.stderr.includes("invalid-sensitive-endpoint-value"));
      assert.equal(error.stdout, "");
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true });
  }
});
