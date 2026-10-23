import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir + "/assets", { recursive: true })
mkdirSync(dir + "/pkgA/pages/heavy", { recursive: true })
writeFileSync(dir + "/app.json", JSON.stringify({
  pages: ["pages/index/index"],
  subPackages: [{ root: "pkgA", pages: ["pages/heavy/heavy"] }],
}, null, 2))
writeFileSync(dir + "/app.js", 'App({})\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
// 主包只有 50KB
writeFileSync(dir + "/assets/main.bin", Buffer.alloc(50 * 1024, 7))
// 子包 2MB：若实现没排除子包，主包会变成 2MB 而超限
writeFileSync(dir + "/pkgA/pages/heavy/heavy.bin", Buffer.alloc(2048 * 1024, 7))
console.log("[build] 小程序构建完成：主包约 50KB，子包 2MB")
