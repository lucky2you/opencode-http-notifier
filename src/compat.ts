/**
 * Adapter between the two OpenCode plugin APIs.
 *
 * Both versions expose an event stream, but the envelope differs:
 *
 * - V1: `{ type, properties }`
 * - V2: `{ id, type, created, data, location? }`
 *
 * `events.ts` reads either shape, so the adapter mainly adds the V2-only
 * vocabulary hint (V2 reports execution lifecycle events that V1 never sent)
 * and keeps `apiVersion` on the result for payload stamping.
 */

import { normalizeEvent, type NormalizedEvent } from "./events.js"

/**
 * V2 execution events carry the same meaning as a V1 `session.status`.
 * Exposed for callers that need to look at the raw envelope.
 */
export const V2_EXECUTION_EVENTS = {
  "session.execution.started": "busy",
  "session.step.started": "busy",
  "session.execution.succeeded": "idle",
  "session.execution.failed": "error",
  "session.retry.scheduled": "retry",
} as const

export interface EventAdapterOptions {
  apiVersion: 1 | 2
  directory?: string
}

/** Normalise a raw event from either API into the notifier's shape. */
export const adaptEvent = (raw: unknown, options: EventAdapterOptions): NormalizedEvent | undefined =>
  normalizeEvent(raw, {
    apiVersion: options.apiVersion,
    ...(options.directory !== undefined ? { directory: options.directory } : {}),
  })
