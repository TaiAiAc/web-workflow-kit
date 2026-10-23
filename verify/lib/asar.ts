// 最小 asar 头解析，只用于“列条目 + 读小文件”，不引入 @electron/asar。
// 格式：[UInt32 4][UInt32 headerPickleSize] + headerPickle([UInt32 payload][UInt32 strLen][json]) + 文件体
import { openSync, readSync, closeSync } from 'node:fs'

interface AsarNode {
  files?: Record<string, AsarNode>
  size?: number
  offset?: string
  unpacked?: boolean
  link?: string
}

export interface AsarArchive {
  path: string
  entries: string[]
  readFile: (entry: string) => Buffer | null
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const read = readSync(fd, buf, 0, length, position)
  if (read !== length)
    throw new Error(`asar truncated at ${position}`)
  return buf
}

export function openAsar(path: string): AsarArchive {
  const fd = openSync(path, 'r')
  try {
    const sizePickle = readAt(fd, 0, 8)
    const headerSize = sizePickle.readUInt32LE(4)
    const headerPickle = readAt(fd, 8, headerSize)
    const strLen = headerPickle.readUInt32LE(4)
    const header = JSON.parse(headerPickle.subarray(8, 8 + strLen).toString('utf8')) as AsarNode
    const base = 8 + headerSize

    const entries: string[] = []
    const index = new Map<string, AsarNode>()
    const walk = (node: AsarNode, prefix: string) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        entries.push(p)
        index.set(p, child)
        if (child.files)
          walk(child, p)
      }
    }
    walk(header, '')

    return {
      path,
      entries,
      readFile(entry) {
        const node = index.get(entry.replace(/\\/g, '/').replace(/^\/+/, ''))
        if (!node || node.files || node.unpacked || node.size == null || node.offset == null)
          return null
        const fd2 = openSync(path, 'r')
        try {
          return readAt(fd2, base + Number(node.offset), node.size)
        }
        finally {
          closeSync(fd2)
        }
      },
    }
  }
  finally {
    closeSync(fd)
  }
}

// 测试用：把 {路径: 内容} 打成 asar
export function packAsar(files: Record<string, string | Buffer>): Buffer {
  const root: AsarNode = { files: {} }
  const bodies: Buffer[] = []
  let offset = 0
  for (const [p, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const parts = p.split('/')
    let node = root
    for (const dir of parts.slice(0, -1))
      node = (node.files![dir] ??= { files: {} })
    node.files![parts.at(-1)!] = { size: data.length, offset: String(offset) }
    bodies.push(data)
    offset += data.length
  }
  const json = Buffer.from(JSON.stringify(root))
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + padded)
  headerPickle.writeUInt32LE(4 + padded, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...bodies])
}
