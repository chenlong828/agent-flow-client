#!/usr/bin/env node
/**
 * DSH ACP 最小探针：spawn `dsh --profile acp`，走一遍
 * initialize → session/new → session/prompt → session/close → session/list。
 *
 * 只依赖 Node 内置模块；协议帧是 ACP v1 的 newline-delimited JSON-RPC。
 * 说明见同目录 README.md。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROTOCOL_VERSION = 1

function usage () {
  console.error(`用法: node acp-probe.mjs --dsh <path/to/bin.js> [options]

选项:
  --dsh <path>          dsh CLI 入口（lib/bin.js）；也可用 DSH_BIN
  --home <dir>          DSH_HOME，默认 /tmp/dsh-acp-probe-home
  --cwd <dir>           session 工作目录，默认当前目录
  --node <path>         启动 dsh 的 node，默认当前 node
  --prompt <text>       提示词，默认 "Reply with exactly: ACP-OK"
  --permission <mode>   allow | reject，默认 reject
  --timeout <sec>       单次 prompt 超时，默认 300
  --cancel-after <ms>   发出 prompt 后等待该毫秒数，发送 session/cancel
  --transcript <file>   把收到的全部协议消息写到文件
  --quiet               不把 dsh 的 stderr 转发到本进程 stderr
  --no-list             不调用 session/list
  --no-close            不调用 session/close（进程会随 stdin EOF 退出）
`)
}

function parseArgs (argv) {
  const out = { permission: 'reject', timeout: 300, quiet: false, list: true, close: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} 需要一个值`)
      return value
    }
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0) }
    else if (arg === '--dsh') out.dsh = take()
    else if (arg === '--home') out.home = take()
    else if (arg === '--cwd') out.cwd = take()
    else if (arg === '--node') out.node = take()
    else if (arg === '--prompt') out.prompt = take()
    else if (arg === '--permission') out.permission = take()
    else if (arg === '--timeout') out.timeout = Number(take())
    else if (arg === '--cancel-after') out.cancelAfter = Number(take())
    else if (arg === '--transcript') out.transcript = take()
    else if (arg === '--quiet') out.quiet = true
    else if (arg === '--no-list') out.list = false
    else if (arg === '--no-close') out.close = false
    else throw new Error(`未知参数: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dshBin = args.dsh ?? process.env.DSH_BIN
if (dshBin === undefined) { usage(); throw new Error('缺少 --dsh 或 DSH_BIN') }
if (args.permission !== 'allow' && args.permission !== 'reject') throw new Error('--permission 只能是 allow 或 reject')

const home = resolve(args.home ?? '/tmp/dsh-acp-probe-home')
const sessionCwd = realpathSync(resolve(args.cwd ?? process.cwd()))
mkdirSync(home, { recursive: true })

const log = (...parts) => process.stderr.write(`[probe] ${parts.join(' ')}\n`)
const transcript = []

// .js 入口用 node 跑；自带启动器（例如安装包里的 dsh shell 脚本）直接执行。
const dshIsNodeScript = /\.(c|m)?js$/.test(dshBin)
const command = dshIsNodeScript ? (args.node ?? process.execPath) : dshBin
const commandArgs = dshIsNodeScript ? [dshBin, '--profile', 'acp'] : ['--profile', 'acp']

// 不带入调用方会话的 DSH_*（DSH_SESSION_ID/DSH_PROFILE 等），只给隔离 home。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))
Object.assign(childEnv, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })

const child = spawn(command, commandArgs, {
  cwd: sessionCwd,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
})

if (!args.quiet) {
  let errBuf = ''
  child.stderr.on('data', (chunk) => {
    errBuf += chunk.toString('utf8')
    let index
    while ((index = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, index)
      errBuf = errBuf.slice(index + 1)
      if (line.trim() !== '') log('dsh stderr:', line)
    }
  })
}

const pending = new Map()
let nextId = 1
let exited = false
let exitInfo
const exitPromise = new Promise((resolveExit) => {
  child.on('exit', (code, signal) => {
    exited = true
    exitInfo = { code, signal }
    resolveExit(exitInfo)
  })
})

function send (message) {
  transcript.push({ direction: 'client->agent', message })
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request (method, params, timeoutMs = 120_000) {
  const id = nextId++
  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectResult(new Error(`${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveResult(value) },
      reject: (error) => { clearTimeout(timer); rejectResult(error) },
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function notify (method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function respond (id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError (id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const permissions = []
const updates = []

function handleServerRequest (message) {
  const { id, method, params } = message
  if (method === 'session/request_permission') {
    const options = Array.isArray(params?.options) ? params.options : []
    const allowOption = args.permission === 'allow'
      ? options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
      : undefined
    const record = {
      tool: params?.toolCall?.title ?? null,
      kind: params?.toolCall?.kind ?? null,
      decision: allowOption !== undefined ? 'allow' : 'reject',
      options: options.map(option => ({ kind: option.kind, name: option.name })),
    }
    permissions.push(record)
    if (allowOption !== undefined) respond(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } })
    else respond(id, { outcome: { outcome: 'cancelled' } })
    return
  }
  // 未声明任何客户端能力（无 fs、无 terminal），其余请求一律拒绝。
  respondError(id, -32601, `probe 不支持 ${method}`)
}

function handleNotification (message) {
  if (message.method !== 'session/update') {
    updates.push({ method: message.method, params: message.params })
    return
  }
  const update = message.params?.update ?? {}
  updates.push(update)
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    assistantText += update.content.text
  }
}

let assistantText = ''
let buffer = ''

function onLine (line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log('忽略非 JSON 输出:', line.slice(0, 200))
    return
  }
  transcript.push({ direction: 'agent->client', message })
  if (message.id !== undefined && message.method !== undefined) handleServerRequest(message)
  else if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (entry === undefined) { log('忽略未知响应 id:', message.id); return }
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
    else entry.resolve(message.result)
  } else if (message.method !== undefined) handleNotification(message)
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') onLine(line)
  }
})

function waitForExit (timeoutMs) {
  return Promise.race([
    exitPromise,
    new Promise((resolveExit) => setTimeout(() => resolveExit(undefined), timeoutMs)),
  ])
}

async function main () {
  log(`dsh=${dshBin} home=${home} cwd=${sessionCwd}`)

  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'agent-flow-client-acp-probe', version: '0.0.0' },
  }, 60_000)
  log('initialize:', JSON.stringify({
    protocolVersion: init?.protocolVersion,
    agentCapabilities: init?.agentCapabilities,
    authMethods: init?.authMethods?.map(method => method.id),
  }))

  const session = await request('session/new', { cwd: sessionCwd, mcpServers: [] }, 120_000)
  const sessionId = session?.sessionId
  if (typeof sessionId !== 'string') throw new Error('session/new 没有返回 sessionId')
  log('session/new:', JSON.stringify({
    sessionId,
    models: session?.models ?? null,
    configOptions: session?.configOptions ?? null,
  }))

  let cancelTimer
  const promptPromise = request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: args.prompt ?? 'Reply with exactly: ACP-OK' }],
  }, args.timeout * 1000)
  if (args.cancelAfter !== undefined) {
    cancelTimer = setTimeout(() => {
      log(`session/cancel after ${args.cancelAfter}ms`)
      notify('session/cancel', { sessionId })
    }, args.cancelAfter)
  }
  const promptResult = await promptPromise
  clearTimeout(cancelTimer)
  log('session/prompt: stopReason=' + String(promptResult?.stopReason) + ' usage=' + JSON.stringify(promptResult?.usage ?? null))

  // 先 close 再 list：list 返回已持久化、非活跃的会话，当前会话在 close 后才会出现。
  if (args.close) {
    await request('session/close', { sessionId }, 60_000)
    log('session/close: ok')
  }

  let listed = null
  if (args.list) {
    listed = await request('session/list', { cwd: sessionCwd }, 30_000)
    log('session/list:', JSON.stringify(listed?.sessions?.map(item => item.sessionId) ?? null))
  }

  const summary = {
    ok: true,
    sessionId,
    stopReason: promptResult?.stopReason ?? null,
    assistantText,
    usage: promptResult?.usage ?? null,
    permissions,
    updateKinds: [...new Set(updates.map(update => update.sessionUpdate).filter(Boolean))],
    listedSessionIds: listed?.sessions?.map(item => item.sessionId) ?? null,
    dshHome: home,
    sessionCwd,
  }
  if (args.transcript !== undefined) writeFileSync(args.transcript, JSON.stringify(transcript, null, 2))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

let failure
try {
  await main()
} catch (error) {
  failure = error
  log('失败:', error?.stack ?? String(error))
} finally {
  // 关闭 stdin 让 ACP 服务器走 EOF 退出；超时则升级为信号。
  child.stdin.end()
  const exit = exited ? exitInfo : await waitForExit(10_000)
  if (exit === undefined) {
    child.kill('SIGTERM')
    const afterTerm = await waitForExit(5_000)
    if (afterTerm === undefined) child.kill('SIGKILL')
  }
  log('dsh 退出:', JSON.stringify(exited ? exitInfo : (exit ?? null)))
}

if (failure !== undefined) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(failure.message ?? failure) }, null, 2)}\n`)
  process.exit(1)
}
