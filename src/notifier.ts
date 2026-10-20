/**
 * Notification pipeline: filter -> dedupe/throttle -> bounded queue -> HTTP.
 *
 * The queue keeps OpenCode's event loop responsive: notification work never
 * blocks a hook, is capped in size, and a slow endpoint cannot pile up
 * unbounded requests.
 */

import { adaptEvent } from "./compat.js"
import { configForEvent, passesNotifyOn, resolveConfig, type ResolvedConfig } from "./config.js"
import type { NormalizedEvent } from "./events.js"
import { buildPayload, planRequest, renderValue, sendRequest } from "./http.js"
import type { NotificationPayload } from "./config.js"
import type { Logger } from "./logger.js"

export interface NotifierContext {
  config: ResolvedConfig
  logger: Logger
  /** Which plugin API produced the events; stamped onto payloads. */
  apiVersion: 1 | 2
  /** Default project directory used when an event carries no location. */
  directory?: string
  hostname?: string
}

interface PendingItem {
  event: NormalizedEvent
  config: ResolvedConfig
  /** Cleanup requests survive the shared abort so a close can still send removals. */
  useCleanupSignal?: boolean
}

export class Notifier {
  readonly config: ResolvedConfig
  private readonly logger: Logger
  private readonly apiVersion: 1 | 2
  private readonly directory?: string
  private readonly hostname?: string
  private queue: PendingItem[] = []
  private inflight = 0
  private closed = false
  private readonly controller = new AbortController()
  private readonly lastSent = new Map<string, number>()
  private readonly lastEventType = new Map<string, boolean>()
  private readonly trackedKeys = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(context: NotifierContext) {
    this.config = context.config
    this.logger = context.logger
    this.apiVersion = context.apiVersion
    this.directory = context.directory
    this.hostname = context.hostname
  }

  /** Notify from a raw OpenCode event. Safe to call fire-and-forget. */
  notify(rawEvent: unknown): void {
    if (!this.config.enabled || this.closed) return
    let event: NormalizedEvent | undefined
    try {
      event = adaptEvent(rawEvent, {
        apiVersion: this.apiVersion,
        ...(this.directory !== undefined ? { directory: this.directory } : {}),
      })
    } catch (error) {
      this.logger.debug(`could not normalize event: ${String(error)}`)
      return
    }
    if (!event) return

    if (!passesNotifyOn(this.config.notifyOn, event.event)) return
    const eventConfig = configForEvent(this.config, event.event)
    if (eventConfig.enabled === false) return

    if (!this.hasDestination(eventConfig)) {
      this.logger.debug(`no destination configured for ${event.event}`)
      return
    }

    if (!this.shouldSend(event, eventConfig)) return

    if (this.queue.length >= eventConfig.maxQueue) {
      const dropped = this.queue.shift()
      if (dropped) this.logger.warn(`queue full (${eventConfig.maxQueue}); dropping ${dropped.event.event}`)
    }
    this.queue.push({ event, config: eventConfig })
    this.drain()
  }

  private hasDestination(config: ResolvedConfig): boolean {
    const urls = config.http.urls ?? {}
    return Boolean(config.url ?? config.http.url ?? Object.values(urls).some(Boolean))
  }

  /** Record the cleanup key from a delivered payload, if configured. */
  private trackFromPayload(payload: NotificationPayload, config: ResolvedConfig): void {
    const field = config.cleanup?.onClose?.field
    if (!field) return
    const value = getPath(payload, field)
    if (value !== undefined && value !== null) this.trackedKeys.add(String(value))
  }

  /** Debounce duplicate events, drop repeated events and throttle sessions. */
  private shouldSend(event: NormalizedEvent, config: ResolvedConfig): boolean {
    const sessionKey = event.sessionID ?? "global"
    // Key on the raw event type so distinct events (e.g. "task finished" and
    // "waiting for input") are never merged, even though they share a derived
    // `state` hint. `busy` may still arrive via several underlying events
    // (execution started, step started...), which the debounce collapses.
    const key = `${event.event}:${sessionKey}`
    const now = Date.now()

    // Only report repeated events when requested. Events without a session
    // (permissions, compaction) are always considered.
    if (event.sessionID && !config.emitRepeatedStates && this.lastEventType.get(key)) {
      this.logger.debug(`skipped ${event.event}: already seen`)
      return false
    }

    const previous = this.lastSent.get(key)
    if (previous !== undefined) {
      const elapsed = now - previous
      if (elapsed < Math.max(config.debounceMs, config.throttleMs)) {
        this.logger.debug(`suppressed ${key} (${elapsed}ms since last)`)
        return false
      }
    }
    this.lastSent.set(key, now)
    if (event.sessionID) this.lastEventType.set(key, true)

    // Bound the bookkeeping map; sessions are short lived but can be numerous.
    if (this.lastSent.size > 1000) {
      const cutoff = now - 60_000
      for (const [mapKey, time] of this.lastSent) {
        if (time < cutoff) {
          this.lastSent.delete(mapKey)
          this.lastEventType.delete(mapKey)
        }
      }
    }
    return true
  }

  private drain(): void {
    while (
      this.inflight < this.config.concurrency &&
      this.queue.length > 0 &&
      // After close(), carry on only with cleanup removals; everything else
      // must stop accepting new work.
      (this.queue[0]?.useCleanupSignal === true || !this.closed)
    ) {
      const item = this.queue.shift()
      if (!item) break
      this.inflight += 1
      void this.execute(item).finally(() => {
        this.inflight -= 1
        this.drain()
      })
    }
  }

  private async execute(item: PendingItem): Promise<void> {
    const { event, config } = item
    try {
      const meta = {
        ...(this.directory !== undefined ? { directory: this.directory } : {}),
        ...(this.hostname !== undefined ? { hostname: this.hostname } : {}),
      }
      const plan = planRequest(event, config, meta)
      if (!plan) return
      this.logger.debug(`${event.event} -> ${plan.method} ${plan.url}`)
      const payload = buildPayload(event, config, meta)
      this.trackFromPayload(payload, config)
      if (config.onNotify) {
        try {
          config.onNotify(payload)
        } catch (error) {
          this.logger.debug(`onNotify listener threw: ${String(error)}`)
        }
      }
      const outcome = await sendRequest(plan, event, config, this.logger, item.useCleanupSignal ? undefined : this.controller.signal)
      if (outcome.ok) this.logger.info(`${event.event} delivered (${outcome.status ?? "ok"})`)
      if (config.onRequest) {
        try {
          config.onRequest(outcome)
        } catch (error) {
          this.logger.debug(`onRequest listener threw: ${String(error)}`)
        }
      }
    } catch (error) {
      this.logger.error(`failed to notify ${event.event}: ${String(error)}`)
    }
  }

  /** Flush queued work; useful in tests and on shutdown. */
  async flush(timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    while ((this.queue.length > 0 || this.inflight > 0) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10)
        this.timers.add(timer)
      })
    }
  }

  /**
   * Send removal (cleanup) requests for every tracked key, fire-and-forget into
   * the queue so callers can await them via {@link flush}. Used on close().
   */
  private enqueueCleanup(): void {
    const cfg = this.config.cleanup?.onClose
    if (!cfg || this.trackedKeys.size === 0) return
    const remove = cfg.remove
    for (const key of this.trackedKeys) {
      const body = renderValue(remove, { key }) as Record<string, unknown> | undefined
      if (this.queue.length >= this.config.maxQueue) {
        const dropped = this.queue.shift()
        if (dropped) this.logger.warn(`queue full during cleanup; dropping ${dropped.event.event}`)
      }
      this.queue.push({
        event: cleanupEvent(key, this.apiVersion),
        config: { ...this.config, body },
        useCleanupSignal: true,
      })
    }
  }

  /** Stop accepting work, await cleanup removals, then abort in-flight requests. */
  async close(timeoutMs = 3000): Promise<void> {
    if (this.closed) return
    // Enqueue cleanup removals and drain them (they ride a dedicated signal that
    // survives the abort below). `closed` gates new work, but cleanup items are
    // still drained because they carry `useCleanupSignal`.
    this.enqueueCleanup()
    const started = Date.now()
    while (this.queue.some((item) => item.useCleanupSignal) && Date.now() - started < timeoutMs) {
      this.drain()
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5)
        this.timers.add(timer)
      })
    }
    this.closed = true
    // In-flight real notifications share the controller; abort them.
    this.controller.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}

/** Read a dotted-path value (e.g. `a.b.c`) from an arbitrary object. */
const getPath = (value: unknown, path: string): unknown => {
  let current: unknown = value
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Synthesise an internal event that routes a cleanup request to the device. */
const cleanupEvent = (key: string, apiVersion: 1 | 2): NormalizedEvent => ({
  type: "httpnotifier.cleanup",
  event: "httpnotifier.cleanup",
  raw: { type: "httpnotifier.cleanup" },
  apiVersion,
  message: key,
})

/**
 * Build a notifier from plugin options. Shared by the V1 and V2 entrypoints so
 * both versions behave identically.
 */
export const createNotifier = (
  options: Record<string, unknown> | undefined,
  logger: Logger,
  context: { directory?: string; apiVersion: 1 | 2; hostname?: string },
): Notifier => {
  return new Notifier({
    config: resolveConfig(options ?? {}),
    logger,
    apiVersion: context.apiVersion,
    ...(context.directory !== undefined ? { directory: context.directory } : {}),
    ...(context.hostname !== undefined ? { hostname: context.hostname } : {}),
  })
}
