export interface LoginForm {
  phone: string
  code: string
}

export interface LoginResult {
  token: string
}

export async function sendCode(phone: string): Promise<void> {
  await fetch("/api/sms/code", { method: "POST", body: JSON.stringify({ phone }) })
}

export async function submitLogin(form: LoginForm): Promise<LoginResult> {
  const res = await fetch("/api/login", { method: "POST", body: JSON.stringify(form) })
  return (await res.json()) as LoginResult
}
