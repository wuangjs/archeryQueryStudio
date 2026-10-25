import type {
  ArcheryInstance,
  QueryExecutionResult,
  QueryLogEntry,
  QueryLogPage,
  ResourceItem,
  TableDescription,
} from "../types";
import { ArcheryError } from "./errors";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function unwrapEnvelope(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload && ("status" in payload || "msg" in payload)) {
    return payload.data;
  }
  return payload;
}

export function envelopeMessage(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.msg === "string" && payload.msg.trim()) {
    return payload.msg;
  }
  return undefined;
}

export function envelopeStatus(payload: unknown): number {
  if (isRecord(payload) && typeof payload.status === "number") {
    return payload.status;
  }
  return 0;
}

export function normalizeInstances(payload: unknown): ArcheryInstance[] {
  const data = unwrapEnvelope(payload);
  const list = asArray(data);
  return list
    .map((item): ArcheryInstance | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const name = asString(item.instance_name ?? item.name ?? item.instance);
      if (!name) {
        return undefined;
      }
      const instance: ArcheryInstance = {
        ...item,
        instance_name: name,
        db_type: asString(item.db_type || item.dbType || "unknown"),
      };
      const id = asNumber(item.id);
      if (id !== undefined) {
        instance.id = id;
      }
      if (item.type !== undefined) {
        instance.type = asString(item.type);
      }
      return instance;
    })
    .filter((item): item is ArcheryInstance => Boolean(item));
}

export function normalizeResources(payload: unknown): ResourceItem[] {
  const data = unwrapEnvelope(payload);
  const list = asArray(data);
  return list
    .map((item): ResourceItem | undefined => {
      if (typeof item === "string" || typeof item === "number") {
        return { name: String(item), raw: item };
      }
      if (isRecord(item)) {
        const name = asString(
          item.name ??
            item.table_name ??
            item.TABLE_NAME ??
            item.db_name ??
            item.schema_name ??
            item.database ??
            item.Tables_in_db ??
            item.Field ??
            item.field ??
            item.column_name ??
            item.COLUMN_NAME ??
            item.columnName,
        );
        return name ? { name, raw: item } : undefined;
      }
      return undefined;
    })
    .filter((item): item is ResourceItem => Boolean(item));
}

export function normalizeExecution(payload: unknown): QueryExecutionResult {
  const status = envelopeStatus(payload);
  const message = envelopeMessage(payload);
  if (status !== 0) {
    throw new ArcheryError("query", message || "Archery 查询失败", {
      status,
      detail: safeJson(payload),
    });
  }
  let data = unwrapEnvelope(payload);
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // A scalar result is legal for some engines; keep it as a message.
      return { columns: ["结果"], rows: [[data]], raw: { value: data } };
    }
  }
  if (data === null || data === undefined) {
    return { columns: [], rows: [], message: message ?? "查询执行完成", raw: {} };
  }
  if (Array.isArray(data)) {
    return arrayResult(data, payload);
  }
  if (!isRecord(data)) {
    return { columns: ["结果"], rows: [[data]], raw: { value: data } };
  }
  if (typeof data.error === "string" && data.error.trim()) {
    throw new ArcheryError("query", data.error, { detail: safeJson(payload) });
  }
  const nested = isRecord(data.data) ? data.data : data;
  let columns = toStringList(nested.column_list ?? nested.columns ?? nested.headers);
  const rawRows = asArray(nested.rows ?? nested.data ?? nested.result);
  let rows: unknown[][];
  if (rawRows.length > 0 && rawRows.every(isRecord)) {
    if (columns.length === 0) {
      columns = Object.keys(rawRows[0] as JsonRecord);
    }
    rows = rawRows.map((row) => columns.map((column) => (row as JsonRecord)[column]));
  } else {
    rows = rawRows.map((row) => (Array.isArray(row) ? row : [row]));
  }
  const raw = { ...nested };
  const affectedRows = asNumber(nested.affected_rows ?? nested.affectedRows ?? nested.effect_row);
  return {
    columns,
    rows,
    queryTime: asNumber(nested.query_time ?? nested.queryTime),
    maskTime: asNumber(nested.mask_time ?? nested.maskTime),
    secondsBehindMaster: asNumber(
      nested.seconds_behind_master ?? nested.secondsBehindMaster ?? nested.slave_lag,
    ),
    fullSql: asString(nested.full_sql ?? nested.fullSql ?? nested.sql) || undefined,
    affectedRows,
    message: message || (affectedRows !== undefined ? `影响 ${affectedRows} 行` : undefined),
    raw,
  };
}

function arrayResult(data: unknown[], payload: unknown): QueryExecutionResult {
  let columns: string[] = [];
  let rows: unknown[][];
  if (data.length > 0 && data.every(isRecord)) {
    columns = Object.keys(data[0] as JsonRecord);
    rows = data.map((row) => columns.map((column) => (row as JsonRecord)[column]));
  } else {
    rows = data.map((row) => (Array.isArray(row) ? row : [row]));
    if (rows.length > 0) {
      columns = rows[0].map((_, index) => `列 ${index + 1}`);
    }
  }
  return { columns, rows, raw: { data, payload } };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

export function normalizeDescription(payload: unknown): TableDescription {
  const result = normalizeExecution(payload);
  const statementCandidate =
    typeof result.raw.create_table === "string"
      ? result.raw.create_table
      : typeof result.raw.CreateTable === "string"
        ? result.raw.CreateTable
        : typeof result.raw.statement === "string"
          ? result.raw.statement
          : undefined;
  let statement = statementCandidate;
  if (!statement && result.rows.length === 1 && result.rows[0]?.length >= 2) {
    const last = result.rows[0][result.rows[0].length - 1];
    if (typeof last === "string" && /\bCREATE\s+(TABLE|VIEW)\b/i.test(last)) {
      statement = last;
    }
  }
  return { result, statement };
}

export function normalizeQueryLogs(payload: unknown, fallbackTotal = 0): QueryLogPage {
  let source = payload;
  if (isRecord(payload) && "data" in payload && !("rows" in payload)) {
    source = payload.data;
  }
  const rowsValue = isRecord(source) ? source.rows : source;
  const rows = asArray(rowsValue).map((item): QueryLogEntry | undefined => {
    if (!isRecord(item)) {
      return undefined;
    }
    const id = asNumber(item.id);
    if (id === undefined) {
      return undefined;
    }
    return {
      id,
      instanceName: asString(item.instance_name),
      dbName: asString(item.db_name),
      sql: asString(item.sqllog ?? item.sql),
      effectRow: asNumber(item.effect_row),
      costTime: asNumber(item.cost_time),
      userDisplay: asString(item.user_display) || undefined,
      favorite: Boolean(item.favorite),
      alias: asString(item.alias) || undefined,
      createTime: asString(item.create_time) || undefined,
    };
  });
  const filtered = rows.filter((row): row is QueryLogEntry => Boolean(row));
  const total = isRecord(source) ? (asNumber(source.total) ?? fallbackTotal) : fallbackTotal;
  return { total: total || filtered.length, rows: filtered };
}

export function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text && text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return undefined;
  }
}
