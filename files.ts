import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Result } from "@opencode/plugin/promise/tool"

const EDIT_TOOLS = new Set(["write", "edit", "patch"])
const EXCLUDED_DIRECTORIES = new Set(["bin", "obj", ".git", "node_modules"])
const GENERATED_CSHARP_FILE = /(?:\.g(?:\.i)?|\.generated)\.cs$/i

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>
  }
  return {}
}

export function isInsideDirectory(directory: string, path: string): boolean {
  const relativePath = relative(directory, path)
  return relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

export function isCSharpFile(path: string): boolean {
  return /\.cs$/i.test(path)
}

function isEligibleSourceFile(root: string, path: string): boolean {
  if (!isInsideDirectory(root, path) || !isCSharpFile(path)) {
    return false
  }

  const relativePath = relative(root, path)
  const directories = relativePath.split(sep)
  if (directories.some(directory => EXCLUDED_DIRECTORIES.has(directory))) {
    return false
  }

  return !GENERATED_CSHARP_FILE.test(relativePath)
}

export function changedPaths(tool: string, input: unknown, result: Result): string[] {
  if (!EDIT_TOOLS.has(tool)) {
    return []
  }

  // Use the edit's actual file list, not patch text or every dirty file in Git.
  if (Array.isArray(result.metadata?.files)) {
    const paths: string[] = []
    for (const entry of result.metadata.files) {
      const file = asObject(entry)
      if (typeof file.file === "string" && file.status !== "deleted") {
        paths.push(file.file)
      }
    }
    return paths
  }

  // Without metadata we cannot safely determine which files a patch changed.
  if (tool === "patch") {
    return []
  }

  const argumentsObject = asObject(input)
  const path = argumentsObject.filePath ?? argumentsObject.path
  return typeof path === "string" ? [path] : []
}

export async function sourceFiles(
  paths: string[],
  workingDirectory: string,
  rootDirectory: string,
): Promise<string[]> {
  const directory = await realpath(workingDirectory)
  const root = await realpath(rootDirectory)
  const files = new Set<string>()

  for (const path of new Set(paths)) {
    const absolutePath = resolve(directory, path)
    if (!isEligibleSourceFile(root, absolutePath)) {
      continue
    }

    try {
      // Check again after resolving symlinks so aliases cannot bypass exclusions.
      const actualPath = await realpath(absolutePath)
      if (isEligibleSourceFile(root, actualPath)) {
        files.add(actualPath)
      }
    } catch (error) {
      // A file may have been deleted since the edit completed.
      if (asObject(error).code !== "ENOENT") {
        throw error
      }
    }
  }

  return [...files]
}
