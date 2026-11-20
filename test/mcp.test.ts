import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp.js";
import { resetData } from "../src/data.js";

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as { type: string; text: string }[])[0];
  return first.text;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const t = text(result);
  return JSON.parse(t.slice(t.indexOf("\n") + 1));
}

beforeEach(() => resetData());

test("lists the three tools with correct read/write hints", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["create_service_request", "get_service_request", "search_service_requests"]);
  assert.equal(byName.search_service_requests.annotations?.readOnlyHint, true);
  assert.equal(byName.get_service_request.annotations?.readOnlyHint, true);
  assert.equal(byName.create_service_request.annotations?.readOnlyHint, false);
});

test("search defaults to open requests and filters by plant", async () => {
  const client = await connect();
  const all = payload(await client.callTool({ name: "search_service_requests", arguments: {} }));
  assert.ok(all.count > 0);
  assert.ok(all.results.every((r: { status: string }) => r.status === "open"));

  const dahej = payload(await client.callTool({ name: "search_service_requests", arguments: { plant: "dahej", status: "all" } }));
  assert.equal(dahej.count, 3);
  assert.ok(dahej.results.every((r: { plant: string }) => r.plant.includes("Dahej")));
});

test("get returns a tool error for an unknown id", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "get_service_request", arguments: { id: "SR-9999" } });
  assert.equal(res.isError, true);
  assert.match(text(res), /No service request found/);
});

test("create then get returns the new request", async () => {
  const client = await connect();
  const created = payload(
    await client.callTool({
      name: "create_service_request",
      arguments: { plant: "Plant A - Jamnagar", title: "Test request", description: "From test", priority: "high" },
    })
  ).created;
  assert.equal(created.id, "SR-1009");
  assert.equal(created.status, "open");

  const fetched = payload(await client.callTool({ name: "get_service_request", arguments: { id: created.id } }));
  assert.equal(fetched.title, "Test request");
});

test("rejects invalid input", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "create_service_request", arguments: { plant: "A", title: "x", priority: "urgent" } });
  assert.equal(res.isError, true);
});
