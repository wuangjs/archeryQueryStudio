import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ArcheryService } from "./services/archeryService";
import { ConnectionStore } from "./services/connectionStore";
import { createLogger } from "./services/logger";
import { ArcheryTreeProvider } from "./tree/archeryTreeProvider";
import { QueryPanel } from "./webview/queryPanel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Archery Query Studio");
  const logger = createLogger(output);
  const store = new ConnectionStore(context);
  const service = new ArcheryService(store, logger);
  const tree = new ArcheryTreeProvider(service, store);
  const treeView = vscode.window.createTreeView("archeryQueryStudio.explorer", {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: false,
  });

  const panel = new QueryPanel({
    context,
    extensionUri: context.extensionUri,
    extensionVersion: String(context.extension.packageJSON.version ?? "0.1.0"),
    store,
    service,
    tree: () => tree,
    logger,
    onShowLogs: () => output.show(true),
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  status.name = "Archery Query Studio";
  status.text = "$(database) Archery";
  status.tooltip = "打开 Archery SQL 查询工作台";
  status.command = "archeryQueryStudio.openQueryConsole";
  status.show();

  const updateStatus = (): void => {
    const count = store.list().length;
    status.text = `$(database) Archery${count ? ` ${count}` : ""}`;
    status.tooltip = count
      ? `${count} 个 Archery 连接 · 点击打开 SQL 工作台`
      : "尚未配置 Archery 连接 · 点击开始";
  };
  updateStatus();

  registerCommands(context, {
    store,
    service,
    tree,
    panel,
    output,
  });

  context.subscriptions.push(
    output,
    store,
    service,
    tree,
    treeView,
    status,
    { dispose: () => panel.dispose() },
    store.onDidChange(updateStatus),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("archeryQueryStudio")) {
        service.invalidateAll();
        tree.refresh();
      }
    }),
  );

  logger.info("Archery Query Studio 已启动");
}

export function deactivate(): void {
  // Resources are disposed through ExtensionContext subscriptions.
}
