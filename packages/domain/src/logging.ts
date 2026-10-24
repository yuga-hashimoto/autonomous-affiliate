import { newTraceId } from "./ids.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|tracking[-_]?url/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Long random-looking secrets: sk-..., ghp_..., AKIA..., JWT-ish, base64/hex >= 24 chars.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:postgres(?:ql)?:\/\/)[^\s]+/gi,
];

const SENSITIVE_URL_QUERY_PARAMS = /^(token|key|secret|sig|signature|access_token|api[-_]?key|password)$/i;

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    for (const paramName of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_QUERY_PARAMS.test(paramName)) {
        url.searchParams.set(paramName, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep a short prefix so logs remain greppable without leaking the secret.
      const head = match.slice(0, Math.min(4, match.length));
      return `${head}${REDACTED}`;
    });
  }
  out = out.replace(EMAIL_PATTERN, (match) => `${match.slice(0, 2)}${REDACTED}`);
  return out;
}

function redactPrimitive(value: unknown): unknown {
  if (typeof value === "string") {
    const asUrl = redactUrl(value);
    return redactString(asUrl);
  }
  return value;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactPrimitive(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  readonly traceId: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  baseFields?: Record<string, unknown>;
  traceId?: string;
}

const memorySinkLines: string[] = [];

export function createMemorySink(): LogSink & { lines: string[] } {
  const lines = memorySinkLines.length > 0 ? memorySinkLines : [];
  memorySinkLines.length = 0;
  const sink = ((line: string) => {
    lines.push(line);
  }) as LogSink & { lines: string[] };
  sink.lines = lines;
  return sink;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink: LogSink =
    options.sink ??
    ((line) => {
      process.stdout.write(`${line}\n`);
    });
  const baseFields = options.baseFields ?? {};
  const traceId = options.traceId ?? newTraceId();

  function write(logLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[logLevel] < LEVEL_WEIGHT[level]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message,
      trace_id: traceId,
      ...redactValue({ ...baseFields, ...fields }) as Record<string, unknown>,
    };
    sink(JSON.stringify(entry));
  }

  return {
    traceId,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (extraFields) =>
      createLogger({ level, sink, baseFields: { ...baseFields, ...extraFields }, traceId }),
  };
}
