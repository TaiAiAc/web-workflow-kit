import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { packAsar } from "./pack-asar.mjs"

// 用法：node scripts/build-electron.mjs [bad-asar]
const badAsar = process.argv.includes("bad-asar")
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const unpacked = "dist/win-unpacked"

mkdirSync(unpacked + "/resources", { recursive: true })
const appPkg = Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, main: "app.js" }), "utf8")
const appJs = Buffer.from('console.log("electron fixture ready")\n', "utf8")
const entries = badAsar
  ? [{ name: "app.js", data: appJs }] // 缺 package.json，且版本无从校验
  : [{ name: "package.json", data: appPkg }, { name: "app.js", data: appJs }]
packAsar(entries, unpacked + "/resources/app.asar")

// 安装包：文件名必须含版本号，latest.yml 的 version / sha512 必须对得上
const installerName = pkg.name + "-" + pkg.version + ".exe"
writeFileSync("dist/" + installerName, "fake-installer-bytes")
const body = readFileSync("dist/" + installerName)
const sha512 = createHash("sha512").update(body).digest("base64")
writeFileSync("dist/latest.yml", [
  "version: " + pkg.version,
  "files:",
  "  - url: " + installerName,
  '    sha512: "' + sha512 + '"',
  "    size: " + body.length,
  "path: " + installerName,
  'sha512: "' + sha512 + '"',
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  "",
].join("\n"))
console.log("[build] electronup build 完成" + (badAsar ? "（app.asar 故意缺 package.json）" : ""))
