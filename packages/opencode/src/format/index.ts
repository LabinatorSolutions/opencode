import { App } from "../app/app"
import { Bus } from "../bus"
import { File } from "../file"
import { Log } from "../util/log"
import path from "path"

import * as Formatter from "./formatter"
import { Config } from "../config/config"
import { mergeDeep } from "remeda"

export namespace Format {
  const log = Log.create({ service: "format" })

  const state = App.state("format", async () => {
    const enabled: Record<string, boolean> = {}
    const cfg = await Config.get()

    const formatters = { ...Formatter } as Record<string, Formatter.Info>
    for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
      if (item.disabled) {
        delete formatters[name]
        continue
      }
      const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
        command: [],
        extensions: [],
        ...item,
      })
      result.enabled = async () => true
      result.name = name
      formatters[name] = result
    }

    return {
      enabled,
      formatters,
    }
  })

  async function isEnabled(item: Formatter.Info) {
    const s = await state()
    let status = s.enabled[item.name]
    if (status === undefined) {
      status = await item.enabled()
      s.enabled[item.name] = status
    }
    return status
  }

  async function getFormatter(ext: string) {
    const formatters = await state().then((x) => x.formatters)
    const result = []
    for (const item of Object.values(formatters)) {
      log.info("checking", { name: item.name, ext })
      if (!item.extensions.includes(ext)) continue
      if (!(await isEnabled(item))) continue
      result.push(item)
    }
    return result
  }

  export function init() {
    log.info("init")
    Bus.subscribe(File.Event.Edited, async (payload) => {
      const file = payload.properties.file
      log.info("formatting", { file })
      const ext = path.extname(file)

      for (const item of await getFormatter(ext)) {
        log.info("running", { command: item.command })
        const proc = Bun.spawn({
          cmd: item.command.map((x) => x.replace("$FILE", file)),
          cwd: App.info().path.cwd,
          env: item.environment,
          stdout: "ignore",
          stderr: "ignore",
        })
        const exit = await proc.exited
        if (exit !== 0)
          log.error("failed", {
            command: item.command,
            ...item.environment,
          })
      }
    })
  }
}
