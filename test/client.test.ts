import { afterEach, describe, expect, it } from "vitest";
import { ArcheryClient } from "../src/archery/client";
import { silentLogger } from "../src/services/logger";
import { MockArcheryServer, type MockOptions } from "./mockArchery";

const servers: MockArcheryServer[] = [];
const clients: ArcheryClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

async function setup(options: MockOptions = {}) {
  const server = new MockArcheryServer(options);
  const baseUrl = await server.start();
  servers.push(server);
  return { server, baseUrl };
}

function makeClient(baseUrl: string, overrides: Partial<ConstructorParameters<typeof ArcheryClient>[0]> = {}) {
  const client = new ArcheryClient({
    baseUrl,
    username: "alice",
    authMode: "password",
    password: "secret",
    allowInsecureTls: false,
    timeoutMs: 5000,
    logger: silentLogger,
    ...overrides,
  });
  clients.push(client);
  return client;
}

describe("ArcheryClient", () => {
  it("logs in with a session, detects the v1 API and executes a query", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    const instances = await client.listInstances();
    expect(instances.map((item) => item.instance_name)).toEqual(["prod-mysql", "analytics-pg"]);
    expect(client.apiStyle).toBe("v1");

    const databases = await client.listResources("prod-mysql", "database");
    expect(databases.map((item) => item.name)).toEqual(["shop", "analytics"]);

    const result = await client.executeQuery({
      instanceName: "prod-mysql",
      dbName: "shop",
      sql: "SELECT * FROM orders",
      limit: 100,
    });
    expect(result.columns).toEqual(["id", "name", "created_at"]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1][1]).toBeNull();
    expect(result.fullSql).toContain("LIMIT 100");
    expect(server.loginCount).toBe(1);
  });

  it("falls back to the legacy API on Archery 1.14", async () => {
    const { baseUrl } = await setup({ mode: "legacy" });
    const client = makeClient(baseUrl);
    const instances = await client.listInstances();
    expect(instances).toHaveLength(2);
    expect(client.apiStyle).toBe("legacy");

    const tables = await client.listResources("prod-mysql", "table", { dbName: "shop" });
    expect(tables.map((item) => item.name)).toEqual(["orders", "users"]);

    const result = await client.executeQuery({
      instanceName: "prod-mysql",
      dbName: "shop",
      sql: "SELECT * FROM orders",
      limit: 100,
    });
    expect(result.rows).toHaveLength(3);
    const description = await client.describeTable("prod-mysql", "shop", "orders");
    expect(description.result.columns).toEqual(["Field", "Type", "Null"]);
    const logs = await client.listQueryLogs({ limit: 20 });
    expect(logs.total).toBe(2);
    expect(logs.rows[0].alias).toBe("订单查询");
  });

  it("re-authenticates after the session expires and retries the request", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    await client.listInstances();
    expect(server.loginCount).toBe(1);
    server.invalidateSession();
    const again = await client.listInstances();
    expect(again).toHaveLength(2);
    expect(server.loginCount).toBe(2);
  });

  it("re-authenticates after a DRF 403 authentication failure", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    server.unauthorizedMode = "drf";
    const client = makeClient(baseUrl);
    await client.listInstances();
    expect(server.loginCount).toBe(1);
    server.invalidateSession();
    const again = await client.listInstances();
    expect(again).toHaveLength(2);
    expect(server.loginCount).toBe(2);
  });

  it("does not treat permission errors as an expired session", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    await client.listInstances();
    const before = server.loginCount;
    await expect(
      client.executeQuery({
        instanceName: "prod-mysql",
        dbName: "shop",
        sql: "permission check",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "api" });
    expect(server.loginCount).toBe(before);
  });

  it("reports bad credentials as an auth error", async () => {
    const { baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl, { password: "wrong" });
    await expect(client.listInstances()).rejects.toMatchObject({
      code: "auth",
      message: "用户名或密码错误",
    });
  });

  it("supports bearer-token connections against the v1 API", async () => {
    const { baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl, {
      authMode: "token",
      token: "test-token",
      password: undefined,
    });
    const instances = await client.listInstances();
    expect(instances).toHaveLength(2);
    expect(client.apiStyle).toBe("v1");
  });

  it("surfaces SQL errors returned in the Archery envelope", async () => {
    const { baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    await expect(
      client.executeQuery({
        instanceName: "prod-mysql",
        dbName: "shop",
        sql: "syntax error",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "query", message: "You have an error in your SQL syntax" });
  });

  it("transparently retries a GET after a reused connection is reset", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    await client.listInstances();
    server.resetConnections(1, "/api/v1/sqlquery/instances/");
    const instances = await client.listInstances();
    expect(instances).toHaveLength(2);
    expect(server.resetCount).toBe(1);
  });

  it("retries a reset during login", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    server.resetConnections(1, "/authenticate/");
    const client = makeClient(baseUrl);
    const instances = await client.listInstances();
    expect(instances).toHaveLength(2);
    expect(server.resetCount).toBe(1);
    expect(server.loginCount).toBe(1);
  });

  it("does not transparently retry an execution POST after a reset", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    await client.listInstances();
    server.resetConnections(1, "/api/v1/sqlquery/execute/");
    await expect(
      client.executeQuery({
        instanceName: "prod-mysql",
        dbName: "shop",
        sql: "SELECT * FROM orders",
        limit: 100,
      }),
    ).rejects.toMatchObject({
      code: "network",
      message: "Archery 连接被重置",
      retryable: true,
    });
    expect(server.resetCount).toBe(1);
  });

  it("can abort an in-flight query", async () => {
    const { server, baseUrl } = await setup({ mode: "v1" });
    server.delayQueriesMs = 2000;
    const client = makeClient(baseUrl);
    const controller = new AbortController();
    const promise = client.executeQuery(
      {
        instanceName: "prod-mysql",
        dbName: "shop",
        sql: "SELECT * FROM orders",
        limit: 100,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("gets table descriptions and columns through the v1 API", async () => {
    const { baseUrl } = await setup({ mode: "v1" });
    const client = makeClient(baseUrl);
    const columns = await client.listResources("prod-mysql", "column", {
      dbName: "shop",
      tableName: "orders",
    });
    expect(columns[0].name).toBe("id");
    const description = await client.describeTable("prod-mysql", "shop", "orders");
    expect(description.result.rows[0]).toEqual(["id", "bigint", "NO"]);
  });
});
