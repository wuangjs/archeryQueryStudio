import type {
  ApiStyle,
  ArcheryInstance,
  AuthMode,
  ConnectionHealth,
  QueryExecutionRequest,
  QueryExecutionResult,
  QueryLogPage,
  ResourceItem,
  TableDescription,
} from "../types";
import type { Logger } from "../services/logger";
import { ArcheryError } from "./errors";
import { HttpTransport, type HttpResponse } from "./http";
import {
  envelopeMessage,
  envelopeStatus,
  isRecord,
  normalizeDescription,
  normalizeExecution,
  normalizeInstances,
  normalizeQueryLogs,
  normalizeResources,
  safeJson,
} from "./normalize";

export interface ArcheryClientOptions {
  baseUrl: string;
  username: string;
  authMode: AuthMode;
  password?: string;
  token?: string;
  allowInsecureTls: boolean;
  timeoutMs: number;
  logger: Logger;
}

interface RequestSpec {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  allowRedirect?: boolean;
  retryable?: boolean;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
const JSON_CONTENT_TYPE = "application/json;charset=UTF-8";

export class ArcheryClient {
  private readonly options: ArcheryClientOptions;
  private readonly transport: HttpTransport;
  private loggedIn = false;
  private loginPromise?: Promise<void>;
  private bearerToken?: string;
  private style?: ApiStyle;
  private sessionCsrf?: string;

  constructor(options: ArcheryClientOptions) {
    this.options = options;
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      allowInsecureTls: options.allowInsecureTls,
      logger: options.logger,
    });
    this.bearerToken =
      options.authMode === "token" && options.token
        ? options.token.replace(/^Bearer\s+/i, "").trim()
        : undefined;
  }

  get apiStyle(): ApiStyle | undefined {
    return this.style;
  }

  async testConnection(): Promise<ConnectionHealth> {
    this.loggedIn = false;
    this.style = undefined;
    await this.login(true);
    const instances = await this.listInstances();
    return {
      ok: true,
      apiStyle: this.style ?? "legacy",
      instanceCount: instances.length,
      username: this.options.username,
      message: `连接成功，共发现 ${instances.length} 个可访问实例`,
    };
  }

  async login(force = false): Promise<void> {
    if (this.options.authMode === "token") {
      if (!this.bearerToken) {
        throw new ArcheryError("auth", "访问令牌为空", { hint: "请编辑连接并填写 Archery 访问令牌。" });
      }
      return;
    }
    if (!this.options.password) {
      throw new ArcheryError("auth", "连接密码为空", { hint: "密码保存在 VS Code SecretStorage 中；请编辑连接重新填写密码。" });
    }
    if (this.loggedIn && !force) {
      return;
    }
    if (this.loginPromise) {
      return this.loginPromise;
    }
    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  async listInstances(): Promise<ArcheryInstance[]> {
    const style = await this.detectApiStyle();
    const path =
      style === "v1"
        ? "/api/v1/sqlquery/instances/"
        : "/group/user_all_instances/";
    try {
      const payload = await this.getJson(path);
      if (envelopeStatus(payload) !== 0) {
        throw new ArcheryError("api", envelopeMessage(payload) || "获取 Archery 实例列表失败");
      }
      return normalizeInstances(payload);
    } catch (error) {
      if (style === "v1" && isNotFound(error)) {
        this.style = "legacy";
        return this.listInstances();
      }
      throw error;
    }
  }

  async listResources(
    instanceName: string,
    resourceType: "database" | "schema" | "table" | "column",
    options: { dbName?: string; schemaName?: string; tableName?: string; signal?: AbortSignal } = {},
  ): Promise<ResourceItem[]> {
    const style = await this.detectApiStyle();
    const params = new URLSearchParams({
      instance_name: instanceName,
      resource_type: resourceType,
    });
    if (options.dbName) {
      params.set("db_name", options.dbName);
    }
    if (options.schemaName) {
      params.set("schema_name", options.schemaName);
    }
    if (options.tableName) {
      params.set("tb_name", options.tableName);
    }
    const path =
      style === "v1"
        ? `/api/v1/sqlquery/resources/?${params.toString()}`
        : `/instance/instance_resource/?${params.toString()}`;
    const payload = await this.getJson(path, options.signal);
    if (envelopeStatus(payload) !== 0) {
      throw new ArcheryError("api", envelopeMessage(payload) || "获取实例资源失败");
    }
    return normalizeResources(payload);
  }

  async executeQuery(
    request: QueryExecutionRequest,
    signal?: AbortSignal,
  ): Promise<QueryExecutionResult> {
    const style = await this.detectApiStyle();
    const payload = {
      instance_name: request.instanceName,
      db_name: request.dbName,
      schema_name: request.schemaName ?? "",
      tb_name: request.tableName ?? "",
      sql_content: request.sql,
      limit_num: request.limit,
    };
    let response: HttpResponse;
    if (style === "v1") {
      response = await this.authenticatedRequest({
        method: "POST",
        path: "/api/v1/sqlquery/execute/",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify(payload),
        signal,
      });
    } else {
      response = await this.authenticatedRequest({
        method: "POST",
        path: "/query/",
        headers: { "Content-Type": FORM_CONTENT_TYPE },
        body: this.formBody(payload),
        signal,
      });
    }
    const parsed = this.parseJson(response, "执行查询");
    return normalizeExecution(parsed);
  }

  async describeTable(
    instanceName: string,
    dbName: string,
    tableName: string,
    schemaName = "",
    signal?: AbortSignal,
  ): Promise<TableDescription> {
    const style = await this.detectApiStyle();
    const payload = {
      instance_name: instanceName,
      db_name: dbName,
      tb_name: tableName,
      schema_name: schemaName,
    };
    const response = await this.authenticatedRequest({
      method: "POST",
      path:
        style === "v1"
          ? "/api/v1/sqlquery/describetable/"
          : "/instance/describetable/",
      headers: {
        "Content-Type": style === "v1" ? JSON_CONTENT_TYPE : FORM_CONTENT_TYPE,
      },
      body: style === "v1" ? JSON.stringify(payload) : this.formBody(payload),
      signal,
      retryable: true,
    });
    const parsed = this.parseJson(response, "获取表结构");
    return normalizeDescription(parsed);
  }

  async listQueryLogs(
    options: { limit?: number; offset?: number; search?: string; signal?: AbortSignal } = {},
  ): Promise<QueryLogPage> {
    const style = await this.detectApiStyle();
    const params = new URLSearchParams({
      limit: String(options.limit ?? 100),
      offset: String(options.offset ?? 0),
    });
    if (options.search) {
      params.set("search", options.search);
    }
    const path =
      style === "v1"
        ? `/api/v1/sqlquery/logs/?${params.toString()}`
        : `/query/querylog/?${params.toString()}`;
    const payload = await this.getJson(path, options.signal);
    if (envelopeStatus(payload) !== 0) {
      throw new ArcheryError("api", envelopeMessage(payload) || "获取查询历史失败");
    }
    return normalizeQueryLogs(payload, options.limit ?? 100);
  }

  dispose(): void {
    this.transport.dispose();
  }

  private async doLogin(): Promise<void> {
    try {
      await this.loginWithSession();
    } catch (error) {
      if (error instanceof ArcheryError && error.status === 404) {
        await this.loginWithJwt();
        return;
      }
      throw error;
    }
  }

  private async loginWithSession(): Promise<void> {
    this.loggedIn = false;
    const loginPage = await this.transport.request({
      method: "GET",
      path: "/login/",
      allowRedirect: false,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (
      loginPage.status >= 300 &&
      loginPage.status < 400 &&
      loginPage.headers.location
    ) {
      const next = new URL(loginPage.headers.location, `${this.transport.baseUrl}/login/`);
      if (next.origin !== this.transport.origin) {
        throw new ArcheryError(
          "unsupported",
          "该 Archery 使用外部单点登录（CAS / OIDC / 钉钉等），插件无法直接完成登录",
          { hint: "请改用访问令牌模式，或在 Archery 中为插件启用本地账号登录。" },
        );
      }
      if (!/\/login/i.test(next.pathname)) {
        this.loggedIn = true;
        return;
      }
    }
    if (loginPage.status === 404) {
      throw new ArcheryError("unsupported", "未找到 Archery 登录接口 /login/", {
        status: 404,
        hint: "请确认该地址是 Archery 服务根地址，而不是子页面地址。",
      });
    }
    const csrf =
      extractCsrfFromHtml(loginPage.body) ??
      this.transport.cookieJar.get("csrftoken", new URL(`${this.transport.baseUrl}/login/`));
    if (!csrf) {
      throw new ArcheryError("auth", "没有从 Archery 登录页获取到 CSRF Token", {
        status: loginPage.status,
        hint: "请确认 Archery 的 /login/ 可访问，且登录页未被反向代理改写。",
      });
    }
    this.sessionCsrf = csrf;
    const form = new URLSearchParams();
    form.set("username", this.options.username);
    form.set("password", this.options.password ?? "");
    form.set("csrfmiddlewaretoken", csrf);
    const response = await this.transport.request({
      method: "POST",
      path: "/authenticate/",
      headers: {
        "Content-Type": FORM_CONTENT_TYPE,
        "X-CSRFToken": csrf,
        Referer: `${this.transport.baseUrl}/login/`,
        Origin: this.transport.origin,
      },
      body: form.toString(),
      allowRedirect: false,
      retryable: true,
    });
    if (response.status === 403) {
      throw new ArcheryError("auth", "Archery 登录请求被拒绝（CSRF 校验失败）", {
        status: 403,
        detail: snippet(response.body),
        hint: "请检查 Archery 的 ALLOWED_HOSTS、CSRF_TRUSTED_ORIGINS 以及反向代理的 Host/Origin 配置。",
      });
    }
    if (response.status === 404) {
      throw new ArcheryError("unsupported", "未找到 Archery 登录接口 /authenticate/", {
        status: 404,
      });
    }
    const payload = this.parseJson(response, "登录 Archery");
    const status = envelopeStatus(payload);
    if (status !== 0) {
      throw new ArcheryError("auth", envelopeMessage(payload) || "Archery 用户名或密码错误", {
        status,
      });
    }
    if (isRecord(payload) && typeof payload.data === "string" && payload.data) {
      throw new ArcheryError("twofa", "该 Archery 账号已启用两步验证，当前插件不支持 2FA 登录", {
        hint: "请使用未启用 2FA 的服务账号，或在 Archery 中为插件账号生成访问令牌后，以“令牌”模式创建连接。",
      });
    }
    this.loggedIn = true;
  }

  private async loginWithJwt(): Promise<void> {
    const response = await this.transport.request({
      method: "POST",
      path: "/api/auth/token/",
      headers: { "Content-Type": JSON_CONTENT_TYPE },
      body: JSON.stringify({ username: this.options.username, password: this.options.password }),
      allowRedirect: false,
      retryable: true,
    });
    if (response.status !== 200) {
      throw new ArcheryError("auth", "Archery 登录失败", {
        status: response.status,
        detail: snippet(response.body),
        hint: "请确认用户名、密码，以及 Archery 是否开放了 API 登录。",
      });
    }
    const parsed = this.parseJson(response, "令牌登录");
    if (isRecord(parsed) && typeof parsed.access === "string") {
      this.bearerToken = parsed.access;
      this.loggedIn = true;
      return;
    }
    throw new ArcheryError("auth", "Archery 登录响应中没有 access token", {
      detail: safeJson(parsed),
    });
  }

  private async detectApiStyle(): Promise<ApiStyle> {
    if (this.style) {
      return this.style;
    }
    await this.login();
    const response = await this.authenticatedRequest({
      method: "GET",
      path: "/api/v1/sqlquery/instances/",
    });
    if (response.status === 404 || response.status === 405) {
      this.style = "legacy";
      return this.style;
    }
    if (response.status === 403) {
      this.style = "legacy";
      return this.style;
    }
    const contentType = String(response.headers["content-type"] ?? "");
    if (!contentType.includes("json")) {
      this.style = "legacy";
      return this.style;
    }
    const parsed = this.parseJson(response, "探测 Archery API");
    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      this.style = "v1";
      return this.style;
    }
    if (Array.isArray(parsed)) {
      this.style = "v1";
      return this.style;
    }
    this.style = "legacy";
    return this.style;
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.authenticatedRequest({ method: "GET", path, signal });
    return this.parseJson(response, "读取 Archery 数据");
  }

  private async authenticatedRequest(spec: RequestSpec): Promise<HttpResponse> {
    if (this.options.authMode === "password") {
      await this.login();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers: Record<string, string> = { ...(spec.headers ?? {}) };
      if (this.bearerToken) {
        headers.Authorization = `Bearer ${this.bearerToken}`;
      }
      if (this.options.authMode !== "token" && (spec.method ?? "GET").toUpperCase() !== "GET") {
        const csrf =
          this.transport.cookieJar.get(
            "csrftoken",
            new URL(`${this.transport.baseUrl}${spec.path}`),
          ) ?? this.sessionCsrf;
        if (csrf) {
          headers["X-CSRFToken"] = csrf;
          headers.Referer = `${this.transport.baseUrl}/`;
          headers.Origin = this.transport.origin;
        }
      }
      const response = await this.transport.request({ ...spec, headers });
      if (!this.isSessionFailure(response)) {
        return response;
      }
      if (this.options.authMode === "token" || attempt > 0) {
        throw new ArcheryError("auth", "Archery 登录状态已失效，请检查账号或访问令牌", {
          status: response.status,
        });
      }
      this.loggedIn = false;
      await this.login(true);
    }
    throw new ArcheryError("auth", "Archery 认证失败");
  }

  private isSessionFailure(response: HttpResponse): boolean {
    if (response.status === 401) {
      return true;
    }
    if (response.redirectedToLogin) {
      return true;
    }
    if (response.status === 403) {
      const body = response.body.slice(0, 4000);
      return /csrf|authentication credentials|not authenticated|身份认证|未认证|未登录|请先登录|登录状态/i.test(body);
    }
    return false;
  }

  private parseJson(response: HttpResponse, action: string): unknown {
    if (this.isSessionFailure(response)) {
      throw new ArcheryError("auth", `${action}时 Archery 登录状态无效`, {
        status: response.status,
      });
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const trimmed = response.body.trim();
    if (!trimmed) {
      throw new ArcheryError("api", `${action}失败：Archery 返回了空响应`, {
        status: response.status,
      });
    }
    if (contentType.includes("text/html") || trimmed.startsWith("<")) {
      throw new ArcheryError("api", `${action}失败：Archery 返回了 HTML 页面而不是 JSON`, {
        status: response.status,
        detail: snippet(trimmed),
        hint: "这通常表示登录已失效、地址指向了错误页面，或反向代理拦截了 API 请求。",
      });
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (response.status >= 400) {
        const msg = envelopeMessage(parsed);
        throw new ArcheryError("api", msg || `${action}失败（HTTP ${response.status}）`, {
          status: response.status,
          detail: safeJson(parsed),
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof ArcheryError) {
        throw error;
      }
      throw new ArcheryError("api", `${action}失败：无法解析 Archery 返回的 JSON`, {
        status: response.status,
        detail: snippet(trimmed),
        cause: error,
      });
    }
  }

  private formBody(payload: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      params.set(key, value === undefined || value === null ? "" : String(value));
    }
    const csrf =
      this.transport.cookieJar.get(
        "csrftoken",
        new URL(`${this.transport.baseUrl}/query/`),
      ) ?? this.sessionCsrf;
    if (csrf) {
      params.set("csrfmiddlewaretoken", csrf);
    }
    return params.toString();
  }
}

function extractCsrfFromHtml(html: string): string | undefined {
  const patterns = [
    /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function snippet(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}…` : normalized;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ArcheryError && error.status === 404;
}
