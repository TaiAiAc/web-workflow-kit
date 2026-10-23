export interface LoginForm {
  phone: string
  code: string
}

export interface LoginResult {
  token: string
}

export async function submitLogin(form: LoginForm): Promise<LoginResult> {
  const res = await fetch("/api/login", { method: "POST", body: JSON.stringify(form.submmit) })
  return (await res.json()) as LoginResult
}
