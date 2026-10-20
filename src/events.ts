/**
 * Translate raw OpenCode events into a single normalised shape.
 *
 * V1 events look like `{ type, properties }`. V2 events look like
 * `{ id, type, created, data, location? }`. Both are reduced here to an
 * internal `NormalizedEvent` so the notifier never has to care which server
 * produced it.
 */

import type { NotifyEvent, RawEventEnvelope, SessionState } from "./config.js"

export interface NormalizedEvent {
  /** OpenCode event name, e.g. `session.idle`. */
  type: string
  /** Notifier-level event used for filtering and routing. */
  event: NotifyEvent
  sessionID?: string
  sessionTitle?: string
  state?: SessionState
  directory?: string
  workspaceID?: string
  projectID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  message?: string
  /** Provider payload, untouched. */
  raw: RawEventEnvelope
  apiVersion: 1 | 2
}

type Dict = Record<string, unknown>

const asDict = (value: unknown): Dict | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/** Read the provider payload regardless of API version. */
export const eventBody = (event: RawEventEnvelope): Dict => {
  const data = asDict(event.data)
  if (data) return data
  const properties = asDict(event.properties)
  if (properties) return properties
  return {}
}

const toState = (value: unknown): SessionState | undefined => {
  const dict = asDict(value)
  const type = asString(dict?.type) ?? asString(value)
  if (type === "busy" || type === "idle" || type === "retry") return type
  return undefined
}

const readModel = (value: unknown): { providerID: string; modelID: string } | undefined => {
  const dict = asDict(value)
  const providerID = asString(dict?.providerID)
  const modelID = asString(dict?.modelID) ?? asString(dict?.id)
  return providerID && modelID ? { providerID, modelID } : undefined
}

const errorMessage = (value: unknown): string | undefined => {
  const dict = asDict(value)
  if (!dict) return undefined
  const data = asDict(dict.data)
  // V1 errors are `{ name, data: { message } }`; prefer the descriptive text.
  return (
    asString(dict.message) ??
    asString(data?.message) ??
    asString(dict.name) ??
    asString(dict.type)
  )
}

export interface NormalizeContext {
  /** Fallback directory, normally the plugin location. */
  directory?: string
  apiVersion: 1 | 2
}

/**
 * Reduce a provider event to the notifier's shape, or `undefined` when the
 * event is not interesting for notifications.
 */
export const normalizeEvent = (
  event: unknown,
  context: NormalizeContext,
): NormalizedEvent | undefined => {
  const envelope = asDict(event)
  const type = asString(envelope?.type)
  if (!envelope || !type) return undefined

  const body = eventBody(envelope as unknown as RawEventEnvelope)
  const location = asDict(envelope.location)
  const info = asDict(body.info)
  const session = asDict(body.session)
  const permission = asDict(body.permission) ?? asDict(body.request)
  const errorDict = asDict(body.error)

  const sessionID =
    asString(body.sessionID) ??
    asString(info?.id) ??
    asString(session?.id) ??
    asString(permission?.sessionID) ??
    asString(body.id)
  const sessionTitle = asString(info?.title) ?? asString(session?.title) ?? asString(body.title)
  const directory =
    asString(location?.directory) ??
    asString(body.directory) ??
    asString(info?.directory) ??
    context.directory
  const workspaceID = asString(location?.workspaceID) ?? asString(info?.workspaceID)
  const projectID = asString(body.projectID) ?? asString(info?.projectID)
  const agent = asString(body.agent) ?? asString(info?.agent)
  const model = readModel(body.model) ?? readModel(info?.model)

  const base = {
    type,
    sessionID,
    sessionTitle,
    directory,
    workspaceID,
    projectID,
    agent,
    model,
    raw: envelope as unknown as RawEventEnvelope,
    apiVersion: context.apiVersion,
  }

  // Only surface events that carry meaning for a remote observer.
  if (type === "session.status") {
    const state = toState(body.status)
    if (!state) return undefined
    return {
      ...base,
      event: `session.${state}` as NotifyEvent,
      state,
      ...(state === "retry" ? { message: asString(body.status && asDict(body.status)?.message) } : {}),
    }
  }

  switch (type) {
    case "session.idle":
      return { ...base, event: "session.idle", state: "idle" }
    case "session.created":
      return { ...base, event: "session.created", state: "idle" }
    case "session.compacted":
      return { ...base, event: "session.compacted" }
    case "session.error":
    case "session.execution.failed":
      return {
        ...base,
        event: "session.error",
        state: "error",
        message: errorMessage(errorDict) ?? asString(body.message),
      }
    case "session.execution.succeeded":
      return { ...base, event: "session.idle", state: "idle" }
    case "session.execution.started":
      return { ...base, event: "session.busy", state: "busy" }
    case "session.retry.scheduled":
      return {
        ...base,
        event: "session.retry",
        state: "retry",
        message: asString(body.reason) ?? asString(body.message),
      }
    case "permission.asked":
    case "permission.updated":
      return {
        ...base,
        event: "permission.asked",
        state: "busy",
        message: asString(permission?.title) ?? asString(body.title),
      }
    case "permission.replied":
      return {
        ...base,
        event: "permission.replied",
        message: asString(body.response) ?? asString(body.reply),
      }
    default:
      return undefined
  }
}
