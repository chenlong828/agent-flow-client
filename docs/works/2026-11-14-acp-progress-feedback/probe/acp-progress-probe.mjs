#!/usr/bin/env node
/**
 * 进度反馈调研探针：spawn `dsh --profile acp`，跑一条会调用 bash 的 prompt，
 * 按到达顺序记录全部 session/update 与 permission 请求（带墙钟时间与相对 prompt 的毫秒）。
 *
 * 目的不是验证 ACP 功能，而是量化「client 在任务执行过程中到底能拿到什么、什么时刻拿到」。
 * 只依赖 Node 内置模块。
 *
 * 用法：
 *   HUNDSUN_PUBLIC_API_KEY=... node acp-progress-probe.mjs \
 *     --dsh /path/to/apps/cli/lib/bin.js --home /tmp/acp-progress/home \
 *     --cwd /tmp/acp-progress/ws --out ./summary.json \
 *     --prompt '用 bash 工具执行 sleep 3，然后只回复 ACP-PROBE-DONE'
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function parseArgs(argv) {
  const out = {
    permission: 'allow',
    timeout: 180,
    prompt: '用 bash 工具执行 `sleep 3`，然后只回复：ACP-PROBE-DONE',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} 需要一个值`)
      return value
    }
    if (arg === '--dsh') out.dsh = take()
    else if (arg === '--node') out.node = take()
    else if (arg === '--home') out.home = take()
    else if (arg === '--cwd') out.cwd = take()
    else if (arg === '--patch') out.patch = take()
    else if (arg === '--out') out.out = take()
    else if (arg === '--prompt') out.prompt = take()
    else if (arg === '--timeout') out.timeout = Number(take())
    else throw new Error(`未知参数: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dshBin = args.dsh ?? process.env.DSH_BIN
if (dshBin === undefined) throw new Error('缺少 --dsh 或 DSH_BIN')

const home = resolve(args.home ?? '/tmp/acp-progress-probe/home')
const cwd = realpathSync(resolve(args.cwd ?? process.cwd()))
const outPath = resolve(args.out ?? join(home, 'summary.json'))
mkdirSync(home, { recursive: true, mode: 0o700 })
mkdirSync(cwd, { recursive: true })

const isNodeScript = /\.(c|m)?js$/.test(dshBin)
const command = isNodeScript ? args.node ?? process.execPath : dshBin
const commandArgs = isNodeScript ? [dshBin, '--profile', 'acp'] : ['--profile', 'acp']
if (args.patch !== undefined) commandArgs.push('--patch', resolve(args.patch))

// 不带入调用方会话的 DSH_*，只给隔离 home；provider 配置与 key 走 patch + 继承环境。
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))
childEnv.DSH_HOME = home
childEnv.DSH_TELEMETRY_DISABLED = '1'

const child = spawn(command, commandArgs, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })

const events = []
const protocol = []
const permissions = []
const startedAt = Date.now()
let assistantText = ''
let promptSentAt = null

function stamp() {
  return { at: new Date().toISOString(), tMs: promptSentAt === null ? null : Date.now() - promptSentAt }
}

const pending = new Map()
let nextId = 1

function send(message) {
  protocol.push({ dir: 'client->agent', ...stamp(), message })
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request(method, params, timeoutMs) {
  const id = nextId++
  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectResult(new Error(`${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolveResult(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        rejectResult(error)
      },
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function handleServerRequest(message) {
  if (message.method === 'session/request_permission') {
    const params = message.params ?? {}
    const options = Array.isArray(params.options) ? params.options : []
    const allow = options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always')
    permissions.push({
      ...stamp(),
      toolCall: params.toolCall ?? null,
      options: options.map((option) => ({ kind: option.kind, name: option.name })),
      decision: allow === undefined ? 'reject' : 'allow',
    })
    if (allow === undefined) respond(message.id, { outcome: { outcome: 'cancelled' } })
    else respond(message.id, { outcome: { outcome: 'selected', optionId: allow.optionId } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `probe 不支持 ${message.method}` } })
}

function summarizeUpdate(update) {
  const base = { kind: update.sessionUpdate, ...stamp() }
  if (update.sessionUpdate === 'agent_message_chunk') {
    return { ...base, messageId: update.messageId, contentType: update.content?.type, text: update.content?.text }
  }
  if (update.sessionUpdate === 'agent_thought_chunk') {
    return { ...base, messageId: update.messageId, textLength: update.content?.text?.length }
  }
  if (update.sessionUpdate === 'tool_call') {
    return { ...base, toolCallId: update.toolCallId, title: update.title, toolKind: update.kind, status: update.status, rawInput: update.rawInput }
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return {
      ...base,
      toolCallId: update.toolCallId,
      status: update.status,
      contentBlocks: Array.isArray(update.content) ? update.content.length : 0,
      contentText: Array.isArray(update.content) ? update.content.map((block) => block?.content?.text ?? '').join('').slice(0, 200) : undefined,
    }
  }
  if (update.sessionUpdate === 'usage_update') {
    return { ...base, used: update.used, size: update.size, cost: update.cost }
  }
  return { ...base, keys: Object.keys(update) }
}

function handleNotification(message) {
  if (message.method === 'session/update') {
    const update = message.params?.update ?? {}
    events.push(summarizeUpdate(update))
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      assistantText += update.content.text
    }
    return
  }
  events.push({ kind: message.method, ...stamp() })
}

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    protocol.push({ dir: 'agent->client', ...stamp(), message })
    if (message.id !== undefined && message.method !== undefined) handleServerRequest(message)
    else if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry === undefined) continue
      pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    } else if (message.method !== undefined) handleNotification(message)
  }
})

let stderrText = ''
child.stderr.on('data', (chunk) => {
  stderrText += chunk.toString('utf8')
})

async function main() {
  const init = await request(
    'initialize',
    { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'af-progress-probe', version: '0.0.0' } },
    60_000,
  )
  const session = await request('session/new', { cwd, mcpServers: [] }, 60_000)
  const sessionId = session?.sessionId
  if (typeof sessionId !== 'string') throw new Error('session/new 没有返回 sessionId')

  promptSentAt = Date.now()
  const promptResult = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: args.prompt }] },
    args.timeout * 1000,
  )
  const promptDoneAt = Date.now()
  await request('session/close', { sessionId }, 30_000).catch(() => undefined)

  const summary = {
    dshBin,
    commandArgs,
    home,
    cwd,
    prompt: args.prompt,
    sessionId,
    initialize: { protocolVersion: init?.protocolVersion, agentCapabilities: init?.agentCapabilities },
    promptResult,
    elapsedMs: promptDoneAt - promptSentAt,
    assistantText,
    permissions,
    updates: events,
    stderrTail: stderrText.split('\n').slice(-20).join('\n'),
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(summary, null, 2))
  writeFileSync(outPath.replace(/\.json$/, '') + '.protocol.jsonl', protocol.map((item) => JSON.stringify(item)).join('\n') + '\n')
  process.stderr.write(`[probe] updates=${events.length} elapsedMs=${summary.elapsedMs} out=${outPath}\n`)
}

main()
  .catch((error) => {
    process.stderr.write(`[probe] 失败：${error.stack ?? error}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    child.stdin.end()
    setTimeout(() => child.kill('SIGKILL'), 1000).unref()
  })
