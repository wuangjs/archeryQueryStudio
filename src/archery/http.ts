import http, { type Agent as HttpAgent, type IncomingHttpHeaders } from "node:http";
import https, { type Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { ArcheryError } from "./errors";
import type { Logger } from "../services/logger";

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires?: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  setFromHeaders(headers: IncomingHttpHeaders, requestUrl: URL): void {
    const raw = headers["set-cookie"];
    if (!raw) {
      return;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      this.setOne(value, requestUrl);
    }
  }

  setOne(raw: string, requestUrl: URL): void {
    const parts = raw.split(";");
    const pair = parts.shift() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) {
      return;
    }
    let domain = requestUrl.hostname;
    let path = defaultCookiePath(requestUrl.pathname);
    let secure = requestUrl.protocol === "https:";
    let expires: number | undefined;
    let maxAge: number | undefined;

    for (const part of parts) {
      const index = part.indexOf("=");
      const key = (index === -1 ? part : part.slice(0, index)).trim().toLowerCase();
      const attr = index === -1 ? "" : part.slice(index + 1).trim();
      if (key === "domain" && attr) {
        domain = attr.replace(/^\./, "").toLowerCase();
      } else if (key === "path" && attr.startsWith("/")) {
        path = attr;
      } else if (key === "secure") {
        secure = true;
      } else if (key === "expires") {
        const parsed = Date.parse(attr);
        if (!Number.isNaN(parsed)) {
          expires = parsed;
        }
      } else if (key === "max-age") {
        const seconds = Number(attr);
        if (Number.isFinite(seconds)) {
          maxAge = seconds;
        }
      }
    }
    if (maxAge !== undefined) {
      expires = Date.now() + maxAge * 1000;
    }
    if (expires !== undefined && expires <= Date.now()) {
      this.cookies.delete(cookieKey(domain, path, name));
      return;
    }
    this.cookies.set(cookieKey(domain, path, name), {
      name,
      value,
      domain,
      path,
      secure,
      expires,
    });
  }

  get(name: string, requestUrl?: URL): string | undefined {
    const now = Date.now();
    for (const cookie of this.cookies.values()) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        continue;
      }
      if (cookie.name === name && (!requestUrl || this.matches(cookie, requestUrl))) {
        return cookie.value;
      }
    }
    return undefined;
  }

  header(requestUrl: URL): string {
    const now = Date.now();
    const parts: string[] = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        continue;
      }
      if (this.matches(cookie, requestUrl)) {
        parts.push(`${cookie.name}=${cookie.value}`);
      }
    }
    return parts.join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }

  private matches(cookie: Cookie, url: URL): boolean {
    const host = url.hostname.toLowerCase();
    const domainOk =
      host === cookie.domain ||
      (host.endsWith(`.${cookie.domain}`) && !isIP(host) && cookie.domain.includes("."));
    if (!domainOk) {
      return false;
    }
    if (cookie.secure && url.protocol !== "https:") {
      return false;
    }
    return url.pathname === cookie.path || url.pathname.startsWith(`${cookie.path.replace(/\/$/, "")}/`);
  }
}

function cookieKey(domain: string, path: string, name: string): string {
  return `${domain}\u0000${path}\u0000${name}`;
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith("/")) {
    return "/";
  }
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  url: string;
  redirectedToLogin: boolean;
}

export interface RequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowRedirect?: boolean;
  /** Allow transparent retry when a reused connection is reset. Defaults to true for GET/HEAD. */
  retryable?: boolean;
}

export interface TransportOptions {
  baseUrl: string;
  timeoutMs: number;
  allowInsecureTls: boolean;
  logger: Logger;
  userAgent?: string;
}

export class HttpTransport {
  readonly baseUrl: string;
  readonly origin: string;
  readonly cookieJar = new CookieJar();
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(options: TransportOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ArcheryError("network", "Archery 地址必须以 http:// 或 https:// 开头");
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.origin = parsed.origin;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.userAgent = options.userAgent ?? "ArcheryQueryStudio/0.1.0";
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      rejectUnauthorized: !options.allowInsecureTls,
    });
  }

  async request(options: RequestOptions): Promise<HttpResponse> {
    const retryable =
      options.retryable ?? ["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase());
    const maxAttempts = retryable ? 3 : 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.performRequest(options, attempt > 0);
      } catch (error) {
        const canRetry =
          error instanceof ArcheryError &&
          error.retryable &&
          attempt + 1 < maxAttempts &&
          !options.signal?.aborted;
        if (!canRetry) {
          throw error;
        }
        this.logger.warn(
          `Archery 连接被重置，正在重试 ${attempt + 1}/${maxAttempts - 1}：${(options.method ?? "GET").toUpperCase()} ${options.path}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
  }

  private async performRequest(options: RequestOptions, forceClose = false): Promise<HttpResponse> {
    let method = (options.method ?? "GET").toUpperCase();
    let url = new URL(`${this.baseUrl}${options.path.startsWith("/") ? options.path : `/${options.path}`}`);
    let body = options.body;
    let headers = { ...(options.headers ?? {}) };
    if (forceClose) {
      headers.Connection = "close";
    }
    let redirects = 0;
    let currentSignal = options.signal;

    for (;;) {
      if (currentSignal?.aborted) {
        throw new ArcheryError("cancelled", "请求已取消");
      }
      const cookie = this.cookieJar.header(url);
      if (cookie) {
        headers.Cookie = cookie;
      }
      const response = await this.sendOnce(url, method, headers, body, options);
      this.cookieJar.setFromHeaders(response.headers, url);
      if (
        options.allowRedirect !== false &&
        REDIRECT_CODES.has(response.status) &&
        response.headers.location
      ) {
        if (++redirects > 5) {
          throw new ArcheryError("network", "Archery 地址重定向次数过多", { status: response.status });
        }
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin) {
          delete headers.Authorization;
          delete headers.Cookie;
        }
        this.logger.debug(`redirect ${response.status} ${url.pathname} -> ${next.pathname}`);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          delete headers["Content-Type"];
          delete headers["Content-Length"];
        }
        url = next;
        currentSignal = options.signal;
        continue;
      }
      const finalPath = new URL(response.url).pathname;
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        url: response.url,
        redirectedToLogin: /\/login\/?(?:2fa\/?)?$/.test(finalPath) && !url.pathname.includes("/api/"),
      };
    }
  }

  dispose(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private sendOnce(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const isHttps = url.protocol === "https:";
    const requestHeaders: Record<string, string | number> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": this.userAgent,
      "X-Requested-With": "XMLHttpRequest",
      ...headers,
    };
    if (body !== undefined) {
      requestHeaders["Content-Length"] = Buffer.byteLength(body);
    }
    const requestFn = isHttps ? https.request : http.request;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const request = requestFn(
        url,
        {
          method,
          headers: requestHeaders,
          agent: isHttps ? this.httpsAgent : this.httpAgent,
          rejectUnauthorized: isHttps ? !(this.httpsAgent.options.rejectUnauthorized === false) : undefined,
        } as https.RequestOptions,
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              request.destroy();
              fail(new ArcheryError("api", "Archery 响应超过 64 MB，已中止"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) {
              return;
            }
            settled = true;
            const text = Buffer.concat(chunks).toString("utf8");
            this.logger.debug(`${method} ${url.pathname} -> ${response.statusCode ?? 0} (${bytes} bytes)`);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: text,
              url: url.toString(),
              redirectedToLogin: false,
            });
          });
          response.on("error", (error) => fail(mapNodeError(error)));
        },
      );

      const timer = setTimeout(() => {
        request.destroy();
        fail(
          new ArcheryError(
            "timeout",
            `Archery 请求超时（${Math.round(timeoutMs / 1000)} 秒）`,
            { hint: "可在设置 archeryQueryStudio.requestTimeout 中调整超时时间。" },
          ),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        request.destroy();
        fail(new ArcheryError("cancelled", "请求已取消"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: ArcheryError): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      request.on("error", (error) => fail(mapNodeError(error)));
      request.on("close", () => {
        if (!settled) {
          fail(
            new ArcheryError("network", "Archery 连接被关闭", {
              hint: "网络连接被提前关闭，可能是代理、负载均衡或网络设备中断了连接。",
              retryable: true,
            }),
          );
        }
      });
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}

function mapNodeError(error: NodeJS.ErrnoException): ArcheryError {
  const code = error.code ?? "";
  const tlsCodes = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
  ]);
  if (tlsCodes.has(code)) {
    return new ArcheryError("tls", "无法验证 Archery 的 TLS 证书", {
      detail: error.message,
      hint: "如果这是内部自签名证书，请在连接设置中开启“允许不安全 TLS 证书”，或为服务配置受信任证书。",
      cause: error,
    });
  }
  if (code === "ECONNREFUSED") {
    return new ArcheryError("network", "Archery 服务拒绝连接", {
      detail: error.message,
      hint: "请确认地址、端口正确，且服务已启动。",
      cause: error,
    });
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ArcheryError("network", "无法解析 Archery 主机名", {
      detail: error.message,
      hint: "请检查地址拼写、DNS 或网络代理设置。",
      cause: error,
    });
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new ArcheryError("timeout", "连接 Archery 超时", {
      hint: "请检查网络或代理设置，或增大请求超时时间。",
      cause: error,
    });
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    return new ArcheryError("network", "Archery 连接被重置", {
      detail: error.message,
      hint: "常见原因：反向代理/负载均衡关闭了空闲连接、Archery 正在重启、VPN 或防火墙中断。对象加载等安全请求会自动重试；如果执行 SQL 时出现，请确认服务端状态后手动重试。",
      cause: error,
      retryable: true,
    });
  }
  return new ArcheryError("network", `无法连接 Archery：${error.message}`, { cause: error });
}
