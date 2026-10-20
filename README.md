# opencode-http-notifier

Notify a remote HTTP endpoint whenever OpenCode's status changes.

- **Source code / issues:** <https://github.com/lucky2you/opencode-http-notifier>

Works with **both plugin APIs** from a single package:

| | V1 | V2 |
| --- | --- | --- |
| How OpenCode loads it | `server(input, options)` | `setup(ctx)` |
| Config key | `plugin` | `plugins` |
| Event envelope | `{ type, properties }` | `{ id, type, created, data, location }` |

The dual entrypoint follows OpenCode's documented "Support V1 and V2 from one
package" pattern, so you do not need two packages or two code paths. The V1
entrypoint requires OpenCode `1.18.29` or newer (the first release that accepts
the object form). Both entrypoints are covered by compile-time contract checks
against `@opencode-ai/plugin` and `@opencode/plugin`.

## Install

You can install from npm, or directly from this repository.

### From npm

```sh
npm install opencode-http-notifier
```

### From the repository (GitHub)

To install straight from `https://github.com/lucky2you/opencode-http-notifier`, use
a git install. npm supports both shorthand and full-URL forms:

```sh
# git+ssh (requires an SSH key configured for GitHub)
npm install git+ssh://git@github.com/lucky2you/opencode-http-notifier.git

# Explicit, HTTPS (works without an SSH key configured)
npm install https://github.com/lucky2you/opencode-http-notifier.git

# npm's GitHub shorthand (default branch)
npm install github:lucky2you/opencode-http-notifier

# Pin to a tag / commit
npm install github:lucky2you/opencode-http-notifier#v1.2.0
```

> The repository does not commit `dist/`, but it ships a `prepare` script that
> runs `npm run build` automatically, so installing from git compiles the package
> on your machine before OpenCode loads it. If you ever need to build by hand,
> see [Development][dev].

For OpenCode specifically, set the `package` field in your config to the URL, so
OpenCode (which delegates to npm) installs and resolves it:

```jsonc
{
  "plugins": [
    { "package": "github:lucky2you/opencode-http-notifier" }
  ]
}
```

[dev]: #development

### V2 (`plugins`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-http-notifier",
      "options": {
        "url": "https://example.com/opencode/events",
        "auth": "Bearer YOUR_TOKEN"
      }
    }
  ]
}
```

### V1 (`plugin`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-http-notifier", { "url": "https://example.com/opencode/events" }]
  ]
}
```

Local development works the same way. V2 expects a **directory** for local
plugins, and the directory's entrypoint must be discoverable. This package
ships `index.mjs` at the root (which re-exports `dist/`), so after `npm run
build` you can point OpenCode at the package root:

```jsonc
{ "plugins": [{ "package": "./path/to/opencode-http-notifier", "options": { "url": "..." } }] }
```

> Verified against OpenCode `2.0.32` on Windows. A local plugin directory that
> only declares `main`/`exports` in `package.json` is **not** loaded — OpenCode
> needs a discoverable entry file such as `index.mjs`, `index.js`, or `index.ts`
> in the directory. The bundled `index.mjs` covers that.

For project-local plugins you can also drop the package under `.opencode/plugins/`:

```text
.opencode/plugins/opencode-http-notifier/   <- copy the package here
```

## What gets sent

The notifier does **not** normalise event identity: every raw OpenCode event
type is preserved and individually matchable. OpenCode emits a range of
lifecycle events; which ones reach your endpoint is controlled by `notifyOn`.

The default scope is `["session.*"]` — every `session.*` event. All share one
envelope, regardless of the OpenCode version:

```json
{
  "type": "session.idle",
  "sessionState": "idle",
  "sessionID": "ses_abc123",
  "directory": "/home/me/project",
  "agent": "build",
  "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-5" },
  "time": { "created": 1792399807043 },
  "version": 2,
  "hostname": "my-laptop"
}
```

The `type` field is the raw provider event name. Events are individually styleable:

| Raw event | Meaning |
| --- | --- |
| `session.step.started` | A model step is running (busy) |
| `session.execution.succeeded` | A turn finished (OpenCode V2 = waiting for input) |
| `session.execution.failed` | The task failed |
| `session.retry.scheduled` | A provider request is being retried |
| `session.permission.*` | OpenCode needs your permission |

> **V1 vs V2: what means "waiting for input".** V1 emits a distinct `session.idle`
> when the session waits for input. **OpenCode V2 does not** — it emits
> `session.execution.succeeded` (after `session.step.ended`) at the end of every
> turn, which is both "task finished" and "waiting for your next input." Style
> that single signal accordingly (e.g. amber + `blink_hz` on a status dot). The
> `session.idle` key is still honoured for V1.

The `sessionState` field and the `http` verb/status machine still map onto a
derived `idle`/`busy`/`retry`/`error` hint, but display/routing is by raw type.

### Matching events with wildcards

`notifyOn` and the `events` keys accept glob patterns:

- an exact name (`session.idle`),
- a dotted-prefix wildcard (`session.*`),
- the catch-all (`*`).

When several patterns could match one event, resolution is **exact name >
more-specific wildcard > `*`**. A `session.*` key (or `*`) supplies a default so
you don't have to enumerate every event.

## Configuration

Every option can be set in plugin `options` or through an `OPENCODE_NOTIFY_*`
environment variable. Plugin options win over environment variables, which win
over defaults.

### Destination

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `OPENCODE_NOTIFY_ENABLED` | `true` | Master switch |
| `url` | `OPENCODE_NOTIFY_URL` | – | Endpoint |
| `method` | `OPENCODE_NOTIFY_METHOD` | `POST` | HTTP method |
| `headers` | `OPENCODE_NOTIFY_HEADERS` | `{}` | Static headers (JSON) |
| `query` | `OPENCODE_NOTIFY_QUERY` | `{}` | Extra query parameters (JSON) |
| `auth` | `OPENCODE_NOTIFY_AUTH` | – | `Authorization` header value |
| `authEnv` | `OPENCODE_NOTIFY_AUTH_ENV` | – | Read `Authorization` from this env var |
| `headersEnv` | `OPENCODE_NOTIFY_HEADERS_ENV` | – | Comma separated env var names forwarded as headers |

`url` supports placeholders: `{event}`, `{type}`, `{state}`, `{sessionID}`,
`{sessionKey}`, `{sessionTitle}`, `{project}`, `{directory}`, `{agent}`,
`{message}`, `{timestamp}`, `{version}`.

`{sessionKey}` is a stable, URL-safe short hash (12 chars, base64url) of the
session ID. It is ideal for device APIs that need a per-session identifier that
must fit in a small field (e.g. a status-dot `app_id` capped at 16 characters):
a session's key is stable across the session's lifetime, and different session
IDs virtually never collide. It is available anywhere placeholders are expanded,
including custom `body` templates.

### Displaying status on a status-dot device (e.g. PixelClock)

For devices with a per-session status endpoint, map OpenCode's lifecycle states
onto that API with `payload: "custom"` and per-event `body` templates. This keeps
the plugin generic — nothing about a specific device is in the plugin code; the
entire device mapping lives in configuration. See
[`examples/pixelclock.status.jsonc`](examples/pixelclock.status.jsonc) for a
complete, copy-paste example.

```jsonc
{
  "event": "session.busy",
  "body": {
    "app_id": "{sessionKey}",
    "active": true,
    "color": "amber",
    "blink_hz": 2,
    "timeout": 600000
  }
}
```

### Body encoding

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `serialize` | `OPENCODE_NOTIFY_SERIALIZE` | `json` | `json`, `form`, `none`, `query` |
| `json` | `OPENCODE_NOTIFY_JSON` | `true` | `false` is shorthand for `serialize: "form"` |
| `payload` | `OPENCODE_NOTIFY_PAYLOAD` | `simple` | `simple`, `raw`, `custom` |
| `body` | `OPENCODE_NOTIFY_BODY` | – | Custom payload template (for `payload: "custom"`) |

- `simple` — the normalised envelope above.
- `raw` — the original provider event, untouched.
- `custom` — the `body` object with placeholders expanded:

```jsonc
{
  "payload": "custom",
  "body": {
    "status": "{state}",
    "session": "{sessionID}",
    "project": "{project}",
    "event": "{event}"
  }
}
```

`serialize: "none"` sends the payload in an `X-OpenCode-Payload` header instead
of the body; `serialize: "query"` appends payload fields as query parameters.

### HTTP status mapping

If you want OpenCode's status to be visible through HTTP verbs or status codes,
use `http`. Each notification is still a single request.

```jsonc
{
  "url": "http://localhost:8080/status",
  "http": {
    "idleMethod": "PUT",
    "busyMethod": "POST",
    "errorMethod": "DELETE",
    "busyStatus": 202,
    "errorStatus": 503
  }
}
```

When no explicit `method` is configured, the request method is derived from the
state: idle/completed → `POST` (200), busy/permission/retry → `POST` (202),
error → `POST` (503). An explicit `method` disables this and always sends that
method.

To send different states to different URLs (one request each):

```jsonc
{
  "http": {
    "urls": {
      "idle": "https://example.com/hooks/idle",
      "busy": "https://example.com/hooks/busy",
      "retry": "https://example.com/hooks/retry",
      "error": "https://example.com/hooks/error",
      "created": "https://example.com/hooks/created",
      "permission": "https://example.com/hooks/permission"
    }
  }
}
```

Environment variables: `OPENCODE_NOTIFY_IDLE_URL`, `OPENCODE_NOTIFY_BUSY_URL`,
`OPENCODE_NOTIFY_ERROR_URL`.

### Delivery behaviour

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `notifyOn` | `OPENCODE_NOTIFY_NOTIFY_ON` | all but compaction | Event list, e.g. `"session.idle,session.error"` |
| `emitRepeatedStates` | `OPENCODE_NOTIFY_EMIT_REPEATED_STATES` | `true` | `false` reports only state changes |
| `debounceMs` | `OPENCODE_NOTIFY_DEBOUNCE_MS` | `500` | Collapse duplicate events for the same state |
| `throttleMs` | `OPENCODE_NOTIFY_THROTTLE_MS` | `0` | Minimum gap between requests per session |
| `timeoutMs` | `OPENCODE_NOTIFY_TIMEOUT_MS` | `5000` | Per-request timeout |
| `retries` | `OPENCODE_NOTIFY_RETRIES` | `3` | Attempts per request (exponential backoff) |
| `retryDelayMs` | `OPENCODE_NOTIFY_RETRY_DELAY_MS` | `500` | Backoff base |
| `maxQueue` | `OPENCODE_NOTIFY_MAX_QUEUE` | `100` | Oldest notifications are dropped beyond this |
| `concurrency` | `OPENCODE_NOTIFY_CONCURRENCY` | `3` | Parallel requests |
| `successStatus` | `OPENCODE_NOTIFY_SUCCESS_STATUS` | `400` | Statuses below this are success |
| `logLevel` | `OPENCODE_NOTIFY_LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info`, `debug` |

**`emitRepeatedStates`** is worth knowing about. OpenCode emits several `busy`
events per turn (one per model request, plus one per step). With the default
`true` you get every one of them. Set it to `false` to receive exactly one
notification per transition — one `busy` and one `idle` per turn — which is
what most status dashboards want:

```jsonc
{ "url": "...", "emitRepeatedStates": false }
```

4xx responses are not retried (except `408` and `429`); network errors, 5xx and
timeouts are retried with exponential backoff.

### Per-event overrides

Any option can be overridden for a single event:

```jsonc
{
  "url": "https://example.com/opencode",
  "events": {
    "session.error": {
      "url": "https://example.com/alerts",
      "headers": { "X-Priority": "high" },
      "payload": "custom",
      "body": { "text": "OpenCode failed in {project}: {message}" }
    },
    "session.compacted": { "enabled": false }
  }
}
```

## Programmatic use

The notifier is usable without OpenCode, which is handy for testing a receiver:

```ts
import { Notifier, resolveConfig } from "opencode-http-notifier"

const notifier = new Notifier({
  config: resolveConfig({ url: "http://localhost:8080/hook" }),
  logger: { debug() {}, info: console.log, warn: console.warn, error: console.error },
  apiVersion: 2,
})

notifier.notify({ type: "session.idle", data: { sessionID: "ses_1" } })
await notifier.flush()
notifier.close()
```

`onRequest(outcome)` and `onNotify(payload)` callbacks are also available on the
config for custom logging or metrics.

## Security notes

- Prefer `authEnv` over `auth` so tokens stay out of `opencode.json`:

  ```jsonc
  { "url": "https://example.com/hook", "authEnv": "OPENCODE_HOOK_TOKEN" }
  ```

  with `OPENCODE_HOOK_TOKEN="Bearer abc..."` in your environment.
- Payloads include the project directory, session ID and title. Treat the
  endpoint as trusted, or use `payload: "custom"` to send only the fields you
  need.
- Requests are fire-and-forget from a bounded queue; a slow endpoint cannot
  block OpenCode, and excess notifications are dropped rather than buffered
  forever.

## Development

```sh
npm install
npm run typecheck   # includes compile-time V1 + V2 contract checks
npm run build
npm test            # 52 tests, including a real local HTTP server
```

## License

MIT
