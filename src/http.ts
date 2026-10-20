/**
 * Build and send one HTTP notification.
 *
 * Everything here is framework free: it takes a resolved config plus a
 * normalised event and produces a request, so it can be unit tested without
 * OpenCode running.
 */

import { createHash } from "node:crypto"

import type {
  HttpMapping,
  NotificationMeta,
  NotificationPayload,
  RequestOutcome,
  ResolvedConfig,
  SessionState,
} from "./config.js"
import type { NormalizedEvent } from "./events.js"
import type { Logger } from "./logger.js"

/** Substitute `{placeholder}` tokens; unknown tokens are left untouched. */
export const renderTemplate = (template: string, values: Record<string, string | number | undefined>): string =>
  template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })

/** Deeply substitute placeholders in strings inside a JSON-like value. */
export const renderValue = (
  value: unknown,
  values: Record<string, string | number | undefined>,
): unknown => {
  if (typeof value === "string") return renderTemplate(value, values)
  if (Array.isArray(value)) return value.map((entry) => renderValue(entry, values))
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) output[key] = renderValue(entry, values)
    return output
  }
  return value
}

export const buildPayload = (
  event: NormalizedEvent,
  config: ResolvedConfig,
  meta: Partial<NotificationMeta> = {},
): NotificationPayload => {
  const created = Date.now()
  const envelope: NotificationPayload = {
    type: event.event,
    time: { created },
    version: event.apiVersion,
  }
  const set = <K extends keyof NotificationPayload>(key: K, value: NotificationPayload[K] | undefined) => {
    if (value !== undefined) envelope[key] = value
  }

  set("sessionState", event.state)
  set("sessionID", event.sessionID)
  set("sessionTitle", event.sessionTitle)
  set("project", meta.project ?? event.projectID)
  set("directory", event.directory)
  set("workspaceID", event.workspaceID)
  set("agent", event.agent)
  set("model", event.model)
  set("message", event.message)
  set("hostname", meta.hostname)

  if (config.payload === "raw") {
    const raw = event.raw as unknown as NotificationPayload
    return { ...raw, type: event.event, time: { created }, version: event.apiVersion }
  }
  if (config.payload === "custom") {
    const template = customTemplate(event, config)
    if (template) return renderValue(template, templateValues(event, created, meta)) as NotificationPayload
  }
  return envelope
}

const customTemplate = (event: NormalizedEvent, config: ResolvedConfig): Record<string, unknown> | undefined => {
  const fromEvent = config.eventBodies[event.event]
  const fromPayloads = config.payloads[event.event]
  const root = fromEvent ?? config.body ?? fromPayloads
  return root
}

export const templateValues = (
  event: NormalizedEvent,
  created: number,
  meta: Partial<NotificationMeta> = {},
): Record<string, string | number | undefined> => ({
  event: event.event,
  type: event.type,
  state: event.state,
  sessionID: event.sessionID,
  sessionKey: shortKey(event.sessionID),
  sessionTitle: event.sessionTitle,
  project: meta.project ?? event.projectID,
  directory: event.directory,
  workspaceID: event.workspaceID,
  agent: event.agent,
  message: event.message,
  timestamp: created,
  version: event.apiVersion,
})

/**
 * Deterministic, URL-safe, short identifier for a session. Intended for
 * device APIs that need a stable per-session key (e.g. a status-dot `app_id`
 * capped at 16 characters). A SHA-256 digest of the session ID is base64url
 * truncated to 12 chars — collisions are astronomically unlikely for the
 * handful of concurrently-rendered sessions a device displays.
 */
export const shortKey = (sessionID: string | undefined, length = 12): string => {
  if (!sessionID) return ""
  const digest = createHash("sha256").update(`opencode-session:${sessionID}`).digest()
  return digest.toString("base64url").slice(0, length)
}

/** What a single notification resolves to once config and state are applied. */
export interface RequestPlan {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /** Expected status used to decide success for state-derived requests. */
  expectedStatus?: number
}

const envValue = (name: string | undefined): string | undefined => {
  if (!name) return undefined
  const value = typeof process === "undefined" ? undefined : process.env[name]
  return value && value !== "" ? value : undefined
}

const stateStatus = (state: SessionState | undefined, mapping: HttpMapping, fallback: number): number => {
  if (state === "busy" || state === "retry") return mapping.busyStatus ?? 202
  if (state === "error") return mapping.errorStatus ?? 503
  return mapping.successStatus ?? fallback
}

const stateMethod = (state: SessionState | undefined, mapping: HttpMapping, fallback: string): string => {
  if (state === "error") return (mapping.errorMethod ?? fallback).toUpperCase()
  if (state === "busy" || state === "retry") return (mapping.busyMethod ?? fallback).toUpperCase()
  return (mapping.idleMethod ?? fallback).toUpperCase()
}

const encodeForm = (payload: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue
    params.append(key, typeof value === "object" ? JSON.stringify(value) : String(value))
  }
  return params.toString()
}

const appendQuery = (url: string, query: Record<string, string>): string => {
  if (Object.keys(query).length === 0) return url
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}${new URLSearchParams(query).toString()}`
}

/**
 * Decide method, URL, headers and body for one notification.
 * Returns `undefined` when the notification has nowhere to go.
 */
export const planRequest = (
  event: NormalizedEvent,
  config: ResolvedConfig,
  meta: Partial<NotificationMeta> = {},
): RequestPlan | undefined => {
  const payload = buildPayload(event, config, meta)
  const values = templateValues(event, payload.time?.created ?? Date.now(), meta)
  const mapping = config.http

  const stateKey =
    event.state ??
    (event.event === "permission.asked" ? "permission" : event.event === "session.created" ? "created" : undefined)

  // Routing precedence:
  // 1. `http.urls.<state>`  -> that URL, method derived from the state.
  // 2. `http.url`/`url`     -> plain request, or the state method machine when
  //                            no explicit method was configured.
  // 3. neither              -> nothing to send.
  let method = config.method
  const explicitMethod = config.methodExplicit === true
  let url: string | undefined
  let expectedStatus: number | undefined
  const stateUrl = stateKey ? mapping.urls?.[stateKey as keyof NonNullable<HttpMapping["urls"]>] : undefined
  const methodMapUrl = mapping.url ?? config.url

  if (stateUrl) {
    url = stateUrl
    method = mapping.method ?? stateMethod(event.state, mapping, config.method)
    expectedStatus = stateStatus(event.state, mapping, 200)
  } else if (methodMapUrl) {
    url = methodMapUrl
    if (mapping.method) method = mapping.method
    else if (!explicitMethod && event.state) {
      method = stateMethod(event.state, mapping, config.method)
      expectedStatus = stateStatus(event.state, mapping, 200)
    }
  }

  if (!url) return undefined
  const renderedUrl = renderTemplate(url, values)

  const headers: Record<string, string> = { "user-agent": "opencode-http-notifier/1", ...config.headers }
  const auth = config.auth ?? envValue(config.authEnv)
  if (auth && !("authorization" in lowerKeys(headers))) headers.authorization = auth
  for (const name of (config.headersEnv ?? "").split(/[,\s]+/)) {
    if (!name) continue
    const value = envValue(name)
    if (value) headers[name] = value
  }

  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.query)) {
    query[key] = renderTemplate(value, values)
  }

  let body: string | undefined
  const serializer = config.json === false ? "form" : config.serialize

  if (serializer === "json") {
    headers["content-type"] ??= "application/json"
    body = JSON.stringify(payload)
  } else if (serializer === "form") {
    headers["content-type"] ??= "application/x-www-form-urlencoded"
    body = encodeForm(payload)
  } else if (serializer === "query") {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue
      query[key] = typeof value === "object" ? JSON.stringify(value) : String(value)
    }
  } else {
    headers["x-opencode-payload"] = JSON.stringify(payload)
  }

  return {
    method: method.toUpperCase(),
    url: appendQuery(renderedUrl, query),
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(expectedStatus !== undefined ? { expectedStatus } : {}),
  }
}

const lowerKeys = (headers: Record<string, string>): Record<string, string> => {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) output[key.toLowerCase()] = value
  return output
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * Send one planned request, retrying non-2xx responses and network errors with
 * exponential backoff.
 */
export const sendRequest = async (
  plan: RequestPlan,
  event: NormalizedEvent,
  config: ResolvedConfig,
  logger: Logger,
  signal?: AbortSignal,
): Promise<RequestOutcome> => {
  const started = Date.now()
  let attempt = 0
  let lastError: string | undefined
  let lastStatus: number | undefined

  while (attempt < config.retries) {
    attempt += 1
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        ...(plan.body !== undefined && !["GET", "HEAD"].includes(plan.method) ? { body: plan.body } : {}),
        signal: controller.signal,
      })
      lastStatus = response.status
      const ok =
        plan.expectedStatus !== undefined
          ? response.status === plan.expectedStatus || response.status < config.successStatus
          : response.status < config.successStatus
      // Drain the body so the connection can be reused.
      try {
        await response.arrayBuffer()
      } catch {
        // Ignore body read failures; the status is what matters.
      }
      if (ok) {
        return {
          event: event.event,
          ...(event.sessionID !== undefined ? { sessionID: event.sessionID } : {}),
          ...(event.state !== undefined ? { state: event.state } : {}),
          url: plan.url,
          method: plan.method,
          status: response.status,
          ok: true,
          attempt,
          durationMs: Date.now() - started,
        }
      }
      lastError = `HTTP ${response.status}`
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break
    } catch (error) {
      lastError = controller.signal.aborted ? "request timed out or was aborted" : describeError(error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }

    if (attempt < config.retries) {
      const base = config.retryBackoffMs ?? config.retryDelayMs
      const delay = base * 2 ** (attempt - 1)
      logger.debug(`retrying ${event.event} in ${delay}ms (attempt ${attempt + 1}/${config.retries})`)
      await sleep(delay)
    }
  }

  if (lastError) logger.warn(`notification ${event.event} failed after ${attempt} attempt(s): ${lastError}`)
  return {
    event: event.event,
    ...(event.sessionID !== undefined ? { sessionID: event.sessionID } : {}),
    ...(event.state !== undefined ? { state: event.state } : {}),
    url: plan.url,
    method: plan.method,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    ok: false,
    attempt,
    ...(lastError !== undefined ? { error: lastError } : {}),
    durationMs: Date.now() - started,
  }
}

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`
    return error.message
  }
  return String(error)
}
