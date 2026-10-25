import * as vscode from "vscode";
import type { OpenQueryContext } from "./webview/protocol";
import type { QueryPanel } from "./webview/queryPanel";
import type { ArcheryService } from "./services/archeryService";
import type { ConnectionStore } from "./services/connectionStore";
import { buildSelect } from "./sql";
import { ArcheryNode, ArcheryTreeProvider } from "./tree/archeryTreeProvider";

export interface CommandDependencies {
  store: ConnectionStore;
  service: ArcheryService;
  tree: ArcheryTreeProvider;
  panel: QueryPanel;
  output: vscode.OutputChannel;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  const { store, service, tree, panel, output } = deps;

  const register = (command: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[command:${command}] ${message}`);
          void vscode.window.showErrorMessage(`Archery：${message}`);
        }
      }),
    );
  };

  register("archeryQueryStudio.addConnection", async () => {
    await panel.showConnectionForm();
  });

  register("archeryQueryStudio.openQueryConsole", async () => {
    await panel.show();
  });

  register("archeryQueryStudio.refreshExplorer", async () => {
    service.invalidateAll();
    tree.refresh();
    panel.postConnections();
  });

  register("archeryQueryStudio.refreshNode", async (arg) => {
    tree.refreshNode(asNode(arg));
  });

  register("archeryQueryStudio.editConnection", async (arg) => {
    const connectionId = await pickConnectionId(arg, store);
    if (connectionId) {
      await panel.showConnectionForm(connectionId);
    }
  });

  register("archeryQueryStudio.removeConnection", async (arg) => {
    const connectionId = await pickConnectionId(arg, store);
    if (!connectionId) {
      return;
    }
    const config = store.get(connectionId);
    if (!config) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `确定删除 Archery 连接“${config.name}”吗？保存在 SecretStorage 中的凭据也会被删除。`,
      { modal: true },
      "删除",
    );
    if (choice !== "删除") {
      return;
    }
    await store.remove(connectionId);
    service.invalidateConnection(connectionId, true);
    tree.refresh();
    panel.notifyConnectionRemoved(connectionId);
    panel.postConnections();
  });

  register("archeryQueryStudio.newQuery", async (arg) => {
    const node = asNode(arg);
    const contextValue = node ? nodeToContext(node) : {};
    await panel.show({ context: { ...contextValue, newTab: true } });
  });

  register("archeryQueryStudio.selectTop100", async (arg) => {
    const node = asNode(arg);
    if (!node || node.kind !== "table" || !node.tableName) {
      return;
    }
    const sql = buildSelect({
      dbType: node.dbType,
      dbName: node.dbName,
      schemaName: node.schemaName,
      tableName: node.tableName,
    });
    await panel.show({
      context: {
        connectionId: node.connectionId,
        instanceName: node.instanceName,
        dbName: node.dbName,
        schemaName: node.schemaName,
        tableName: node.tableName,
        dbType: node.dbType,
        sql,
        newTab: true,
        autoRun: true,
      },
    });
  });

  register("archeryQueryStudio.describeTable", async (arg) => {
    const node = asNode(arg);
    if (!node || node.kind !== "table" || !node.tableName) {
      return;
    }
    await panel.show({
      context: {
        ...nodeToContext(node),
        describe: true,
        newTab: true,
      },
    });
  });

  register("archeryQueryStudio.copyName", async (arg) => {
    const node = asNode(arg);
    if (!node) {
      return;
    }
    const name =
      node.tableName ?? node.dbName ?? node.instanceName ?? node.connectionName;
    await vscode.env.clipboard.writeText(name);
    void vscode.window.setStatusBarMessage(`已复制：${name}`, 2000);
  });

  register("archeryQueryStudio.showLogs", async () => {
    output.show(true);
  });
}

function asNode(value: unknown): ArcheryNode | undefined {
  return value instanceof ArcheryNode ? value : undefined;
}

async function pickConnectionId(
  arg: unknown,
  store: ConnectionStore,
): Promise<string | undefined> {
  const node = asNode(arg);
  if (node) {
    return node.connectionId;
  }
  const connections = store.list();
  if (connections.length === 0) {
    await vscode.commands.executeCommand("archeryQueryStudio.addConnection");
    return undefined;
  }
  if (connections.length === 1) {
    return connections[0].id;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((config) => ({
      label: config.name,
      description: config.baseUrl,
      detail: `用户：${config.username}`,
      id: config.id,
    })),
    { title: "选择 Archery 连接", placeHolder: "请选择要操作的连接" },
  );
  return picked?.id;
}

function nodeToContext(node: ArcheryNode): OpenQueryContext {
  return {
    connectionId: node.connectionId,
    instanceName: node.instanceName,
    dbName: node.dbName,
    schemaName: node.schemaName,
    tableName: node.tableName,
    dbType: node.dbType,
  };
}
