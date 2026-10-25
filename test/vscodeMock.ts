import { EventEmitter as NodeEmitter } from "node:events";

export class EventEmitter<T> {
  private readonly emitter = new NodeEmitter();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.emitter.on("event", listener);
    return { dispose: () => this.emitter.off("event", listener) };
  };

  fire(value: T): void {
    this.emitter.emit("event", value);
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}

export interface Disposable {
  dispose(): void;
}

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  id?: string;
  command?: unknown;

  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1, One: 1, Two: 2 } as const;

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  constructor(public value = "") {}
}

interface UriValue {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
}

function makeUri(path: string): UriValue {
  return {
    scheme: "file",
    path,
    fsPath: path,
    toString: () => `file://${path}`,
  };
}

export const Uri = {
  file: (path: string): UriValue => makeUri(path),
  joinPath: (base: UriValue, ...parts: string[]): UriValue =>
    makeUri([base.path.replace(/\/$/, ""), ...parts].join("/")),
  parse: (value: string): UriValue => makeUri(value),
};

export const commands = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable {
    this.handlers.set(command, handler);
    return { dispose: () => this.handlers.delete(command) };
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    return this.handlers.get(command)?.(...args);
  },
};

export interface WebviewPanelMock {
  webview: {
    html: string;
    messages: unknown[];
    asWebviewUri(uri: UriValue): UriValue;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(callback: (message: unknown) => void): Disposable;
    receive(message: unknown): void;
  };
  iconPath?: unknown;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): Disposable;
}

export const createdPanels: WebviewPanelMock[] = [];

function createPanel(): WebviewPanelMock {
  let disposeListener: (() => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const messages: unknown[] = [];
  const panel: WebviewPanelMock = {
    webview: {
      html: "",
      messages,
      asWebviewUri: (uri) => uri,
      postMessage: async (message: unknown) => {
        messages.push(message);
        return true;
      },
      onDidReceiveMessage: (callback) => {
        messageListener = callback;
        return { dispose: () => (messageListener = undefined) };
      },
      receive: (message: unknown) => messageListener?.(message),
    },
    reveal: () => undefined,
    dispose: () => disposeListener?.(),
    onDidDispose: (listener) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    },
  };
  createdPanels.push(panel);
  return panel;
}

export const window = {
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: () => ({
    message: undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => ({
    name: "",
    text: "",
    tooltip: "",
    command: "",
    show: () => undefined,
    dispose: () => undefined,
  }),
  createWebviewPanel: () => createPanel(),
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showSaveDialog: async () => undefined,
  showOpenDialog: async () => undefined,
  showQuickPick: async () => undefined,
  setStatusBarMessage: () => ({ dispose: () => undefined }),
};

export const env = {
  clipboard: {
    writeText: async () => undefined,
  },
};

export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T): T => fallback,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  fs: {
    writeFile: async () => undefined,
    readFile: async () => new Uint8Array(),
  },
};

export function resetMock(): void {
  commands.handlers.clear();
  createdPanels.length = 0;
}

export class ExtensionContextMock {
  subscriptions: Disposable[] = [];
  extensionUri = makeUri("/extension");
  extension = { packageJSON: { version: "0.1.0" } };
  globalState = new MockMemento();
  workspaceState = new MockMemento();
  secrets = new MockSecrets();
}

class MockMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

class MockSecrets {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
