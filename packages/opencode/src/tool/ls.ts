import { z } from "zod"
import { Tool } from "./tool"
import { App } from "../app/app"
import * as path from "path"
import DESCRIPTION from "./ls.txt"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100

export const ListTool = Tool.define("list", {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("The absolute path to the directory to list (must be absolute, not relative)").optional(),
    ignore: z.array(z.string()).describe("List of glob patterns to ignore").optional(),
  }),
  async execute(params) {
    const app = App.info()
    const searchPath = path.resolve(app.path.cwd, params.path || ".")

    const glob = new Bun.Glob("**/*")
    const files = []

    for await (const file of glob.scan({ cwd: searchPath, dot: true })) {
      if (IGNORE_PATTERNS.some((p) => file.includes(p))) continue
      if (params.ignore?.some((pattern) => new Bun.Glob(pattern).match(file))) continue
      files.push(file)
      if (files.length >= LIMIT) break
    }

    // Build directory structure
    const dirs = new Set<string>()
    const filesByDir = new Map<string, string[]>()

    for (const file of files) {
      const dir = path.dirname(file)
      const parts = dir === "." ? [] : dir.split("/")

      // Add all parent directories
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? "." : parts.slice(0, i).join("/")
        dirs.add(dirPath)
      }

      // Add file to its directory
      if (!filesByDir.has(dir)) filesByDir.set(dir, [])
      filesByDir.get(dir)!.push(path.basename(file))
    }

    function renderDir(dirPath: string, depth: number): string {
      const indent = "  ".repeat(depth)
      let output = ""

      if (depth > 0) {
        output += `${indent}${path.basename(dirPath)}/\n`
      }

      const childIndent = "  ".repeat(depth + 1)
      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort()

      // Render subdirectories first
      for (const child of children) {
        output += renderDir(child, depth + 1)
      }

      // Render files
      const files = filesByDir.get(dirPath) || []
      for (const file of files.sort()) {
        output += `${childIndent}${file}\n`
      }

      return output
    }

    const output = `${searchPath}/\n` + renderDir(".", 0)

    return {
      title: path.relative(app.path.root, searchPath),
      metadata: {
        count: files.length,
        truncated: files.length >= LIMIT,
      },
      output,
    }
  },
})
