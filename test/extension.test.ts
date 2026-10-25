import { beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/extension";
import { ConnectionStore } from "../src/services/connectionStore";
import {
  commands,
  createdPanels,
  ExtensionContextMock,
  resetMock,
} from "./vscodeMock";

beforeEach(() => {
  resetMock();
});

describe("extension activation", () => {
  it("registers the workbench commands and creates a panel on demand", async () => {
    const context = new ExtensionContextMock();
    activate(context as never);
    expect([...commands.handlers.keys()]).toContain("archeryQueryStudio.openQueryConsole");
    expect([...commands.handlers.keys()]).toContain("archeryQueryStudio.addConnection");

    await commands.executeCommand("archeryQueryStudio.addConnection");
    expect(createdPanels).toHaveLength(1);
    const html = createdPanels[0].webview.html;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("webview.js");
    expect(html).toContain("webview.css");

    const panel = createdPanels[0];
    panel.webview.receive({ type: "ready" });
    await tick();
    const bootstrap = panel.webview.messages.find(
      (message) => (message as { type?: string }).type === "bootstrap",
    ) as { connections: unknown[]; settings: { defaultLimit: number } };
    expect(bootstrap).toBeDefined();
    expect(bootstrap.connections).toEqual([]);
    expect(bootstrap.settings.defaultLimit).toBe(100);

    panel.webview.receive({
      type: "saveConnection",
      requestId: "req-1",
      draft: {
        name: "生产",
        baseUrl: "https://archery.example.com",
        username: "alice",
        password: "secret",
        authMode: "password",
        allowInsecureTls: false,
      },
    });
    await tick();
    const response = panel.webview.messages.find(
      (message) =>
        (message as { type?: string }).type === "response" &&
        (message as { requestId?: string }).requestId === "req-1",
    ) as { ok: boolean; data: { connection: { name: string } } };
    expect(response.ok).toBe(true);
    expect(response.data.connection.name).toBe("生产");
    const saved = context.globalState.get("archeryQueryStudio.connections.v1") as Array<{
      id: string;
      name: string;
    }>;
    expect(saved[0].name).toBe("生产");
    expect(JSON.stringify(saved)).not.toContain("secret");

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ConnectionStore", () => {
  it("stores metadata and secrets separately and keeps secrets on edit", async () => {
    const context = new ExtensionContextMock();
    const store = new ConnectionStore(context as never);
    const saved = await store.save({
      name: " prod ",
      baseUrl: "archery.example.com/",
      username: "alice",
      password: "secret",
      authMode: "password",
      allowInsecureTls: false,
    });
    expect(saved.name).toBe("prod");
    expect(saved.baseUrl).toBe("https://archery.example.com");
    expect(store.list()).toHaveLength(1);
    expect(await context.secrets.get(`archeryQueryStudio.secret.${saved.id}.password`)).toBe("secret");
    expect(JSON.stringify(context.globalState.get("archeryQueryStudio.connections.v1"))).not.toContain("secret");

    await store.save({
      id: saved.id,
      name: "prod-readonly",
      baseUrl: saved.baseUrl,
      username: "alice",
      authMode: "password",
      allowInsecureTls: true,
    });
    expect(store.get(saved.id)?.name).toBe("prod-readonly");
    expect((await store.getSecret(saved.id)).password).toBe("secret");

    await store.remove(saved.id);
    expect(store.list()).toHaveLength(0);
    expect(await context.secrets.get(`archeryQueryStudio.secret.${saved.id}.password`)).toBeUndefined();
  });

  it("validates required credentials", async () => {
    const context = new ExtensionContextMock();
    const store = new ConnectionStore(context as never);
    await expect(
      store.save({
        name: "prod",
        baseUrl: "https://archery.example.com",
        username: "alice",
        authMode: "password",
        allowInsecureTls: false,
      }),
    ).rejects.toThrow("请填写 Archery 登录密码");
  });
});
