/**
 * Compile-time contract checks against both published plugin type packages.
 *
 * These assertions are never executed; `tsc` fails the build if the dual
 * entrypoint stops matching either API.
 */

import type * as V1 from "@opencode-ai/plugin"
import type { Plugin as V2 } from "@opencode/plugin"
import plugin, { setup, server } from "../src/index"

type V2Plugin = V2.Plugin

/** V2 reads `id` and `setup` from the default export. */
export const v2: V2Plugin = plugin
export const v2Setup: V2Plugin["setup"] = setup

/** V1 reads `server` from the module namespace (or default export). */
export const v1: Pick<V1.PluginModule, "server"> = { server }

const expectAssignable = <T>(value: T): T => value
expectAssignable<V2Plugin>(plugin)
expectAssignable<V1.PluginModule["server"]>(server)
