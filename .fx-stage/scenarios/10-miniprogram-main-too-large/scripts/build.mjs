import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir + "/assets", { recursive: true })
mkdirSync(dir + "/pkgA", { recursive: true })
writeFileSync(dir + "/app.json", JSON.stringify({
  pages: ["pages/index/index"],
  subPackages: [{ root: "pkgA", pages: ["pages/heavy/heavy"] }],
}, null, 2))
writeFileSync(dir + "/app.js", 'App({})\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
// 主包 300KB，超过 main_max_kb: 200
writeFileSync(dir + "/assets/main.bin", Buffer.alloc(300 * 1024, 7))
// 子包 120KB：不计入主包
writeFileSync(dir + "/pkgA/heavy.bin", Buffer.alloc(120 * 1024, 7))
console.log("[build] 小程序构建完成：主包约 300KB")
