import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface CompletionTable {
  name: string;
  detail?: string;
}

export interface CompletionColumn {
  name: string;
  table?: string;
}

const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "UNION ALL",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "TRUNCATE TABLE",
  "WITH",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "NOT IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
  "DISTINCT",
  "ASC",
  "DESC",
  "EXPLAIN",
  "DESCRIBE",
  "SHOW",
  "USE",
  "DATABASE",
  "TABLE",
  "INDEX",
  "VIEW",
  "PRIMARY KEY",
  "FOREIGN KEY",
  "DEFAULT",
  "CURRENT_TIMESTAMP",
  "NOW()",
];

const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--vscode-editor-foreground)",
      backgroundColor: "var(--vscode-editor-background)",
      fontSize: "14px",
    },
    ".cm-scroller": {
      fontFamily: "var(--vscode-editor-font-family, 'SFMono-Regular', Consolas, monospace)",
      lineHeight: "1.65",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "10px 0 24px",
      caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
    },
    ".cm-line": { padding: "0 14px 0 8px" },
    ".cm-gutters": {
      backgroundColor: "var(--vscode-editorGutter-background, transparent)",
      color: "var(--vscode-editorLineNumber-foreground)",
      border: "none",
      paddingLeft: "4px",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--vscode-editor-lineHighlightBackground, rgba(127,127,127,.08))",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--vscode-editorLineNumber-activeForeground)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor:
        "var(--vscode-editor-selectionBackground, var(--archery-editor-selection, rgba(38, 79, 120, 0.72))) !important",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--vscode-editorCursor-foreground, #aeafad)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-panels": {
      backgroundColor: "var(--vscode-editorWidget-background)",
      color: "var(--vscode-editorWidget-foreground)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--vscode-editorSuggestWidget-background)",
      color: "var(--vscode-editorSuggestWidget-foreground)",
      border: "1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-widget-border))",
      borderRadius: "4px",
      boxShadow: "0 2px 10px rgba(0,0,0,.28)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))",
      color: "var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))",
    },
    ".cm-tooltip-autocomplete ul li": { padding: "3px 8px" },
    ".cm-completionLabel": { fontFamily: "var(--vscode-editor-font-family)" },
    ".cm-completionDetail": { color: "var(--vscode-descriptionForeground)", marginLeft: "8px" },
    ".cm-placeholder": { color: "var(--vscode-input-placeholderForeground)" },
    ".cm-matchingBracket": {
      backgroundColor: "var(--vscode-editorBracketMatch-background)",
      outline: "1px solid var(--vscode-editorBracketMatch-border)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--vscode-editor-findMatchHighlightBackground)",
    },
  },
  { dark: isDarkTheme() },
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--vscode-symbolIcon-keywordForeground, #569cd6)", fontWeight: "600" },
  { tag: tags.string, color: "var(--vscode-symbolIcon-stringForeground, #ce9178)" },
  { tag: tags.number, color: "var(--vscode-symbolIcon-numberForeground, #b5cea8)" },
  { tag: tags.bool, color: "var(--vscode-symbolIcon-booleanForeground, #569cd6)" },
  { tag: tags.null, color: "var(--vscode-symbolIcon-nullForeground, #569cd6)" },
  { tag: tags.comment, color: "var(--vscode-editor-commentForeground, #6a9955)", fontStyle: "italic" },
  { tag: tags.typeName, color: "var(--vscode-symbolIcon-classForeground, #4ec9b0)" },
  { tag: tags.operator, color: "var(--vscode-editor-foreground)" },
  { tag: tags.variableName, color: "var(--vscode-symbolIcon-variableForeground, #9cdcfe)" },
  { tag: tags.propertyName, color: "var(--vscode-symbolIcon-propertyForeground, #9cdcfe)" },
  { tag: tags.function(tags.variableName), color: "var(--vscode-symbolIcon-functionForeground, #dcdcaa)" },
  { tag: tags.special(tags.string), color: "var(--vscode-symbolIcon-stringForeground, #ce9178)" },
]);

export interface RunIntent {
  selected: boolean;
}

export class SqlEditor {
  readonly view: EditorView;
  private tables: CompletionTable[] = [];
  private columns: CompletionColumn[] = [];
  private suppressChange = false;
  private changeListener?: (value: string) => void;
  private cursorListener?: (line: number, column: number, selected: number) => void;

  constructor(parent: HTMLElement, initialValue = "") {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          placeholder("输入 SQL；选中语句后按 Ctrl/⌘ + Enter 只执行选中部分…"),
          sql(),
          syntaxHighlighting(highlight),
          autocompletion({
            override: [this.completionSource],
            activateOnTyping: true,
            maxRenderedOptions: 120,
          }),
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                preventDefault: true,
                run: () => {
                  const selected = this.getSelection().length > 0;
                  void this.runListener?.({ selected });
                  return true;
                },
              },
              {
                key: "Mod-Shift-Enter",
                preventDefault: true,
                run: () => {
                  void this.runListener?.({ selected: true });
                  return true;
                },
              },
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  void this.saveListener?.();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.suppressChange) {
              this.changeListener?.(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              this.cursorListener?.(
                line.number,
                head - line.from + 1,
                update.state.selection.main.to - update.state.selection.main.from,
              );
            }
          }),
        ],
      }),
    });
  }

  private runListener?: (intent: RunIntent) => void | Promise<void>;
  private saveListener?: () => void | Promise<void>;

  onRun(listener: (intent: RunIntent) => void | Promise<void>): void {
    this.runListener = listener;
  }

  onSave(listener: () => void | Promise<void>): void {
    this.saveListener = listener;
  }

  onChange(listener: (value: string) => void): void {
    this.changeListener = listener;
  }

  onCursor(listener: (line: number, column: number, selected: number) => void): void {
    this.cursorListener = listener;
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  setValue(value: string): void {
    if (value === this.getValue()) {
      return;
    }
    this.suppressChange = true;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: value },
      });
    } finally {
      this.suppressChange = false;
    }
  }

  getSelection(): string {
    const selection = this.view.state.selection.main;
    return selection.empty ? "" : this.view.state.sliceDoc(selection.from, selection.to);
  }

  replaceSelection(value: string): void {
    this.view.dispatch(this.view.state.replaceSelection(value));
    this.view.focus();
  }

  setCompletions(tables: CompletionTable[], columns: CompletionColumn[] = []): void {
    this.tables = tables;
    this.columns = columns;
  }

  focus(): void {
    this.view.focus();
  }

  refresh(): void {
    this.view.requestMeasure();
  }

  private readonly completionSource = (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$.\u4e00-\u9fa5]*/);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }
    const options: Completion[] = [];
    const dot = word.text.lastIndexOf(".");
    const prefix = (dot >= 0 ? word.text.slice(dot + 1) : word.text).toLowerCase();
    const from = dot >= 0 ? word.to - (word.text.length - dot - 1) : word.from;
    for (const table of this.tables) {
      if (prefix && !table.name.toLowerCase().includes(prefix)) {
        continue;
      }
      options.push({
        label: table.name,
        type: "class",
        detail: table.detail ?? "table",
        apply: table.name,
      });
    }
    for (const column of this.columns) {
      if (prefix && !column.name.toLowerCase().includes(prefix)) {
        continue;
      }
      options.push({
        label: column.name,
        type: "property",
        detail: column.table ? `column · ${column.table}` : "column",
        apply: column.name,
      });
    }
    for (const keyword of KEYWORDS) {
      if (prefix && !keyword.toLowerCase().startsWith(prefix)) {
        continue;
      }
      options.push({ label: keyword, type: "keyword", apply: keyword });
    }
    return {
      from,
      options,
      validFor: /^[\w$.\u4e00-\u9fa5]*$/i,
    };
  };
}

function isDarkTheme(): boolean {
  return (
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast")
  );
}
