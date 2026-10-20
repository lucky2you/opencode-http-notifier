import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { resolveConfig, parseEvents, configForEvent } from "../dist/config.js"
import { normalizeEvent } from "../dist/events.js"
import { buildPayload, planRequest, renderTemplate } from "../dist/http.js"
import { Notifier } from "../dist/notifier.js"
import { silentLogger } from "../dist/logger.js"

interface Captured {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

const startServer = async (
  handler?: (req: IncomingMessage, body: string) => { status?: number } | void,
): Promise<{ server: Server; url: string; requests: Captured[] }> => {
  const requests: Captured[] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const captured: Captured = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body }
      requests.push(captured)
      const result = handler?.(req, body) ?? {}
      res.statusCode = result.status ?? 200
      res.end("ok")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}`, requests }
}

const closeServer = (server: Server | undefined) =>
  new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))

/** V1 event envelopes, exactly as `@opencode-ai/sdk` ships them. */
const v1Idle = (sessionID = "ses_1") => ({ type: "session.idle", properties: { sessionID } })
const v1Status = (status: unknown, sessionID = "ses_1") => ({
  type: "session.status",
  properties: { sessionID, status },
})
const v1Error = (sessionID = "ses_1") => ({
  type: "session.error",
  properties: { sessionID, error: { name: "UnknownError", data: { message: "provider exploded" } } },
})

/** V2 event envelopes, exactly as `@opencode/schema` ships them. */
const v2Idle = (sessionID = "ses_1") => ({
  id: "evt_1",
  type: "session.idle",
  created: Date.now(),
  data: { sessionID },
  location: { directory: "/repo" },
})
const v2Status = (status: unknown, sessionID = "ses_1") => ({
  id: "evt_2",
  type: "session.status",
  created: Date.now(),
  data: { sessionID, status },
})
const v2Failed = (sessionID = "ses_1") => ({
  id: "evt_3",
  type: "session.execution.failed",
  created: Date.now(),
  data: { sessionID, error: { type: "api", message: "rate limited", status: 429 } },
})

const makeNotifier = (options: Record<string, unknown>, apiVersion: 1 | 2 = 1) =>
  new Notifier({
    config: resolveConfig(options, {}),
    logger: silentLogger,
    apiVersion,
    directory: "/repo",
  })

describe("config resolution", () => {
  test("defaults are safe and notification events exclude compaction", () => {
    const config = resolveConfig({}, {})
    assert.equal(config.enabled, true)
    assert.equal(config.method, "POST")
    assert.equal(config.methodExplicit, false)
    assert.equal(config.serialize, "json")
    assert.equal(config.payload, "simple")
    assert.equal(config.timeoutMs, 5000)
    assert.equal(config.retries, 3)
    assert.equal(config.concurrency, 3)
    assert.ok(config.notifyOn.includes("session.idle"))
    assert.ok(!config.notifyOn.includes("session.compacted"))
  })

  test("plugin options override environment variables which override defaults", () => {
    const config = resolveConfig(
      { url: "http://from-options", retries: 9 },
      { OPENCODE_NOTIFY_URL: "http://from-env", OPENCODE_NOTIFY_RETRIES: "2", OPENCODE_NOTIFY_TIMEOUT_MS: "1234" },
    )
    assert.equal(config.url, "http://from-options")
    assert.equal(config.retries, 9)
    assert.equal(config.timeoutMs, 1234)
  })

  test("environment variables can configure headers, auth and state URLs", () => {
    const config = resolveConfig(
      {},
      {
        OPENCODE_NOTIFY_URL: "http://x",
        OPENCODE_NOTIFY_HEADERS: '{"X-Env":"yes"}',
        OPENCODE_NOTIFY_AUTH: "Bearer secret",
        OPENCODE_NOTIFY_BUSY_URL: "http://x/busy",
        OPENCODE_NOTIFY_IDLE_URL: "http://x/idle",
      },
    )
    assert.deepEqual(config.headers, { "X-Env": "yes" })
    assert.equal(config.auth, "Bearer secret")
    assert.equal(config.http.urls?.busy, "http://x/busy")
    assert.equal(config.http.urls?.idle, "http://x/idle")
  })

  test("invalid values fall back to defaults instead of throwing", () => {
    const config = resolveConfig(
      { serialize: "yaml", payload: "nope", retries: -5, maxQueue: "abc", logLevel: "loud" },
      {},
    )
    assert.equal(config.serialize, "json")
    assert.equal(config.payload, "simple")
    assert.equal(config.retries, 1)
    assert.equal(config.maxQueue, 100)
    assert.equal(config.logLevel, "warn")
  })

  test("event names accept aliases and comma separated lists", () => {
    assert.deepEqual(parseEvents("idle,error"), ["session.idle", "session.error"])
    assert.deepEqual(parseEvents(["done", "permission"]), ["session.idle", "permission.asked"])
    assert.deepEqual(parseEvents("bogus"), [])
  })

  test("per-event overrides normalise booleans and pin methods", () => {
    const off = resolveConfig({ url: "http://x", events: { "session.idle": { enabled: false } } }, {})
    assert.equal(off.events["session.idle"]?.enabled, false)
    const offString = resolveConfig({ url: "http://x", events: { "session.idle": { enabled: "false" } } }, {})
    assert.equal(offString.events["session.idle"]?.enabled, false)

    const pinned = resolveConfig(
      { url: "http://x", events: { "session.busy": { method: "patch" } } },
      {},
    )
    const busy = configForEvent(pinned, "session.busy")
    assert.equal(busy.method, "PATCH")
    assert.equal(busy.methodExplicit, true)
    // A different event keeps the state method machine.
    assert.equal(configForEvent(pinned, "session.idle").methodExplicit, false)
  })

  test("per-event overrides do not leak between events", () => {
    const config = resolveConfig(
      {
        url: "http://x",
        headers: { "X-Base": "1" },
        events: { "session.error": { headers: { "X-Alert": "1" }, http: { urls: { error: "http://err" } } } },
      },
      {},
    )
    const error = configForEvent(config, "session.error")
    const idle = configForEvent(config, "session.idle")
    assert.deepEqual(error.headers, { "X-Base": "1", "X-Alert": "1" })
    assert.deepEqual(idle.headers, { "X-Base": "1" })
    assert.equal(error.http.urls?.error, "http://err")
    assert.equal(idle.http.urls?.error, undefined)
  })
})

describe("event normalisation across API versions", () => {
  test("V1 and V2 idle events normalise identically", () => {
    const v1 = normalizeEvent(v1Idle(), { apiVersion: 1, directory: "/repo" })
    const v2 = normalizeEvent(v2Idle(), { apiVersion: 2, directory: "/repo" })
    assert.equal(v1?.event, "session.idle")
    assert.equal(v1?.state, "idle")
    assert.equal(v1?.sessionID, "ses_1")
    assert.equal(v1?.apiVersion, 1)
    assert.equal(v2?.event, "session.idle")
    assert.equal(v2?.state, "idle")
    assert.equal(v2?.sessionID, "ses_1")
    assert.equal(v2?.apiVersion, 2)
    assert.equal(v2?.directory, "/repo")
  })

  test("V1 session.status maps to busy, retry and idle", () => {
    assert.equal(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })?.event, "session.busy")
    assert.equal(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })?.state, "busy")
    const retry = normalizeEvent(
      v1Status({ type: "retry", attempt: 2, message: "overloaded", next: 1 }),
      { apiVersion: 1 },
    )
    assert.equal(retry?.event, "session.retry")
    assert.equal(retry?.state, "retry")
    assert.equal(retry?.message, "overloaded")
    assert.equal(normalizeEvent(v1Status({ type: "idle" }), { apiVersion: 1 })?.event, "session.idle")
  })

  test("V1 session.error carries the provider message", () => {
    const event = normalizeEvent(v1Error(), { apiVersion: 1 })
    assert.equal(event?.event, "session.error")
    assert.equal(event?.state, "error")
    assert.equal(event?.message, "provider exploded")
  })

  test("V2 execution lifecycle events map onto the same states", () => {
    assert.equal(normalizeEvent(v2Status({ type: "busy" }), { apiVersion: 2 })?.event, "session.busy")
    assert.equal(normalizeEvent({ type: "session.execution.started", data: { sessionID: "s" } }, { apiVersion: 2 })?.state, "busy")
    assert.equal(normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "s" } }, { apiVersion: 2 })?.event, "session.idle")
    const failed = normalizeEvent(v2Failed(), { apiVersion: 2 })
    assert.equal(failed?.event, "session.error")
    assert.equal(failed?.state, "error")
    assert.equal(failed?.message, "rate limited")
    const retry = normalizeEvent({ type: "session.retry.scheduled", data: { sessionID: "s", message: "again" } }, { apiVersion: 2 })
    assert.equal(retry?.event, "session.retry")
  })

  test("permissions map to permission.asked, including the V1 name", () => {
    const v2 = normalizeEvent(
      { type: "permission.asked", data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["rm -rf"] } },
      { apiVersion: 2 },
    )
    assert.equal(v2?.event, "permission.asked")
    assert.equal(v2?.sessionID, "ses_1")
    const v1 = normalizeEvent(
      { type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run bash?" } },
      { apiVersion: 1 },
    )
    assert.equal(v1?.event, "permission.asked")
    assert.equal(v1?.message, "Run bash?")
  })

  test("session.created and compacted are recognised", () => {
    assert.equal(
      normalizeEvent({ type: "session.created", properties: { info: { id: "ses_9", title: "Hello" } } }, { apiVersion: 1 })?.event,
      "session.created",
    )
    assert.equal(
      normalizeEvent({ type: "session.compacted", data: { sessionID: "ses_9" } }, { apiVersion: 2 })?.event,
      "session.compacted",
    )
  })

  test("unrelated and malformed events are ignored", () => {
    assert.equal(normalizeEvent({ type: "file.edited", properties: { file: "a.ts" } }, { apiVersion: 1 }), undefined)
    assert.equal(normalizeEvent({ type: "session.status", properties: { status: { type: "weird" } } }, { apiVersion: 1 }), undefined)
    assert.equal(normalizeEvent({ properties: {} }, { apiVersion: 1 }), undefined)
    assert.equal(normalizeEvent(null, { apiVersion: 2 }), undefined)
    assert.equal(normalizeEvent("nope", { apiVersion: 2 }), undefined)
  })
})

describe("payload and request planning", () => {
  test("template rendering leaves unknown placeholders untouched", () => {
    assert.equal(
      renderTemplate("http://x/{event}/{sessionID}/{nope}", { event: "idle", sessionID: "ses_1" }),
      "http://x/idle/ses_1/{nope}",
    )
  })

  test("simple payload has a stable envelope", () => {
    const event = normalizeEvent(v1Idle(), { apiVersion: 1, directory: "/repo" })!
    const payload = buildPayload(event, resolveConfig({}, {}))
    assert.equal(payload.type, "session.idle")
    assert.equal(payload.sessionState, "idle")
    assert.equal(payload.sessionID, "ses_1")
    assert.equal(payload.version, 1)
    assert.equal(typeof payload.time.created, "number")
  })

  test("raw payload forwards the provider event", () => {
    const raw = v2Idle()
    const event = normalizeEvent(raw, { apiVersion: 2 })!
    const payload = buildPayload(event, resolveConfig({ payload: "raw" }, {}))
    assert.equal(payload.id, "evt_1")
    assert.deepEqual((payload as unknown as { data: unknown }).data, { sessionID: "ses_1" })
  })

  test("custom payload templates expand placeholders", () => {
    const event = normalizeEvent(v1Idle("ses_42"), { apiVersion: 1 })!
    const config = resolveConfig({ payload: "custom", body: { session: "{sessionID}", kind: "{event}", fixed: 1 } }, {})
    const payload = buildPayload(event, config)
    assert.equal(payload.session, "ses_42")
    assert.equal(payload.kind, "session.idle")
    assert.equal(payload.fixed, 1)
  })

  test("{sessionKey} is a stable short hash of the session ID", () => {
    const config = resolveConfig(
      { payload: "custom", body: { app_id: "{sessionKey}" } },
      {},
    )
    const a1 = buildPayload(normalizeEvent(v1Idle("ses_abcd1234"), { apiVersion: 1 })!, config)!.app_id
    const a2 = buildPayload(normalizeEvent(v1Idle("ses_abcd1234"), { apiVersion: 1 })!, config)!.app_id
    const b = buildPayload(normalizeEvent(v1Idle("ses_other999"), { apiVersion: 1 })!, config)!.app_id
    assert.equal(a1, a2, "same session must hash to the same app_id")
    assert.notEqual(a1, b, "different sessions must hash differently")
    assert.ok(a1 && String(a1).length <= 16, "app_id fits the PixelClock limit")
    assert.match(String(a1), /^[A-Za-z0-9_-]+$/, "app_id is URL-safe")
  })

  test("per-state URLs select the state method machine", () => {
    const config = resolveConfig(
      { http: { urls: { idle: "http://x/idle", busy: "http://x/busy", error: "http://x/error" } } },
      {},
    )
    const idle = planRequest(normalizeEvent(v1Idle(), { apiVersion: 1 })!, config)!
    const busy = planRequest(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })!, config)!
    const error = planRequest(normalizeEvent(v1Error(), { apiVersion: 1 })!, config)!
    assert.equal(idle.url, "http://x/idle")
    assert.equal(idle.method, "POST")
    assert.equal(busy.url, "http://x/busy")
    assert.equal(error.url, "http://x/error")
    assert.equal(error.method, "POST")
  })

  test("a plain URL uses state derived methods when no method is set", () => {
    const config = resolveConfig({ url: "http://x/status" }, {})
    const idle = planRequest(normalizeEvent(v1Idle(), { apiVersion: 1 })!, config)!
    const busy = planRequest(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })!, config)!
    assert.equal(idle.method, "POST")
    assert.equal(idle.expectedStatus, 200)
    assert.equal(busy.method, "POST")
    assert.equal(busy.expectedStatus, 202)
  })

  test("an explicit method wins over the state machine", () => {
    const config = resolveConfig({ url: "http://x", method: "put" }, {})
    const busy = planRequest(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })!, config)!
    assert.equal(busy.method, "PUT")
    assert.equal(busy.expectedStatus, undefined)
  })

  test("the state machine honours custom verbs and statuses", () => {
    const config = resolveConfig(
      { url: "http://x", http: { idleMethod: "PUT", busyMethod: "PATCH", errorMethod: "DELETE", busyStatus: 204 } },
      {},
    )
    const idle = planRequest(normalizeEvent(v1Idle(), { apiVersion: 1 })!, config)!
    const busy = planRequest(normalizeEvent(v1Status({ type: "busy" }), { apiVersion: 1 })!, config)!
    const error = planRequest(normalizeEvent(v1Error(), { apiVersion: 1 })!, config)!
    assert.equal(idle.method, "PUT")
    assert.equal(busy.method, "PATCH")
    assert.equal(busy.expectedStatus, 204)
    assert.equal(error.method, "DELETE")
    assert.equal(error.expectedStatus, 503)
  })

  test("URL placeholders, query parameters and auth are applied", () => {
    const config = resolveConfig(
      {
        url: "http://x/notify/{sessionID}?event={event}",
        query: { source: "opencode", project: "{project}" },
        auth: "Bearer test-token",
        headers: { "X-Static": "1" },
      },
      {},
    )
    const plan = planRequest(normalizeEvent(v1Idle("ses_7"), { apiVersion: 1 })!, config)!
    assert.match(plan.url, /^http:\/\/x\/notify\/ses_7\?event=session\.idle&source=opencode/)
    assert.equal(plan.headers.authorization, "Bearer test-token")
    assert.equal(plan.headers["X-Static"], "1")
    assert.equal(plan.headers["content-type"], "application/json")
  })

  test("serializers produce json, form, header and query encodings", () => {
    const event = normalizeEvent(v1Idle("ses_5"), { apiVersion: 1 })!
    const json = planRequest(event, resolveConfig({ url: "http://x" }, {}))!
    assert.deepEqual(JSON.parse(json.body!).sessionID, "ses_5")

    const form = planRequest(event, resolveConfig({ url: "http://x", serialize: "form" }, {}))!
    assert.equal(form.headers["content-type"], "application/x-www-form-urlencoded")
    assert.match(form.body!, /sessionID=ses_5/)

    const none = planRequest(event, resolveConfig({ url: "http://x", serialize: "none" }, {}))!
    assert.equal(none.body, undefined)
    assert.match(none.headers["x-opencode-payload"] ?? "", /ses_5/)

    const query = planRequest(event, resolveConfig({ url: "http://x", serialize: "query" }, {}))!
    assert.equal(query.body, undefined)
    assert.match(query.url, /sessionID=ses_5/)
  })

  test("json:false falls back to form encoding", () => {
    const plan = planRequest(
      normalizeEvent(v1Idle(), { apiVersion: 1 })!,
      resolveConfig({ url: "http://x", json: false }, {}),
    )!
    assert.equal(plan.headers["content-type"], "application/x-www-form-urlencoded")
  })
})

describe("delivery over a real HTTP server", () => {
  let server: Server | undefined
  let url = ""
  let requests: Captured[] = []

  beforeEach(async () => {
    const started = await startServer()
    server = started.server
    url = started.url
    requests = started.requests
  })

  afterEach(async () => {
    await closeServer(server)
    server = undefined
  })

  test("a V1 idle event reaches the endpoint as JSON", async () => {
    const notifier = makeNotifier({ url, timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle())
    await notifier.flush()
    notifier.close()

    assert.equal(requests.length, 1)
    const body = JSON.parse(requests[0]!.body)
    assert.equal(requests[0]!.method, "POST")
    assert.equal(body.type, "session.idle")
    assert.equal(body.sessionID, "ses_1")
    assert.equal(body.version, 1)
  })

  test("a V2 event in the same configuration delivers the same shape", async () => {
    const notifier = makeNotifier({ url, timeoutMs: 2000 }, 2)
    notifier.notify(v2Idle())
    await notifier.flush()
    notifier.close()

    assert.equal(requests.length, 1)
    const body = JSON.parse(requests[0]!.body)
    assert.equal(body.type, "session.idle")
    assert.equal(body.version, 2)
    assert.equal(body.directory, "/repo")
  })

  test("per-state URLs receive their own method and path", async () => {
    const notifier = makeNotifier(
      {
        timeoutMs: 2000,
        http: { urls: { idle: `${url}/idle`, busy: `${url}/busy`, error: `${url}/error` } },
      },
      1,
    )
    notifier.notify(v1Idle("ses_a"))
    notifier.notify(v1Status({ type: "busy" }, "ses_b"))
    notifier.notify(v1Error("ses_c"))
    await notifier.flush()
    notifier.close()

    const paths = requests.map((request) => new URL(request.url, url).pathname).sort()
    assert.deepEqual(paths, ["/busy", "/error", "/idle"])
  })

  test("state derived methods are actually sent", async () => {
    const notifier = makeNotifier({ url, timeoutMs: 2000 }, 1)
    notifier.notify(v1Status({ type: "busy" }, "ses_busy"))
    await notifier.flush()
    notifier.close()
    assert.equal(requests[0]!.method, "POST")
    assert.equal(JSON.parse(requests[0]!.body).sessionState, "busy")
  })

  test("custom headers, auth and query are delivered", async () => {
    const notifier = makeNotifier(
      { url, auth: "Bearer abc", headers: { "X-Token": "xyz" }, query: { src: "oc" }, timeoutMs: 2000 },
      1,
    )
    notifier.notify(v1Idle())
    await notifier.flush()
    notifier.close()

    const request = requests[0]!
    assert.equal(request.headers.authorization, "Bearer abc")
    assert.equal(request.headers["x-token"], "xyz")
    assert.match(request.url, /src=oc/)
  })

  test("retries a failing endpoint and reports the outcomes", async () => {
    let attempts = 0
    const flaky = await startServer(() => ({ status: ++attempts < 3 ? 500 : 200 }))
    try {
      const outcomes: Array<{ ok: boolean; attempt: number; status?: number }> = []
      const notifier = makeNotifier(
        {
          url: flaky.url,
          retries: 3,
          retryDelayMs: 5,
          timeoutMs: 2000,
          onRequest: (outcome: { ok: boolean; attempt: number; status?: number }) => outcomes.push(outcome),
        },
        1,
      )
      notifier.notify(v1Idle())
      await notifier.flush()
      notifier.close()

      assert.equal(flaky.requests.length, 3)
      assert.equal(outcomes.length, 1)
      assert.equal(outcomes[0]!.ok, true)
      assert.equal(outcomes[0]!.attempt, 3)
    } finally {
      await closeServer(flaky.server)
    }
  })

  test("does not retry client errors", async () => {
    const rejecting = await startServer(() => ({ status: 404 }))
    try {
      const notifier = makeNotifier({ url: rejecting.url, retries: 3, retryDelayMs: 5, timeoutMs: 2000 }, 1)
      notifier.notify(v1Idle())
      await notifier.flush()
      notifier.close()
      assert.equal(rejecting.requests.length, 1)
    } finally {
      await closeServer(rejecting.server)
    }
  })

  test("times out an unresponsive endpoint", async () => {
    const slow = createServer(() => {
      // Never respond.
    })
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve))
    const { port } = slow.address() as AddressInfo
    try {
      const outcomes: Array<{ ok: boolean; error?: string }> = []
      const notifier = makeNotifier(
        {
          url: `http://127.0.0.1:${port}`,
          retries: 1,
          timeoutMs: 120,
          onRequest: (outcome: { ok: boolean; error?: string }) => outcomes.push(outcome),
        },
        1,
      )
      notifier.notify(v1Idle())
      await notifier.flush(3000)
      notifier.close()
      assert.equal(outcomes.length, 1)
      assert.equal(outcomes[0]!.ok, false)
      assert.match(outcomes[0]!.error ?? "", /timed out/)
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
  })

  test("respects notifyOn filtering and per-event disabling", async () => {
    const notifier = makeNotifier({ url, notifyOn: ["session.error"], timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle())
    notifier.notify(v1Error())
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 1)
    assert.equal(JSON.parse(requests[0]!.body).type, "session.error")

    const disabled = makeNotifier(
      { url, events: { "session.idle": { enabled: false } }, timeoutMs: 2000 },
      1,
    )
    const before = requests.length
    disabled.notify(v1Idle())
    await disabled.flush()
    disabled.close()
    assert.equal(requests.length, before)
  })

  test("emitRepeatedStates:false sends only state transitions", async () => {
    const notifier = makeNotifier({ url, emitRepeatedStates: false, debounceMs: 0, timeoutMs: 2000 }, 1)
    notifier.notify(v1Status({ type: "busy" }, "ses_x"))
    notifier.notify(v1Status({ type: "busy" }, "ses_x"))
    notifier.notify(v1Status({ type: "busy" }, "ses_x"))
    notifier.notify(v1Idle("ses_x"))
    notifier.notify(v1Idle("ses_x"))
    await notifier.flush()
    notifier.close()

    const types = requests.map((request) => JSON.parse(request.body).type)
    assert.deepEqual(types, ["session.busy", "session.idle"])
  })

  test("emitRepeatedStates defaults to true so every change is reported", async () => {
    const notifier = makeNotifier({ url, debounceMs: 0, timeoutMs: 2000 }, 1)
    notifier.notify(v1Status({ type: "busy" }, "ses_y"))
    await notifier.flush()
    notifier.notify(v1Status({ type: "busy" }, "ses_y"))
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 2)
  })

  test("per-event overrides route events to different endpoints", async () => {
    const notifier = makeNotifier(
      {
        url: `${url}/default`,
        timeoutMs: 2000,
        events: {
          "session.error": { url: `${url}/alerts`, headers: { "X-Kind": "alert" } },
        },
      },
      1,
    )
    notifier.notify(v1Idle("ses_1"))
    notifier.notify(v1Error("ses_2"))
    await notifier.flush()
    notifier.close()

    const paths = requests.map((request) => new URL(request.url, url).pathname)
    assert.deepEqual(paths.sort(), ["/alerts", "/default"])
    const alert = requests.find((request) => request.url.startsWith("/alerts"))!
    assert.equal(alert.headers["x-kind"], "alert")
  })

  test("debounces duplicate events for the same session", async () => {
    const notifier = makeNotifier({ url, debounceMs: 200, timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle("ses_dup"))
    notifier.notify(v1Idle("ses_dup"))
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 1)
  })

  test("different sessions are not debounced against each other", async () => {
    const notifier = makeNotifier({ url, debounceMs: 200, timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle("ses_a"))
    notifier.notify(v1Idle("ses_b"))
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 2)
  })

  test("disabled config sends nothing", async () => {
    const notifier = makeNotifier({ url, enabled: false, timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle())
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 0)
  })

  test("no destination configured sends nothing", async () => {
    const notifier = makeNotifier({ timeoutMs: 2000 }, 1)
    notifier.notify(v1Idle())
    await notifier.flush()
    notifier.close()
    assert.equal(requests.length, 0)
  })

  test("queue drops oldest entries instead of growing without bound", async () => {
    const slow = await startServer(() => new Promise(() => {}) as never)
    try {
      const notifier = makeNotifier({ url: slow.url, maxQueue: 2, concurrency: 1, retries: 1, timeoutMs: 60 }, 1)
      for (let index = 0; index < 10; index += 1) notifier.notify(v1Idle(`ses_${index}`))
      await notifier.flush(4000)
      notifier.close()
      assert.ok(slow.requests.length <= 3, `expected a bounded queue, got ${slow.requests.length}`)
    } finally {
      await closeServer(slow.server)
    }
  })

  test("a status-dot mapping sends one stable app_id per session over HTTP", async () => {
    // Mirrors the PixelClock `/status` contract: each session maps to a stable,
    // URL-safe short `app_id`, and repeated events for it share that id.
    const config = {
      url,
      payload: "custom" as const,
      emitRepeatedStates: false as const,
      debounceMs: 0,
      timeoutMs: 2000,
      events: {
        "session.busy": { body: { app_id: "{sessionKey}", active: true, color: "amber", timeout: 600000 } },
        "session.idle": { body: { app_id: "{sessionKey}", active: true, color: "green", timeout: 600000 } },
      },
    }
    const notifier = makeNotifier(config, 1)
    notifier.notify(v1Status({ type: "busy" }, "ses_myrun"))
    // Same session emitting busy again (state unchanged) must not fire a second request.
    notifier.notify(v1Status({ type: "busy" }, "ses_myrun"))
    notifier.notify(v1Idle("ses_myrun"))
    await notifier.flush()
    notifier.close()

    assert.equal(requests.length, 2, "busy then idle only")
    const bodies = requests.map((r) => JSON.parse(r.body))
    assert.deepEqual(
      bodies.map((b) => b.app_id),
      [bodies[0].app_id, bodies[0].app_id],
      "one stable app_id per session",
    )
    assert.ok(bodies[0].app_id.length <= 16)
    assert.match(bodies[0].app_id, /^[A-Za-z0-9_-]+$/)
    assert.equal(bodies[1].color, "green")
  })
})

describe("plugin entrypoints", () => {
  test("V1 server() exposes an event hook and a dispose hook", async () => {
    const { server } = await import("../dist/index.js")
    const hooks = await server({ directory: "/repo" }, { url: "http://127.0.0.1:1", enabled: false })
    assert.equal(typeof hooks.event, "function")
    assert.equal(typeof hooks.dispose, "function")
    await hooks.dispose()
  })

  test("V2 setup() subscribes to the event stream and unsubscribes on cleanup", async () => {
    const { setup } = await import("../dist/index.js")
    const notified: unknown[] = []
    let stopped = false
    const ctx = {
      options: { url: "http://127.0.0.1:1", retries: 1, timeoutMs: 50, logLevel: "silent" },
      location: { directory: "/repo" },
      event: {
        async *subscribe(options?: { signal?: AbortSignal }) {
          try {
            yield v2Idle()
            yield v2Status({ type: "busy" })
            // Wait for cleanup to abort the subscription.
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => {
                stopped = true
                resolve()
              })
            })
          } finally {
            stopped = true
          }
        },
      },
    }
    const notifierSpy = ctx.options as Record<string, unknown>
    notifierSpy.onNotify = (payload: unknown) => notified.push(payload)

    const cleanup = await setup(ctx)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(typeof cleanup, "function")
    await cleanup()
    assert.equal(stopped, true)
    assert.equal((notified as Array<{ type: string }>)[0]?.type, "session.idle")
    assert.equal((notified as Array<{ type: string }>)[1]?.type, "session.busy")
  })

  test("the default export carries both entrypoints", async () => {
    const module = await import("../dist/index.js")
    assert.equal(module.default.id, "opencode-http-notifier")
    assert.equal(module.default.setup, module.setup)
    assert.equal(module.default.server, module.server)
  })
})
