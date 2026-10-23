// 按 electron asar 的二进制格式写归档：8 字节 size pickle + header pickle + 文件体。
// 格式见 kit 的 verify/lib/asar.ts；这里用最小实现，供门禁的 unpacked 检查读取。
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function packAsar(entries, outPath) {
  const files = {}
  const bodies = []
  let offset = 0
  for (const e of entries) {
    files[e.name] = { size: e.data.length, offset }
    bodies.push(e.data)
    offset += e.data.length
  }
  const json = Buffer.from(JSON.stringify({ files }), "utf8")
  const pad = (4 - (json.length % 4)) % 4
  const jsonBuf = Buffer.concat([json, Buffer.alloc(pad, 0x20)])
  const payloadSize = jsonBuf.length + 4
  const headerSize = payloadSize + 4
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerSize, 4)
  const headerPickle = Buffer.alloc(8 + jsonBuf.length)
  headerPickle.writeUInt32LE(payloadSize, 0)
  headerPickle.writeUInt32LE(jsonBuf.length, 4)
  jsonBuf.copy(headerPickle, 8)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, Buffer.concat([sizePickle, headerPickle, ...bodies]))
}
