// 断点恢复：主图每个节点结束后把 state 写进 .agent/checkpoints.sqlite。
// 进程崩溃或 Ctrl-C 后，resume 从最后一个完成的节点继续；中断时正在跑的那个节点会整体重跑。
//
// 存储用 Node 内置的 node:sqlite（Electron 自带，不需要原生模块）。检查点的读写逻辑直接沿用 LangGraph 的
// MemorySaver，这里只负责每次写入后把该线程整份落盘、启动时读回来。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata, PendingWrite } from "@langchain/langgraph-checkpoint"
import { MemorySaver } from "@langchain/langgraph"
import { type Config, writeText } from "./config.ts"

export const ENTRIES = ["code", "verify"] as const
export type Entry = typeof ENTRIES[number]
const KEEP_THREADS = 20 // 只留最近这么多次运行的检查点

/** 入口编码进 thread_id，恢复时才能重建同一张图。 */
export function newThreadId(entry: Entry): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${entry}-${stamp}-${p(Math.floor(performance.now() * 1000) % 1_000_000, 6)}`
}

export function entryOf(threadId: string): Entry {
  const entry = threadId.split("-", 1)[0]
  if (!(ENTRIES as readonly string[]).includes(entry))
    throw new Error(`unknown thread id '${threadId}'`)
  return entry as Entry
}

// 检查点里是序列化好的字节：存 JSON 时转 base64
const U8 = "$u8"
const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? { [U8]: Buffer.from(v).toString("base64") } : v)
function reviver(_k: string, v: any) {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v[U8] === "string"
    ? new Uint8Array(Buffer.from(v[U8], "base64"))
    : v
}

const threadOf = (config: RunnableConfig): string => String(config.configurable?.thread_id ?? "")

export class SqliteSaver extends MemorySaver {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    super()
    this.db = db
    db.exec("CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL)")
    for (const row of db.prepare("SELECT thread_id, data FROM threads").all() as { thread_id: string, data: string }[]) {
      const { storage, writes } = JSON.parse(row.data, reviver)
      this.storage[row.thread_id] = storage
      Object.assign(this.writes, writes)
    }
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const r = await super.put(config, checkpoint, metadata)
    this.save(threadOf(config))
    return r
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    await super.putWrites(config, writes, taskId, taskPath)
    this.save(threadOf(config))
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId)
    this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId)
  }

  private save(threadId: string): void {
    if (!threadId || !this.storage[threadId])
      return
    // writes 的键是 JSON 数组 [thread_id, checkpoint_ns, checkpoint_id]
    const writes = Object.fromEntries(Object.entries(this.writes).filter(([k]) => JSON.parse(k)[0] === threadId))
    this.db.prepare("INSERT OR REPLACE INTO threads (thread_id, data, updated) VALUES (?, ?, ?)")
      .run(threadId, JSON.stringify({ storage: this.storage[threadId], writes }, replacer), Date.now())
    const old = this.db.prepare("SELECT thread_id FROM threads ORDER BY updated DESC LIMIT -1 OFFSET ?").all(KEEP_THREADS) as { thread_id: string }[]
    for (const { thread_id } of old)
      void this.deleteThread(thread_id)
  }
}

export interface OpenCheckpointer {
  saver: SqliteSaver
  close: () => void
}

/** checkpoint.enabled=false 时返回 null（不落盘，也就不能恢复）。 */
export async function openCheckpointer(cfg: Config): Promise<OpenCheckpointer | null> {
  if (cfg.get("checkpoint").enabled === false)
    return null
  const { DatabaseSync } = await import("node:sqlite") // 按需加载：不开检查点时不触发实验特性提示
  writeText(join(cfg.stateDir, ".gitkeep"), "")
  const db = new DatabaseSync(join(cfg.stateDir, "checkpoints.sqlite"))
  return { saver: new SqliteSaver(db), close: () => db.close() }
}

const lastPath = (cfg: Config) => join(cfg.stateDir, "last_thread.json")

export function remember(cfg: Config, threadId: string): void {
  writeText(lastPath(cfg), JSON.stringify({ thread_id: threadId }))
}

export function lastThread(cfg: Config): string | null {
  try {
    return JSON.parse(readFileSync(lastPath(cfg), "utf8")).thread_id ?? null
  }
  catch {
    return null
  }
}
