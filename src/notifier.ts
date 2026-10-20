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
import { buildPayload, planRequest, sendRequest } from "./http.js"
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
    if (event.sessionID && !config.emitRepeatedStates && this.lastEventType.get(event.event)) {
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
    if (event.sessionID) this.lastEventType.set(event.event, true)

    // Bound the bookkeeping map; sessions are short lived but can be numerous.
    if (this.lastSent.size > 1000) {
      const cutoff = now - 60_000
      for (const [mapKey, time] of this.lastSent) {
        if (time < cutoff) this.lastSent.delete(mapKey)
      }
    }
    return true
  }

  private drain(): void {
    while (!this.closed && this.inflight < this.config.concurrency && this.queue.length > 0) {
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
      if (config.onNotify) {
        try {
          config.onNotify(buildPayload(event, config, meta))
        } catch (error) {
          this.logger.debug(`onNotify listener threw: ${String(error)}`)
        }
      }
      const outcome = await sendRequest(plan, event, config, this.logger, this.controller.signal)
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

  /** Stop accepting work and abort in-flight requests. */
  close(): void {
    this.closed = true
    this.queue = []
    this.controller.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}

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
