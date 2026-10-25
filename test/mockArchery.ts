import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOptions {
  mode?: "v1" | "legacy";
  username?: string;
  password?: string;
  token?: string;
}

export class MockArcheryServer {
  readonly mode: "v1" | "legacy";
  readonly username: string;
  readonly password: string;
  readonly token: string;
  readonly requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }> = [];
  loginCount = 0;
  sessionValid = false;
  failNextQuery = false;
  delayQueriesMs = 0;
  unauthorizedMode: "redirect" | "drf" = "redirect";
  resetNextRequests = 0;
  resetPathIncludes = "";
  resetCount = 0;
  private server?: http.Server;
  private sessionCounter = 0;
  private csrf = "csrf-token-1";

  constructor(options: MockOptions = {}) {
    this.mode = options.mode ?? "v1";
    this.username = options.username ?? "alice";
    this.password = options.password ?? "secret";
    this.token = options.token ?? "test-token";
  }

  async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  invalidateSession(): void {
    this.sessionValid = false;
  }

  resetConnections(count = 1, pathIncludes = ""): void {
    this.resetNextRequests = count;
    this.resetPathIncludes = pathIncludes;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    this.requests.push({ method: request.method ?? "GET", path: url.pathname + url.search, headers: request.headers });
    if (this.resetNextRequests > 0 && url.pathname.includes(this.resetPathIncludes)) {
      this.resetNextRequests -= 1;
      this.resetCount += 1;
      request.socket.destroy();
      return;
    }
    if (url.pathname === "/login/") {
      this.csrf = `csrf-${++this.sessionCounter}`;
      response.setHeader("Set-Cookie", `csrftoken=${this.csrf}; Path=/; SameSite=Lax`);
      return this.html(response, `<!DOCTYPE html><html><body><form><input type="hidden" name="csrfmiddlewaretoken" value="${this.csrf}" /></form></body></html>`);
    }
    if (url.pathname === "/authenticate/" && request.method === "POST") {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      if (form.get("csrfmiddlewaretoken") !== this.csrf || request.headers["x-csrftoken"] !== this.csrf) {
        return this.json(response, 403, { detail: "CSRF verification failed" });
      }
      if (form.get("username") !== this.username || form.get("password") !== this.password) {
        return this.json(response, 200, { status: 1, msg: "用户名或密码错误", data: "" });
      }
      this.loginCount += 1;
      this.sessionValid = true;
      const session = `session-${this.loginCount}`;
      response.setHeader("Set-Cookie", `sessionid=${session}; Path=/; HttpOnly; SameSite=Lax`);
      return this.json(response, 200, { status: 0, msg: "ok", data: null });
    }
    const authorized = this.isAuthorized(request);
    if (url.pathname === "/api/v1/sqlquery/instances/") {
      if (this.mode !== "v1") {
        return this.notFound(response);
      }
      if (!authorized) {
        return this.redirectLogin(response);
      }
      return this.json(response, 200, {
        status: 0,
        msg: "ok",
        data: [
          { id: 1, type: "master", db_type: "mysql", instance_name: "prod-mysql" },
          { id: 2, type: "slave", db_type: "postgresql", instance_name: "analytics-pg" },
        ],
      });
    }
    if (url.pathname === "/group/user_all_instances/") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      return this.json(response, 200, {
        status: 0,
        msg: "ok",
        data: [
          { id: 1, type: "master", db_type: "mysql", instance_name: "prod-mysql" },
          { id: 2, type: "slave", db_type: "postgresql", instance_name: "analytics-pg" },
        ],
      });
    }
    if (url.pathname === "/api/v1/sqlquery/resources/" || url.pathname === "/instance/instance_resource/") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      const resource = url.searchParams.get("resource_type");
      if (resource === "database") {
        return this.json(response, 200, { status: 0, msg: "ok", data: ["shop", "analytics"] });
      }
      if (resource === "schema") {
        return this.json(response, 200, { status: 0, msg: "ok", data: ["public", "reporting"] });
      }
      if (resource === "table") {
        return this.json(response, 200, { status: 0, msg: "ok", data: ["orders", "users"] });
      }
      if (resource === "column") {
        return this.json(response, 200, {
          status: 0,
          msg: "ok",
          data: [
            { Field: "id", Type: "bigint", Null: "NO", Key: "PRI" },
            { Field: "name", Type: "varchar(64)", Null: "YES", Key: "" },
          ],
        });
      }
      return this.json(response, 200, { status: 1, msg: "不支持的资源类型", data: [] });
    }
    if (url.pathname === "/api/v1/sqlquery/execute/" && request.method === "POST") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      const body = await readBody(request);
      if (!this.hasCsrf(request)) {
        return this.json(response, 403, { detail: "CSRF verification failed" });
      }
      const payload = JSON.parse(body) as Record<string, unknown>;
      return this.queryResponse(response, String(payload.sql_content ?? ""));
    }
    if (url.pathname === "/query/" && request.method === "POST") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      const body = await readBody(request);
      if (!this.hasCsrf(request)) {
        return this.json(response, 403, { detail: "CSRF verification failed" });
      }
      const form = new URLSearchParams(body);
      return this.queryResponse(response, form.get("sql_content") ?? "");
    }
    if (url.pathname === "/instance/describetable/" && request.method === "POST") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      await readBody(request);
      if (!this.hasCsrf(request)) {
        return this.json(response, 403, { detail: "CSRF verification failed" });
      }
      return this.json(response, 200, {
        status: 0,
        msg: "ok",
        data: {
          column_list: ["Field", "Type", "Null"],
          rows: [
            ["id", "bigint", "NO"],
            ["name", "varchar(64)", "YES"],
          ],
          full_sql: "SHOW FULL COLUMNS FROM orders",
        },
      });
    }
    if (url.pathname === "/api/v1/sqlquery/describetable/" && request.method === "POST") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      await readBody(request);
      if (!this.hasCsrf(request)) {
        return this.json(response, 403, { detail: "CSRF verification failed" });
      }
      return this.json(response, 200, {
        status: 0,
        msg: "ok",
        data: {
          column_list: ["Field", "Type", "Null"],
          rows: [
            ["id", "bigint", "NO"],
            ["name", "varchar(64)", "YES"],
          ],
          full_sql: "SHOW FULL COLUMNS FROM orders",
        },
      });
    }
    if (url.pathname === "/api/v1/sqlquery/logs/" || url.pathname === "/query/querylog/") {
      if (!authorized) {
        return this.redirectLogin(response);
      }
      return this.json(response, 200, {
        total: 2,
        rows: [
          {
            id: 9,
            instance_name: "prod-mysql",
            db_name: "shop",
            sqllog: "SELECT * FROM orders LIMIT 100",
            effect_row: 2,
            cost_time: 0.12,
            user_display: "Alice",
            favorite: true,
            alias: "订单查询",
            create_time: "2026-10-23 10:00:00",
          },
          {
            id: 8,
            instance_name: "prod-mysql",
            db_name: "shop",
            sqllog: "SELECT COUNT(*) FROM users",
            effect_row: 1,
            cost_time: 0.08,
            user_display: "Alice",
            favorite: false,
            alias: "",
            create_time: "2026-10-23 09:59:00",
          },
        ],
      });
    }
    return this.notFound(response);
  }

  private async queryResponse(response: ServerResponse, sql: string): Promise<void> {
    if (this.delayQueriesMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayQueriesMs));
    }
    if (this.failNextQuery) {
      this.failNextQuery = false;
      return this.json(response, 200, { status: 1, msg: "Query execution was interrupted", data: {} });
    }
    if (/syntax/i.test(sql)) {
      return this.json(response, 200, { status: 1, msg: "You have an error in your SQL syntax", data: {} });
    }
    if (/permission/i.test(sql)) {
      this.json(response, 403, { detail: "You do not have permission to perform this action." });
      return;
    }
    return this.json(response, 200, {
      status: 0,
      msg: "ok",
      data: {
        column_list: ["id", "name", "created_at"],
        rows: [
          [1, "Alice", "2026-10-20 10:00:00"],
          [2, null, "2026-10-21 11:30:00"],
          [3, "订单 3", "2026-10-22 09:15:00"],
        ],
        query_time: 0.032,
        mask_time: 0.001,
        seconds_behind_master: 0,
        full_sql: `${sql} LIMIT 100`,
        affected_rows: 0,
      },
    });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (request.headers.authorization === `Bearer ${this.token}`) {
      return true;
    }
    const cookies = parseCookies(request.headers.cookie ?? "");
    return this.sessionValid && Boolean(cookies.sessionid);
  }

  private hasCsrf(request: IncomingMessage): boolean {
    if (request.headers.authorization === `Bearer ${this.token}`) {
      return true;
    }
    return request.headers["x-csrftoken"] === this.csrf;
  }

  private redirectLogin(response: ServerResponse): void {
    if (this.unauthorizedMode === "drf") {
      this.json(response, 403, { detail: "Authentication credentials were not provided." });
      return;
    }
    response.statusCode = 302;
    response.setHeader("Location", "/login/");
    response.end("");
  }

  private notFound(response: ServerResponse): void {
    this.json(response, 404, { detail: "Not found" });
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private html(response: ServerResponse, body: string): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(body);
  }
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
