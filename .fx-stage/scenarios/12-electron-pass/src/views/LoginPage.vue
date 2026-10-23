<script setup lang="ts">
import { ref } from "vue"
import { sendCode, submitLogin } from "../api/login"

const phone = ref("")
const code = ref("")
const countdown = ref(0)
const error = ref("")

async function onSendCode() {
  try {
    await sendCode(phone.value)
    countdown.value = 60
  } catch (e) {
    error.value = "验证码发送失败，请稍后重试"
  }
}

async function onSubmit() {
  try {
    await submitLogin({ phone: phone.value, code: code.value })
  } catch (e) {
    error.value = "手机号或验证码不正确"
  }
}
</script>

<template>
  <form class="login" @submit.prevent="onSubmit">
    <input v-model="phone" placeholder="手机号" />
    <input v-model="code" placeholder="验证码" />
    <button type="button" :disabled="countdown > 0" @click="onSendCode">
      {{ countdown > 0 ? countdown + "s" : "获取验证码" }}
    </button>
    <button type="submit">登录</button>
    <p v-if="error" class="error">{{ error }}</p>
  </form>
</template>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.error {
  color: #d92d20;
}
</style>
