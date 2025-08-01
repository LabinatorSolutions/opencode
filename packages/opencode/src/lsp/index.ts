import { App } from "../app/app"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { LSPServer } from "./server"
import { z } from "zod"
import { Config } from "../config/config"
import { spawn } from "child_process"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .openapi({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .openapi({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .openapi({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const state = App.state(
    "lsp",
    async () => {
      const clients: LSPClient.Info[] = []
      const servers: Record<string, LSPServer.Info> = LSPServer
      const cfg = await Config.get()
      for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
        const existing = servers[name]
        if (item.disabled) {
          delete servers[name]
          continue
        }
        servers[name] = {
          ...existing,
          extensions: item.extensions ?? existing.extensions,
          spawn: async (_app, root) => {
            return {
              process: spawn(item.command[0], item.command.slice(1), {
                cwd: root,
                env: {
                  ...process.env,
                  ...item.env,
                },
              }),
              initialization: item.initialization,
            }
          },
        }
      }
      return {
        broken: new Set<string>(),
        servers,
        clients,
      }
    },
    async (state) => {
      for (const client of state.clients) {
        await client.shutdown()
      }
    },
  )

  export async function init() {
    return state()
  }

  async function getClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext
    const result: LSPClient.Info[] = []
    for (const server of Object.values(LSPServer)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file, App.info())
      if (!root) continue
      if (s.broken.has(root + server.id)) continue

      const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (match) {
        result.push(match)
        continue
      }
      const handle = await server.spawn(App.info(), root)
      if (!handle) continue
      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(root + server.id)
        handle.process.kill()
        log.error("", { error: err })
      })
      if (!client) continue
      s.clients.push(client)
      result.push(client)
    }
    return result
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    const clients = await getClients(input)
    await run(async (client) => {
      if (!clients.includes(client)) return
      const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
      await client.notify.open({ path: input })
      return wait
    })
  }

  export async function diagnostics() {
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const result of await run(async (client) => client.diagnostics)) {
      for (const [path, diagnostics] of result.entries()) {
        const arr = results[path] || []
        arr.push(...diagnostics)
        results[path] = arr
      }
    }
    return results
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return run((client) => {
      return client.connection.sendRequest("textDocument/hover", {
        textDocument: {
          uri: `file://${input.file}`,
        },
        position: {
          line: input.line,
          character: input.character,
        },
      })
    })
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export async function workspaceSymbol(query: string) {
    return run((client) =>
      client.connection
        .sendRequest("workspace/symbol", {
          query,
        })
        .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
        .then((result: any) => result.slice(0, 10))
        .catch(() => []),
    ).then((result) => result.flat() as LSP.Symbol[])
  }

  export async function documentSymbol(uri: string) {
    return run((client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((result) => result.flat() as (LSP.DocumentSymbol | LSP.Symbol)[])
      .then((result) => result.filter(Boolean))
  }

  async function run<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await state().then((x) => x.clients)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
