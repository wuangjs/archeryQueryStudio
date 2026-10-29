import { extractColumnComments, type ColumnCommentMap } from "../src/columnComments";
import {
  buildDeleteStatements,
  DeleteSqlError,
  extractPrimaryKeyColumns,
} from "../src/deleteSql";
import {
  pushRecentTableFilter,
  sanitizeTableFilterHistory,
} from "../src/filterHistory";
import {
  buildRedisDataCommand,
  buildRedisScanCommand,
  buildRedisTypeCommand,
  isRedisDbType,
  normalizeRedisKeyPattern,
  parseRedisKeyType,
  parseRedisScanRows,
} from "../src/redis";
import { createTableNameMatcher } from "../src/tableFilter";
import {
  buildInsertStatements,
  insertModeLabel,
  InsertSqlError,
  supportsInsertMode,
  type InsertMode,
} from "../src/insertSql";
import { buildSelect, clearOrderBy, toggleOrderBy } from "../src/sql";
import {
  buildUpdateStatements,
  UpdateSqlError,
} from "../src/updateSql";
import type {
  ArcheryInstance,
  ConnectionHealth,
  QueryExecutionResult,
  QueryLogEntry,
  QueryLogPage,
  ResourceItem,
} from "../src/types";
import type {
  BootstrapMessage,
  ConnectionFormDraft,
  ConnectionInfo,
  ExecuteQueryData,
  HostMessage,
  ListInstancesData,
  ListResourcesData,
  OpenQueryContext,
  OpenSqlFileData,
  SaveConnectionData,
} from "../src/webview/protocol";
import { bridge, HostError } from "./bridge";
import { SqlEditor } from "./editor";
import { icon, logoSvg } from "./icons";
import {
  activeConnection,
  activeTab,
  createTab,
  emptyCatalog,
  emptyHistory,
  initialState,
  isSchemaDbType,
  queryTabTitle,
  restoreTabs,
  resultRowCount,
  tabContextLabel,
  toSnapshot,
  type AppState,
  type QueryErrorInfo,
  type TabState,
  type TableStructureSnapshot,
} from "./state";

let state: AppState = initialState([], { defaultLimit: 100, allowInsecureTls: false });
let editor: SqlEditor;
let tableFilter = "";
let tableFilterRegex = false;
let redisSearchTimer: number | undefined;
let redisSearchSeq = 0;
let dbListSignature = "";
let tableListSignature = "";
let dbListContext = "";
let tableListContext = "";
let dbListScrollTop = 0;
let tableListScrollTop = 0;
let catalogSeq = 0;
let historySeq = 0;
let columnsSeq = 0;
let persistTimer: number | undefined;
let resultFilterTimer: number | undefined;
let historyFilterTimer: number | undefined;
let missingBootstrapTimer: number | undefined;
let modalCleanup: (() => void) | undefined;
const columnCache = new Map<string, ResourceItem[]>();
interface TableMetadataEntry {
  comments: ColumnCommentMap;
  structure: TableStructureSnapshot;
}
const tableMetadataCache = new Map<string, TableMetadataEntry>();
const tableMetadataPending = new Map<string, Promise<TableMetadataEntry>>();
let statusPosition = { line: 1, column: 1, selected: 0 };
let tooltipTimer: number | undefined;
let tooltipTarget: HTMLElement | undefined;
interface RowDragState {
  tabId: string;
  startRow: HTMLTableRowElement;
  baseSelection: Set<number>;
  additive: boolean;
  startX: number;
  startY: number;
  active: boolean;
}
let rowDrag: RowDragState | undefined;
let suppressRowClick = false;

mount();

function mount(): void {
  const app = document.getElementById("app");
  if (!app) {
    return;
  }
  app.className = "app";
  app.innerHTML = shellHtml();

  const host = document.getElementById("editor");
  if (!host) {
    return;
  }
  editor = new SqlEditor(host, "");
  editor.onChange((value) => {
    const tab = activeTab(state);
    if (tab) {
      tab.sql = value;
      schedulePersist();
    }
  });
  editor.onCursor((line, column, selected) => {
    statusPosition = { line, column, selected };
    renderStatus();
  });
  editor.onRun(() => executeQuery(false));
  editor.onSave(() => saveSqlFile());

  bindEvents();
  bridge.onMessage((message) => void handleHostMessage(message));
  renderAll();
  restoreSplitter();
  restoreSidebar();
  bridge.ready();
  byId<HTMLButtonElement>("clear-filter").hidden = true;
  missingBootstrapTimer = window.setTimeout(() => {
    if (!state.connections.length) {
      renderWelcome();
    }
  }, 1200);
  window.setInterval(() => {
    if (activeTab(state)?.status === "running") {
      renderStatus();
      updateRunningTime();
    }
  }, 500);
}

function shellHtml(): string {
  return `
  <div class="shell">
    <header class="titlebar">
      <div class="brand">
        ${logoSvg(22)}
        <div class="brand-text"><strong>Archery</strong><span>Query Studio</span></div>
      </div>
      <button id="sidebar-toggle" class="icon-btn ghost" title="显示/隐藏对象浏览器">${icon("panel-left", 16)}</button>
      <div class="connection-area">
        <span class="eyebrow">连接</span>
        <select id="connection-select" class="select connection-select" title="选择 Archery 连接"></select>
        <button id="add-connection" class="icon-btn" title="添加 Archery 连接">${icon("plus")}</button>
        <button id="edit-connection" class="icon-btn" title="编辑当前连接">${icon("edit")}</button>
      </div>
      <div class="titlebar-spacer"></div>
      <div class="titlebar-actions">
        <button id="refresh-catalog" class="icon-btn" title="刷新对象树">${icon("refresh")}</button>
        <button id="open-settings" class="icon-btn" title="打开插件设置">${icon("settings")}</button>
        <button id="show-logs" class="icon-btn" title="查看插件日志">${icon("terminal")}</button>
      </div>
    </header>

    <div class="workarea">
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-head">
          <span>对象浏览器</span>
          <button id="refresh-sidebar" class="icon-btn tiny" title="重新加载当前对象">${icon("refresh", 13)}</button>
        </div>
        <div class="sidebar-scroll">
          <div class="sidebar-block">
            <label class="field-label" for="instance-select">实例</label>
            <select id="instance-select" class="select field-select"></select>
          </div>
          <div id="schema-field" class="sidebar-block" hidden>
            <label class="field-label" for="schema-select">Schema</label>
            <select id="schema-select" class="select field-select"></select>
          </div>
          <div class="sidebar-block database-block">
            <div class="section-heading"><span>数据库</span><span id="db-count" class="count"></span></div>
            <div id="db-list" class="object-list"></div>
          </div>
          <div class="sidebar-block table-block">
            <div class="section-heading"><span id="table-section-label">数据表</span><span id="table-count" class="count"></span></div>
            <div class="filter-wrap">
              <div class="filter-box">${icon("search", 13)}<input id="table-filter" type="text" placeholder="筛选表名" spellcheck="false" /><button id="table-filter-regex" class="clear-filter regex-toggle" title="切换正则匹配" aria-pressed="false"><span class="regex-symbol">.*</span><span id="table-filter-regex-label" class="regex-state">普通</span></button><button id="table-filter-history-btn" class="clear-filter" title="最近筛选记录">${icon("history", 12)}</button><button id="clear-filter" class="clear-filter" title="清除筛选">${icon("x", 12)}</button></div>
              <div id="table-filter-history" class="filter-history" hidden></div>
            </div>
            <div id="table-list" class="object-list table-list"></div>
          </div>
        </div>
        <div class="sidebar-foot">${icon("info", 12)} <span>单击表名立即查询；结果字段悬停查看备注</span></div>
      </aside>
      <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整对象浏览器宽度" title="拖动调整宽度；双击恢复默认"></div>

      <main id="workspace" class="workspace">
        <div id="query-tabs" class="query-tabs"></div>
        <div class="context-bar">
          <div id="context-path" class="context-path"></div>
          <div class="context-actions">
            <label class="limit-control" title="每页从 Archery 读取的行数"><span>每页</span>
              <select id="limit-select" class="mini-select">
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
                <option value="5000">5000</option>
                <option value="0">服务端</option>
              </select>
            </label>
            <button id="load-sql" class="text-btn" title="从文件打开 SQL">${icon("folder-open")}<span>打开</span></button>
            <button id="save-sql" class="text-btn" title="保存 SQL 到文件 (Ctrl/Cmd+S)">${icon("save")}<span>保存</span></button>
            <button id="explain-query" class="text-btn" title="对当前 SQL 执行 EXPLAIN">${icon("code")}<span>EXPLAIN</span></button>
            <button id="stop-query" class="text-btn danger" title="停止等待（中断本地请求）" hidden>${icon("stop")}<span>停止</span></button>
            <button id="run-query" class="primary-btn run-btn" title="执行全部 SQL 或选中的 SQL (Ctrl/Cmd+Enter)">${icon("play")}<span>执行</span><kbd>Ctrl+Enter</kbd></button>
          </div>
        </div>
        <div id="editor-pane" class="editor-pane"><div id="editor" class="editor-host"></div></div>
        <div id="splitter" class="splitter" title="拖动调整编辑器与结果区域高度"></div>
        <section id="result-pane" class="result-pane">
          <div class="result-head">
            <div id="result-tabbar" class="result-tabbar">
              <button class="result-tab" data-result-tab="results">${icon("table")}<span>结果</span><span id="result-count" class="pill"></span></button>
              <button class="result-tab" data-result-tab="messages">${icon("terminal")}<span>消息</span></button>
              <button class="result-tab" data-result-tab="history">${icon("history")}<span>历史</span></button>
            </div>
            <div id="result-actions" class="result-actions"></div>
          </div>
          <div id="result-body" class="result-body"></div>
        </section>
        <footer class="statusbar">
          <span id="status-connection" class="status-item"></span>
          <span id="status-position" class="status-item"></span>
          <span class="statusbar-spacer"></span>
          <span id="status-query" class="status-item"></span>
        </footer>
      </main>
    </div>

    <div id="welcome" class="welcome-overlay" hidden>
      <div class="welcome-card">
        <div class="welcome-logo">${logoSvg(58)}</div>
        <div class="welcome-kicker">SQL · AUDIT · QUERY</div>
        <h1>把 Archery 变成你的 SQL 工作台</h1>
        <p>浏览授权实例和数据库，编写并执行 SQL，查看与导出结果。所有查询都经过 Archery 的权限校验、审计和脱敏。</p>
        <button id="welcome-add" class="primary-btn welcome-btn">${icon("plus", 16)}<span>添加 Archery 连接</span></button>
        <div class="welcome-steps">
          <div class="welcome-step"><b>01</b><span>填写 Archery 地址与账号</span></div>
          <div class="welcome-step"><b>02</b><span>选择实例和数据库</span></div>
          <div class="welcome-step"><b>03</b><span>编写 SQL，一键执行</span></div>
        </div>
        <div class="welcome-note">${icon("link", 13)} 插件只连接 Archery 接口，不会绕过平台直接连接数据库。</div>
      </div>
    </div>
  </div>
  <div id="modal-root"></div>
  <div id="toast-root" class="toast-root"></div>
  <div id="column-tooltip" class="column-tooltip" role="tooltip" hidden></div>`;
}

function bindEvents(): void {
  byId<HTMLButtonElement>("sidebar-toggle").addEventListener("click", toggleSidebar);
  byId<HTMLButtonElement>("welcome-add").addEventListener("click", () => void openConnectionModal());
  byId<HTMLButtonElement>("add-connection").addEventListener("click", () => void openConnectionModal());
  byId<HTMLButtonElement>("edit-connection").addEventListener("click", () => {
    if (state.activeConnectionId) {
      void openConnectionModal(state.activeConnectionId);
    }
  });
  byId<HTMLButtonElement>("refresh-catalog").addEventListener("click", () => void refreshCatalog());
  byId<HTMLButtonElement>("refresh-sidebar").addEventListener("click", () => void refreshCatalog());
  byId<HTMLButtonElement>("open-settings").addEventListener("click", () => {
    void bridge
      .request({ type: "openSettings" })
      .catch((error: unknown) => toast(messageOf(error), "error"));
  });
  byId<HTMLButtonElement>("show-logs").addEventListener("click", () => {
    void bridge.request({ type: "showLogs" }).catch(() => undefined);
  });
  byId<HTMLSelectElement>("connection-select").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    void changeConnection(value || undefined);
  });
  byId<HTMLSelectElement>("instance-select").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    void changeInstance(value);
  });
  byId<HTMLSelectElement>("schema-select").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    void changeSchema(value);
  });
  byId<HTMLSelectElement>("limit-select").addEventListener("change", (event) => {
    changeResultPageSize(Number((event.target as HTMLSelectElement).value));
  });

  const filter = byId<HTMLInputElement>("table-filter");
  const filterRegexButton = byId<HTMLButtonElement>("table-filter-regex");
  const filterHistory = byId<HTMLElement>("table-filter-history");
  const filterHistoryButton = byId<HTMLButtonElement>("table-filter-history-btn");
  updateTableFilterModeUi();
  filterRegexButton.addEventListener("click", () => {
    tableFilterRegex = !tableFilterRegex;
    updateTableFilterModeUi();
    renderTableList();
  });
  filter.addEventListener("input", () => {
    tableFilter = filter.value;
    byId<HTMLButtonElement>("clear-filter").hidden = !tableFilter;
    if (isRedisInstance()) {
      window.clearTimeout(redisSearchTimer);
      redisSearchTimer = window.setTimeout(() => {
        void searchRedisKeys(tableFilter);
      }, 450);
      return;
    }
    renderTableList();
  });
  filter.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (isRedisInstance()) {
        window.clearTimeout(redisSearchTimer);
        void searchRedisKeys(tableFilter);
      } else {
        rememberTableFilter(tableFilter);
      }
      closeTableFilterHistory();
      return;
    }
    if (event.key === "Escape") {
      closeTableFilterHistory();
    }
  });
  filterHistoryButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleTableFilterHistory();
  });
  filterHistory.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-clear-table-history]")) {
      state.tableFilterHistory = [];
      schedulePersist();
      renderTableFilterHistory();
      return;
    }
    const item = target.closest<HTMLElement>("[data-table-filter-history]");
    const saved = item?.dataset.tableFilterHistory;
    if (saved !== undefined) {
      const regex = saved.length > 1 && saved.startsWith("/") && saved.endsWith("/");
      const term = regex ? saved.slice(1, -1) : saved;
      tableFilterRegex = regex;
      updateTableFilterModeUi();
      tableFilter = term;
      filter.value = term;
      byId<HTMLButtonElement>("clear-filter").hidden = !term;
      rememberTableFilter(term, regex);
      renderTableList();
      closeTableFilterHistory();
      filter.focus();
    }
  });
  byId<HTMLButtonElement>("clear-filter").addEventListener("click", () => {
    tableFilter = "";
    filter.value = "";
    byId<HTMLButtonElement>("clear-filter").hidden = true;
    closeTableFilterHistory();
    if (isRedisInstance()) {
      window.clearTimeout(redisSearchTimer);
      void searchRedisKeys("");
    } else {
      renderTableList();
    }
    filter.focus();
  });
  document.addEventListener("mousedown", (event) => {
    if (!(event.target as HTMLElement).closest(".result-menu")) {
      closeResultMenus();
    }
    if (!(event.target as HTMLElement).closest(".tab-context-menu")) {
      closeTabContextMenu();
    }
    if (filterHistory.hidden) {
      return;
    }
    const target = event.target as Node;
    if (
      filterHistory.contains(target) ||
      filterHistoryButton.contains(target) ||
      filter.contains(target)
    ) {
      return;
    }
    closeTableFilterHistory();
  });

  byId<HTMLElement>("db-list").addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-db]");
    if (item?.dataset.db) {
      void changeDatabase(item.dataset.db);
    }
  });
  byId<HTMLElement>("table-list").addEventListener("click", (event) => {
    const structure = (event.target as HTMLElement).closest<HTMLElement>("[data-table-structure]");
    if (structure?.dataset.tableStructure) {
      void openTableStructure(structure.dataset.tableStructure);
      return;
    }
    if (event.detail > 1) {
      return;
    }
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-table]");
    if (item?.dataset.table) {
      queryTable(item.dataset.table);
    }
  });

  byId<HTMLElement>("query-tabs").addEventListener("click", (event) => {
    closeTabContextMenu();
    const close = (event.target as HTMLElement).closest<HTMLElement>("[data-close-tab]");
    if (close?.dataset.closeTab) {
      event.stopPropagation();
      closeTab(close.dataset.closeTab);
      return;
    }
    if ((event.target as HTMLElement).closest("#new-tab")) {
      newTab();
      return;
    }
    const tabEl = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    if (tabEl?.dataset.tabId) {
      activateTab(tabEl.dataset.tabId);
    }
  });

  byId<HTMLElement>("query-tabs").addEventListener("contextmenu", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    if (!item?.dataset.tabId) {
      return;
    }
    event.preventDefault();
    openTabContextMenu(item.dataset.tabId, event.clientX, event.clientY);
  });
  byId<HTMLButtonElement>("run-query").addEventListener("click", () => void executeQuery(false));
  byId<HTMLButtonElement>("stop-query").addEventListener("click", () => stopQuery());
  byId<HTMLButtonElement>("explain-query").addEventListener("click", () => void executeQuery(true));
  byId<HTMLButtonElement>("save-sql").addEventListener("click", () => void saveSqlFile());
  byId<HTMLButtonElement>("load-sql").addEventListener("click", () => void openSqlFile());

  byId<HTMLElement>("result-tabbar").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-result-tab]");
    if (button?.dataset.resultTab) {
      switchResultTab(button.dataset.resultTab as "results" | "messages" | "history");
    }
  });
  byId<HTMLElement>("result-actions").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const menuToggle = target.closest<HTMLElement>("[data-result-menu]");
    if (menuToggle?.dataset.resultMenu) {
      event.stopPropagation();
      toggleResultMenu(menuToggle.dataset.resultMenu);
      return;
    }
    const button = target.closest<HTMLElement>("[data-action]");
    if (button?.dataset.action) {
      if (button.dataset.insertMode) {
        const tab = activeTab(state);
        if (tab) {
          tab.insertMode = button.dataset.insertMode as InsertMode;
          renderResultActions(tab);
        }
      }
      closeResultMenus();
      void handleResultAction(button.dataset.action);
    }
  });
  byId<HTMLElement>("result-body").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const page = target.closest<HTMLElement>("[data-page]");
    if (page?.dataset.page) {
      const tab = activeTab(state);
      if (tab?.result && tab.status !== "running") {
        const targetPage = Number(page.dataset.page);
        const pageSize = Math.max(1, tab.pageSize);
        const loadedPages = Math.max(1, Math.ceil(tab.result.rows.length / pageSize));
        if (targetPage > tab.page && targetPage >= loadedPages && tab.hasMoreRows && !tab.filter) {
          void loadMoreRows(tab);
          return;
        }
        tab.page = targetPage;
        renderResults();
      }
      return;
    }
    const sort = target.closest<HTMLElement>("[data-sort-column]");
    if (sort?.dataset.sortColumn) {
      hideColumnTooltip();
      void executeOrderBy(Number(sort.dataset.sortColumn));
      return;
    }
    const load = target.closest<HTMLElement>("[data-history-load]");
    if (load?.dataset.historyLoad) {
      void loadHistoryEntry(Number(load.dataset.historyLoad));
      return;
    }
    const refresh = target.closest<HTMLElement>("[data-history-refresh]");
    if (refresh) {
      void loadHistory(true);
      return;
    }
    if (suppressRowClick) {
      suppressRowClick = false;
      return;
    }
    const cell = target.closest<HTMLElement>("td[data-cell-row]");
    if (cell) {
      if (target.closest("input, textarea, select") || event.detail > 1) {
        return;
      }
      const tab = activeTab(state);
      if (tab?.result && tab.status !== "running") {
        commitActiveCellEdit(cell);
        selectResultCell(cell);
      }
      return;
    }
    const row = target.closest<HTMLTableRowElement>(".grid tbody tr[data-row-index]");
    if (row && !target.closest("input, button, a, select, textarea, label")) {
      const tab = activeTab(state);
      if (tab?.result && tab.status !== "running") {
        commitActiveCellEdit();
        clearSelectedResultCell();
        const index = Number(row.dataset.rowIndex);
        if (tab.selectedRows.has(index)) {
          tab.selectedRows.delete(index);
        } else {
          tab.selectedRows.add(index);
        }
        updateSelectionUi(tab);
      }
    }
  });
  document.addEventListener("copy", (event) => {
    if (isEditorFocused()) {
      return;
    }
    const selected = document.querySelector<HTMLElement>("#result-body td.cell-selected[data-cell-row]");
    const tab = activeTab(state);
    if (!selected || !tab?.result) {
      return;
    }
    const row = Number(selected.dataset.cellRow);
    const column = Number(selected.dataset.cellCol);
    const text = rawCellValue(tab.result.rows[row]?.[column]);
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    notifyCellCopied(tab, row, column);
  });
  byId<HTMLElement>("result-body").addEventListener("mousedown", beginRowDrag);
  document.addEventListener("mousemove", moveRowDrag);
  document.addEventListener("mouseup", endRowDrag);
  byId<HTMLElement>("result-body").addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>("[data-cell-row]");
    if (!cell || target.closest("input, textarea, select")) {
      return;
    }
    const tab = activeTab(state);
    if (!tab?.result || tab.status === "running") {
      return;
    }
    const row = Number(cell.dataset.cellRow);
    const column = Number(cell.dataset.cellCol);
    if (event.ctrlKey || event.metaKey) {
      openValueViewer(tab.result, row, column);
      return;
    }
    startCellEdit(cell, tab, row, column);
  });

  document.addEventListener("mouseover", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-column-tooltip]");
    if (!target) {
      hideColumnTooltip();
      return;
    }
    if (target === tooltipTarget) {
      return;
    }
    if (tooltipTarget) {
      hideColumnTooltip();
    }
    window.clearTimeout(tooltipTimer);
    tooltipTarget = target;
    tooltipTimer = window.setTimeout(() => {
      if (tooltipTarget === target) {
        showColumnTooltip(target);
      }
    }, 220);
  });
  document.addEventListener("mouseout", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-column-tooltip]");
    if (!target) {
      return;
    }
    const related = event.relatedTarget as Node | null;
    if (related && target.contains(related)) {
      return;
    }
    hideColumnTooltip();
  });
  document.addEventListener("scroll", () => hideColumnTooltip(), true);
  bindSplitter();
  bindSidebarResizer();
  window.addEventListener("resize", () => {
    editor.refresh();
    renderResults();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      closeResultMenus();
      closeTabContextMenu();
    }
    const modalOpen = byId<HTMLElement>("modal-root").children.length > 0;
    if (
      !modalOpen &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      !isEditorFocused() &&
      !(event.target instanceof HTMLElement && event.target.closest(
        "input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']",
      ))
    ) {
      const selected = document.querySelector<HTMLElement>("#result-body td.cell-selected[data-cell-row]");
      const tab = activeTab(state);
      if (selected && tab?.result) {
        event.preventDefault();
        copyCellRaw(tab, Number(selected.dataset.cellRow), Number(selected.dataset.cellCol));
        return;
      }
      if (tab?.result && tab.selectedRows.size) {
        event.preventDefault();
        void copySelectedRows(tab);
        return;
      }
    }
    if (!modalOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      if (!isEditorFocused()) {
        event.preventDefault();
        void saveSqlFile();
      }
    }
    if (!modalOpen && (event.ctrlKey || event.metaKey) && event.key === "Enter" && !isEditorFocused()) {
      event.preventDefault();
      void executeQuery(false);
    }
  });
}

async function handleHostMessage(message: HostMessage): Promise<void> {
  switch (message.type) {
    case "bootstrap":
      await applyBootstrap(message);
      return;
    case "connections":
      applyConnections(message.connections);
      return;
    case "context":
      await handleContext(message.context, message.action, message.connectionDraft);
      return;
    case "toast":
      toast(message.message, message.severity);
      return;
    case "connectionRemoved":
      handleConnectionRemoved(message.connectionId);
      return;
    case "response":
    case "exportDone":
      return;
    default:
      return;
  }
}

async function applyBootstrap(message: BootstrapMessage): Promise<void> {
  window.clearTimeout(missingBootstrapTimer);
  state = initialState(message.connections, message.settings);
  state.tableFilterHistory = sanitizeTableFilterHistory(message.snapshot?.tableFilterHistory);
  const restored = restoreTabs(message.snapshot, state);
  state.tabs = restored;
  const savedConnection =
    message.snapshot?.activeConnectionId &&
    state.connections.some((connection) => connection.id === message.snapshot?.activeConnectionId)
      ? message.snapshot.activeConnectionId
      : undefined;
  state.activeConnectionId = savedConnection ?? state.connections[0]?.id;
  if (restored.length) {
    state.activeTabId = restored.some((tab) => tab.id === message.snapshot?.activeTabId)
      ? message.snapshot?.activeTabId
      : restored[0].id;
  } else if (!message.context) {
    const tab = createTab(state);
    state.tabs = [tab];
    state.activeTabId = tab.id;
  }
  for (const tab of state.tabs) {
    if (
      !tab.connectionId ||
      !state.connections.some((connection) => connection.id === tab.connectionId)
    ) {
      tab.connectionId = state.activeConnectionId;
      tab.instanceName = "";
      tab.dbName = "";
      tab.schemaName = "";
      tab.tableName = "";
      tab.dbType = "";
    }
  }
  const tab = activeTab(state);
  if (tab) {
    editor.setValue(tab.sql);
    if (!tab.connectionId) {
      tab.connectionId = state.activeConnectionId;
    }
  }
  renderAll();

  if (message.action === "add-connection") {
    await openConnectionModal();
  } else if (message.action === "edit-connection") {
    await openConnectionModal(message.context?.connectionId, message.connectionDraft);
  } else if (message.action === "show-history" && activeTab(state)) {
    const active = activeTab(state);
    if (active) {
      active.resultTab = "history";
      renderResults();
      await loadHistoryIfNeeded(true);
    }
  }

  if (message.context && !message.context.newTab && !message.action) {
    await handleContext(message.context);
  } else if (message.context?.newTab) {
    await handleContext(message.context);
  } else if (tab) {
    await syncCatalog(tab, false);
  }
  schedulePersist();
}

function applyConnections(connections: ConnectionInfo[]): void {
  const previousActive = state.activeConnectionId;
  const previous = state.connections.find((item) => item.id === previousActive);
  const next = connections.find((item) => item.id === previousActive);
  const connectionChanged =
    previous !== undefined &&
    next !== undefined &&
    (previous.baseUrl !== next.baseUrl ||
      previous.username !== next.username ||
      previous.authMode !== next.authMode ||
      previous.allowInsecureTls !== next.allowInsecureTls);
  state.connections = connections;
  if (!connections.some((connection) => connection.id === state.activeConnectionId)) {
    state.activeConnectionId = connections[0]?.id;
  }
  for (const tab of state.tabs) {
    if (tab.connectionId && !connections.some((connection) => connection.id === tab.connectionId)) {
      if (tab.requestId) {
        bridge.cancel(tab.requestId);
        tab.requestId = undefined;
      }
      tab.connectionId = state.activeConnectionId;
      tab.instanceName = "";
      tab.dbName = "";
      tab.schemaName = "";
      tab.tableName = "";
      tab.dbType = "";
      resetTabQueryState(tab);
    }
  }
  renderConnectionSelect();
  renderWelcome();
  if (previousActive !== state.activeConnectionId || connectionChanged) {
    const tab = activeTab(state);
    if (tab && tab.connectionId === state.activeConnectionId) {
      state.catalog = emptyCatalog();
      void syncCatalog(tab, true);
    }
  } else {
    renderContext();
  }
  schedulePersist();
}

async function handleContext(
  context: OpenQueryContext,
  action?: "add-connection" | "edit-connection" | "show-history",
  connectionDraft?: ConnectionFormDraft,
): Promise<void> {
  if (action === "add-connection") {
    await openConnectionModal();
    return;
  }
  if (action === "edit-connection") {
    await openConnectionModal(context.connectionId, connectionDraft);
    return;
  }
  if (action === "show-history") {
    const tab = activeTab(state);
    if (tab) {
      tab.resultTab = "history";
      renderResults();
      await loadHistoryIfNeeded(true);
    }
    return;
  }
  await applyContext(context);
}

async function applyContext(context: OpenQueryContext): Promise<void> {
  let connectionId = context.connectionId;
  if (connectionId && !state.connections.some((connection) => connection.id === connectionId)) {
    connectionId = undefined;
  }
  connectionId = connectionId ?? state.activeConnectionId;
  const shouldCreate = Boolean(context.newTab) || state.tabs.length === 0;
  let tab: TabState;
  if (shouldCreate) {
    tab = createTab(state, {
      connectionId,
      instanceName: context.instanceName,
      dbName: context.dbName,
      schemaName: context.schemaName,
      tableName: context.tableName,
      dbType: context.dbType,
      sql: context.sql,
      title: context.tableName || context.dbName || context.instanceName,
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(tab);
  } else {
    tab = activeTab(state) ?? createTab(state, { connectionId });
    if (!state.tabs.includes(tab)) {
      state.tabs.push(tab);
    }
    if (connectionId) {
      tab.connectionId = connectionId;
    }
    if (context.instanceName !== undefined) {
      tab.instanceName = context.instanceName;
    }
    if (context.dbName !== undefined) {
      tab.dbName = context.dbName;
    }
    if (context.schemaName !== undefined) {
      tab.schemaName = context.schemaName;
    }
    if (context.tableName !== undefined) {
      tab.tableName = context.tableName;
    }
    if (context.dbType !== undefined) {
      tab.dbType = context.dbType;
    }
    if (context.sql !== undefined) {
      tab.sql = context.sql;
    }
  }
  if (connectionId) {
    state.activeConnectionId = connectionId;
  }
  tab.connectionId = connectionId;
  if (!tab.title || /^查询 \d+$/.test(tab.title)) {
    tab.title = context.tableName || context.dbName || context.instanceName || tab.title;
  }
  state.activeTabId = tab.id;
  tab.resultTab = context.describe ? "messages" : "results";
  editor.setValue(tab.sql);
  renderAll();
  schedulePersist();

  const syncPromise = syncCatalog(tab, false);
  if (context.describe) {
    await runDescribe(tab);
    await syncPromise;
  } else {
    await syncPromise;
    if (context.autoRun) {
      await executeQuery(false);
    }
  }
}

function renderAll(): void {
  renderConnectionSelect();
  renderWelcome();
  renderInstanceSelect();
  renderSchemaSelect();
  renderDbList();
  renderTableList();
  renderQueryTabs();
  renderContext();
  renderResults();
  renderStatus();
}

function renderConnectionSelect(): void {
  const select = byId<HTMLSelectElement>("connection-select");
  const previous = state.activeConnectionId ?? "";
  select.replaceChildren();
  if (!state.connections.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "尚未配置连接";
    select.append(option);
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const connection of state.connections) {
      const option = document.createElement("option");
      option.value = connection.id;
      option.textContent = connection.name;
      option.title = `${connection.baseUrl}\n用户：${connection.username}`;
      select.append(option);
    }
    select.value = state.connections.some((connection) => connection.id === previous)
      ? previous
      : state.connections[0].id;
  }
  byId<HTMLButtonElement>("edit-connection").disabled = !state.activeConnectionId;
  renderWelcome();
}

function renderWelcome(): void {
  const welcome = document.getElementById("welcome");
  if (!welcome) {
    return;
  }
  welcome.hidden = state.connections.length > 0;
}

function renderInstanceSelect(): void {
  const select = byId<HTMLSelectElement>("instance-select");
  select.replaceChildren();
  if (!state.activeConnectionId) {
    select.append(option("", "选择连接后加载实例"));
    select.disabled = true;
    return;
  }
  if (state.catalog.instancesLoading) {
    select.append(option("", "正在加载实例…"));
    select.disabled = true;
    return;
  }
  if (!state.catalog.instances.length) {
    select.append(option("", state.catalog.error ? "实例加载失败" : "没有可访问的实例"));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.append(option("", "选择实例"));
  for (const instance of state.catalog.instances) {
    const item = option(instance.instance_name, `${instance.instance_name} · ${instance.db_type}`);
    select.append(item);
  }
  select.value = state.catalog.instanceName;
}

function renderSchemaSelect(): void {
  const field = byId<HTMLElement>("schema-field");
  const select = byId<HTMLSelectElement>("schema-select");
  const show = isSchemaDbType(activeTab(state)?.dbType || selectedInstance()?.db_type) &&
    (state.catalog.schemasLoading || state.catalog.schemas.length > 0);
  field.hidden = !show;
  if (!show) {
    select.replaceChildren();
    return;
  }
  select.replaceChildren();
  if (state.catalog.schemasLoading) {
    select.append(option("", "正在加载 schema…"));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const schema of state.catalog.schemas) {
    select.append(option(schema.name, schema.name));
  }
  select.value = state.catalog.schemaName;
}

function renderDbList(): void {
  const list = byId<HTMLElement>("db-list");
  const count = byId<HTMLElement>("db-count");
  count.textContent = state.catalog.databases.length ? String(state.catalog.databases.length) : "";
  const signature = JSON.stringify({
    connection: state.activeConnectionId ?? "",
    instance: state.catalog.instanceName,
    loading: state.catalog.databasesLoading,
    error: state.catalog.error?.message ?? "",
    names: state.catalog.databases.map((database) => database.name),
  });
  if (signature === dbListSignature && list.childElementCount > 0) {
    for (const item of list.querySelectorAll<HTMLElement>("[data-db]")) {
      item.classList.toggle("active", item.dataset.db === state.catalog.dbName);
    }
    return;
  }
  if (list.querySelector("[data-db]")) {
    dbListScrollTop = list.scrollTop;
  }
  const context = `${state.activeConnectionId ?? ""}\u0000${state.catalog.instanceName || activeTab(state)?.instanceName || ""}`;
  if (context !== dbListContext) {
    dbListContext = context;
    dbListScrollTop = 0;
  }
  dbListSignature = signature;
  list.replaceChildren();
  try {
    if (!state.activeConnectionId) {
      list.append(emptyHint("添加连接后可浏览数据库"));
      return;
    }
    if (state.catalog.databasesLoading) {
      list.append(skeleton(4));
      return;
    }
    if (state.catalog.error) {
      list.append(errorInline(state.catalog.error, () => void refreshCatalog()));
      return;
    }
    if (!state.catalog.instanceName) {
      list.append(emptyHint("选择实例后显示数据库"));
      return;
    }
    if (!state.catalog.databases.length) {
      list.append(emptyHint("没有可访问的数据库"));
      return;
    }
    for (const database of state.catalog.databases) {
      const button = document.createElement("button");
      button.type = "button";
      const displayName = database.displayName ?? database.name;
      button.className = `object-item${database.name === state.catalog.dbName ? " active" : ""}`;
      button.dataset.db = database.name;
      button.title = displayName;
      button.innerHTML = `${icon("database", 14)}<span class="object-name"></span>`;
      const label = button.querySelector<HTMLElement>(".object-name");
      if (label) {
        label.textContent = displayName;
      }
      list.append(button);
    }
  } finally {
    list.scrollTop = dbListScrollTop;
  }
}




function applyTableFilterUi(): void {
  const redis = isRedisInstance();
  const input = document.getElementById("table-filter") as HTMLInputElement | null;
  const regexButton = document.getElementById("table-filter-regex") as HTMLButtonElement | null;
  const historyButton = document.getElementById("table-filter-history-btn") as HTMLButtonElement | null;
  if (regexButton) {
    regexButton.hidden = redis;
  }
  if (historyButton) {
    historyButton.hidden = redis;
  }
  if (redis) {
    closeTableFilterHistory();
    if (input) {
      input.placeholder = "搜索 Key（支持 * ?）";
      input.title = "输入 Key 模式后自动 SCAN；前后 * 未输入时自动补齐";
    }
  } else {
    updateTableFilterModeUi();
  }
}

async function searchRedisKeys(pattern: string): Promise<void> {
  const tab = activeTab(state);
  if (
    !tab?.connectionId ||
    !tab.instanceName ||
    !tab.dbName ||
    !isRedisInstance()
  ) {
    return;
  }
  const connectionId = tab.connectionId;
  const instanceName = tab.instanceName;
  const dbName = tab.dbName;
  const tabId = tab.id;
  const seq = ++redisSearchSeq;
  state.catalog.tablesLoading = true;
  state.catalog.tablesError = undefined;
  renderTableList();
  try {
    const result = await bridge.request<ExecuteQueryData>({
      type: "executeQuery",
      connectionId,
      tabId,
      request: {
        instanceName,
        dbName,
        schemaName: "",
        tableName: "",
        sql: buildRedisScanCommand(normalizeRedisKeyPattern(pattern), 1000),
        limit: 1000,
      },
    });
    if (seq !== redisSearchSeq || activeTab(state)?.id !== tabId) {
      return;
    }
    if (state.catalog.instanceName !== instanceName || state.catalog.dbName !== dbName) {
      return;
    }
    const keys = parseRedisScanRows(result.rows);
    state.catalog.tables = keys.map((name) => ({ name, raw: name }));
    state.catalog.tablesLoading = false;
    state.catalog.tablesError = undefined;
    renderTableList();
  } catch (error) {
    if (seq !== redisSearchSeq || activeTab(state)?.id !== tabId) {
      return;
    }
    state.catalog.tablesLoading = false;
    state.catalog.tablesError = toQueryError(error);
    renderTableList();
  }
}

function updateTableFilterModeUi(): void {
  const input = document.getElementById("table-filter") as HTMLInputElement | null;
  const button = document.getElementById("table-filter-regex") as HTMLButtonElement | null;
  if (input) {
    input.placeholder = tableFilterRegex ? "筛选表名（正则）" : "筛选表名";
    input.title = tableFilterRegex
      ? "正则模式（忽略大小写）；例如 ^order_ 或 ^(user|order)s?$"
      : "输入表名筛选；点击 .* 启用正则，回车或点击表后记录";
  }
  if (button) {
    button.classList.toggle("active", tableFilterRegex);
    button.setAttribute("aria-pressed", String(tableFilterRegex));
    button.title = tableFilterRegex
      ? "当前为正则匹配，点击切换为普通匹配"
      : "当前为普通匹配，点击切换为正则匹配";
  }
  const state = document.getElementById("table-filter-regex-label");
  if (state) {
    state.textContent = tableFilterRegex ? "正则" : "普通";
  }
}

function rememberTableFilter(value: string, regex = tableFilterRegex): void {
  const term = value.trim();
  if (!term) {
    return;
  }
  const entry = regex ? `/${term}/` : term;
  const next = pushRecentTableFilter(state.tableFilterHistory, entry);
  if (next === state.tableFilterHistory) {
    return;
  }
  state.tableFilterHistory = next;
  schedulePersist();
  if (!byId<HTMLElement>("table-filter-history").hidden) {
    renderTableFilterHistory();
  }
}

function renderTableFilterHistory(): void {
  const panel = byId<HTMLElement>("table-filter-history");
  panel.replaceChildren();
  const head = document.createElement("div");
  head.className = "filter-history-head";
  const title = document.createElement("span");
  title.textContent = "最近筛选";
  head.append(title);
  if (state.tableFilterHistory.length) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "filter-history-clear";
    clear.dataset.clearTableHistory = "1";
    clear.textContent = "清空";
    head.append(clear);
  }
  panel.append(head);
  if (!state.tableFilterHistory.length) {
    const empty = document.createElement("div");
    empty.className = "filter-history-empty";
    empty.textContent = "暂无筛选记录";
    panel.append(empty);
    return;
  }
  for (const term of state.tableFilterHistory) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "filter-history-item";
    item.dataset.tableFilterHistory = term;
    item.title = term;
    item.innerHTML = `${icon("history", 12)}<span></span>`;
    const label = item.querySelector<HTMLElement>("span");
    if (label) {
      label.textContent = term;
    }
    panel.append(item);
  }
}

function toggleTableFilterHistory(): void {
  const panel = byId<HTMLElement>("table-filter-history");
  const button = byId<HTMLButtonElement>("table-filter-history-btn");
  if (panel.hidden) {
    renderTableFilterHistory();
    panel.hidden = false;
    button.classList.add("active");
    button.setAttribute("aria-expanded", "true");
  } else {
    closeTableFilterHistory();
  }
}

function closeTableFilterHistory(): void {
  const panel = byId<HTMLElement>("table-filter-history");
  const button = byId<HTMLButtonElement>("table-filter-history-btn");
  panel.hidden = true;
  button.classList.remove("active");
  button.setAttribute("aria-expanded", "false");
}

function renderTableList(): void {
  const list = byId<HTMLElement>("table-list");
  const count = byId<HTMLElement>("table-count");
  const active = activeTab(state);
  const redis = isRedisInstance();
  applyTableFilterUi();
  const sectionLabel = byId<HTMLElement>("table-section-label");
  sectionLabel.textContent = redis ? "Redis Keys" : "数据表";
  const filter = tableFilter.trim();
  const matcher = redis ? undefined : createTableNameMatcher(filter, tableFilterRegex);
  const tables = redis
    ? state.catalog.tables
    : state.catalog.tables.filter((table) => matcher?.test(table.name));
  const filterBox = document.getElementById("table-filter")?.closest(".filter-box");
  filterBox?.classList.toggle("invalid", Boolean(matcher?.error));
  count.textContent = state.catalog.tables.length
    ? redis
      ? String(tables.length)
      : filter
        ? `${tables.length}/${state.catalog.tables.length}`
        : String(state.catalog.tables.length)
    : "";
  const signature = JSON.stringify({
    connection: state.activeConnectionId ?? "",
    instance: state.catalog.instanceName,
    database: state.catalog.dbName,
    schema: state.catalog.schemaName,
    filter,
    regex: tableFilterRegex,
    redis,
    loading: state.catalog.tablesLoading,
    error: state.catalog.tablesError ?? "",
    names: state.catalog.tables.map((table) => table.name),
  });
  if (signature === tableListSignature && list.childElementCount > 0) {
    for (const item of list.querySelectorAll<HTMLElement>("[data-table]")) {
      item.classList.toggle("active", item.dataset.table === active?.tableName);
    }
    return;
  }
  if (list.querySelector("[data-table]")) {
    tableListScrollTop = list.scrollTop;
  }
  const context = [
    state.activeConnectionId ?? "",
    state.catalog.instanceName,
    state.catalog.dbName,
    state.catalog.schemaName,
    filter,
    tableFilterRegex ? "regex" : "literal",
    redis ? "redis" : "sql",
  ].join("\u0000");
  if (context !== tableListContext) {
    tableListContext = context;
    tableListScrollTop = 0;
  }
  tableListSignature = signature;
  list.replaceChildren();
  try {
    if (!state.catalog.dbName) {
      list.append(emptyHint(redis ? "选择 Redis DB 后显示 Key" : "选择数据库后显示数据表"));
      return;
    }
    if (state.catalog.tablesLoading) {
      list.append(skeleton(6));
      return;
    }
    if (state.catalog.tablesError) {
      list.append(errorInline(state.catalog.tablesError, () => void refreshCatalog()));
      return;
    }
    if (!state.catalog.tables.length) {
      list.append(emptyHint(redis ? "该 DB 中没有可见的 Key" : "该库中没有可见的数据表"));
      return;
    }
    if (matcher?.error) {
      list.append(emptyHint(matcher.error));
      return;
    }
    if (!tables.length) {
      list.append(emptyHint(redis ? "没有匹配的 Key" : "没有匹配的表名"));
      return;
    }
    for (const table of tables) {
      const row = document.createElement("div");
      row.className = "table-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = `object-item${table.name === active?.tableName ? " active" : ""}`;
      button.dataset.table = table.name;
      button.title = redis
        ? `${table.name}（单击查询 Key 内容）`
        : `${table.name}（单击立即查询）`;
      button.innerHTML = `${icon(redis ? "key" : "table", 14)}<span class="object-name"></span>`;
      const label = button.querySelector<HTMLElement>(".object-name");
      if (label) {
        label.textContent = table.name;
      }
      row.append(button);
      if (!redis) {
        const structure = document.createElement("button");
        structure.type = "button";
        structure.className = "table-structure-btn";
        structure.dataset.tableStructure = table.name;
        structure.title = `查看 ${table.name} 表结构`;
        structure.setAttribute("aria-label", `查看 ${table.name} 表结构`);
        structure.innerHTML = icon("info", 13);
        row.append(structure);
      }
      list.append(row);
    }
  } finally {
    list.scrollTop = tableListScrollTop;
  }
}


function renderQueryTabs(): void {
  const bar = byId<HTMLElement>("query-tabs");
  bar.replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `query-tab${tab.id === state.activeTabId ? " active" : ""}${tab.status === "running" ? " running" : ""}`;
    item.dataset.tabId = tab.id;
    item.title = tabContextLabel(tab) || tab.title;
    const iconEl = document.createElement("span");
    iconEl.className = "tab-icon";
    iconEl.innerHTML = icon(tab.status === "running" ? "refresh" : "code", 13, tab.status === "running" ? "spin" : "");
    item.append(iconEl);
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = queryTabTitle(tab);
    item.append(label);
    if (tab.status === "running") {
      const spinner = document.createElement("span");
      spinner.className = "running-dot";
      item.append(spinner);
    }
    if (state.tabs.length > 1) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.dataset.closeTab = tab.id;
      close.title = "关闭查询标签";
      close.innerHTML = icon("close", 11);
      item.append(close);
    }
    bar.append(item);
  }
  const add = document.createElement("button");
  add.id = "new-tab";
  add.className = "icon-btn new-tab";
  add.title = "新建查询标签";
  add.innerHTML = icon("plus", 14);
  bar.append(add);
  const activeEl = bar.querySelector<HTMLElement>(".query-tab.active");
  activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderContext(): void {
  const tab = activeTab(state);
  const path = byId<HTMLElement>("context-path");
  path.replaceChildren();
  if (!tab) {
    path.append(emptyHint("没有查询标签"));
  } else {
    const connection = state.connections.find((item) => item.id === tab.connectionId);
    const pieces = [
      connection?.name,
      tab.instanceName,
      tab.dbName,
      tab.schemaName,
      tab.tableName,
    ].filter((value): value is string => Boolean(value));
    if (!pieces.length) {
      path.append(emptyHint("选择连接、实例和数据库"));
    } else {
      pieces.forEach((piece, index) => {
        if (index > 0) {
          const separator = document.createElement("span");
          separator.className = "path-separator";
          separator.textContent = "›";
          path.append(separator);
        }
        const chip = document.createElement("span");
        chip.className = index === pieces.length - 1 ? "path-chip current" : "path-chip";
        chip.textContent = piece;
        path.append(chip);
      });
    }
    if (tab.dbType) {
      const badge = document.createElement("span");
      badge.className = "db-type";
      badge.textContent = tab.dbType;
      path.append(badge);
    }
  }
  const running = tab?.status === "running";
  const limit = byId<HTMLSelectElement>("limit-select");
  if (tab) {
    limit.value = String(tab.limit);
  }
  const hasConnection = Boolean(tab?.connectionId);
  const disabled = !tab || !hasConnection || !tab.instanceName || running;
  byId<HTMLButtonElement>("run-query").disabled = disabled;
  byId<HTMLButtonElement>("explain-query").disabled = disabled;
  byId<HTMLButtonElement>("save-sql").disabled = !tab;
  byId<HTMLButtonElement>("load-sql").disabled = false;
  byId<HTMLButtonElement>("stop-query").hidden = !running;
  byId<HTMLButtonElement>("run-query").classList.toggle("is-running", Boolean(running));
}

function renderResults(): void {
  hideColumnTooltip();
  const tab = activeTab(state);
  const focusId = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  const selectionStart =
    document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  const tabbar = byId<HTMLElement>("result-tabbar");
  for (const button of tabbar.querySelectorAll<HTMLElement>("[data-result-tab]")) {
    button.classList.toggle("active", button.dataset.resultTab === (tab?.resultTab ?? "results"));
  }
  const count = byId<HTMLElement>("result-count");
  count.textContent = tab ? String(resultRowCount(tab)) : "";
  count.hidden = !tab || !tab.result || tab.result.rows.length === 0;
  renderResultActions(tab);
  const body = byId<HTMLElement>("result-body");
  body.replaceChildren();
  if (!tab) {
    body.append(emptyState("code", "还没有查询标签", "点击上方 + 新建一个查询标签。"));
  } else if (tab.resultTab === "history") {
    renderHistoryTab(body, tab);
  } else if (tab.resultTab === "messages") {
    renderMessagesTab(body, tab);
  } else {
    renderResultTab(body, tab);
  }
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next instanceof HTMLInputElement) {
      next.focus();
      if (selectionStart !== null) {
        next.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }
}

function renderResultActions(tab?: TabState): void {
  const actions = byId<HTMLElement>("result-actions");
  actions.replaceChildren();
  if (!tab?.result) {
    return;
  }
  const selectedCount = tab.selectedRows.size;
  const changedRows = new Set([...tab.cellEdits.values()].map((edit) => edit.row)).size;
  if (!supportsInsertMode(tab.dbType, tab.insertMode)) {
    tab.insertMode = "insert";
  }
  actions.append(actionButton("copy", "复制结果", "copy", "复制为 TSV"));
  if (changedRows > 0) {
    actions.append(
      actionButton(
        "copy-updates",
        `复制 UPDATE (${changedRows})`,
        "save",
        `复制 ${changedRows} 行未执行的 UPDATE 语句`,
      ),
    );
  }
  if (selectedCount > 0) {
    actions.append(actionButton("clear-selection", "清除选择", "close", "清除所有已选行"));
  }
  const menu = document.createElement("div");
  menu.className = "result-menu";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "text-btn small result-menu-toggle";
  toggle.dataset.resultMenu = "result-actions";
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "更多结果操作";
  toggle.innerHTML = `${icon("more", 14)}<span>更多操作</span>${icon("chevron-down", 11)}`;
  menu.append(toggle);

  const panel = document.createElement("div");
  panel.className = "result-menu-panel";
  panel.dataset.menuPanel = "result-actions";
  panel.hidden = true;
  panel.setAttribute("role", "menu");

  const sqlTitle = document.createElement("div");
  sqlTitle.className = "result-menu-title";
  sqlTitle.textContent = selectedCount
    ? `复制选中行 SQL (${selectedCount})`
    : "复制选中行 SQL（先勾选行）";
  panel.append(sqlTitle);

  for (const mode of ["insert", "replace", "ignore"] as InsertMode[]) {
    const supported = supportsInsertMode(tab.dbType, mode);
    const item = resultMenuItem(
      "copy-selected-insert",
      insertModeLabel(mode),
      mode === "replace" ? "refresh" : mode === "ignore" ? "plus" : "copy",
    );
    item.dataset.insertMode = mode;
    item.disabled = selectedCount === 0 || !supported;
    if (!supported) {
      item.title = "覆盖/忽略插入仅支持 MySQL/MariaDB";
    } else if (selectedCount === 0) {
      item.title = "先在结果左侧勾选要复制的行";
    } else {
      item.title = `复制已选 ${selectedCount} 行为${insertModeLabel(mode)} SQL`;
    }
    if (tab.insertMode === mode) {
      const current = document.createElement("span");
      current.className = "result-menu-current";
      current.textContent = "当前";
      item.append(current);
    }
    panel.append(item);
  }

  const separator = document.createElement("div");
  separator.className = "result-menu-separator";
  panel.append(separator);

  const deleteItem = resultMenuItem(
    "copy-selected-delete",
    "复制 DELETE",
    "trash",
  );
  deleteItem.disabled = selectedCount === 0;
  deleteItem.title = selectedCount
    ? `复制已选 ${selectedCount} 行的 DELETE SQL`
    : "先在结果左侧勾选要复制的行";
  panel.append(deleteItem);

  const exportSeparator = document.createElement("div");
  exportSeparator.className = "result-menu-separator";
  panel.append(exportSeparator);
  const exportTitle = document.createElement("div");
  exportTitle.className = "result-menu-title";
  exportTitle.textContent = "导出当前结果";
  panel.append(exportTitle);
  panel.append(resultMenuItem("export-csv", "导出 CSV", "download"));
  panel.append(resultMenuItem("export-json", "导出 JSON", "download"));
  panel.append(resultMenuItem("export-sql", "导出 SQL（INSERT）", "download"));

  menu.append(panel);
  actions.append(menu);
}

function resultMenuItem(action: string, label: string, iconName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-menu-item";
  button.dataset.action = action;
  button.setAttribute("role", "menuitem");
  button.innerHTML = `${icon(iconName, 13)}<span></span>`;
  const text = button.querySelector<HTMLElement>("span");
  if (text) {
    text.textContent = label;
  }
  return button;
}

function closeResultMenus(): void {
  for (const panel of document.querySelectorAll<HTMLElement>("[data-menu-panel]")) {
    panel.hidden = true;
  }
  for (const toggle of document.querySelectorAll<HTMLElement>("[data-result-menu]")) {
    toggle.setAttribute("aria-expanded", "false");
  }
}

function toggleResultMenu(id: string): void {
  const panel = document.querySelector<HTMLElement>(`[data-menu-panel="${id}"]`);
  const toggle = document.querySelector<HTMLElement>(`[data-result-menu="${id}"]`);
  if (!panel || !toggle) {
    return;
  }
  const open = panel.hidden;
  closeResultMenus();
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

function renderResultTab(body: HTMLElement, tab: TabState): void {
  if (tab.status === "running" && !tab.result) {
    body.append(loadingState(`正在通过 Archery 执行${tab.limit ? `，每页最多加载 ${tab.limit} 行` : ""}…`));
    return;
  }
  if (tab.error) {
    body.append(errorCard(tab.error));
    if (tab.executedSql) {
      body.append(sqlBlock("已执行的 SQL", tab.executedSql));
    }
    return;
  }
  if (!tab.result) {
    body.append(
      emptyState(
        "play",
        "准备执行查询",
        tab.instanceName
          ? "按 Ctrl/⌘ + Enter 执行全部 SQL；选中一段 SQL 时只执行选中部分。"
          : "先从左侧选择实例和数据库，然后编写 SQL。",
      ),
    );
    return;
  }
  const result = tab.result;
  const fieldNeedle = tab.columnFilter.trim().toLowerCase();
  const shownColumns = result.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !fieldNeedle || name.toLowerCase().includes(fieldNeedle));
  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.append(metaItem(`已加载 ${formatNumber(result.rows.length)} 行`));
  if (tab.elapsedMs !== undefined) {
    meta.append(metaItem(`总耗时 ${formatDuration(tab.elapsedMs)}`));
  }
  if (result.queryTime !== undefined) {
    meta.append(metaItem(`服务端 ${formatDuration(result.queryTime * 1000)}`));
  }
  if (result.affectedRows !== undefined && result.rows.length === 0) {
    meta.append(metaItem(`影响 ${formatNumber(result.affectedRows)} 行`));
  }
  if (result.secondsBehindMaster !== undefined && result.secondsBehindMaster > 0) {
    meta.append(metaItem(`主从延迟 ${result.secondsBehindMaster}s`, "warn"));
  }
  body.append(meta);

  const filterBar = document.createElement("div");
  filterBar.className = "grid-filter-bar";
  const searchIcon = document.createElement("span");
  searchIcon.innerHTML = icon("search", 13);
  filterBar.append(searchIcon);
  const filterInput = document.createElement("input");
  filterInput.id = "result-filter";
  filterInput.type = "text";
  filterInput.placeholder = "在结果中筛选…";
  filterInput.title = "筛选结果行（包含隐藏列中的内容）";
  filterInput.value = tab.filter;
  filterInput.spellcheck = false;
  filterInput.addEventListener("input", () => {
    window.clearTimeout(resultFilterTimer);
    tab.filter = filterInput.value;
    tab.page = 0;
    resultFilterTimer = window.setTimeout(() => renderResults(), 160);
  });
  filterBar.append(filterInput);
  const fieldDivider = document.createElement("span");
  fieldDivider.className = "grid-filter-divider";
  filterBar.append(fieldDivider);
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "column-field-filter";
  const fieldIcon = document.createElement("span");
  fieldIcon.innerHTML = icon("search", 13);
  const fieldInput = document.createElement("input");
  fieldInput.id = "column-filter";
  fieldInput.type = "text";
  fieldInput.placeholder = "定位字段名…";
  fieldInput.title = "按字段名筛选显示列，按 Esc 清除";
  fieldInput.value = tab.columnFilter;
  fieldInput.spellcheck = false;
  fieldInput.addEventListener("input", () => {
    tab.columnFilter = fieldInput.value;
    renderResults();
  });
  fieldInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tab.columnFilter) {
      event.preventDefault();
      tab.columnFilter = "";
      renderResults();
    }
  });
  fieldWrap.append(fieldIcon, fieldInput);
  if (tab.columnFilter) {
    const clearField = document.createElement("button");
    clearField.type = "button";
    clearField.className = "clear-filter";
    clearField.title = "清除字段筛选";
    clearField.innerHTML = icon("x", 12);
    clearField.addEventListener("click", () => {
      tab.columnFilter = "";
      renderResults();
    });
    fieldWrap.append(clearField);
  }
  filterBar.append(fieldWrap);
  const hint = document.createElement("span");
  hint.className = "grid-filter-hint";
  hint.textContent = tab.columnFilter
    ? `字段显示 ${shownColumns.length}/${result.columns.length}，导出仍包含全部字段`
    : tab.filter
      ? "正在筛选全部已加载行"
      : "拖动行可框选；筛选只影响当前展示，不影响导出";
  filterBar.append(hint);
  body.append(filterBar);

  if (!shownColumns.length) {
    body.append(
      emptyState(
        "search",
        "没有匹配的字段",
        `没有找到名称包含“${tab.columnFilter.trim()}”的字段，按 Esc 可清除字段筛选。`,
      ),
    );
    return;
  }

  const visible = visibleRows(tab);
  if (!visible.rows.length) {
    body.append(emptyState("filter", "没有匹配的数据", tab.filter ? "请调整结果筛选条件。" : "查询返回了 0 行。"));
    return;
  }
  const gridWrap = document.createElement("div");
  gridWrap.className = "grid-wrap";
  const table = document.createElement("table");
  table.className = fieldNeedle ? "grid column-filtered" : "grid";
  const colgroup = document.createElement("colgroup");
  const indexCol = document.createElement("col");
  indexCol.style.width = "64px";
  colgroup.append(indexCol);
  shownColumns.forEach(({ name, index }) => {
    const col = document.createElement("col");
    col.style.width = `${columnWidth(name, index, result, visible.indices)}px`;
    colgroup.append(col);
  });
  if (!fieldNeedle) {
    const filler = document.createElement("col");
    filler.className = "filler-col";
    colgroup.append(filler);
  }
  table.append(colgroup);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const indexHeader = document.createElement("th");
  indexHeader.className = "row-number";
  indexHeader.title = "选择本页所有行";
  const indexHeadInner = document.createElement("div");
  indexHeadInner.className = "row-number-inner";
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.className = "row-select-box";
  selectAll.id = "select-page-rows";
  const pageIndices = visible.rows.map((entry) => entry.originalIndex);
  const selectedOnPage = pageIndices.filter((index) => tab.selectedRows.has(index)).length;
  selectAll.checked = pageIndices.length > 0 && selectedOnPage === pageIndices.length;
  selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIndices.length;
  selectAll.setAttribute("aria-label", "选择本页所有行");
  selectAll.addEventListener("change", () => {
    for (const index of pageIndices) {
      if (selectAll.checked) {
        tab.selectedRows.add(index);
      } else {
        tab.selectedRows.delete(index);
      }
    }
    updateSelectionUi(tab);
  });
  const hash = document.createElement("span");
  hash.className = "row-index";
  hash.textContent = "#";
  indexHeadInner.append(selectAll, hash);
  indexHeader.append(indexHeadInner);
  headerRow.append(indexHeader);
  shownColumns.forEach(({ name: column, index }) => {
    const th = document.createElement("th");
    const head = document.createElement("div");
    head.className = "column-head";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "column-sort";
    button.dataset.sortColumn = String(index);
    button.dataset.columnTooltip = column;
    button.dataset.columnComment = findColumnComment(tab.columnComments, column);
    button.dataset.columnLoading =
      tab.columnComments === undefined && Boolean(tab.tableName) ? "1" : "0";
    button.dataset.columnTable = tab.tableName || "";
    button.setAttribute("aria-label", `${column}：点击切换排序状态（正序 / 倒序 / 取消）`);
    const label = document.createElement("span");
    label.textContent = column;
    button.append(label);
    if (tab.sort?.column === index) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.innerHTML = icon(tab.sort.direction === 1 ? "arrow-up" : "arrow-down", 11);
      button.append(arrow);
    }
    if (fieldNeedle) {
      th.classList.add("column-search-match");
    }
    head.append(button);
    th.append(head);
    headerRow.append(th);
  });
  if (!fieldNeedle) {
    const filler = document.createElement("th");
    filler.className = "filler-col";
    headerRow.append(filler);
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const entry of visible.rows) {
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = String(entry.originalIndex);
    if (tab.selectedRows.has(entry.originalIndex)) {
      tr.classList.add("row-selected");
    }
    const rowNumber = document.createElement("td");
    rowNumber.className = "row-number";
    const rowNumberInner = document.createElement("div");
    rowNumberInner.className = "row-number-inner";
    const rowCheckbox = document.createElement("input");
    rowCheckbox.type = "checkbox";
    rowCheckbox.className = "row-select-box";
    rowCheckbox.dataset.rowSelect = String(entry.originalIndex);
    rowCheckbox.checked = tab.selectedRows.has(entry.originalIndex);
    rowCheckbox.setAttribute("aria-label", `选择第 ${entry.originalIndex + 1} 行`);
    rowCheckbox.addEventListener("change", () => {
      if (rowCheckbox.checked) {
        tab.selectedRows.add(entry.originalIndex);
      } else {
        tab.selectedRows.delete(entry.originalIndex);
      }
      updateSelectionUi(tab);
    });
    const rowIndex = document.createElement("span");
    rowIndex.className = "row-index";
    rowIndex.textContent = String(entry.originalIndex + 1);
    rowNumberInner.append(rowCheckbox, rowIndex);
    rowNumber.append(rowNumberInner);
    tr.append(rowNumber);
    shownColumns.forEach(({ index: columnIndex }) => {
      const cell = document.createElement("td");
      const value = entry.row[columnIndex];
      setCellContent(cell as HTMLTableCellElement, value);
      cell.dataset.cellRow = String(entry.originalIndex);
      cell.dataset.cellCol = String(columnIndex);
      if (tab.cellEdits.has(cellEditKey(entry.originalIndex, columnIndex))) {
        cell.classList.add("cell-modified");
      }
      if (value === null || value === undefined) {
        cell.classList.add("null");
      }
      tr.append(cell);
    });
    if (!fieldNeedle) {
      const filler = document.createElement("td");
      filler.className = "filler-col";
      tr.append(filler);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  gridWrap.append(table);
  body.append(gridWrap);

  const footer = document.createElement("div");
  footer.className = "grid-footer";
  const loadedTotal = result.rows.length;
  const total = visible.total;
  const pageCount = Math.max(1, Math.ceil(total / tab.pageSize));
  const page = Math.min(Math.max(0, tab.page), pageCount - 1);
  const from = total === 0 ? 0 : page * tab.pageSize + 1;
  const to = Math.min(total, (page + 1) * tab.pageSize);
  const canLoadMore = tab.hasMoreRows && !tab.filter && !tab.pageLoading;
  const info = document.createElement("span");
  info.className = "pager-info";
  const moreHint = tab.hasMoreRows
    ? tab.filter
      ? "，清除筛选后可继续加载"
      : "，还有更多"
    : "";
  info.textContent = `第 ${from}–${to} 行 · 已加载 ${formatNumber(loadedTotal)} 行${moreHint}${tab.filter ? "（已筛选）" : ""}`;
  footer.append(info);
  const pager = document.createElement("div");
  pager.className = "pager";
  const prev = pagerButton("上一页", page - 1, page <= 0 || tab.pageLoading);
  pager.append(prev);
  const pageLabel = document.createElement("span");
  pageLabel.className = "page-label";
  if (tab.pageLoading) {
    pageLabel.textContent = "加载中…";
  } else if (tab.hasMoreRows && !tab.filter) {
    pageLabel.textContent = `第 ${page + 1} 页`;
  } else {
    pageLabel.textContent = `${page + 1} / ${pageCount}`;
  }
  pager.append(pageLabel);
  const next = pagerButton("下一页", page + 1, tab.pageLoading || (page >= pageCount - 1 && !canLoadMore));
  next.title = canLoadMore ? "从数据库加载下一页" : "";
  pager.append(next);
  const sizeWrap = document.createElement("label");
  sizeWrap.className = "page-size";
  sizeWrap.append(document.createTextNode("每页"));
  const sizeSelect = document.createElement("select");
  sizeSelect.className = "mini-select";
  for (const size of [50, 100, 200, 500, 1000, 5000]) {
    sizeSelect.append(option(String(size), String(size)));
  }
  sizeSelect.value = String(tab.pageSize);
  sizeSelect.disabled = tab.pageLoading;
  sizeSelect.addEventListener("change", () => {
    changeResultPageSize(Number(sizeSelect.value));
  });
  sizeWrap.append(sizeSelect);
  pager.append(sizeWrap);
  footer.append(pager);
  body.append(footer);
}

function renderMessagesTab(body: HTMLElement, tab: TabState): void {
  if (!tab.executedSql && !tab.error && !tab.result && !tab.describeStatement) {
    body.append(emptyState("terminal", "暂无消息", "执行查询后，这里会显示耗时、影响行数、实际执行 SQL 等信息。"));
    return;
  }
  if (tab.status === "running") {
    body.append(loadingState("正在执行，请稍候…"));
  }
  if (tab.error) {
    body.append(errorCard(tab.error));
  }
  if (tab.result) {
    const details = document.createElement("div");
    details.className = "message-grid";
    details.append(messageRow("状态", "执行成功"));
    details.append(messageRow("返回行数", formatNumber(tab.result.rows.length)));
    if (tab.elapsedMs !== undefined) {
      details.append(messageRow("总耗时", formatDuration(tab.elapsedMs)));
    }
    if (tab.result.queryTime !== undefined) {
      details.append(messageRow("服务端耗时", formatDuration(tab.result.queryTime * 1000)));
    }
    if (tab.result.maskTime !== undefined) {
      details.append(messageRow("脱敏耗时", formatDuration(tab.result.maskTime * 1000)));
    }
    if (tab.result.affectedRows !== undefined) {
      details.append(messageRow("影响行数", formatNumber(tab.result.affectedRows)));
    }
    if (tab.result.secondsBehindMaster !== undefined) {
      details.append(messageRow("主从延迟", `${tab.result.secondsBehindMaster} 秒`));
    }
    body.append(details);
  }
  if (tab.describeStatement) {
    body.append(sqlBlock("DDL", tab.describeStatement));
  }
  if (tab.executedSql) {
    body.append(sqlBlock("已执行的 SQL", tab.executedSql, tab.result?.fullSql));
  }
  if (tab.result?.message) {
    const notice = document.createElement("div");
    notice.className = "message-note";
    notice.textContent = tab.result.message;
    body.append(notice);
  }
}

function renderHistoryTab(body: HTMLElement, tab: TabState): void {
  const connectionId = tab.connectionId ?? state.activeConnectionId;
  if (!connectionId) {
    body.append(emptyState("history", "尚未选择连接", "选择 Archery 连接后可以查看服务端查询历史。"));
    return;
  }
  if (state.history.connectionId !== connectionId) {
    state.history = { ...emptyHistory(), connectionId };
    void loadHistoryIfNeeded(false);
  }
  const toolbar = document.createElement("div");
  toolbar.className = "history-toolbar";
  const search = document.createElement("div");
  search.className = "filter-box history-search";
  search.innerHTML = icon("search", 13);
  const input = document.createElement("input");
  input.id = "history-search";
  input.type = "text";
  input.placeholder = "搜索 SQL、别名或用户…";
  input.value = state.history.search;
  input.spellcheck = false;
  input.addEventListener("input", () => {
    window.clearTimeout(historyFilterTimer);
    state.history.search = input.value;
    state.history.loaded = false;
    historyFilterTimer = window.setTimeout(() => void loadHistory(true), 350);
  });
  search.append(input);
  toolbar.append(search);
  const refresh = document.createElement("button");
  refresh.className = "secondary-btn";
  refresh.dataset.historyRefresh = "1";
  refresh.innerHTML = `${icon("refresh", 13)}<span>刷新</span>`;
  toolbar.append(refresh);
  const total = document.createElement("span");
  total.className = "history-total";
  total.textContent = state.history.loaded ? `${formatNumber(state.history.total)} 条` : "";
  toolbar.append(total);
  body.append(toolbar);

  if (state.history.loading && !state.history.entries.length) {
    body.append(loadingState("正在加载 Archery 查询历史…"));
    return;
  }
  if (state.history.error) {
    body.append(errorCard(state.history.error));
    return;
  }
  if (!state.history.entries.length) {
    body.append(emptyState("history", "暂无查询历史", "在 Archery 中执行过查询后，历史会出现在这里。"));
    return;
  }
  const list = document.createElement("div");
  list.className = "history-list";
  for (const entry of state.history.entries) {
    list.append(historyCard(entry));
  }
  body.append(list);
}

function historyCard(entry: QueryLogEntry): HTMLElement {
  const card = document.createElement("article");
  card.className = "history-card";
  const head = document.createElement("div");
  head.className = "history-card-head";
  const title = document.createElement("div");
  title.className = "history-title";
  title.textContent = entry.alias || `查询 #${entry.id}`;
  head.append(title);
  const time = document.createElement("span");
  time.className = "history-time";
  time.textContent = entry.createTime || "";
  head.append(time);
  card.append(head);
  const meta = document.createElement("div");
  meta.className = "history-meta";
  meta.append(metaItem(entry.instanceName || "未知实例"));
  if (entry.dbName) {
    meta.append(metaItem(entry.dbName));
  }
  if (entry.costTime !== undefined) {
    meta.append(metaItem(formatDuration(entry.costTime * 1000)));
  }
  if (entry.effectRow !== undefined) {
    meta.append(metaItem(`${formatNumber(entry.effectRow)} 行`));
  }
  if (entry.userDisplay) {
    meta.append(metaItem(entry.userDisplay));
  }
  card.append(meta);
  const pre = document.createElement("pre");
  pre.className = "history-sql";
  pre.textContent = truncate(entry.sql, 500);
  card.append(pre);
  const actions = document.createElement("div");
  actions.className = "history-actions";
  const load = document.createElement("button");
  load.className = "secondary-btn small";
  load.dataset.historyLoad = String(entry.id);
  load.innerHTML = `${icon("file-plus", 13)}<span>载入到新标签</span>`;
  actions.append(load);
  const copy = document.createElement("button");
  copy.className = "text-btn small";
  copy.innerHTML = `${icon("copy", 13)}<span>复制 SQL</span>`;
  copy.addEventListener("click", () => {
    void bridge
      .request({ type: "copyText", text: entry.sql })
      .then(() => toast("SQL 已复制", "info"))
      .catch((error: unknown) => toast(messageOf(error), "error"));
  });
  actions.append(copy);
  card.append(actions);
  return card;
}

async function syncCatalog(tab: TabState, force: boolean): Promise<void> {
  const connectionId = tab.connectionId ?? state.activeConnectionId;
  if (!connectionId) {
    state.catalog = emptyCatalog();
    renderInstanceSelect();
    renderSchemaSelect();
    renderDbList();
    renderTableList();
    renderContext();
    return;
  }
  state.activeConnectionId = connectionId;
  tab.connectionId = connectionId;
  if (!force && catalogMatches(tab)) {
    updateCompletions(tab);
    if (tab.tableName) {
      void loadColumns(tab);
    }
    renderInstanceSelect();
    renderSchemaSelect();
    renderDbList();
    renderTableList();
    renderContext();
    return;
  }
  const seq = ++catalogSeq;
  const previousDb = state.catalog.dbName;
  state.catalog = { ...emptyCatalog(), instancesLoading: true };
  renderInstanceSelect();
  renderSchemaSelect();
  renderDbList();
  renderTableList();
  renderContext();

  let instances: ArcheryInstance[];
  try {
    const data = await bridge.request<ListInstancesData>({
      type: "listInstances",
      connectionId,
      force,
    });
    instances = data.instances;
  } catch (error) {
    if (seq !== catalogSeq) {
      return;
    }
    state.catalog.instancesLoading = false;
    state.catalog.error = toQueryError(error);
    renderAllSidebar();
    return;
  }
  if (seq !== catalogSeq) {
    return;
  }
  state.catalog.instances = instances;
  state.catalog.instancesLoading = false;
  if (!instances.length) {
    clearTabCatalog(tab);
    renderAllSidebar();
    return;
  }
  const instance =
    instances.find((item) => item.instance_name === tab.instanceName) ?? instances[0];
  tab.instanceName = instance.instance_name;
  tab.dbType = instance.db_type;
  state.catalog.instanceName = instance.instance_name;
  renderAllSidebar();

  state.catalog.databasesLoading = true;
  renderAllSidebar();
  let databases: ResourceItem[];
  try {
    const data = await bridge.request<ListResourcesData>({
      type: "listResources",
      connectionId,
      instanceName: instance.instance_name,
      resourceType: "database",
      force,
    });
    databases = data.items;
  } catch (error) {
    if (seq !== catalogSeq) {
      return;
    }
    state.catalog.databasesLoading = false;
    state.catalog.error = toQueryError(error);
    renderAllSidebar();
    return;
  }
  if (seq !== catalogSeq) {
    return;
  }
  state.catalog.databases = databases;
  state.catalog.databasesLoading = false;
  if (!databases.length) {
    tab.dbName = "";
    tab.schemaName = "";
    tab.tableName = "";
    renderAllSidebar();
    return;
  }
  const database = databases.find((item) => item.name === tab.dbName) ?? databases[0];
  if (previousDb !== database.name) {
    resetTableFilter();
  }
  tab.dbName = database.name;
  state.catalog.dbName = database.name;
  renderAllSidebar();

  let schemaName = "";
  if (isSchemaDbType(instance.db_type)) {
    state.catalog.schemasLoading = true;
    renderAllSidebar();
    let schemas: ResourceItem[] = [];
    try {
      const data = await bridge.request<ListResourcesData>({
        type: "listResources",
        connectionId,
        instanceName: instance.instance_name,
        resourceType: "schema",
        dbName: database.name,
        force,
      });
      schemas = data.items;
    } catch {
      schemas = [];
    }
    if (seq !== catalogSeq) {
      return;
    }
    state.catalog.schemas = schemas;
    state.catalog.schemasLoading = false;
    if (schemas.length) {
      const previousSchema = schemas.find((item) => item.name === tab.schemaName);
      schemaName = (previousSchema ?? schemas[0]).name;
    }
  }
  tab.schemaName = schemaName;
  state.catalog.schemaName = schemaName;
  renderAllSidebar();

  state.catalog.tablesLoading = true;
  renderAllSidebar();
  try {
    const data = await bridge.request<ListResourcesData>({
      type: "listResources",
      connectionId,
      instanceName: instance.instance_name,
      resourceType: "table",
      dbName: database.name,
      schemaName,
      force,
    });
    if (seq !== catalogSeq) {
      return;
    }
    state.catalog.tables = data.items;
    state.catalog.tablesLoading = false;
    if (tab.tableName && !data.items.some((item) => item.name === tab.tableName)) {
      tab.tableName = "";
    }
  } catch (error) {
    if (seq !== catalogSeq) {
      return;
    }
    state.catalog.tablesLoading = false;
    state.catalog.tablesError = toQueryError(error);
  }
  renderAllSidebar();
  updateCompletions(tab);
  if (tab.tableName) {
    void loadColumns(tab);
  }
  schedulePersist();
}

function catalogMatches(tab: TabState): boolean {
  if (!state.catalog.instances.length) {
    return false;
  }
  if (state.catalog.instanceName !== tab.instanceName) {
    return false;
  }
  if (state.catalog.dbName !== tab.dbName) {
    return false;
  }
  if (isSchemaDbType(tab.dbType) && state.catalog.schemaName !== tab.schemaName) {
    return false;
  }
  return state.catalog.tables.length > 0 || tab.dbName === "";
}

function renderAllSidebar(): void {
  renderInstanceSelect();
  renderSchemaSelect();
  renderDbList();
  renderTableList();
  renderContext();
}

async function changeConnection(connectionId: string | undefined): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  state.activeConnectionId = connectionId;
  tab.connectionId = connectionId;
  tab.instanceName = "";
  tab.dbName = "";
  tab.schemaName = "";
  tab.tableName = "";
  tab.dbType = "";
  resetTabQueryState(tab);
  state.history = emptyHistory();
  state.catalog = emptyCatalog();
  resetTableFilter();
  renderAll();
  schedulePersist();
  if (connectionId) {
    await syncCatalog(tab, false);
  }
}

async function changeInstance(instanceName: string): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  tab.instanceName = instanceName;
  tab.dbName = "";
  tab.schemaName = "";
  tab.tableName = "";
  tab.dbType = state.catalog.instances.find((item) => item.instance_name === instanceName)?.db_type ?? "";
  resetTabQueryState(tab);
  resetTableFilter();
  renderAllSidebar();
  schedulePersist();
  await syncCatalog(tab, false);
}

async function changeDatabase(dbName: string): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  if (state.catalog.dbName === dbName) {
    return;
  }
  tab.dbName = dbName;
  tab.schemaName = "";
  tab.tableName = "";
  resetTabQueryState(tab);
  resetTableFilter();
  renderAllSidebar();
  schedulePersist();
  await syncCatalog(tab, false);
}

async function changeSchema(schemaName: string): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  tab.schemaName = schemaName;
  tab.tableName = "";
  resetTabQueryState(tab);
  renderAllSidebar();
  schedulePersist();
  await syncCatalog(tab, false);
}

interface QueryTabContext {
  connectionId: string;
  instanceName: string;
  dbName: string;
  schemaName: string;
  dbType: string;
  tableName: string;
  sql: string;
  title: string;
}

function prepareQueryTab(context: QueryTabContext): TabState {
  const current = activeTab(state);
  const reusable =
    current &&
    current.status === "idle" &&
    !current.sql.trim() &&
    !current.result &&
    !current.executedSql;
  let tab: TabState;
  if (reusable) {
    tab = current;
  } else {
    tab = createTab(state, {
      connectionId: context.connectionId,
      instanceName: context.instanceName,
      dbName: context.dbName,
      schemaName: context.schemaName,
      tableName: context.tableName,
      dbType: context.dbType,
      sql: context.sql,
      title: context.title,
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(tab);
  }
  tab.connectionId = context.connectionId;
  tab.instanceName = context.instanceName;
  tab.dbName = context.dbName;
  tab.schemaName = context.schemaName;
  tab.tableName = context.tableName;
  tab.dbType = context.dbType;
  tab.sql = context.sql;
  tab.title = context.title;
  tab.status = "idle";
  tab.error = undefined;
  tab.result = undefined;
  tab.executedSql = undefined;
  tab.columnComments = undefined;
  tab.tableStructure = undefined;
  tab.describeStatement = undefined;
  tab.selectedRows.clear();
  tab.cellEdits.clear();
  tab.hasMoreRows = false;
  tab.pageLoading = false;
  tab.resultTab = "results";
  tab.page = 0;
  tab.filter = "";
  tab.columnFilter = "";
  tab.sort = undefined;
  state.activeTabId = tab.id;
  editor.setValue(context.sql);
  renderAll();
  schedulePersist();
  return tab;
}

function queryTable(tableName: string): void {
  if (!isRedisInstance()) {
    rememberTableFilter(tableFilter);
  }
  closeTableFilterHistory();
  const instance = selectedInstance();
  const instanceName = state.catalog.instanceName;
  if (!state.activeConnectionId || !instanceName || !state.catalog.dbName) {
    toast("请先选择实例和数据库", "warning");
    return;
  }
  const schemaName = state.catalog.schemaName;
  const dbName = state.catalog.dbName;
  const dbType = instance?.db_type ?? activeTab(state)?.dbType ?? "";
  if (isRedisDbType(dbType)) {
    void openRedisKey(tableName, {
      connectionId: state.activeConnectionId,
      instanceName,
      dbName,
      schemaName,
      dbType,
    });
    return;
  }
  const sql = buildSelect({ dbType, dbName, schemaName, tableName });
  const tab = prepareQueryTab({
    connectionId: state.activeConnectionId,
    instanceName,
    dbName,
    schemaName,
    dbType,
    tableName,
    sql,
    title: tableName,
  });
  void loadColumns(tab);
  void executeQuery(false, { sqlOverride: sql });
}

let redisKeySeq = 0;

async function openRedisKey(
  key: string,
  context: Omit<QueryTabContext, "tableName" | "sql" | "title">,
): Promise<void> {
  const seq = ++redisKeySeq;
  toast(`正在读取 Key 类型：${key}`, "info", 1200);
  let type: string;
  try {
    const result = await bridge.request<ExecuteQueryData>({
      type: "executeQuery",
      connectionId: context.connectionId,
      tabId: activeTab(state)?.id ?? "redis-key-type",
      request: {
        instanceName: context.instanceName,
        dbName: context.dbName,
        schemaName: context.schemaName,
        tableName: "",
        sql: buildRedisTypeCommand(key),
        limit: 1,
      },
    });
    if (seq !== redisKeySeq) {
      return;
    }
    type = parseRedisKeyType(result.rows, result.message);
  } catch (error) {
    if (seq === redisKeySeq) {
      toast(errorText(error), "error");
    }
    return;
  }
  if (!type || type === "none") {
    toast(`Key 不存在或已过期：${key}`, "warning");
    return;
  }
  const command = buildRedisDataCommand(key, type);
  if (!command) {
    toast(`暂不支持自动查询 ${type} 类型的 Key`, "warning");
    return;
  }
  toast(`Key 类型：${type}`, "info", 1200);
  prepareQueryTab({
    ...context,
    tableName: key,
    sql: command,
    title: `${key} · ${type}`,
  });
  void executeQuery(false, { sqlOverride: command });
}

async function loadColumns(tab: TabState): Promise<void> {
  if (!tab.connectionId || !tab.instanceName || !tab.dbName || !tab.tableName) {
    return;
  }
  const key = [
    tab.connectionId,
    tab.instanceName,
    tab.dbName,
    tab.schemaName,
    tab.tableName,
  ].join("\u0000");
  const seq = ++columnsSeq;
  let items = columnCache.get(key);
  if (!items) {
    try {
      const data = await bridge.request<ListResourcesData>({
        type: "listResources",
        connectionId: tab.connectionId,
        instanceName: tab.instanceName,
        resourceType: "column",
        dbName: tab.dbName,
        schemaName: tab.schemaName,
        tableName: tab.tableName,
      });
      items = data.items;
      columnCache.set(key, items);
    } catch {
      return;
    }
  }
  if (seq !== columnsSeq) {
    return;
  }
  const current = activeTab(state);
  if (!current || current.tableName !== tab.tableName || current.dbName !== tab.dbName) {
    return;
  }
  updateCompletions(current, items);
}

function updateCompletions(tab: TabState, columns?: ResourceItem[]): void {
  const tables = state.catalog.tables.map((table) => ({
    name: table.name,
    detail: tab.dbName,
  }));
  const columnItems = (columns ?? columnCache.get(
    [tab.connectionId, tab.instanceName, tab.dbName, tab.schemaName, tab.tableName].join("\u0000"),
  ) ?? []).map((item) => ({
    name: columnName(item),
    table: tab.tableName,
  }));
  editor.setCompletions(tables, columnItems);
}


interface TableMetadataRef {
  connectionId: string;
  instanceName: string;
  dbName: string;
  schemaName: string;
  tableName: string;
  dbType: string;
}

function tableMetadataKey(tab: TabState): string | undefined {
  if (!tab.connectionId || !tab.instanceName || !tab.dbName || !tab.tableName) {
    return undefined;
  }
  return [
    tab.connectionId,
    tab.instanceName,
    tab.dbName,
    tab.schemaName,
    tab.tableName,
  ].join("\u0000");
}

function tableMetadataRef(tab: TabState): TableMetadataRef | undefined {
  if (!tab.connectionId || !tab.instanceName || !tab.dbName || !tab.tableName) {
    return undefined;
  }
  return {
    connectionId: tab.connectionId,
    instanceName: tab.instanceName,
    dbName: tab.dbName,
    schemaName: tab.schemaName,
    tableName: tab.tableName,
    dbType: tab.dbType,
  };
}

async function loadTableMetadataFor(
  ref: TableMetadataRef,
  tabId: string,
): Promise<TableMetadataEntry | undefined> {
  const key = [
    ref.connectionId,
    ref.instanceName,
    ref.dbName,
    ref.schemaName,
    ref.tableName,
  ].join("\u0000");
  const cached = tableMetadataCache.get(key);
  if (cached) {
    return cached;
  }
  let pending = tableMetadataPending.get(key);
  if (!pending) {
    pending = bridge
      .request<{ result: QueryExecutionResult; statement?: string }>({
        type: "describeTable",
        connectionId: ref.connectionId,
        instanceName: ref.instanceName,
        dbName: ref.dbName,
        schemaName: ref.schemaName,
        tableName: ref.tableName,
        tabId,
      })
      .then((description) => ({
        comments: extractColumnComments(
          description.result.columns,
          description.result.rows,
          description.statement,
          ref.dbType,
        ),
        structure: {
          columns: description.result.columns,
          rows: description.result.rows,
          statement: description.statement,
        },
      }));
    tableMetadataPending.set(key, pending);
  }
  try {
    const metadata = await pending;
    tableMetadataCache.set(key, metadata);
    return metadata;
  } catch {
    return undefined;
  } finally {
    if (tableMetadataPending.get(key) === pending) {
      tableMetadataPending.delete(key);
    }
  }
}

async function loadTableMetadata(tab: TabState): Promise<TableMetadataEntry | undefined> {
  if (isRedisDbType(tab.dbType)) {
    return undefined;
  }
  const ref = tableMetadataRef(tab);
  if (!ref) {
    return undefined;
  }
  const key = tableMetadataKey(tab);
  const metadata = await loadTableMetadataFor(ref, tab.id);
  if (!metadata) {
    if (tableMetadataKey(tab) === key) {
      tab.columnComments = {};
      tab.tableStructure = undefined;
      updateColumnTooltipData(tab);
    }
    return undefined;
  }
  if (tableMetadataKey(tab) !== key) {
    return metadata;
  }
  tab.columnComments = metadata.comments;
  tab.tableStructure = metadata.structure;
  updateColumnTooltipData(tab);
  return metadata;
}

async function openTableStructure(tableName: string): Promise<void> {
  if (!state.activeConnectionId || !state.catalog.instanceName || !state.catalog.dbName) {
    toast("请先选择实例和数据库", "warning");
    return;
  }
  const ref: TableMetadataRef = {
    connectionId: state.activeConnectionId,
    instanceName: state.catalog.instanceName,
    dbName: state.catalog.dbName,
    schemaName: state.catalog.schemaName,
    tableName,
    dbType: selectedInstance()?.db_type ?? "",
  };
  const key = [
    ref.connectionId,
    ref.instanceName,
    ref.dbName,
    ref.schemaName,
    ref.tableName,
  ].join("\u0000");
  if (!tableMetadataCache.has(key) && !tableMetadataPending.has(key)) {
    toast("正在读取表结构…", "info", 1000);
  }
  const metadata = await loadTableMetadataFor(ref, "sidebar-structure");
  if (!metadata) {
    toast("未能获取该表的结构信息", "warning");
    return;
  }
  const active = activeTab(state);
  if (active && tableMetadataKey(active) === [
    ref.connectionId,
    ref.instanceName,
    ref.dbName,
    ref.schemaName,
    ref.tableName,
  ].join("\u0000")) {
    active.columnComments = metadata.comments;
    active.tableStructure = metadata.structure;
    updateColumnTooltipData(active);
  }
  showStructureModal(tableName, undefined, metadata);
}

function updateColumnTooltipData(tab: TabState): void {
  if (state.activeTabId !== tab.id) {
    return;
  }
  const tip = document.getElementById("column-tooltip");
  for (const button of document.querySelectorAll<HTMLElement>(
    ".grid thead th button[data-column-tooltip]",
  )) {
    const column = button.dataset.columnTooltip ?? "";
    button.dataset.columnComment = findColumnComment(tab.columnComments, column);
    button.dataset.columnLoading =
      tab.columnComments === undefined && Boolean(tab.tableName) ? "1" : "0";
    button.dataset.columnTable = tab.tableName || "";
    if (tooltipTarget === button && tip && !tip.hidden) {
      showColumnTooltip(button);
    }
  }
}

function findColumnComment(comments: Record<string, string> | undefined, column: string): string {
  if (!comments) {
    return "";
  }
  if (comments[column] !== undefined) {
    return comments[column];
  }
  const lower = column.toLowerCase();
  for (const [name, comment] of Object.entries(comments)) {
    if (name.toLowerCase() === lower) {
      return comment;
    }
  }
  return "";
}

function showColumnTooltip(button: HTMLElement): void {
  const tip = document.getElementById("column-tooltip");
  if (!tip) {
    return;
  }
  const column = button.dataset.columnTooltip ?? "";
  const comment = button.dataset.columnComment ?? "";
  const loading = button.dataset.columnLoading === "1";
  const table = button.dataset.columnTable ?? "";
  tip.replaceChildren();
  const title = document.createElement("div");
  title.className = "column-tooltip-title";
  title.textContent = column;
  tip.append(title);
  if (table) {
    const meta = document.createElement("div");
    meta.className = "column-tooltip-meta";
    meta.textContent = `表：${table}`;
    tip.append(meta);
  }
  const body = document.createElement("div");
  if (comment) {
    body.className = "column-tooltip-comment";
    body.textContent = `备注：${comment}`;
  } else {
    body.className = "column-tooltip-empty";
    body.textContent = loading
      ? "正在读取字段备注…"
      : !table
        ? "当前结果未关联具体表，无法读取字段备注。"
        : "该字段暂无备注。";
  }
  tip.append(body);
  const hint = document.createElement("div");
  hint.className = "column-tooltip-hint";
  hint.textContent = "点击字段名：正序 → 倒序 → 取消排序，循环切换并执行。";
  tip.append(hint);
  tip.hidden = false;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const rect = button.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 6);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideColumnTooltip(): void {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = undefined;
  tooltipTarget = undefined;
  const tip = document.getElementById("column-tooltip");
  if (tip) {
    tip.hidden = true;
  }
}

interface ExecuteOptions {
  sqlOverride?: string;
  sort?: { column: number; direction: 1 | -1 };
  filter?: string;
  columnFilter?: string;
}


function showStructureModal(
  tableName: string,
  focusColumn: string | undefined,
  metadata: TableMetadataEntry,
): void {
  const structure = metadata.structure;
  const content = document.createElement("div");
  content.className = "structure-view";
  const meta = document.createElement("div");
  meta.className = "structure-meta";
  meta.textContent = focusColumn ? `表：${tableName} · 字段：${focusColumn}` : `表：${tableName}`;
  content.append(meta);

  const structureBody = document.createElement("div");
  structureBody.className = "structure-body";
  let firstMatch: HTMLElement | undefined;
  if (structure.statement) {
    const ddl = document.createElement("div");
    ddl.className = "structure-ddl";
    const needle = focusColumn?.toLowerCase();
    for (const line of structure.statement.split(/\r?\n/)) {
      const row = document.createElement("div");
      row.className = "structure-ddl-line";
      row.textContent = line || " ";
      if (needle && lineMentionsColumn(line, needle)) {
        row.classList.add("structure-match");
        firstMatch ??= row;
      }
      ddl.append(row);
    }
    structureBody.append(ddl);
    if (needle && !firstMatch) {
      firstMatch = (ddl.firstElementChild as HTMLElement | null) ?? undefined;
    }
  } else if (structure.rows.length) {
    const table = document.createElement("table");
    table.className = "structure-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    structure.columns.forEach((name) => {
      const th = document.createElement("th");
      th.textContent = name;
      headRow.append(th);
    });
    if (!structure.columns.length) {
      const th = document.createElement("th");
      th.textContent = "表结构";
      headRow.append(th);
    }
    head.append(headRow);
    table.append(head);
    const nameIndex = findStructureNameIndex(structure.columns);
    const tableBody = document.createElement("tbody");
    for (const row of structure.rows) {
      const tr = document.createElement("tr");
      const values = structure.columns.length ? structure.columns.map((_, index) => row[index]) : [row];
      for (const value of values) {
        const td = document.createElement("td");
        td.textContent = truncate(formatValue(value), 300);
        if (value === null || value === undefined) {
          td.classList.add("null");
        }
        tr.append(td);
      }
      if (
        focusColumn &&
        nameIndex >= 0 &&
        String(row[nameIndex] ?? "").toLowerCase() === focusColumn.toLowerCase()
      ) {
        tr.classList.add("structure-match");
        firstMatch ??= tr;
      }
      tableBody.append(tr);
    }
    table.append(tableBody);
    structureBody.append(table);
  } else {
    structureBody.append(
      emptyState("table", "没有可展示的表结构", "Archery 返回的描述中没有字段明细或 DDL。"),
    );
  }
  content.append(structureBody);

  const searchTargets = Array.from(
    structureBody.querySelectorAll<HTMLElement>(
      ".structure-ddl-line, .structure-table th, .structure-table td",
    ),
  );
  if (searchTargets.length) {
    content.insertBefore(createStructureSearch(structureBody, searchTargets), structureBody);
  }

  const close = openModal(`表结构 · ${tableName}`, content, "modal-wide");
  modalCleanup = close;
  if (firstMatch) {
    window.setTimeout(() => {
      firstMatch?.scrollIntoView({ block: "center", inline: "nearest" });
    }, 30);
  }
}

function createStructureSearch(
  structureBody: HTMLElement,
  targets: HTMLElement[],
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "structure-search";
  const searchIcon = document.createElement("span");
  searchIcon.className = "structure-search-icon";
  searchIcon.innerHTML = icon("search", 13);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "structure-search-input";
  input.placeholder = "搜索字段、类型、备注或 DDL…";
  input.spellcheck = false;
  const count = document.createElement("span");
  count.className = "structure-search-count";
  const previous = structureSearchButton("上一处", "arrow-up");
  const next = structureSearchButton("下一处", "arrow-down");
  const clear = structureSearchButton("清除搜索", "close");
  clear.classList.add("structure-search-clear");
  bar.append(searchIcon, input, count, previous, next, clear);

  const originals = new Map<HTMLElement, string>();
  for (const target of targets) {
    originals.set(target, target.textContent ?? "");
  }
  let matches: HTMLElement[] = [];
  let index = 0;

  const updateNavigation = (): void => {
    const query = input.value.trim();
    count.textContent = query
      ? matches.length
        ? `${index + 1}/${matches.length}`
        : "0/0"
      : "";
    previous.disabled = matches.length === 0;
    next.disabled = matches.length === 0;
    clear.disabled = !query;
  };

  const clearMarks = (): void => {
    for (const target of targets) {
      target.textContent = originals.get(target) ?? "";
      target.classList.remove("structure-search-hit");
    }
    for (const row of structureBody.querySelectorAll("tr")) {
      row.classList.remove("structure-search-row");
    }
  };

  const highlight = (target: HTMLElement, text: string, query: string): HTMLElement[] => {
    target.replaceChildren();
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    const marks: HTMLElement[] = [];
    let position = 0;
    let found = lower.indexOf(needle);
    while (found >= 0) {
      if (found > position) {
        target.append(document.createTextNode(text.slice(position, found)));
      }
      const mark = document.createElement("mark");
      mark.className = "structure-search-mark";
      mark.textContent = text.slice(found, found + query.length);
      target.append(mark);
      marks.push(mark);
      position = found + query.length;
      found = lower.indexOf(needle, position);
    }
    if (position < text.length) {
      target.append(document.createTextNode(text.slice(position)));
    }
    return marks;
  };

  const scrollTo = (): void => {
    if (!matches.length) {
      return;
    }
    for (const mark of matches) {
      mark.classList.remove("structure-search-current");
    }
    const current = matches[index];
    current?.classList.add("structure-search-current");
    current?.scrollIntoView({ block: "center", inline: "center" });
    updateNavigation();
  };

  const apply = (): void => {
    clearMarks();
    matches = [];
    index = 0;
    const query = input.value.trim();
    if (query) {
      for (const target of targets) {
        const original = originals.get(target) ?? "";
        if (!original.toLowerCase().includes(query.toLowerCase())) {
          continue;
        }
        target.classList.add("structure-search-hit");
        target.closest("tr")?.classList.add("structure-search-row");
        matches.push(...highlight(target, original, query));
      }
      updateNavigation();
      if (matches.length) {
        scrollTo();
      }
    } else {
      updateNavigation();
    }
  };

  input.addEventListener("input", apply);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!matches.length) {
        return;
      }
      index = (index + (event.shiftKey ? -1 : 1) + matches.length) % matches.length;
      scrollTo();
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      apply();
    }
  });
  previous.addEventListener("click", () => {
    if (!matches.length) {
      return;
    }
    index = (index - 1 + matches.length) % matches.length;
    scrollTo();
  });
  next.addEventListener("click", () => {
    if (!matches.length) {
      return;
    }
    index = (index + 1) % matches.length;
    scrollTo();
  });
  clear.addEventListener("click", () => {
    input.value = "";
    apply();
    input.focus();
  });
  updateNavigation();
  window.setTimeout(() => input.focus(), 30);
  return bar;
}

function structureSearchButton(title: string, iconName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "structure-search-button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon(iconName, 13);
  return button;
}


function lineMentionsColumn(line: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, "i").test(line);
}

function findStructureNameIndex(columns: string[]): number {
  const aliases = new Set(["field", "columnname", "column", "name", "colname"]);
  return columns.findIndex((column) =>
    aliases.has(column.toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
}

async function executeOrderBy(columnIndex: number): Promise<void> {
  const tab = activeTab(state);
  if (!tab?.result) {
    return;
  }
  if (tab.status === "running") {
    toast("当前查询仍在执行，请稍候", "warning");
    return;
  }
  if (!tab.connectionId) {
    toast("请先添加并选择一个 Archery 连接", "warning");
    return;
  }
  if (!tab.instanceName) {
    toast("请先选择实例", "warning");
    return;
  }
  const column = tab.result.columns[columnIndex];
  if (!column) {
    return;
  }
  const source = editor.getValue().trim() || tab.sql.trim() || tab.executedSql || "";
  if (!source) {
    toast("执行框中没有可排序的 SQL", "warning");
    return;
  }
  const currentDirection = tab.sort?.column === columnIndex ? tab.sort.direction : 0;
  if (currentDirection === -1) {
    let cleared: ReturnType<typeof clearOrderBy>;
    try {
      cleared = clearOrderBy(source);
    } catch (error) {
      toast(messageOf(error), "warning");
      return;
    }
    editor.setValue(cleared.sql);
    tab.sql = cleared.sql;
    await executeQuery(false, {
      sqlOverride: cleared.sql,
      sort: undefined,
      filter: tab.filter,
      columnFilter: tab.columnFilter,
    });
    return;
  }
  let sorted: ReturnType<typeof toggleOrderBy>;
  try {
    const cleared = clearOrderBy(source);
    sorted = toggleOrderBy(cleared.sql, column, tab.dbType);
    if (currentDirection === 1) {
      sorted = toggleOrderBy(sorted.sql, column, tab.dbType);
    }
  } catch (error) {
    toast(messageOf(error), "warning");
    return;
  }
  editor.setValue(sorted.sql);
  tab.sql = sorted.sql;
  await executeQuery(false, {
    sqlOverride: sorted.sql,
    sort: { column: columnIndex, direction: sorted.direction === "ASC" ? 1 : -1 },
    filter: tab.filter,
    columnFilter: tab.columnFilter,
  });
}

async function executeQuery(explain: boolean, options: ExecuteOptions = {}): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  if (tab.status === "running") {
    return;
  }
  if (!tab.connectionId) {
    toast("请先添加并选择一个 Archery 连接", "warning");
    return;
  }
  if (!tab.instanceName) {
    toast("请先选择实例", "warning");
    return;
  }
  const fullSql = editor.getValue();
  const selection = editor.getSelection();
  let sql = (options.sqlOverride ?? (selection.trim() ? selection : fullSql)).trim();
  if (!sql) {
    toast("SQL 不能为空", "warning");
    editor.focus();
    return;
  }
  tab.sql = fullSql;
  const executedSql =
    explain && !/^\s*explain\b/i.test(sql) ? `EXPLAIN\n${sql}` : sql;
  window.clearTimeout(resultFilterTimer);
  tab.executedSql = executedSql;
  tab.columnComments = undefined;
  tab.tableStructure = undefined;
  tab.selectedRows.clear();
  tab.cellEdits.clear();
  tab.hasMoreRows = false;
  tab.pageLoading = false;
  const pageSize = Math.max(1, tab.limit > 0 ? tab.limit : tab.pageSize > 0 ? tab.pageSize : 100);
  tab.pageSize = pageSize;
  tab.limit = pageSize;
  tab.status = "running";
  tab.error = undefined;
  tab.result = undefined;
  tab.describeStatement = undefined;
  tab.resultTab = "results";
  tab.startedAt = performance.now();
  tab.elapsedMs = undefined;
  tab.page = 0;
  tab.filter = options.filter ?? "";
  tab.columnFilter = options.columnFilter ?? "";
  tab.sort = options.sort;
  renderQueryTabs();
  renderContext();
  renderResults();
  renderStatus();
  schedulePersist();
  const connectionId = tab.connectionId;
  const { requestId, promise } = bridge.requestWithId<ExecuteQueryData>({
    type: "executeQuery",
    connectionId,
    tabId: tab.id,
    request: {
      instanceName: tab.instanceName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      tableName: tab.tableName,
      sql: executedSql,
      limit: Math.min(5000, pageSize + 1),
    },
  });
  tab.requestId = requestId;
  try {
    const result = await promise;
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    tab.status = "success";
    const pageSize = Math.max(1, tab.pageSize);
    const pageable = isPageableSql(executedSql);
    const hasMore = pageable && result.rows.length > pageSize;
    tab.result = hasMore ? { ...result, rows: result.rows.slice(0, pageSize) } : result;
    tab.hasMoreRows = hasMore;
    tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
    tab.resultTab = "results";
    tab.page = 0;
    state.history.loaded = false;
    if (tab.result.rows.length === 0 && result.affectedRows !== undefined) {
      tab.resultTab = "messages";
    }
    tab.title = /^查询 \d+$/.test(tab.title)
      ? tab.tableName || tab.dbName || tab.title
      : tab.title;
    renderAll();
    void loadTableMetadata(tab);
    schedulePersist();
  } catch (error) {
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    const info = toQueryError(error);
    if (info.code === "cancelled") {
      tab.status = "idle";
      tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
    } else {
      tab.status = "error";
      tab.error = info;
      tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
      toast(info.message, "error");
    }
    renderAll();
  }
}


function isPageableSql(sql: string): boolean {
  return /^\s*(?:select|with)\b/i.test(sql);
}

function changeResultPageSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    return;
  }
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  if (tab.status === "running") {
    renderContext();
    renderResults();
    return;
  }
  tab.limit = size;
  tab.pageSize = size;
  tab.page = 0;
  tab.hasMoreRows = false;
  schedulePersist();
  renderContext();
  if (
    tab.result &&
    tab.result.rows.length > 0 &&
    tab.executedSql &&
    !tab.describeStatement &&
    isPageableSql(tab.executedSql)
  ) {
    void executeQuery(false, {
      sqlOverride: tab.executedSql,
      filter: tab.filter,
      columnFilter: tab.columnFilter,
      sort: tab.sort,
    });
    return;
  }
  renderResults();
}

async function loadMoreRows(tab: TabState): Promise<void> {
  if (
    tab.status === "running" ||
    tab.pageLoading ||
    !tab.hasMoreRows ||
    !tab.result ||
    !tab.executedSql ||
    !tab.connectionId ||
    !isPageableSql(tab.executedSql)
  ) {
    return;
  }
  const pageSize = Math.max(1, tab.pageSize);
  const targetPage = tab.page + 1;
  const targetLoaded = (targetPage + 1) * pageSize;
  if (targetLoaded > 5000) {
    tab.hasMoreRows = false;
    toast("单次最多加载 5000 行，可缩小查询范围后重试", "warning");
    renderResults();
    return;
  }
  const requestLimit = Math.min(5000, targetLoaded + 1);
  tab.pageLoading = true;
  tab.status = "running";
  tab.error = undefined;
  tab.startedAt = performance.now();
  renderQueryTabs();
  renderResults();
  renderStatus();
  const { requestId, promise } = bridge.requestWithId<ExecuteQueryData>({
    type: "executeQuery",
    connectionId: tab.connectionId,
    tabId: tab.id,
    request: {
      instanceName: tab.instanceName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      tableName: tab.tableName,
      sql: tab.executedSql,
      limit: requestLimit,
    },
  });
  tab.requestId = requestId;
  try {
    const result = await promise;
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    tab.pageLoading = false;
    tab.status = "success";
    const loaded = Math.min(targetLoaded, result.rows.length);
    const hasMore = result.rows.length > loaded;
    tab.cellEdits.clear();
    tab.result = { ...result, rows: result.rows.slice(0, loaded) };
    tab.hasMoreRows = hasMore;
    const pageCount = Math.max(1, Math.ceil(loaded / pageSize));
    tab.page = Math.min(targetPage, pageCount - 1);
    tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
    renderQueryTabs();
    renderResults();
    renderStatus();
    schedulePersist();
  } catch (error) {
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    tab.pageLoading = false;
    tab.status = "success";
    const info = toQueryError(error);
    if (info.code !== "cancelled") {
      toast(info.message, "error");
    }
    renderQueryTabs();
    renderResults();
    renderStatus();
  }
}

async function runDescribe(tab: TabState): Promise<void> {
  if (!tab.connectionId || !tab.instanceName || !tab.dbName || !tab.tableName) {
    toast("缺少实例、数据库或表名，无法获取表结构", "warning");
    return;
  }
  tab.status = "running";
  tab.error = undefined;
  tab.result = undefined;
  tab.selectedRows.clear();
  tab.cellEdits.clear();
  tab.hasMoreRows = false;
  tab.pageLoading = false;
  tab.startedAt = performance.now();
  tab.resultTab = "messages";
  tab.executedSql = `-- 表结构：${[tab.dbName, tab.schemaName, tab.tableName].filter(Boolean).join(".")}`;
  renderQueryTabs();
  renderResults();
  renderStatus();
  const { requestId, promise } = bridge.requestWithId<{
    result: QueryExecutionResult;
    statement?: string;
  }>({
    type: "describeTable",
    connectionId: tab.connectionId,
    instanceName: tab.instanceName,
    dbName: tab.dbName,
    tableName: tab.tableName,
    schemaName: tab.schemaName,
    tabId: tab.id,
  });
  tab.requestId = requestId;
  try {
    const description = await promise;
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    tab.status = "success";
    tab.result = description.result;
    tab.columnComments = {};
    tab.tableStructure = undefined;
    tab.describeStatement = description.statement;
    tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
    tab.resultTab = description.result.rows.length ? "results" : "messages";
    tab.title = `表结构 · ${tab.tableName}`;
    renderAll();
    schedulePersist();
  } catch (error) {
    if (tab.requestId !== requestId) {
      return;
    }
    tab.requestId = undefined;
    tab.status = "error";
    tab.error = toQueryError(error);
    tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
    renderAll();
    toast(tab.error.message, "error");
  }
}

function stopQuery(): void {
  const tab = activeTab(state);
  if (!tab?.requestId) {
    return;
  }
  bridge.cancel(tab.requestId);
  tab.requestId = undefined;
  tab.status = "idle";
  tab.elapsedMs = performance.now() - (tab.startedAt ?? performance.now());
  renderQueryTabs();
  renderContext();
  renderResults();
  renderStatus();
  toast("已停止等待查询结果。Archery 服务端可能仍在执行该语句。", "warning");
}


let tabContextMenu: HTMLElement | undefined;

function closeTabContextMenu(): void {
  tabContextMenu?.remove();
  tabContextMenu = undefined;
}

function openTabContextMenu(tabId: string, x: number, y: number): void {
  closeTabContextMenu();
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return;
  }
  const menu = document.createElement("div");
  menu.className = "tab-context-menu";
  menu.setAttribute("role", "menu");
  const addItem = (
    label: string,
    iconName: string,
    disabled: boolean,
    action: "close-current" | "close-others" | "close-right",
  ): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-context-item";
    button.dataset.tabAction = action;
    button.disabled = disabled;
    button.innerHTML = `${icon(iconName, 13)}<span></span>`;
    const text = button.querySelector<HTMLElement>("span");
    if (text) {
      text.textContent = label;
    }
    menu.append(button);
  };
  addItem("关闭此标签", "close", false, "close-current");
  addItem("关闭其他标签", "close", state.tabs.length <= 1, "close-others");
  addItem("关闭右侧标签", "chevron-right", index >= state.tabs.length - 1, "close-right");
  menu.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-action]");
    if (!button?.dataset.tabAction) {
      return;
    }
    const action = button.dataset.tabAction;
    closeTabContextMenu();
    if (action === "close-current") {
      closeTab(tabId);
      return;
    }
    if (action === "close-others") {
      const ids = new Set(
        state.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id),
      );
      closeTabs(ids, tabId);
      return;
    }
    if (action === "close-right") {
      const ids = new Set(
        state.tabs.slice(index + 1).map((tab) => tab.id),
      );
      closeTabs(ids, tabId);
    }
  });
  document.body.append(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - height - 8))}px`;
  tabContextMenu = menu;
}

function closeTabs(ids: Set<string>, fallbackTabId?: string): void {
  if (!ids.size) {
    return;
  }
  const activeId = state.activeTabId;
  const activeIndex = state.tabs.findIndex((tab) => tab.id === activeId);
  for (const tab of state.tabs) {
    if (ids.has(tab.id) && tab.requestId) {
      bridge.cancel(tab.requestId);
    }
  }
  state.tabs = state.tabs.filter((tab) => !ids.has(tab.id));
  if (!state.tabs.length) {
    const replacement = createTab(state, {
      connectionId: state.activeConnectionId,
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(replacement);
    state.activeTabId = replacement.id;
  } else if (activeId && ids.has(activeId)) {
    const fallback = state.tabs.find((tab) => tab.id === fallbackTabId);
    state.activeTabId = fallback
      ? fallback.id
      : state.tabs[Math.min(Math.max(0, activeIndex), state.tabs.length - 1)].id;
  }
  const active = activeTab(state);
  if (active) {
    editor.setValue(active.sql);
  }
  renderAll();
  schedulePersist();
  if (active) {
    void syncCatalog(active, false);
  }
}

function newTab(): void {
  const current = activeTab(state);
  const tab = createTab(state, {
    connectionId: current?.connectionId ?? state.activeConnectionId,
    instanceName: state.catalog.instanceName || current?.instanceName,
    dbName: state.catalog.dbName || current?.dbName,
    schemaName: state.catalog.schemaName || current?.schemaName,
    dbType: current?.dbType || selectedInstance()?.db_type,
    limit: state.settings.defaultLimit,
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  editor.setValue("");
  editor.focus();
  renderAll();
  schedulePersist();
}

function closeTab(tabId: string): void {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return;
  }
  const tab = state.tabs[index];
  if (tab.requestId) {
    bridge.cancel(tab.requestId);
  }
  state.tabs.splice(index, 1);
  if (!state.tabs.length) {
    const replacement = createTab(state, {
      connectionId: state.activeConnectionId,
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(replacement);
    state.activeTabId = replacement.id;
  } else if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[Math.min(index, state.tabs.length - 1)].id;
  }
  const active = activeTab(state);
  if (active) {
    editor.setValue(active.sql);
  }
  renderAll();
  schedulePersist();
  if (active) {
    void syncCatalog(active, false);
  }
}

function activateTab(tabId: string): void {
  if (state.activeTabId === tabId) {
    editor.focus();
    return;
  }
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }
  state.activeTabId = tab.id;
  if (tab.connectionId && tab.connectionId !== state.activeConnectionId) {
    state.activeConnectionId = tab.connectionId;
  }
  editor.setValue(tab.sql);
  renderAll();
  schedulePersist();
  void syncCatalog(tab, false);
}

function switchResultTab(tab: "results" | "messages" | "history"): void {
  const active = activeTab(state);
  if (!active) {
    return;
  }
  active.resultTab = tab;
  renderResults();
  if (tab === "history") {
    void loadHistoryIfNeeded(true);
  }
}

async function handleResultAction(action: string): Promise<void> {
  const tab = activeTab(state);
  if (!tab?.result) {
    return;
  }
  if (action === "copy") {
    await copyResult(tab);
    return;
  }
  if (action === "clear-selection") {
    tab.selectedRows.clear();
    updateSelectionUi(tab);
    return;
  }
  if (action === "copy-selected-insert") {
    await copySelectedInsert(tab);
    return;
  }
  if (action === "copy-selected-delete") {
    await copySelectedDelete(tab);
    return;
  }
  if (action === "copy-updates") {
    await copyChangedUpdates(tab);
    return;
  }
  const format =
    action === "export-csv" ? "csv" : action === "export-json" ? "json" : action === "export-sql" ? "sql" : undefined;
  if (!format) {
    return;
  }
  try {
    await bridge.request({
      type: "exportResult",
      format,
      columns: tab.result.columns,
      rows: tab.result.rows,
      sql: tab.executedSql,
      tableName: tab.tableName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      dbType: tab.dbType,
      suggestedName: `${tab.title}-${timestampForFile()}`,
    });
  } catch (error) {
    if (messageOf(error).includes("已取消导出")) {
      return;
    }
    toast(errorText(error), "error");
  }
}



function beginRowDrag(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }
  const target = event.target as HTMLElement;
  if (target.closest("input, button, a, select, textarea, label")) {
    return;
  }
  const row = target.closest<HTMLTableRowElement>(".grid tbody tr[data-row-index]");
  if (!row) {
    return;
  }
  const tab = activeTab(state);
  if (!tab?.result || tab.status === "running") {
    return;
  }
  rowDrag = {
    tabId: tab.id,
    startRow: row,
    baseSelection: new Set(tab.selectedRows),
    additive: event.ctrlKey || event.metaKey,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  event.preventDefault();
}

function moveRowDrag(event: MouseEvent): void {
  if (!rowDrag) {
    return;
  }
  const tab = activeTab(state);
  if (!tab || tab.id !== rowDrag.tabId) {
    endRowDrag();
    return;
  }
  if (!rowDrag.active) {
    if (Math.hypot(event.clientX - rowDrag.startX, event.clientY - rowDrag.startY) < 4) {
      return;
    }
    rowDrag.active = true;
    document.body.classList.add("selecting-rows");
  }
  const point = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  const row = point?.closest<HTMLTableRowElement>(".grid tbody tr[data-row-index]");
  if (!row) {
    return;
  }
  const tbody = row.parentElement;
  if (!tbody) {
    return;
  }
  const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>("tr[data-row-index]"));
  const start = rows.indexOf(rowDrag.startRow);
  const end = rows.indexOf(row);
  if (start < 0 || end < 0) {
    return;
  }
  const selected = new Set<number>(rowDrag.additive ? rowDrag.baseSelection : []);
  for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
    const value = rows[index]?.dataset.rowIndex;
    if (value !== undefined) {
      selected.add(Number(value));
    }
  }
  tab.selectedRows.clear();
  for (const index of selected) {
    tab.selectedRows.add(index);
  }
  updateSelectionUi(tab);
  event.preventDefault();
}

function endRowDrag(): void {
  if (!rowDrag) {
    return;
  }
  const wasActive = rowDrag.active;
  rowDrag = undefined;
  document.body.classList.remove("selecting-rows");
  if (wasActive) {
    suppressRowClick = true;
    window.setTimeout(() => {
      suppressRowClick = false;
    }, 250);
  }
}



function cellEditKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function sameCellValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function parseEditedValue(text: string, original: unknown): unknown {
  if (original === null || original === undefined) {
    return text.trim() === "" || text.trim().toUpperCase() === "NULL" ? null : text;
  }
  if (typeof original === "number") {
    if (text.trim() !== "" && Number.isFinite(Number(text))) {
      return Number(text);
    }
    return text;
  }
  if (typeof original === "boolean") {
    if (/^(true|1)$/i.test(text.trim())) {
      return true;
    }
    if (/^(false|0)$/i.test(text.trim())) {
      return false;
    }
    return text;
  }
  if (typeof original === "object") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function startCellEdit(
  cell: HTMLElement,
  tab: TabState,
  row: number,
  column: number,
): void {
  if (cell.querySelector(".cell-editor") || !tab.result) {
    return;
  }
  const key = cellEditKey(row, column);
  const value = tab.result.rows[row]?.[column];
  const original = tab.cellEdits.get(key)?.original ?? value;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cell-editor";
  input.value = rawCellValue(value);
  input.spellcheck = false;
  let finished = false;

  const restore = (): void => {
    cell.classList.remove("cell-editing");
    cell.classList.remove("null");
    setCellContent(cell as HTMLTableCellElement, value);
    if (value === null || value === undefined) {
      cell.classList.add("null");
    }
    cell.classList.toggle("cell-modified", tab.cellEdits.has(key));
  };

  const finish = (commit: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (!commit) {
      restore();
      return;
    }
    const next = parseEditedValue(input.value, original);
    if (tab.result) {
      tab.result.rows[row][column] = next;
    }
    if (sameCellValue(next, original)) {
      tab.cellEdits.delete(key);
    } else {
      tab.cellEdits.set(key, { row, column, original, value: next });
    }
    cell.classList.remove("cell-editing");
    cell.classList.remove("null");
    setCellContent(cell as HTMLTableCellElement, next);
    if (next === null || next === undefined) {
      cell.classList.add("null");
    }
    cell.classList.toggle("cell-modified", tab.cellEdits.has(key));
    selectResultCell(cell);
    renderResultActions(tab);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
      input.blur();
    }
  });
  input.addEventListener("blur", () => finish(true));
  cell.classList.add("cell-editing");
  cell.replaceChildren(input);
  input.focus();
  input.select();
}

function rawCellValue(value: unknown): string {
  if (value === null) {
    return "NULL";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function commitActiveCellEdit(except?: HTMLElement): void {
  const editor = document.querySelector<HTMLInputElement>("#result-body .cell-editor");
  if (editor && !except?.contains(editor)) {
    editor.blur();
  }
}

function selectResultCell(cell: HTMLElement): void {
  clearSelectedResultCell();
  cell.classList.add("cell-selected");
  cell.tabIndex = -1;
  cell.setAttribute("aria-selected", "true");
  cell.focus({ preventScroll: true });
}

function clearSelectedResultCell(): void {
  for (const cell of document.querySelectorAll<HTMLElement>("#result-body td.cell-selected")) {
    cell.classList.remove("cell-selected");
    cell.removeAttribute("aria-selected");
  }
}

let lastCellCopyNotice: { key: string; at: number } | undefined;

function notifyCellCopied(tab: TabState, row: number, column: number): void {
  const key = `${tab.id}:${row}:${column}`;
  const now = performance.now();
  if (lastCellCopyNotice?.key === key && now - lastCellCopyNotice.at < 600) {
    return;
  }
  lastCellCopyNotice = { key, at: now };
  const columnName = tab.result?.columns[column] ?? `列 ${column + 1}`;
  toast(`已复制原始数据：${columnName} · 第 ${row + 1} 行`, "info", 1400);
}

function copyCellRaw(tab: TabState, row: number, column: number): void {
  if (!tab.result) {
    return;
  }
  const value = tab.result.rows[row]?.[column];
  const text = rawCellValue(value);
  void bridge
    .request({ type: "copyText", text })
    .then(() => notifyCellCopied(tab, row, column))
    .catch((error: unknown) => toast(errorText(error), "error"));
}

function updateSelectionUi(tab: TabState): void {
  if (activeTab(state)?.id !== tab.id) {
    return;
  }
  let pageTotal = 0;
  let pageSelected = 0;
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    ".grid input[data-row-select]",
  )) {
    const index = Number(checkbox.dataset.rowSelect);
    checkbox.checked = tab.selectedRows.has(index);
    checkbox.closest("tr")?.classList.toggle("row-selected", checkbox.checked);
    pageTotal += 1;
    if (checkbox.checked) {
      pageSelected += 1;
    }
  }
  const selectAll = document.getElementById("select-page-rows") as HTMLInputElement | null;
  if (selectAll) {
    selectAll.checked = pageTotal > 0 && pageSelected === pageTotal;
    selectAll.indeterminate = pageSelected > 0 && pageSelected < pageTotal;
  }
  renderResultActions(tab);
}



async function copyChangedUpdates(tab: TabState): Promise<void> {
  if (!tab.result) {
    return;
  }
  if (!tab.tableName) {
    toast("当前结果未关联具体表，无法生成 UPDATE。请从左侧数据表列表打开查询。", "warning");
    return;
  }
  if (!tab.cellEdits.size) {
    toast("当前没有未执行的单元格修改", "warning");
    return;
  }
  let statement = tab.tableStructure?.statement;
  if (!statement) {
    const metadata = await loadTableMetadata(tab);
    statement = metadata?.structure.statement;
  }
  const byRow = new Map<number, Array<{ column: number; original: unknown; value: unknown }>>();
  for (const edit of tab.cellEdits.values()) {
    const edits = byRow.get(edit.row) ?? [];
    edits.push({ column: edit.column, original: edit.original, value: edit.value });
    byRow.set(edit.row, edits);
  }
  const updates = [...byRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, edits]) => {
      const currentRow = tab.result?.rows[row] ?? [];
      const originalRow = currentRow.slice();
      for (const edit of edits) {
        originalRow[edit.column] = edit.original;
      }
      return {
        originalRow,
        changes: edits.map((edit) => ({ columnIndex: edit.column, value: edit.value })),
      };
    });
  try {
    const sql = buildUpdateStatements({
      columns: tab.result.columns,
      updates,
      tableName: tab.tableName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      dbType: tab.dbType,
      primaryKey: extractPrimaryKeyColumns(statement),
    });
    await bridge.request({ type: "copyText", text: sql });
    toast(`已复制 ${updates.length} 条 UPDATE 语句到剪贴板`, "info");
  } catch (error) {
    toast(
      error instanceof UpdateSqlError ? error.message : errorText(error),
      "error",
    );
  }
}

async function copySelectedDelete(tab: TabState): Promise<void> {
  if (!tab.result) {
    return;
  }
  if (!tab.tableName) {
    toast("当前结果未关联具体表，无法生成 DELETE。请从左侧数据表列表打开查询。", "warning");
    return;
  }
  const rows = tab.result.rows.filter((_, index) => tab.selectedRows.has(index));
  if (!rows.length) {
    toast("请先在结果左侧勾选要复制的行", "warning");
    return;
  }
  let statement = tab.tableStructure?.statement;
  if (!statement) {
    const metadata = await loadTableMetadata(tab);
    statement = metadata?.structure.statement;
  }
  try {
    const sql = buildDeleteStatements({
      columns: tab.result.columns,
      rows,
      tableName: tab.tableName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      dbType: tab.dbType,
      primaryKey: extractPrimaryKeyColumns(statement),
    });
    await bridge.request({ type: "copyText", text: sql });
    toast(`已复制 ${rows.length} 行 DELETE SQL 到剪贴板`, "info");
  } catch (error) {
    toast(
      error instanceof DeleteSqlError ? error.message : errorText(error),
      "error",
    );
  }
}

async function copySelectedInsert(tab: TabState): Promise<void> {
  if (!tab.result) {
    return;
  }
  if (!tab.tableName) {
    toast("当前结果未关联具体表，无法生成 INSERT。请从左侧数据表列表打开查询。", "warning");
    return;
  }
  const rows = tab.result.rows.filter((_, index) => tab.selectedRows.has(index));
  if (!rows.length) {
    toast("请先在结果左侧勾选要复制的行", "warning");
    return;
  }
  if (!supportsInsertMode(tab.dbType, tab.insertMode)) {
    toast(`当前数据库不支持${insertModeLabel(tab.insertMode)}`, "warning");
    return;
  }
  let sql: string;
  try {
    sql = buildInsertStatements({
      columns: tab.result.columns,
      rows,
      tableName: tab.tableName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      dbType: tab.dbType,
      mode: tab.insertMode,
    });
  } catch (error) {
    toast(error instanceof InsertSqlError ? error.message : messageOf(error), "error");
    return;
  }
  try {
    await bridge.request({ type: "copyText", text: sql });
    toast(
      `已复制 ${rows.length} 行${insertModeLabel(tab.insertMode)} SQL 到剪贴板`,
      "info",
    );
  } catch (error) {
    toast(errorText(error), "error");
  }
}



async function copySelectedRows(tab: TabState): Promise<void> {
  if (!tab.result || !tab.selectedRows.size) {
    return;
  }
  const rows = tab.result.rows.filter((_, index) => tab.selectedRows.has(index));
  const lines = [
    tab.result.columns.join("\t"),
    ...rows.map((row) =>
      row
        .map((value) =>
          value === null || value === undefined
            ? "\\N"
            : formatValue(value).replace(/\r?\n/g, " ").replace(/\t/g, " "),
        )
        .join("\t"),
    ),
  ];
  try {
    await bridge.request({ type: "copyText", text: lines.join("\n") });
    toast(`已复制 ${rows.length} 行到剪贴板`, "info");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function copyResult(tab: TabState): Promise<void> {
  if (!tab.result) {
    return;
  }
  const lines = [
    tab.result.columns.join("\t"),
    ...tab.result.rows.map((row) =>
      row
        .map((value) =>
          value === null || value === undefined
            ? "\\N"
            : formatValue(value).replace(/\r?\n/g, " ").replace(/\t/g, " "),
        )
        .join("\t"),
    ),
  ];
  const text = lines.join("\n");
  if (text.length > 8 * 1024 * 1024) {
    toast("结果超过 8 MB，请使用 CSV/JSON 导出", "warning");
    return;
  }
  try {
    await bridge.request({ type: "copyText", text });
    toast(`已复制 ${formatNumber(tab.result.rows.length)} 行到剪贴板`, "info");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function loadHistoryIfNeeded(force: boolean): Promise<void> {
  const tab = activeTab(state);
  const connectionId = tab?.connectionId ?? state.activeConnectionId;
  if (!connectionId) {
    return;
  }
  if (!force && state.history.connectionId === connectionId && state.history.loaded) {
    return;
  }
  if (state.history.loading) {
    return;
  }
  await loadHistory(force, connectionId);
}

async function loadHistory(force: boolean, explicitConnectionId?: string): Promise<void> {
  const tab = activeTab(state);
  const connectionId = explicitConnectionId ?? tab?.connectionId ?? state.activeConnectionId;
  if (!connectionId) {
    return;
  }
  if (!force && state.history.loaded && state.history.connectionId === connectionId) {
    return;
  }
  const seq = ++historySeq;
  state.history.connectionId = connectionId;
  state.history.loading = true;
  state.history.error = undefined;
  if (tab?.resultTab === "history") {
    renderResults();
  }
  try {
    const page = await bridge.request<QueryLogPage>({
      type: "queryLogs",
      connectionId,
      search: state.history.search,
    });
    if (seq !== historySeq) {
      return;
    }
    state.history.entries = page.rows;
    state.history.total = page.total;
    state.history.loaded = true;
    state.history.loading = false;
    if (activeTab(state)?.resultTab === "history") {
      renderResults();
    }
  } catch (error) {
    if (seq !== historySeq) {
      return;
    }
    state.history.loading = false;
    state.history.error = toQueryError(error);
    if (activeTab(state)?.resultTab === "history") {
      renderResults();
    }
  }
}

async function loadHistoryEntry(id: number): Promise<void> {
  const entry = state.history.entries.find((item) => item.id === id);
  const current = activeTab(state);
  if (!entry || !current) {
    return;
  }
  const tab = createTab(state, {
    connectionId: current.connectionId ?? state.activeConnectionId,
    instanceName: entry.instanceName,
    dbName: entry.dbName,
    sql: entry.sql,
    title: entry.alias || `历史 #${entry.id}`,
    limit: state.settings.defaultLimit,
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  editor.setValue(tab.sql);
  editor.focus();
  renderAll();
  schedulePersist();
  await syncCatalog(tab, false);
}

async function refreshCatalog(): Promise<void> {
  const tab = activeTab(state);
  void bridge.request({ type: "refreshExplorer" }).catch(() => undefined);
  if (tab) {
    state.catalog.instances = [];
    state.catalog.tables = [];
    state.history.loaded = false;
    await syncCatalog(tab, true);
  }
}

async function saveSqlFile(): Promise<void> {
  const tab = activeTab(state);
  if (!tab) {
    return;
  }
  const sql = editor.getValue();
  if (!sql.trim()) {
    toast("没有可保存的 SQL", "warning");
    return;
  }
  try {
    await bridge.request({
      type: "saveSqlFile",
      sql,
      suggestedName: `${sanitizeName(tab.title)}.sql`,
    });
  } catch (error) {
    if (messageOf(error).includes("已取消保存")) {
      return;
    }
    toast(errorText(error), "error");
  }
}

async function openSqlFile(): Promise<void> {
  try {
    const data = await bridge.request<OpenSqlFileData>({ type: "openSqlFile" });
    if (!data?.content) {
      return;
    }
    const current = activeTab(state);
    const tab = createTab(state, {
      connectionId: current?.connectionId ?? state.activeConnectionId,
      instanceName: state.catalog.instanceName || current?.instanceName,
      dbName: state.catalog.dbName || current?.dbName,
      schemaName: state.catalog.schemaName || current?.schemaName,
      dbType: current?.dbType || selectedInstance()?.db_type,
      sql: data.content,
      title: (data.name || "导入的查询").replace(/\.sql$/i, ""),
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(tab);
    state.activeTabId = tab.id;
    editor.setValue(data.content);
    editor.focus();
    renderAll();
    schedulePersist();
  } catch (error) {
    if (messageOf(error).includes("已取消打开")) {
      return;
    }
    toast(errorText(error), "error");
  }
}

async function openConnectionModal(
  connectionId?: string,
  providedDraft?: ConnectionFormDraft,
): Promise<void> {
  let draft = providedDraft;
  if (!draft && connectionId) {
    try {
      const data = await bridge.request<{ draft: ConnectionFormDraft }>({
        type: "getConnectionDraft",
        connectionId,
      });
      draft = data.draft;
    } catch (error) {
      toast(errorText(error), "error");
      return;
    }
  }
  const editing = Boolean(draft?.id ?? connectionId);
  const form = document.createElement("form");
  form.className = "connection-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-intro">${icon("link", 15)}<span>${editing ? "修改连接信息。留空的凭据字段不会覆盖已保存的值。" : "连接 Archery 服务。插件仅保存接口地址和用户名，密码/令牌存入 VS Code SecretStorage。"}</span></div>
    <div class="form-grid">
      <label class="form-field"><span>连接名称</span><input name="name" type="text" placeholder="例如：生产只读" autocomplete="off" /></label>
      <label class="form-field full"><span>Archery 地址</span><input name="baseUrl" type="text" placeholder="https://archery.example.com" spellcheck="false" autocomplete="url" /></label>
      <label class="form-field"><span>用户名</span><input name="username" type="text" placeholder="Archery 登录用户名" autocomplete="username" /></label>
      <label class="form-field"><span>认证方式</span><select name="authMode" class="select"><option value="password">用户名密码</option><option value="token">访问令牌</option></select></label>
      <label class="form-field full" data-password-row><span>密码</span><input name="password" type="password" placeholder="${draft?.hasPassword ? "已保存，留空则保持不变" : "Archery 登录密码"}" autocomplete="current-password" /></label>
      <label class="form-field full" data-token-row hidden><span>访问令牌</span><input name="token" type="password" placeholder="${draft?.hasToken ? "已保存，留空则保持不变" : "Bearer Token / JWT"}" autocomplete="off" /></label>
      <label class="checkbox-field full"><input name="allowInsecureTls" type="checkbox" /><span>允许不安全 TLS 证书（仅用于信任的内网自签名证书）</span></label>
      <div class="http-warning full" hidden>${icon("alert", 14)}<span>当前使用 HTTP，登录密码会以明文在网络中传输。建议为 Archery 配置 HTTPS。</span></div>
      <div class="form-status full" hidden></div>
    </div>
    <div class="modal-actions">
      ${editing ? `<button type="button" class="text-btn danger" data-delete>${icon("trash")}<span>删除连接</span></button>` : ""}
      <span class="modal-actions-spacer"></span>
      <button type="button" class="secondary-btn" data-cancel>取消</button>
      <button type="button" class="secondary-btn" data-test>${icon("plug")}<span>测试连接</span></button>
      <button type="submit" class="primary-btn">${icon("check")}<span>保存连接</span></button>
    </div>`;
  const nameInput = form.elements.namedItem("name") as HTMLInputElement;
  const urlInput = form.elements.namedItem("baseUrl") as HTMLInputElement;
  const userInput = form.elements.namedItem("username") as HTMLInputElement;
  const authSelect = form.elements.namedItem("authMode") as HTMLSelectElement;
  const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
  const tokenInput = form.elements.namedItem("token") as HTMLInputElement;
  const insecureInput = form.elements.namedItem("allowInsecureTls") as HTMLInputElement;
  const passwordRow = form.querySelector<HTMLElement>("[data-password-row]");
  const tokenRow = form.querySelector<HTMLElement>("[data-token-row]");
  const httpWarning = form.querySelector<HTMLElement>(".http-warning");
  const status = form.querySelector<HTMLElement>(".form-status");
  const testButton = form.querySelector<HTMLButtonElement>("[data-test]")!;
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const deleteButton = form.querySelector<HTMLButtonElement>("[data-delete]");
  nameInput.value = draft?.name ?? "";
  urlInput.value = draft?.baseUrl ?? "https://";
  userInput.value = draft?.username ?? "";
  authSelect.value = draft?.authMode ?? "password";
  insecureInput.checked = draft?.allowInsecureTls ?? state.settings.allowInsecureTls;
  passwordInput.value = "";
  tokenInput.value = "";

  const refreshVisibility = (): void => {
    const tokenMode = authSelect.value === "token";
    if (passwordRow) {
      passwordRow.hidden = tokenMode;
    }
    if (tokenRow) {
      tokenRow.hidden = !tokenMode;
    }
    if (httpWarning) {
      httpWarning.hidden = !/^http:\/\//i.test(urlInput.value.trim());
    }
  };
  const setBusy = (busy: boolean): void => {
    testButton.disabled = busy;
    submitButton.disabled = busy;
    if (deleteButton) {
      deleteButton.disabled = busy;
    }
  };
  const showStatus = (kind: "ok" | "error", message: string): void => {
    if (!status) {
      return;
    }
    status.hidden = false;
    status.className = `form-status full ${kind}`;
    status.innerHTML = kind === "ok" ? icon("check", 14) : icon("alert", 14);
    const text = document.createElement("span");
    text.textContent = message;
    status.append(text);
  };
  const clearStatus = (): void => {
    if (status) {
      status.hidden = true;
      status.replaceChildren();
    }
  };
  const buildDraft = (): ConnectionFormDraft => {
    const draftValue: ConnectionFormDraft = {
      id: draft?.id ?? connectionId,
      name: nameInput.value.trim(),
      baseUrl: urlInput.value.trim(),
      username: userInput.value.trim(),
      authMode: authSelect.value === "token" ? "token" : "password",
      allowInsecureTls: insecureInput.checked,
      hasPassword: draft?.hasPassword,
      hasToken: draft?.hasToken,
    };
    if (passwordInput.value) {
      draftValue.password = passwordInput.value;
    }
    if (tokenInput.value) {
      draftValue.token = tokenInput.value;
    }
    return draftValue;
  };
  const validate = (): string | undefined => {
    if (!urlInput.value.trim()) {
      return "请填写 Archery 地址";
    }
    if (!userInput.value.trim()) {
      return "请填写用户名";
    }
    if (!draft && authSelect.value === "password" && !passwordInput.value) {
      return "请填写密码";
    }
    if (!draft && authSelect.value === "token" && !tokenInput.value) {
      return "请填写访问令牌";
    }
    return undefined;
  };

  authSelect.addEventListener("change", refreshVisibility);
  urlInput.addEventListener("input", refreshVisibility);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  form.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", closeModal);
  testButton.addEventListener("click", () => void testConnection(buildDraft, validate, setBusy, showStatus, clearStatus));
  submitButton.addEventListener("click", () => {
    // The form submit handler does the work; this prevents the modal backdrop from stealing focus.
  });

  let deleteArmed = false;
  if (deleteButton) {
    deleteButton.addEventListener("click", () => {
      if (!deleteArmed) {
        deleteArmed = true;
        deleteButton.classList.add("danger-armed");
        deleteButton.innerHTML = `${icon("alert")}<span>再次点击确认删除</span>`;
        window.setTimeout(() => {
          deleteArmed = false;
          deleteButton.classList.remove("danger-armed");
          deleteButton.innerHTML = `${icon("trash")}<span>删除连接</span>`;
        }, 3500);
        return;
      }
      void removeCurrentConnection(draft?.id ?? connectionId);
    });
  }

  const save = async (): Promise<void> => {
    clearStatus();
    const validation = validate();
    if (validation) {
      showStatus("error", validation);
      return;
    }
    setBusy(true);
    try {
      const data = await bridge.request<SaveConnectionData>({
        type: "saveConnection",
        draft: buildDraft(),
      });
      if (!data.connection) {
        throw new Error("保存连接失败：服务端未返回连接信息");
      }
      applySavedConnection(data.connection);
      closeModal();
      toast(`连接“${data.connection.name}”已保存`, "info");
    } catch (error) {
      showStatus("error", errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const close = openModal(editing ? "编辑 Archery 连接" : "添加 Archery 连接", form, "modal-wide");
  modalCleanup = close;
  refreshVisibility();
  window.setTimeout(() => (editing ? urlInput : urlInput).focus(), 30);
}

async function testConnection(
  buildDraft: () => ConnectionFormDraft,
  validate: () => string | undefined,
  setBusy: (busy: boolean) => void,
  showStatus: (kind: "ok" | "error", message: string) => void,
  clearStatus: () => void,
): Promise<void> {
  clearStatus();
  const validation = validate();
  if (validation) {
    showStatus("error", validation);
    return;
  }
  setBusy(true);
  try {
    const health = await bridge.request<ConnectionHealth>({
      type: "testConnection",
      draft: buildDraft(),
    });
    showStatus(
      "ok",
      `连接成功：${health.instanceCount} 个可访问实例 · API ${health.apiStyle === "v1" ? "v1" : "Legacy"} · ${health.username}`,
    );
  } catch (error) {
    const hint = error instanceof HostError && error.hint ? ` ${error.hint}` : "";
    showStatus("error", `${messageOf(error)}${hint}`);
  } finally {
    setBusy(false);
  }
}

async function removeCurrentConnection(connectionId: string | undefined): Promise<void> {
  if (!connectionId) {
    closeModal();
    return;
  }
  try {
    await bridge.request({ type: "deleteConnection", connectionId });
    handleConnectionRemoved(connectionId);
    closeModal();
    toast("连接已删除", "info");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function applySavedConnection(connection: ConnectionInfo): void {
  const index = state.connections.findIndex((item) => item.id === connection.id);
  if (index >= 0) {
    state.connections[index] = connection;
  } else {
    state.connections.push(connection);
  }
  state.connections.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  state.activeConnectionId = connection.id;
  let tab = activeTab(state);
  if (!tab) {
    tab = createTab(state, { connectionId: connection.id });
    state.tabs.push(tab);
    state.activeTabId = tab.id;
  }
  if (tab.connectionId !== connection.id) {
    tab.connectionId = connection.id;
    tab.instanceName = "";
    tab.dbName = "";
    tab.schemaName = "";
    tab.tableName = "";
    tab.dbType = "";
    resetTabQueryState(tab);
  }
  state.history = emptyHistory();
  editor.setValue(tab.sql);
  renderAll();
  void syncCatalog(tab, false);
  schedulePersist();
}

function handleConnectionRemoved(connectionId: string): void {
  for (const tab of state.tabs) {
    if (tab.connectionId === connectionId && tab.requestId) {
      bridge.cancel(tab.requestId);
    }
  }
  state.connections = state.connections.filter((item) => item.id !== connectionId);
  if (state.activeConnectionId === connectionId) {
    state.activeConnectionId = state.connections[0]?.id;
  }
  state.tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
  if (!state.tabs.length) {
    const tab = createTab(state, {
      connectionId: state.activeConnectionId,
      limit: state.settings.defaultLimit,
    });
    state.tabs.push(tab);
    state.activeTabId = tab.id;
  } else if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }
  state.catalog = emptyCatalog();
  state.history = emptyHistory();
  const tab = activeTab(state);
  if (tab) {
    tab.connectionId = state.activeConnectionId;
    editor.setValue(tab.sql);
  }
  renderAll();
  schedulePersist();
  if (tab && state.activeConnectionId) {
    void syncCatalog(tab, false);
  }
}

function openValueViewer(result: QueryExecutionResult, row: number, column: number): void {
  const value = result.rows[row]?.[column];
  const title = result.columns[column] ?? `列 ${column + 1}`;
  const content = document.createElement("div");
  content.className = "value-viewer";
  const meta = document.createElement("div");
  meta.className = "value-meta";
  meta.textContent = `${title} · 第 ${row + 1} 行 · ${value === null ? "NULL" : typeof value}`;
  content.append(meta);
  const fullValue = value === null ? "NULL" : value === undefined ? "" : formatValue(value);
  const pre = document.createElement("pre");
  pre.textContent =
    fullValue.length > 1_000_000
      ? `${fullValue.slice(0, 1_000_000)}\n\n…（内容超过 1 MB，已截断显示；复制仍会复制完整值）`
      : fullValue;
  content.append(pre);
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  actions.append(spacer());
  const copy = document.createElement("button");
  copy.className = "secondary-btn";
  copy.innerHTML = `${icon("copy")}<span>复制值</span>`;
  copy.addEventListener("click", () => {
    void bridge
      .request({ type: "copyText", text: fullValue })
      .then(() => toast("已复制单元格内容", "info"))
      .catch((error: unknown) => toast(errorText(error), "error"));
  });
  actions.append(copy);
  const closeButton = document.createElement("button");
  closeButton.className = "primary-btn";
  closeButton.textContent = "关闭";
  closeButton.addEventListener("click", closeModal);
  actions.append(closeButton);
  content.append(actions);
  const close = openModal("单元格内容", content, "modal-value");
  modalCleanup = close;
}

function openModal(
  title: string,
  content: HTMLElement,
  size: "modal-wide" | "modal-value" = "modal-wide",
): () => void {
  closeModal();
  const root = byId<HTMLElement>("modal-root");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const dialog = document.createElement("div");
  dialog.className = `modal-dialog ${size}`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const header = document.createElement("div");
  header.className = "modal-header";
  const heading = document.createElement("strong");
  heading.textContent = title;
  header.append(heading);
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "关闭";
  close.innerHTML = icon("close", 14);
  header.append(close);
  const body = document.createElement("div");
  body.className = "modal-body";
  body.append(content);
  dialog.append(header, body);
  overlay.append(dialog);
  root.append(overlay);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const cleanup = (): void => {
    overlay.remove();
    modalCleanup = undefined;
    window.removeEventListener("keydown", onKey);
    previousFocus?.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    }
  };
  close.addEventListener("click", cleanup);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  window.addEventListener("keydown", onKey);
  return cleanup;
}

function closeModal(): void {
  modalCleanup?.();
  modalCleanup = undefined;
  byId<HTMLElement>("modal-root").replaceChildren();
}


function applySidebarWidth(width: number, maxWidth?: number): number {
  const sidebar = byId<HTMLElement>("sidebar");
  const workarea = sidebar.parentElement;
  const parentWidth = workarea?.getBoundingClientRect().width ?? window.innerWidth;
  const max = Math.max(220, Math.min(maxWidth ?? 720, parentWidth - 360));
  const next = Math.max(220, Math.min(max, Math.round(width)));
  sidebar.style.setProperty("--sidebar-width", `${next}px`);
  editor.refresh();
  return next;
}

function bindSidebarResizer(): void {
  const resizer = byId<HTMLElement>("sidebar-resizer");
  const sidebar = byId<HTMLElement>("sidebar");
  const workarea = sidebar.parentElement;
  let dragging = false;
  const save = (): void => {
    try {
      window.localStorage.setItem(
        "archeryQueryStudio.sidebarWidth",
        `${Math.round(sidebar.getBoundingClientRect().width)}`,
      );
    } catch {
      // localStorage may be unavailable.
    }
  };
  const restore = (): void => {
    try {
      const saved = Number(window.localStorage.getItem("archeryQueryStudio.sidebarWidth"));
      if (Number.isFinite(saved) && saved > 0) {
        applySidebarWidth(saved);
      }
    } catch {
      // localStorage may be unavailable.
    }
  };
  resizer.addEventListener("pointerdown", (event) => {
    if (!state.sidebarOpen || !workarea) {
      return;
    }
    dragging = true;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar");
    event.preventDefault();
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!dragging || !workarea) {
      return;
    }
    const rect = workarea.getBoundingClientRect();
    applySidebarWidth(event.clientX - rect.left);
    event.preventDefault();
  });
  const finish = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.classList.remove("resizing-sidebar");
    save();
    editor.refresh();
  };
  resizer.addEventListener("pointerup", finish);
  resizer.addEventListener("pointercancel", finish);
  resizer.addEventListener("dblclick", () => {
    applySidebarWidth(264);
    save();
    editor.refresh();
  });
  restore();
  window.addEventListener("resize", () => {
    if (state.sidebarOpen) {
      applySidebarWidth(sidebar.getBoundingClientRect().width);
    }
  });
}

function bindSplitter(): void {
  const splitter = byId<HTMLElement>("splitter");
  const workspace = byId<HTMLElement>("workspace");
  let dragging = false;
  const move = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const rect = workspace.getBoundingClientRect();
    const fromTop = Math.max(120, event.clientY - rect.top);
    const resultHeight = Math.max(140, Math.min(rect.height - fromTop, rect.height * 0.72));
    const percentage = Math.max(18, Math.min(68, (resultHeight / rect.height) * 100));
    workspace.style.setProperty("--result-height", `${percentage}%`);
    editor.refresh();
    event.preventDefault();
  };
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", () => {
    dragging = false;
    document.body.classList.remove("resizing");
    try {
      window.localStorage.setItem(
        "archeryQueryStudio.resultHeight",
        getComputedStyle(workspace).getPropertyValue("--result-height").trim(),
      );
    } catch {
      // localStorage may be unavailable.
    }
  });
  splitter.addEventListener("pointercancel", () => {
    dragging = false;
    document.body.classList.remove("resizing");
  });
}

function restoreSplitter(): void {
  try {
    const saved = window.localStorage.getItem("archeryQueryStudio.resultHeight");
    if (saved) {
      byId<HTMLElement>("workspace").style.setProperty("--result-height", saved);
    }
  } catch {
    // ignore
  }
}

function toggleSidebar(): void {
  state.sidebarOpen = !state.sidebarOpen;
  renderSidebarState();
  try {
    window.localStorage.setItem("archeryQueryStudio.sidebar", state.sidebarOpen ? "open" : "closed");
  } catch {
    // ignore
  }
}

function restoreSidebar(): void {
  try {
    const saved = window.localStorage.getItem("archeryQueryStudio.sidebar");
    if (saved === "closed") {
      state.sidebarOpen = false;
    }
  } catch {
    // ignore
  }
  renderSidebarState();
}

function renderSidebarState(): void {
  byId<HTMLElement>("sidebar").classList.toggle("collapsed", !state.sidebarOpen);
  byId<HTMLButtonElement>("sidebar-toggle").classList.toggle("active", state.sidebarOpen);
  editor?.refresh();
}

function renderStatus(): void {
  const connection = activeConnection(state);
  const tab = activeTab(state);
  const statusConnection = byId<HTMLElement>("status-connection");
  statusConnection.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `status-dot${connection && state.catalog.instances.length ? " online" : ""}`;
  statusConnection.append(dot);
  const connText = document.createElement("span");
  connText.textContent = connection
    ? `${connection.name} · ${connection.username}`
    : "未选择连接";
  statusConnection.append(connText);
  const position = byId<HTMLElement>("status-position");
  position.textContent = statusPosition.selected
    ? `已选 ${statusPosition.selected} 字符`
    : `行 ${statusPosition.line}，列 ${statusPosition.column}`;
  const query = byId<HTMLElement>("status-query");
  if (!tab) {
    query.textContent = "";
    return;
  }
  if (tab.status === "running") {
    query.textContent = `执行中 ${formatDuration(performance.now() - (tab.startedAt ?? performance.now()))}`;
    query.className = "status-item running";
  } else if (tab.error) {
    query.textContent = "执行失败";
    query.className = "status-item error";
  } else if (tab.result) {
    query.textContent = `${formatNumber(tab.result.rows.length)} 行${tab.elapsedMs !== undefined ? ` · ${formatDuration(tab.elapsedMs)}` : ""}`;
    query.className = "status-item";
  } else {
    query.textContent = tab.instanceName ? `${tab.instanceName}${tab.dbName ? ` / ${tab.dbName}` : ""}` : "";
    query.className = "status-item";
  }
}

function updateRunningTime(): void {
  const tab = activeTab(state);
  const element = byId<HTMLElement>("status-query");
  if (tab?.status === "running") {
    element.textContent = `执行中 ${formatDuration(performance.now() - (tab.startedAt ?? performance.now()))}`;
  }
}

function schedulePersist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    if (!state.tabs.length && !state.tableFilterHistory.length) {
      return;
    }
    void bridge.request({ type: "persistState", snapshot: toSnapshot(state) }).catch(() => undefined);
  }, 700);
}

function visibleRows(tab: TabState): {
  rows: Array<{ row: unknown[]; originalIndex: number }>;
  total: number;
  indices: number[];
} {
  if (!tab.result) {
    return { rows: [], total: 0, indices: [] };
  }
  const filter = tab.filter.trim().toLowerCase();
  let rows = tab.result.rows.map((row, index) => ({ row, originalIndex: index }));
  if (filter) {
    rows = rows.filter((entry) =>
      entry.row.some((value) => formatValue(value).toLowerCase().includes(filter)),
    );
  }
  const total = rows.length;
  const page = Math.min(Math.max(0, tab.page), Math.max(0, Math.ceil(total / tab.pageSize) - 1));
  tab.page = page;
  const pageRows = rows.slice(page * tab.pageSize, (page + 1) * tab.pageSize);
  return { rows: pageRows, total, indices: pageRows.map((entry) => entry.originalIndex) };
}


function columnWidth(
  column: string,
  columnIndex: number,
  result: QueryExecutionResult,
  indices: number[],
): number {
  let max = Math.max(10, column.length * 1.1 + 4);
  for (const index of indices.slice(0, 30)) {
    const value = result.rows[index]?.[columnIndex];
    max = Math.max(max, Math.min(48, formatValue(value).length * 0.95 + 3));
  }
  return Math.max(80, Math.min(360, Math.round(max * 7.2)));
}

function setCellContent(cell: HTMLTableCellElement, value: unknown): void {
  if (value === null || value === undefined) {
    const badge = document.createElement("span");
    badge.className = "null-badge";
    badge.textContent = "NULL";
    cell.append(badge);
    return;
  }
  const text = formatValue(value);
  cell.textContent = truncate(text, 260);
  if (text.length > 260) {
    cell.title = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  }
}


function resetTableFilter(): void {
  window.clearTimeout(redisSearchTimer);
  redisSearchSeq += 1;
  tableFilter = "";
  const feedback = document.getElementById("table-filter") as HTMLInputElement | null;
  if (feedback) {
    feedback.value = "";
  }
  const clear = document.getElementById("clear-filter") as HTMLButtonElement | null;
  if (clear) {
    clear.hidden = true;
  }
}

function resetTabQueryState(tab: TabState): void {
  if (tab.requestId) {
    bridge.cancel(tab.requestId);
    tab.requestId = undefined;
  }
  tab.status = "idle";
  tab.result = undefined;
  tab.error = undefined;
  tab.executedSql = undefined;
  tab.columnComments = undefined;
  tab.tableStructure = undefined;
  tab.selectedRows.clear();
  tab.cellEdits.clear();
  tab.hasMoreRows = false;
  tab.pageLoading = false;
  tab.startedAt = undefined;
  tab.elapsedMs = undefined;
  tab.resultTab = "results";
  tab.page = 0;
  tab.filter = "";
  tab.columnFilter = "";
  tab.sort = undefined;
  renderQueryTabs();
  renderResults();
  renderStatus();
}

function selectedInstance(): ArcheryInstance | undefined {
  return state.catalog.instances.find((item) => item.instance_name === state.catalog.instanceName);
}

function isRedisInstance(): boolean {
  return isRedisDbType(selectedInstance()?.db_type ?? activeTab(state)?.dbType);
}

function clearTabCatalog(tab: TabState): void {
  tab.instanceName = "";
  tab.dbName = "";
  tab.schemaName = "";
  tab.tableName = "";
  tab.dbType = "";
  state.catalog.instanceName = "";
  state.catalog.dbName = "";
  state.catalog.schemaName = "";
  state.catalog.databases = [];
  state.catalog.schemas = [];
  state.catalog.tables = [];
}

function actionButton(action: string, label: string, iconName: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "text-btn small";
  button.dataset.action = action;
  button.title = title;
  button.innerHTML = `${icon(iconName, 13)}<span></span>`;
  const span = button.querySelector("span");
  if (span) {
    span.textContent = label;
  }
  return button;
}

function metaItem(text: string, className = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = `meta-item${className ? ` ${className}` : ""}`;
  span.textContent = text;
  return span;
}

function messageRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "message-row";
  const key = document.createElement("span");
  key.className = "message-key";
  key.textContent = label;
  const val = document.createElement("span");
  val.className = "message-value";
  val.textContent = value;
  row.append(key, val);
  return row;
}

function sqlBlock(title: string, sql: string, fullSql?: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "sql-block";
  const head = document.createElement("div");
  head.className = "sql-block-head";
  const label = document.createElement("span");
  label.textContent = title;
  head.append(label);
  const copy = document.createElement("button");
  copy.className = "icon-btn tiny";
  copy.title = "复制 SQL";
  copy.innerHTML = icon("copy", 12);
  copy.addEventListener("click", () => {
    void bridge
      .request({ type: "copyText", text: sql })
      .then(() => toast("SQL 已复制", "info"))
      .catch((error: unknown) => toast(errorText(error), "error"));
  });
  head.append(copy);
  block.append(head);
  const pre = document.createElement("pre");
  pre.textContent = sql;
  block.append(pre);
  if (fullSql && fullSql !== sql) {
    const actual = document.createElement("div");
    actual.className = "sql-actual";
    const caption = document.createElement("span");
    caption.textContent = "Archery 实际执行（含 limit / 改写）";
    const actualPre = document.createElement("pre");
    actualPre.textContent = fullSql;
    actual.append(caption, actualPre);
    block.append(actual);
  }
  return block;
}

function errorCard(error: QueryErrorInfo): HTMLElement {
  const card = document.createElement("div");
  card.className = "error-card";
  const iconEl = document.createElement("span");
  iconEl.className = "error-icon";
  iconEl.innerHTML = icon("alert", 20);
  const content = document.createElement("div");
  content.className = "error-content";
  const title = document.createElement("strong");
  title.textContent = errorTitle(error);
  content.append(title);
  const message = document.createElement("p");
  message.textContent = error.message;
  content.append(message);
  if (error.hint) {
    const hint = document.createElement("p");
    hint.className = "error-hint";
    hint.textContent = error.hint;
    content.append(hint);
  }
  card.append(iconEl, content);
  return card;
}

function errorTitle(error: QueryErrorInfo): string {
  switch (error.code) {
    case "auth":
      return "Archery 认证失败";
    case "network":
    case "tls":
    case "timeout":
      return "无法连接 Archery";
    case "cancelled":
      return "请求已取消";
    case "twofa":
      return "需要两步验证";
    case "unsupported":
      return "不支持的登录方式";
    case "query":
      return "查询失败";
    default:
      return "操作失败";
  }
}

function emptyState(iconName: string, title: string, subtitle: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const symbol = document.createElement("div");
  symbol.className = "empty-symbol";
  symbol.innerHTML = icon(iconName, 28);
  const h = document.createElement("strong");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = subtitle;
  wrap.append(symbol, h, p);
  return wrap;
}

function loadingState(message: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "loading-state";
  const spinner = document.createElement("span");
  spinner.className = "spinner large";
  const text = document.createElement("span");
  text.textContent = message;
  wrap.append(spinner, text);
  return wrap;
}

function emptyHint(text: string): HTMLElement {
  const span = document.createElement("div");
  span.className = "empty-hint";
  span.textContent = text;
  return span;
}

function errorInline(error: QueryErrorInfo, retry: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inline-error";
  const message = document.createElement("span");
  message.textContent = error.hint ? `${error.message} ${error.hint}` : error.message;
  const button = document.createElement("button");
  button.className = "text-btn small";
  button.textContent = "重试";
  button.addEventListener("click", retry);
  wrap.append(message, button);
  return wrap;
}

function skeleton(rows: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "skeleton-list";
  for (let index = 0; index < rows; index += 1) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    wrap.append(row);
  }
  return wrap;
}

function pagerButton(label: string, page: number, disabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "pager-btn";
  button.textContent = label;
  button.disabled = disabled;
  button.dataset.page = String(page);
  return button;
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function spacer(): HTMLElement {
  const span = document.createElement("span");
  span.className = "modal-actions-spacer";
  return span;
}

function toQueryError(error: unknown): QueryErrorInfo {
  if (error instanceof HostError) {
    return { message: error.message, hint: error.hint, code: error.code, status: error.status };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function errorText(error: unknown): string {
  if (error instanceof HostError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatValue(value: unknown): string {
  if (value === null) {
    return "NULL";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.max(1, Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function columnName(item: ResourceItem): string {
  if (Array.isArray(item.raw)) {
    return String(item.raw[0] ?? item.name);
  }
  if (typeof item.raw === "object" && item.raw !== null) {
    const record = item.raw as Record<string, unknown>;
    return String(record.name ?? record.column_name ?? record.COLUMN_NAME ?? item.name);
  }
  return item.name;
}

function sanitizeName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 120) || "query";
}

function timestampForFile(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isEditorFocused(): boolean {
  const active = document.activeElement;
  return Boolean(active && active.closest(".cm-editor"));
}

function toast(message: string, severity: "info" | "warning" | "error" = "info", timeout = 4200): void {
  const root = document.getElementById("toast-root");
  if (!root) {
    return;
  }
  const item = document.createElement("div");
  item.className = `toast ${severity}`;
  const iconEl = document.createElement("span");
  iconEl.className = "toast-icon";
  iconEl.innerHTML = icon(severity === "error" ? "alert" : severity === "warning" ? "alert" : "info", 15);
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  const close = document.createElement("button");
  close.className = "toast-close";
  close.innerHTML = icon("close", 11);
  close.addEventListener("click", () => item.remove());
  item.append(iconEl, text, close);
  root.append(item);
  window.setTimeout(() => {
    item.classList.add("leaving");
    window.setTimeout(() => item.remove(), 200);
  }, timeout);
  while (root.children.length > 4) {
    root.firstElementChild?.remove();
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少界面元素 #${id}`);
  }
  return element as T;
}
