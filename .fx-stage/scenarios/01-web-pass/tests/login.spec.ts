import { describe, expect, it } from "vitest"
import { submitLogin } from "../src/api/login"

describe("登录", () => {
  it("验证码正确时返回 token", async () => {
    const r = await submitLogin({ phone: "13800000000", code: "123456" })
    expect(r.token).toBeTruthy()
  })
})
