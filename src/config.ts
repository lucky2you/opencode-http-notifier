/**
 * Configuration model for the HTTP notifier.
 *
 * Every option can be supplied in one of three places (highest precedence first):
 *
 * 1. The plugin options object passed by OpenCode.
 * 2. Environment variables (`OPENCODE_NOTIFY_*`).
 * 3. Built-in defaults.
 *
 * V1 is configured with `plugin: [["opencode-http-notifier", {...}]]` and V2 with
 * `plugins: [{ package: "opencode-http-notifier", options: { ... } }]`.
 */

/** Status values reported for a session, mirrored across API versions. */
export type SessionState = "idle" | "busy" | "retry" | "error"

/** Events emitted when a session enters a new state. */
export type NotifyEvent =
  | "session.idle"
  | "session.busy"
  | "session.retry"
  | "session.error"
  | "session.created"
  | "permission.asked"
  | "permission.replied"
  | "session.compacted"

export const NOTIFY_EVENTS: readonly NotifyEvent[] = [
  "session.idle",
  "session.busy",
  "session.retry",
  "session.error",
  "session.created",
  "permission.asked",
  "permission.replied",
  "session.compacted",
]

/** Built-in payload profiles. `raw` forwards the provider event unchanged. */
export type PayloadMode = "raw" | "simple" | "custom"

/** How OpenCode status maps onto the outgoing HTTP request. */
export interface HttpMapping {
  /**
   * HTTP method. When omitted a single request is sent with the method that
   * matches the session state: idle/completed -> `idleMethod` (200),
   * busy/permission/retry -> `busyMethod` (202), error -> `errorMethod` (503).
   */
  method?: string
  /**
   * URL used for state-derived methods and for a plain `url`. Supports the
   * placeholders documented in {@link HttpNotifierConfig.url}.
   */
  url?: string
  /**
   * Per-state URLs. Any key that is set sends one request to that URL, which
   * lets a single endpoint receive the full status machine over HTTP verbs.
   */
  urls?: Partial<Record<SessionState | "created" | "permission", string>>
  /** Method used when the state is `idle`. Default `POST`. */
  idleMethod?: string
  /** Method used when the state is `busy` (also used for `retry`). Default `POST`. */
  busyMethod?: string
  /** Method used when the state is `error`. Default `POST`. */
  errorMethod?: string
  /** Status code sent with a plain `url` request. @default 200 */
  successStatus?: number
  /** Status code sent for `busy` in state-derived mode. @default 202 */
  busyStatus?: number
  /** Status code sent for `error` in state-derived mode. @default 503 */
  errorStatus?: number
  /** Optional `text/plain` body emitted for state-derived requests. */
  body?: string
}

export interface HttpNotifierConfig {
  /** Master switch. @default true */
  enabled?: boolean
  /**
   * Endpoint URL. Placeholders are expanded per request:
   * `{event}`, `{state}`, `{sessionID}`, `{sessionTitle}`, `{project}`,
   * `{directory}`, `{timestamp}`.
   */
  url?: string
  /** HTTP method. @default "POST" */
  method?: string
  /** Static headers merged with `auth` and `headersEnv`. */
  headers?: Record<string, string>
  /** Query string parameters appended to the URL. */
  query?: Record<string, string>
  /** `Authorization` header value, usually `Bearer ${token}`. */
  auth?: string
  /**
   * Name of an environment variable whose value is sent as the
   * `Authorization` header. Useful to keep secrets out of `opencode.json`.
   */
  authEnv?: string
  /**
   * Optional comma separated names of environment variables to forward as
   * request headers, e.g. `"X-Signature,X-Notifier-Key"`.
   */
  headersEnv?: string
  /**
   * Send the event payload as the JSON request body. Same as
   * `serialize: "json"`. @default true
   */
  json?: boolean
  /**
   * Request encoding.
   * - `json`: JSON body (default).
   * - `form`: `application/x-www-form-urlencoded` body.
   * - `none`: no body, payload is sent in the `X-OpenCode-Payload` header.
   * - `query`: no body, payload fields are appended as query parameters.
   * @default "json"
   */
  serialize?: "json" | "form" | "none" | "query"
  /**
   * Payload shape.
   * - `simple`: normalised envelope described in the README (default).
   * - `raw`: the provider event, unchanged.
   * - `custom`: the object built by `body` / `payload`.
   * @default "simple"
   */
  payload?: PayloadMode
  /**
   * Custom payload template. Placeholders are expanded and non-string values
   * are kept as-is. Used when `payload` is `custom`, unless `buildPayload` is
   * supplied.
   */
  body?: Record<string, unknown>
  /** Environment variable holding a JSON object used as the custom payload. */
  bodyEnv?: string
  /** Process-wide HTTP mapping (method/status/URL per state). */
  http?: HttpMapping
  /** Per-event overrides, merged over the base configuration. */
  events?: Partial<Record<NotifyEvent, EventOverride>>
  /**
   * Event names to notify. Defaults to every event except `session.compacted`.
   * A per-event `enabled: false` disables a single event.
   */
  /**
   * Event glob patterns to notify. Each may be an exact event type (e.g.
   * `session.idle`), a dotted-prefix wildcard (`session.*`), or the catch-all
   * `*`. Defaults to every curated event except `session.compacted`.
   */
  notifyOn?: string[]
  /**
   * Debounce identical events for the same session, in milliseconds.
   * @default 500
   */
  debounceMs?: number
  /**
   * When true (the default) every event for a session is delivered even if the
   * reported state has not changed since the previous notification. Set to
   * `false` to only send state transitions, e.g. one `busy` and one `idle` per
   * turn instead of one `busy` per model request.
   * @default true
   */
  emitRepeatedStates?: boolean
  /**
   * Minimum distance between two notifications for the same session, in
   * milliseconds.
   * @default 0
   */
  throttleMs?: number
  /** Abort a request after this many milliseconds. @default 5000 */
  timeoutMs?: number
  /** Attempts per request, including the first one. @default 3 */
  retries?: number
  /** Base delay between retries; grows exponentially. @default 500 */
  retryDelayMs?: number
  /** Delay before the first retry, overriding the exponential base. */
  retryBackoffMs?: number
  /** Maximum number of queued notifications before the oldest are dropped. @default 100 */
  maxQueue?: number
  /** Maximum number of requests in flight. @default 3 */
  concurrency?: number
  /** Treat any response status below this value as success. @default 400 */
  successStatus?: number
  /** Minimum log level printed to stderr. @default "warn" */
  logLevel?: "silent" | "error" | "warn" | "info" | "debug"
  /**
   * Callback invoked after each request attempt. Receives the outcome and the
   * notification that was sent.
   */
  onRequest?: (outcome: RequestOutcome) => void
  /**
   * Callback invoked when an event is dispatched, after filtering, before the
   * request is sent.
   */
  onNotify?: (notification: NotificationPayload) => void
}

/** Per-event configuration. Accepts the same fields as the base config. */
export type EventOverride = Omit<HttpNotifierConfig, "events" | "onRequest" | "onNotify">

export interface RawEventEnvelope {
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  location?: unknown
}

export interface NotificationMeta {
  /** Event type (raw provider event name). */
  event: string
  sessionID?: string
  sessionTitle?: string
  state?: SessionState
  project?: string
  directory?: string
  workspaceID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  message?: string
  timestamp: number
  /** `1` for V1, `2` for V2. */
  apiVersion: 1 | 2
  hostname?: string
}

export interface RequestOutcome {
  event: string
  sessionID?: string
  state?: SessionState
  url: string
  method: string
  status?: number
  ok: boolean
  attempt: number
  error?: string
  durationMs: number
}

export type NotificationPayload = {
  type: string
  sessionState?: SessionState
  sessionID?: string
  sessionTitle?: string
  project?: string
  directory?: string
  workspaceID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  message?: string
  time: { created: number }
  version: 1 | 2
  [key: string]: unknown
}

const EVENT_ALIASES: Record<string, NotifyEvent> = {
  "session.idle": "session.idle",
  idle: "session.idle",
  done: "session.idle",
  completed: "session.idle",
  "session.busy": "session.busy",
  busy: "session.busy",
  start: "session.busy",
  started: "session.busy",
  "session.retry": "session.retry",
  retry: "session.retry",
  "session.error": "session.error",
  error: "session.error",
  failed: "session.error",
  "session.created": "session.created",
  created: "session.created",
  "permission.asked": "permission.asked",
  permission: "permission.asked",
  "permission.replied": "permission.replied",
  "session.compacted": "session.compacted",
  compacted: "session.compacted",
}

const DEFAULT_EVENTS: string[] = ["session.*"]

const string = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim() !== "") return value
  if (typeof value === "number") return String(value)
  return undefined
}

const bool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(normalized)) return true
    if (["0", "false", "no", "off"].includes(normalized)) return false
  }
  return fallback
}

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  const source = record(value)
  if (!source) return undefined
  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) {
    const text = string(entry)
    if (text !== undefined) output[key] = text
  }
  return Object.keys(output).length > 0 ? output : undefined
}

export const parseEvents = (value: unknown): NotifyEvent[] | undefined => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : undefined
  if (!list) return undefined
  const resolved: NotifyEvent[] = []
  for (const entry of list) {
    const key = typeof entry === "string" ? entry.trim().toLowerCase() : ""
    const event = EVENT_ALIASES[key]
    if (event && !resolved.includes(event)) resolved.push(event)
  }
  return resolved
}

/**
 * Parse a list of notify filters. Unlike {@link parseEvents} this also keeps
 * wildcard patterns (`session.*`, `*`) so callers can match swaths of events.
 */
export const parsePatterns = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : undefined
  if (!list) return undefined
  const resolved: string[] = []
  for (const entry of list) {
    if (typeof entry !== "string") continue
    const pattern = patternKey(entry)
    if (pattern && !resolved.includes(pattern)) resolved.push(pattern)
  }
  return resolved.length > 0 ? resolved : undefined
}

/**
 * Normalise a config key into a glob pattern for event matching. Returns the
 * lowercased raw key (so wildcards like `*` and `session.*` pass through
 * untouched), or a canonical alias when the key maps to a known event.
 * `undefined` for malformed input.
 */
export const patternKey = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  return EVENT_ALIASES[lower] ?? lower
}

/**
 * Whether a glob pattern (exact event name, `session.*`, or `*`) matches a
 * concrete event type. `*` matches every event; a trailing `.*` matches any
 * event in that dotted prefix; an exact name matches only itself.
 */
export const globMatch = (pattern: string, event: string): boolean => {
  if (pattern === "*") return true
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2)
    return event === prefix || event.startsWith(`${prefix}.`)
  }
  return pattern === event
}

/**
 * Resolve the single most specific event override for a concrete event type
 * from a map keyed by glob patterns. Precedence: exact name > narrower
 * wildcard > catch-all `*`.
 */
export const matchKey = (
  map: Record<string, unknown>,
  event: string,
): string | undefined => {
  if (map[event] !== undefined) return event
  // Most specific wildcard: longest matching dotted prefix first.
  let best: string | undefined
  let bestSegments = -1
  for (const pattern of Object.keys(map)) {
    if (pattern === "*") continue
    if (!globMatch(pattern, event)) continue
    const segments = pattern.split(".").length
    if (segments > bestSegments) {
      bestSegments = segments
      best = pattern
    }
  }
  if (best !== undefined) return best
  return map["*"] !== undefined ? "*" : undefined
}

/**
 * Merge the matched event override (and its wildcard default) into a base
 * config. Called instead of {@link configForEvent} when wildcard patterns are
 * present; `configForEvent` already handles exact-name lookups.
 */
export const overrideForEvent = (
  config: ResolvedConfig,
  event: string,
): { config: ResolvedConfig; body?: Record<string, unknown> } => {
  const body = eventBodiesFor(config, event)
  const cfg = configForEvent(config, event)
  return { config: body ? { ...cfg, body } : cfg, ...(body ? { body } : {}) }
}

/** Find the matched per-event body template for a concrete event type. */
export const eventBodiesFor = (
  config: ResolvedConfig,
  event: string,
): Record<string, unknown> | undefined => {
  const key = matchKey(config.eventBodies, event)
  return key !== undefined ? config.eventBodies[key] : undefined
}

/** Find the matched per-event payload template for a concrete event type. */
export const payloadFor = (
  config: ResolvedConfig,
  event: string,
): Record<string, unknown> | undefined => {
  const key = matchKey(config.payloads, event)
  return key !== undefined ? config.payloads[key] : undefined
}

/** Find the matched per-event override for a concrete event type. */
export const eventOverride = (
  config: ResolvedConfig,
  event: string,
): EventOverride | undefined => {
  const key = matchKey(config.events, event)
  return key !== undefined ? config.events[key] : undefined
}

/** Whether a concrete event passes the configured notifyOn filters. */
export const passesNotifyOn = (notifyOn: readonly string[], event: string): boolean =>
  notifyOn.some((pattern) => globMatch(pattern, event))

const ENV_PREFIX = "OPENCODE_NOTIFY_"

const ENV_FIELDS: Record<string, keyof HttpNotifierConfig> = {
  ENABLED: "enabled",
  URL: "url",
  METHOD: "method",
  HEADERS: "headers",
  QUERY: "query",
  AUTH: "auth",
  AUTH_ENV: "authEnv",
  HEADERS_ENV: "headersEnv",
  JSON: "json",
  SERIALIZE: "serialize",
  PAYLOAD: "payload",
  BODY: "body",
  BODY_ENV: "bodyEnv",
  HTTP: "http",
  NOTIFY_ON: "notifyOn",
  DEBOUNCE_MS: "debounceMs",
  EMIT_REPEATED_STATES: "emitRepeatedStates",
  THROTTLE_MS: "throttleMs",
  TIMEOUT_MS: "timeoutMs",
  RETRIES: "retries",
  RETRY_DELAY_MS: "retryDelayMs",
  RETRY_BACKOFF_MS: "retryBackoffMs",
  MAX_QUEUE: "maxQueue",
  CONCURRENCY: "concurrency",
  SUCCESS_STATUS: "successStatus",
  LOG_LEVEL: "logLevel",
}

/** Read configuration from `OPENCODE_NOTIFY_*` environment variables. */
export const readEnvConfig = (env: Record<string, string | undefined>): Record<string, unknown> => {
  const output: Record<string, unknown> = {}
  for (const [suffix, field] of Object.entries(ENV_FIELDS)) {
    const value = env[`${ENV_PREFIX}${suffix}`]
    if (value === undefined || value === "") continue
    if (["enabled", "json", "emitRepeatedStates"].includes(field)) output[field] = bool(value, true)
    else if (["headers", "query", "body", "http"].includes(field)) output[field] = record(value)
    else if (["debounceMs", "throttleMs", "timeoutMs", "retries", "retryDelayMs", "retryBackoffMs", "maxQueue", "concurrency", "successStatus"].includes(field)) {
      const parsed = num(value)
      if (parsed !== undefined) output[field] = parsed
    } else if (field === "notifyOn") output[field] = parseEvents(value)
    else output[field] = value
  }

  const perState = ["IDLE", "BUSY", "ERROR"] as const
  const urls: Record<string, string> = {}
  for (const state of perState) {
    const value = env[`${ENV_PREFIX}${state}_URL`]
    if (value) urls[state.toLowerCase()] = value
  }
  if (Object.keys(urls).length > 0) {
    const base = record(output.http) ?? {}
    output.http = { ...base, urls: { ...(record(base.urls) ?? {}), ...urls } }
  }
  return output
}

export interface ResolvedConfig extends Required<Omit<HttpNotifierConfig,
  "url" | "auth" | "authEnv" | "headersEnv" | "body" | "bodyEnv" | "onRequest" | "onNotify" | "retryBackoffMs" | "events" | "method">> {
  /** Defaults to POST. */
  method: string
  /**
   * True when the user explicitly configured a method or a `method` mapping.
   * Untouched defaults keep the state-derived method machine enabled.
   */
  methodExplicit: boolean
  url?: string
  auth?: string
  authEnv?: string
  headersEnv?: string
  body?: Record<string, unknown>
  bodyEnv?: string
  retryBackoffMs?: number
  onRequest?: (outcome: RequestOutcome) => void
  onNotify?: (notification: NotificationPayload) => void
  events: Record<string, EventOverride>
  /** Per-event payload templates, expanded alongside `events`. */
  payloads: Record<string, Record<string, unknown>>
  /** Per-event templates that came from `events.<name>.body`. */
  eventBodies: Record<string, Record<string, unknown>>
}

const SERIALIZERS = ["json", "form", "none", "query"] as const
const PAYLOADS = ["raw", "simple", "custom"] as const
const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const normalizeHeaders = (value: unknown): Record<string, string> => stringRecord(value) ?? {}
const normalizeQuery = (value: unknown): Record<string, string> => stringRecord(value) ?? {}

const normalizeHttp = (value: unknown): HttpMapping => {
  const source = record(value) ?? {}
  const urls = stringRecord(source.urls)
  const mapping: HttpMapping = {}
  if (string(source.method)) mapping.method = string(source.method)
  if (string(source.url)) mapping.url = string(source.url)
  if (urls) mapping.urls = urls as HttpMapping["urls"]
  if (string(source.idleMethod)) mapping.idleMethod = string(source.idleMethod)
  if (string(source.busyMethod)) mapping.busyMethod = string(source.busyMethod)
  if (string(source.errorMethod)) mapping.errorMethod = string(source.errorMethod)
  const successStatus = num(source.successStatus)
  if (successStatus !== undefined) mapping.successStatus = successStatus
  const busyStatus = num(source.busyStatus)
  if (busyStatus !== undefined) mapping.busyStatus = busyStatus
  const errorStatus = num(source.errorStatus)
  if (errorStatus !== undefined) mapping.errorStatus = errorStatus
  if (typeof source.body === "string") mapping.body = source.body
  return mapping
}

const mergeHttp = (base: HttpMapping, override: HttpMapping): HttpMapping => ({
  ...base,
  ...override,
  urls: { ...(base.urls ?? {}), ...(override.urls ?? {}) },
})

/**
 * Merge plugin options over environment variables over defaults and validate
 * the result. Invalid values fall back to defaults instead of throwing so a
 * typo can never break OpenCode's startup.
 */
export const resolveConfig = (
  options: Record<string, unknown> = {},
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): ResolvedConfig => {
  const merged: Record<string, unknown> = { ...readEnvConfig(env) }
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) merged[key] = value
  }

  const notifyOn = parsePatterns(merged.notifyOn) ?? DEFAULT_EVENTS
  const eventOverridesInput = record(merged.events) ?? {}
  const events: Record<string, EventOverride> = {}
  const eventBodies: Record<string, Record<string, unknown>> = {}
  const payloads: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(eventOverridesInput)) {
    const entry = record(value)
    if (!entry) continue
    const pattern = patternKey(key)
    if (!pattern) continue
    const normalized: EventOverride = {}
    for (const field of Object.keys(entry) as Array<keyof EventOverride>) {
      if (field === "body") continue
      if (field === "headers" || field === "query") {
        ;(normalized as Record<string, unknown>)[field] = stringRecord(entry[field]) ?? {}
      } else if (field === "http") {
        normalized.http = normalizeHttp(entry.http)
      } else if (field === "enabled") {
        // Accept booleans and strings; only store when explicitly provided.
        if (entry.enabled !== undefined) normalized.enabled = bool(entry.enabled, true)
      } else if (field === "emitRepeatedStates") {
        if (entry.emitRepeatedStates !== undefined) {
          normalized.emitRepeatedStates = bool(entry.emitRepeatedStates, true)
        }
      } else if (["debounceMs", "throttleMs", "timeoutMs", "retries", "retryDelayMs", "retryBackoffMs", "maxQueue", "concurrency", "successStatus"].includes(field)) {
        const parsed = num(entry[field])
        if (parsed !== undefined) (normalized as Record<string, unknown>)[field] = parsed
      } else if (field === "url" || field === "method" || field === "auth" || field === "authEnv" || field === "headersEnv" || field === "serialize" || field === "payload" || field === "logLevel" || field === "json") {
        const text = string(entry[field])
        if (text !== undefined) (normalized as Record<string, unknown>)[field] = field === "json" ? bool(entry[field], true) : text
      }
    }
    if (Object.keys(normalized).length > 0) events[pattern] = normalized
    const body = record(entry.body)
    if (body) eventBodies[pattern] = body
  }

  const explicitPayloads = record(merged.payloads) ?? {}
  for (const [key, value] of Object.entries(explicitPayloads)) {
    const body = record(value)
    const pattern = patternKey(key)
    if (pattern && body) payloads[pattern] = body
  }

  const maxQueue = Math.max(0, Math.floor(num(merged.maxQueue) ?? 100))
  const concurrency = Math.max(1, Math.floor(num(merged.concurrency) ?? 3))
  const http = normalizeHttp(merged.http)
  const methodExplicit = typeof merged.method === "string" && merged.method !== "" || http.method !== undefined

  return {
    enabled: bool(merged.enabled, true),
    url: string(merged.url),
    method: (string(merged.method) ?? "POST").toUpperCase(),
    methodExplicit,
    headers: normalizeHeaders(merged.headers),
    query: normalizeQuery(merged.query),
    auth: string(merged.auth),
    authEnv: string(merged.authEnv),
    headersEnv: string(merged.headersEnv),
    json: bool(merged.json, true),
    serialize: oneOf(merged.serialize, SERIALIZERS, "json"),
    payload: oneOf(merged.payload, PAYLOADS, "simple"),
    body: record(merged.body),
    bodyEnv: string(merged.bodyEnv),
    http,
    events,
    payloads,
    eventBodies,
    notifyOn,
    debounceMs: Math.max(0, num(merged.debounceMs) ?? 500),
    emitRepeatedStates: bool(merged.emitRepeatedStates, true),
    throttleMs: Math.max(0, num(merged.throttleMs) ?? 0),
    timeoutMs: Math.max(1, num(merged.timeoutMs) ?? 5000),
    retries: Math.max(1, Math.floor(num(merged.retries) ?? 3)),
    retryDelayMs: Math.max(0, num(merged.retryDelayMs) ?? 500),
    retryBackoffMs: num(merged.retryBackoffMs),
    maxQueue,
    concurrency,
    successStatus: Math.max(100, num(merged.successStatus) ?? 400),
    logLevel: oneOf(merged.logLevel, LOG_LEVELS, "warn"),
    onRequest: typeof merged.onRequest === "function" ? (merged.onRequest as ResolvedConfig["onRequest"]) : undefined,
    onNotify: typeof merged.onNotify === "function" ? (merged.onNotify as ResolvedConfig["onNotify"]) : undefined,
  }
}

/** Merge one event's overrides over one event's mapping. */
export const configForEvent = (config: ResolvedConfig, event: string): ResolvedConfig => {
  const key = matchKey(config.events, event)
  const override = key !== undefined ? config.events[key] : undefined
  if (!override) return config
  const http = mergeHttp(config.http, override.http ?? {})
  const method = string(override.method)?.toUpperCase() ?? config.method
  return {
    ...config,
    ...(override as Partial<ResolvedConfig>),
    method,
    // Route with the state machine whenever neither the base config nor this
    // event pins a method.
    methodExplicit: config.methodExplicit || override.method !== undefined || override.http?.method !== undefined,
    headers: { ...config.headers, ...(override.headers ?? {}) },
    query: { ...config.query, ...(override.query ?? {}) },
    http,
    body: override.body ?? config.body,
  }
}
