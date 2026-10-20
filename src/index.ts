/**
 * opencode-http-notifier
 *
 * Notifies a remote HTTP endpoint whenever OpenCode's status changes
 * (session idle/busy/retry/error, permissions, compaction...).
 *
 * The same package supports both plugin APIs:
 *
 * - V1 loads `server(input, options)` from the exported module object.
 * - V2 loads `setup(ctx)` (and ignores the `server` field).
 *
 * Both paths build the same `Notifier`, so configuration, payloads, retries
 * and routing behave identically on either version.
 */

import { createLogger } from "./logger.js"
import { createNotifier, type Notifier } from "./notifier.js"
import { resolveConfig } from "./config.js"

export type { HttpMapping, HttpNotifierConfig, NotificationPayload, NotifyEvent, RequestOutcome, SessionState } from "./config.js"
export { NOTIFY_EVENTS, resolveConfig } from "./config.js"
export type { NormalizedEvent } from "./events.js"
export { shortKey } from "./http.js"
export { Notifier, createNotifier } from "./notifier.js"
export { createLogger } from "./logger.js"

export const PLUGIN_ID = "opencode-http-notifier"

interface Lifecycle {
  notifier: Notifier
  dispose(): Promise<void>
}

const hostname = (): string | undefined => {
  try {
    return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? undefined
  } catch {
    return undefined
  }
}

const start = (options: Record<string, unknown> | undefined, context: {
  apiVersion: 1 | 2
  directory?: string
}): Lifecycle => {
  // The logger level comes from config, so resolve once, then build the real
  // notifier with that level.
  const level = resolveConfig(options ?? {}).logLevel
  const logger = createLogger(level)
  const notifier = createNotifier(options ?? {}, logger, {
    ...context,
    ...(hostname() !== undefined ? { hostname: hostname() } : {}),
  })
  if (!notifier.config.enabled) {
    logger.info("disabled via configuration")
  } else {
    const urls = notifier.config.url ?? notifier.config.http.url
    const perState = Object.entries(notifier.config.http.urls ?? {})
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${value}`)
    const destination = urls ?? (perState.length > 0 ? perState.join(", ") : undefined)
    logger.info(destination ? `notifying ${destination}` : "no destination configured; notifications are dropped")
  }
  return { notifier, dispose: async () => notifier.close() }
}

/** V1 plugin entrypoint: `plugin: [["opencode-http-notifier", {...}]]`. */
export const server = async (
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const directory = typeof input.directory === "string" ? input.directory : undefined
  const lifecycle = start(options, { apiVersion: 1, ...(directory !== undefined ? { directory } : {}) })
  return {
    event: async ({ event }: { event: unknown }) => {
      lifecycle.notifier.notify(event)
    },
    dispose: async () => {
      // Let in-flight notifications finish before tearing the notifier down.
      await lifecycle.notifier.flush(1000).catch(() => {})
      await lifecycle.dispose()
    },
  }
}

/** V1 module shape. V1 calls `server()`; V2 ignores this field. */
export const id = PLUGIN_ID

/**
 * V2 plugin definition.
 *
 * The object literal mirrors `@opencode/plugin`'s `Plugin.define` result so
 * the package has no hard runtime dependency on either plugin type package.
 * Type packages are dev-only; OpenCode provides the runtime.
 */
export const setup = async (ctx: {
  options?: Record<string, unknown>
  location?: { directory?: string; project?: { id?: string; directory?: string } }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> }
}) => {
  const directory = ctx.location?.directory ?? ctx.location?.project?.directory
  const lifecycle = start(ctx.options, { apiVersion: 2, ...(directory !== undefined ? { directory } : {}) })
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        lifecycle.notifier.notify(event)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        createLogger(lifecycle.notifier.config.logLevel).error(`event subscription failed: ${String(error)}`)
      }
    }
  })()

  return async () => {
    controller.abort()
    // Give queued notifications a brief chance to land before shutting down.
    await lifecycle.notifier.flush(1000).catch(() => {})
    await lifecycle.dispose()
  }
}

/**
 * Default export is the V2 plugin definition with the V1 entrypoint attached,
 * as documented by OpenCode's "Support V1 and V2 from one package" guidance.
 */
const plugin = {
  id: PLUGIN_ID,
  setup,
  server,
}

export default plugin
