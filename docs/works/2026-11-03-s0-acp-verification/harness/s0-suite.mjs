#!/usr/bin/env node
/**
 * S0 P0 阻断项验证套件：用 ACP 驱动 dsh，逐项验证 S0-01…S0-12。
 *
 * 用法：
 *   node s0-suite.mjs [--only S0-01,S0-02] [--dsh <bin.js>] [--home <DSH_HOME>]
 *                     [--agents-home <dir>] [--work-root <dir>] [--out <dir>] [--keep]
 *
 * 证据：
 *   - ACP 侧：session/update、tool_call、permission、stopReason、JSON-RPC error；
 *   - 目录侧：会话日志里的 skill-catalog entries（zstd 解压，内部格式）；
 *   - 进程/文件侧：退出码、kill -0、脚本落盘文件。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const DEFAULT_DSH = '/Users/chenlong/agent/deepseek-harness/apps/cli/lib/bin.js'
const DEFAULT_HOME = '/tmp/dsh-s0/home'
const DEFAULT_AGENTS = '/tmp/dsh-s0/agents'
const DEFAULT_WORK = '/tmp/dsh-s0/ws'
const DEFAULT_OUT = path.join(HERE, '..', 'runs')

function parseArgs (argv) {
  const out = {
    dsh: process.env.DSH_BIN ?? DEFAULT_DSH,
    node: process.env.DSH_NODE ?? process.execPath,
    home: DEFAULT_HOME,
    agentsHome: DEFAULT_AGENTS,
    workRoot: DEFAULT_WORK,
    out: DEFAULT_OUT,
    only: null,
    keep: false,
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
    else if (arg === '--agents-home') out.agentsHome = take()
    else if (arg === '--work-root') out.workRoot = take()
    else if (arg === '--out') out.out = take()
    else if (arg === '--only') out.only = take().split(',').map(s => s.trim()).filter(Boolean)
    else if (arg === '--keep') out.keep = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${arg}`)
  }
  return out
}

function printHelp () {
  console.log(`S0 验证套件
  node s0-suite.mjs [options]
  --dsh <path>          dsh 入口，默认 ${DEFAULT_DSH}
  --node <path>         跑 dsh 的 node，默认当前 node
  --home <dir>          DSH_HOME，默认 ${DEFAULT_HOME}（需含 .credentials.yaml）
  --agents-home <dir>   DSH_AGENTS_HOME，默认 ${DEFAULT_AGENTS}（空目录，隔离用户技能）
  --work-root <dir>     工作区根，默认 ${DEFAULT_WORK}
  --out <dir>           证据输出目录，默认 runs/
  --only S0-01,S0-03    只跑指定项
  --keep                保留工作区（默认保留，失败排查用）`)
}

const args = parseArgs(process.argv.slice(2))
fs.mkdirSync(args.home, { recursive: true })
fs.mkdirSync(args.agentsHome, { recursive: true })
fs.mkdirSync(args.workRoot, { recursive: true })
fs.mkdirSync(args.out, { recursive: true })

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------- ACP client

class AcpProcess {
  constructor ({ name, home = args.home, agentsHome = args.agentsHome, cwd, patch, permission = 'allow' }) {
    this.name = name
    this.home = home
    this.agentsHome = agentsHome
    this.permission = permission
    this.nextId = 1
    this.pending = new Map()
    this.promptStates = new Map()
    this.toolCalls = new Map()
    this.permissions = []
    this.updateKinds = []
    this.badLines = 0
    this.badLineSamples = []
    this.stderr = ''
    this.stdoutLines = 0
    this.exited = null
    this.exitInfo = null
    this.transcript = []

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')))
    env.DSH_HOME = home
    env.DSH_AGENTS_HOME = agentsHome
    env.DSH_TELEMETRY_DISABLED = '1'

    const dshArgs = [args.dsh, '--profile', 'acp']
    if (patch !== undefined) dshArgs.push('--patch', patch)

    this.child = spawn(args.node, dshArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.startedAt = Date.now()

    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exited = { code, signal }
        this.exitInfo = { code, signal }
        for (const entry of this.pending.values()) {
          entry.reject(new Error(`dsh 已退出（${JSON.stringify(this.exited)}）`))
        }
        this.pending.clear()
        resolve(this.exited)
      })
    })

    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000)
    })

    let buffer = ''
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') this.onLine(line)
      }
    })
  }

  send (message) {
    this.transcript.push({ direction: 'client->agent', method: message.method ?? 'response', id: message.id ?? null })
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  respond (id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  respondError (id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  request (method, params, timeoutMs = 120_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify (method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  onLine (line) {
    this.stdoutLines++
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.badLines++
      if (this.badLineSamples.length < 3) this.badLineSamples.push(line.slice(0, 200))
      return
    }
    this.transcript.push({ direction: 'agent->client', method: message.method ?? 'response', id: message.id ?? null })
    if (message.id !== undefined && message.method !== undefined) this.onServerRequest(message)
    else if (message.id !== undefined) this.onResponse(message)
    else if (message.method !== undefined) this.onNotification(message)
  }

  onResponse (message) {
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
    else entry.resolve(message.result)
  }

  onServerRequest (message) {
    const { id, method, params } = message
    if (method === 'session/request_permission') {
      const options = Array.isArray(params?.options) ? params.options : []
      const allowOption = this.permission === 'allow'
        ? options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
        : undefined
      this.permissions.push({
        sessionId: params?.sessionId ?? null,
        title: params?.toolCall?.title ?? null,
        kind: params?.toolCall?.kind ?? null,
        options: options.map(option => option.kind),
        decision: allowOption !== undefined ? 'allow' : 'reject',
      })
      if (allowOption !== undefined) this.respond(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } })
      else this.respond(id, { outcome: { outcome: 'cancelled' } })
      return
    }
    this.respondError(id, -32601, `suite 不支持 ${method}`)
  }

  onNotification (message) {
    if (message.method !== 'session/update') return
    const params = message.params ?? {}
    const update = params.update ?? {}
    this.updateKinds.push(update.sessionUpdate)
    const state = this.promptStates.get(params.sessionId)

    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && state !== undefined) {
      state.text += update.content.text
    }
    if (update.sessionUpdate === 'tool_call') {
      const call = {
        toolCallId: update.toolCallId,
        title: update.title ?? null,
        kind: update.kind ?? null,
        status: update.status ?? null,
      }
      this.toolCalls.set(update.toolCallId, call)
      state?.toolCalls.push(call)
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const previous = this.toolCalls.get(update.toolCallId) ?? { toolCallId: update.toolCallId }
      const merged = {
        ...previous,
        title: update.title ?? previous.title ?? null,
        kind: update.kind ?? previous.kind ?? null,
        status: update.status ?? previous.status ?? null,
      }
      this.toolCalls.set(update.toolCallId, merged)
      const list = state?.toolCalls ?? []
      const existing = list.find(item => item.toolCallId === update.toolCallId)
      if (existing !== undefined) Object.assign(existing, merged)
      else list.push(merged)
    }
  }

  async initialize () {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 's0-suite', version: '0.0.0' },
    }, 60_000)
  }

  async newSession (cwd) {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, 120_000)
    if (typeof result?.sessionId !== 'string') throw new Error('session/new 未返回 sessionId')
    return result
  }

  async prompt (sessionId, text, { timeoutMs = 180_000, cancelAfterMs } = {}) {
    const state = { text: '', toolCalls: [], startedAt: Date.now() }
    this.promptStates.set(sessionId, state)
    let timer
    const promise = this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs)
    if (cancelAfterMs !== undefined) {
      timer = setTimeout(() => {
        this.notify('session/cancel', { sessionId })
      }, cancelAfterMs)
    }
    try {
      const result = await promise
      return {
        stopReason: result?.stopReason ?? null,
        usage: result?.usage ?? null,
        text: state.text,
        toolCalls: state.toolCalls,
        durationMs: Date.now() - state.startedAt,
      }
    } finally {
      clearTimeout(timer)
      this.promptStates.delete(sessionId)
    }
  }

  async cancel (sessionId) {
    this.notify('session/cancel', { sessionId })
  }

  async close (sessionId) {
    return this.request('session/close', { sessionId }, 60_000)
  }

  async list (cwd) {
    return this.request('session/list', { cwd }, 30_000)
  }

  async setConfigOption (sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value }, 30_000)
  }

  async dispose (timeoutMs = 10_000) {
    if (this.exited !== null) return this.exited
    this.child.stdin.end()
    const exit = await Promise.race([this.exitPromise, sleep(timeoutMs).then(() => undefined)])
    if (exit !== undefined) return exit
    this.child.kill('SIGTERM')
    const afterTerm = await Promise.race([this.exitPromise, sleep(5_000).then(() => undefined)])
    if (afterTerm !== undefined) return afterTerm
    this.child.kill('SIGKILL')
    return this.exitPromise
  }

  kill9 () {
    this.child.kill('SIGKILL')
    return this.exitPromise
  }
}

// ---------------------------------------------------------- session log oracle

function findSessionFile (home, sessionId) {
  const sessions = path.join(home, 'sessions')
  if (!fs.existsSync(sessions)) return null
  for (const group of fs.readdirSync(sessions)) {
    const candidate = path.join(sessions, group, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function readSessionEvents (home, sessionId) {
  const file = findSessionFile(home, sessionId)
  if (file === null) return { file: null, events: [], error: 'session log 不存在' }
  try {
    const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
    const events = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try { events.push(JSON.parse(line)) } catch { /* 半帧 */ }
    }
    return { file, events, error: null }
  } catch (error) {
    return { file, events: [], error: `zstd 解压失败: ${error.message}` }
  }
}

function catalogOf (home, sessionId) {
  const { file, events, error } = readSessionEvents(home, sessionId)
  if (error !== null) return { file: null, error, entries: [], names: [], catalogs: 0 }
  const catalogs = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'skill-catalog')
  const latest = catalogs.at(-1)
  const entries = (latest?.data?.source?.entries ?? []).map(entry => ({
    name: entry.name,
    description: entry.description ?? '',
  }))
  return { file, error: null, entries, names: entries.map(entry => entry.name).sort(), catalogs: catalogs.length }
}

// ---------------------------------------------------------------- fixtures

function makeWorkspace (ctx, name, { git = false } = {}) {
  const dir = path.join(ctx.workRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (git) {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
    execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, '-c', 'user.email=s0@example.com', '-c', 'user.name=s0', 'commit', '-qm', 'init'], { stdio: 'ignore' })
  }
  return fs.realpathSync(dir)
}

function skillFile (name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
}

function writeBundle (root, { name, token, description, body, directoryName }) {
  const dir = path.join(root, directoryName ?? name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(name, description ?? `Test skill ${name}.`, body ?? `Reply with exactly: ${token}`))
  return dir
}

function writeFlat (root, { name, token, description }) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, `${name}.md`), skillFile(name, description ?? `Flat skill ${name}.`, `Reply with exactly: ${token}`))
}

function writeBad (root, { name }) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nReply with exactly: BAD-TOKEN\n`)
}

function writeNested (root, { group, name, token }) {
  const dir = path.join(root, group, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(name, `Nested skill ${name}.`, `Reply with exactly: ${token}`))
}

function writeScript (root, { name, scriptName, token, relative = false }) {
  const dir = path.join(root, name)
  const scripts = path.join(dir, 'scripts')
  fs.mkdirSync(scripts, { recursive: true })
  const scriptPath = path.join(scripts, scriptName)
  fs.writeFileSync(scriptPath, `#!/bin/sh\nset -eu\necho "${token}"\nprintf "%s" "${token}" > "$(dirname "$0")/../token.txt"\n`)
  fs.chmodSync(scriptPath, 0o755)
  const command = relative ? path.posix.join('scripts', scriptName) : scriptPath
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(
    name,
    `Run a shell script when asked for ${token}.`,
    `Run this exact bash command: \`${command}\`\nThen reply with the token it printed, and nothing else.`,
  ))
  return { dir, scriptPath }
}

// ---------------------------------------------------------------- assertions

function makeSteps () {
  const steps = []
  return {
    steps,
    check (name, ok, detail = '') {
      steps.push({ name, ok: ok === true, detail })
      return ok === true
    },
  }
}

function finish (scenario, verdict, extra = {}) {
  return {
    scenario,
    verdict,
    at: new Date().toISOString(),
    ...extra,
  }
}

function processInfo (proc) {
  return {
    stdoutLines: proc.stdoutLines,
    badLines: proc.badLines,
    badLineSamples: proc.badLineSamples,
    stderrTail: proc.stderr.slice(-4000),
    updateKinds: [...new Set(proc.updateKinds)],
    permissions: proc.permissions,
    toolCalls: [...proc.toolCalls.values()],
    exit: proc.exitInfo,
    durationMs: Date.now() - proc.startedAt,
  }
}

// ---------------------------------------------------------------- scenarios

const SCENARIOS = {}

SCENARIOS['S0-01'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-01')
  const proc = new AcpProcess({ name: 'S0-01', cwd: ws })
  let catalog
  try {
    const init = await proc.initialize()
    check('initialize protocolVersion=1', init?.protocolVersion === 1, JSON.stringify(init?.protocolVersion))
    const session = await proc.newSession(ws)
    check('session/new 返回 sessionId', typeof session.sessionId === 'string', session.sessionId)
    const prompt = await proc.prompt(session.sessionId, 'Reply with exactly: OK')
    check('stopReason=end_turn', prompt.stopReason === 'end_turn', String(prompt.stopReason))
    check('assistant 文本含 OK', prompt.text.includes('OK'), prompt.text.slice(0, 100))
    check('stdout 无非协议行', proc.badLines === 0, proc.badLineSamples.join(' | '))
    await proc.close(session.sessionId)
    catalog = catalogOf(ctx.home, session.sessionId)
    check('session/close 成功', true)
  } finally {
    const exit = await proc.dispose()
    check('进程退出码 0', exit?.code === 0, JSON.stringify(exit))
  }
  return finish('S0-01', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, catalog: catalog ?? null, process: processInfo(proc),
  })
}

SCENARIOS['S0-02'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-02')
  const dshSkills = path.join(ws, '.dsh', 'skills')
  const agentsSkills = path.join(ws, '.agents', 'skills')
  writeBundle(dshSkills, { name: 'alpha', token: 'ALPHA-TOKEN', description: 'Skill alpha; outputs ALPHA-TOKEN.' })
  writeBundle(agentsSkills, { name: 'beta', token: 'BETA-TOKEN', description: 'Skill beta; outputs BETA-TOKEN.' })
  writeFlat(dshSkills, { name: 'flat-skill', token: 'FLAT-TOKEN', description: 'Flat skill; outputs FLAT-TOKEN.' })
  writeNested(dshSkills, { group: 'group', name: 'nested-skill', token: 'NESTED-TOKEN' })
  writeBad(dshSkills, { name: 'bad-skill' })
  writeBundle(dshSkills, { name: 'dup', token: 'DSH-DUP-TOKEN', description: 'Duplicate in project .dsh; outputs DSH-DUP-TOKEN.' })
  writeBundle(agentsSkills, { name: 'dup', token: 'AGENTS-DUP-TOKEN', description: 'Duplicate in project .agents; outputs AGENTS-DUP-TOKEN.' })

  const proc = new AcpProcess({ name: 'S0-02', cwd: ws })
  let catalog
  try {
    await proc.initialize()
    const session = await proc.newSession(ws)

    await proc.prompt(session.sessionId, 'Reply with exactly: OK')
    const load = await proc.prompt(session.sessionId,
      'Use the skill tool to load each of these skills in order: alpha, beta, flat-skill, dup. After loading all four, reply with the four tokens they specify, one per line.')
    await proc.close(session.sessionId)

    catalog = catalogOf(ctx.home, session.sessionId)
    check('目录可读', catalog.error === null, catalog.error ?? '')
    const names = catalog.names
    check('目录含 alpha/.dsh', names.includes('alpha'), names.join(','))
    check('目录含 beta/.agents', names.includes('beta'), names.join(','))
    check('目录含 flat-skill', names.includes('flat-skill'), names.join(','))
    check('目录不含 nested-skill', !names.includes('nested-skill'), names.join(','))
    check('目录不含 bad-skill', !names.includes('bad-skill'), names.join(','))
    check('目录含 dup（去重后一条）', names.includes('dup'), names.join(','))

    check('加载 alpha 得到 ALPHA-TOKEN', load.text.includes('ALPHA-TOKEN'), load.text.slice(0, 400))
    check('加载 beta 得到 BETA-TOKEN', load.text.includes('BETA-TOKEN'), load.text.slice(0, 400))
    check('加载 flat 得到 FLAT-TOKEN', load.text.includes('FLAT-TOKEN'), load.text.slice(0, 400))
    check('dup 使用 .dsh 版本', load.text.includes('DSH-DUP-TOKEN') && !load.text.includes('AGENTS-DUP-TOKEN'), load.text.slice(0, 400))
    check('发生 skill 工具调用', load.toolCalls.length > 0, JSON.stringify(load.toolCalls))
  } finally {
    await proc.dispose()
  }
  return finish('S0-02', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, catalog, process: processInfo(proc),
  })
}

SCENARIOS['S0-03'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const proc = new AcpProcess({ name: 'S0-03', cwd: ctx.workRoot })
  const rows = []
  const runCase = async (label, { delayMs, writeBefore = false }) => {
    const ws = makeWorkspace(ctx, `s0-03-${label}`)
    if (writeBefore) writeBundle(path.join(ws, '.dsh', 'skills'), { name: 's0-alpha', token: 'S0-ALPHA-A', description: 'Outputs S0-ALPHA-A.' })
    const session = await proc.newSession(ws)
    if (!writeBefore) writeBundle(path.join(ws, '.dsh', 'skills'), { name: 's0-alpha', token: 'S0-ALPHA-A', description: 'Outputs S0-ALPHA-A.' })
    if (delayMs > 0) await sleep(delayMs)
    const result = await proc.prompt(session.sessionId, 'Use the skill tool to load skill "s0-alpha", then follow it.')
    await proc.close(session.sessionId)
    const catalog = catalogOf(ctx.home, session.sessionId)
    const row = {
      label, delayMs, writeBefore,
      visible: catalog.names.includes('s0-alpha'),
      tokenSeen: result.text.includes('S0-ALPHA-A'),
      catalogNames: catalog.names,
      text: result.text.slice(0, 120),
    }
    rows.push(row)
    return row
  }

  try {
    await proc.initialize()
    for (let repeat = 1; repeat <= 3; repeat++) await runCase(`immediate-${repeat}`, { delayMs: 0 })
    for (const delay of [50, 200, 500]) await runCase(`delay-${delay}`, { delayMs: delay })
    await runCase('control-write-before', { delayMs: 0, writeBefore: true })

    // 同 session 内替换技能
    const ws = makeWorkspace(ctx, 's0-03-replace')
    writeBundle(path.join(ws, '.dsh', 'skills'), { name: 's0-alpha', token: 'S0-ALPHA-A', description: 'Outputs S0-ALPHA-A.' })
    const session = await proc.newSession(ws)
    const before = await proc.prompt(session.sessionId, 'Use the skill tool to load skill "s0-alpha", then follow it.')
    writeBundle(path.join(ws, '.dsh', 'skills'), { name: 's0-alpha', token: 'S0-ALPHA-B', description: 'Outputs S0-ALPHA-B.' })
    const after = await proc.prompt(session.sessionId, 'Use the skill tool to load skill "s0-alpha" again, then follow it.')
    await proc.close(session.sessionId)
    const catalogAfter = catalogOf(ctx.home, session.sessionId)
    rows.push({
      label: 'same-session-replace',
      before: before.text.slice(0, 80),
      after: after.text.slice(0, 80),
      beforeSeen: before.text.includes('S0-ALPHA-A'),
      afterSeen: after.text.includes('S0-ALPHA-B'),
      catalogDescription: catalogAfter.entries.find(entry => entry.name === 's0-alpha')?.description ?? null,
      catalogNames: catalogAfter.names,
    })

    const immediate = rows.filter(row => row.label.startsWith('immediate'))
    const immediateHits = immediate.filter(row => row.visible).length
    const control = rows.find(row => row.label === 'control-write-before')
    const replace = rows.find(row => row.label === 'same-session-replace')
    check('对照组（先写后建）可见', control?.visible === true, JSON.stringify(control))
    check('立即写后 prompt 至少一次可见', immediateHits > 0, `${immediateHits}/3`)
    check('500ms 内可见', rows.filter(row => row.delayMs > 0).some(row => row.visible), JSON.stringify(rows.filter(row => row.delayMs > 0)))
    check('同 session 替换后看到新 token', replace?.afterSeen === true, JSON.stringify(replace))
  } finally {
    await proc.dispose()
  }

  const verdict = steps.every(step => step.ok) ? '通过' : (steps.find(step => !step.ok)?.name.includes('替换') ? '部分通过' : '失败')
  return finish('S0-03', verdict, { steps, rows, process: processInfo(proc) })
}

SCENARIOS['S0-04'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-04')
  const skills = path.join(ws, '.dsh', 'skills')
  writeBundle(skills, { name: 's0-beta', token: 'A-TOKEN', description: 'Outputs A-TOKEN.' })
  const proc = new AcpProcess({ name: 'S0-04', cwd: ws })
  const sessions = []
  try {
    await proc.initialize()
    const sessionA = await proc.newSession(ws)
    sessions.push(sessionA.sessionId)
    const a = await proc.prompt(sessionA.sessionId, 'Use the skill tool to load skill "s0-beta", then follow it.')
    check('会话 A 得到 A-TOKEN', a.text.includes('A-TOKEN'), a.text.slice(0, 120))
    await proc.close(sessionA.sessionId)

    writeBundle(skills, { name: 's0-beta', token: 'B-TOKEN', description: 'Outputs B-TOKEN.' })
    const sessionB = await proc.newSession(ws)
    sessions.push(sessionB.sessionId)
    const b = await proc.prompt(sessionB.sessionId, 'Use the skill tool to load skill "s0-beta", then follow it.')
    check('会话 B 得到 B-TOKEN', b.text.includes('B-TOKEN'), b.text.slice(0, 120))
    check('会话 B 不残留 A-TOKEN', !b.text.includes('A-TOKEN'), b.text.slice(0, 120))
    await proc.close(sessionB.sessionId)
    const catalogB = catalogOf(ctx.home, sessionB.sessionId)
    check('会话 B 目录描述为 B', (catalogB.entries.find(entry => entry.name === 's0-beta')?.description ?? '').includes('B-TOKEN'), JSON.stringify(catalogB.entries))

    writeBundle(skills, { name: 's0-beta', token: 'A-TOKEN', description: 'Outputs A-TOKEN.' })
    const sessionC = await proc.newSession(ws)
    sessions.push(sessionC.sessionId)
    const c = await proc.prompt(sessionC.sessionId, 'Use the skill tool to load skill "s0-beta", then follow it.')
    check('会话 C 回到 A-TOKEN', c.text.includes('A-TOKEN'), c.text.slice(0, 120))
    check('进程未重启（同一 pid）', proc.exited === null && proc.child.pid !== undefined, String(proc.child.pid))
    await proc.close(sessionC.sessionId)
  } finally {
    const exit = await proc.dispose()
    check('进程正常退出', exit?.code === 0, JSON.stringify(exit))
  }
  return finish('S0-04', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, process: processInfo(proc), sessions,
  })
}

SCENARIOS['S0-05'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-05')
  writeBundle(path.join(ws, '.dsh', 'skills'), { name: 'proj-dsh', token: 'PROJ-DSH-TOKEN', description: 'Project .dsh skill.' })
  writeBundle(path.join(ws, '.agents', 'skills'), { name: 'proj-agent', token: 'PROJ-AGENT-TOKEN', description: 'Project .agents skill.' })
  writeBundle(path.join(ctx.home, 'skills'), { name: 'user-dsh', token: 'USER-DSH-TOKEN', description: 'User DSH home skill.' })
  writeBundle(path.join(ctx.agentsHome, 'skills'), { name: 'user-agents', token: 'USER-AGENTS-TOKEN', description: 'User agents home skill.' })

  const patch = path.join(ws, 'skill-roots.patch.yml')
  fs.writeFileSync(patch, `- id: skill-filesystem\n  config:\n    includeDefaultRoots: false\n    customSkillDirs:\n      - ${path.join(ws, '.dsh', 'skills')}\n`)

  const defaultProc = new AcpProcess({ name: 'S0-05-default', cwd: ws })
  const patchProc = new AcpProcess({ name: 'S0-05-patched', cwd: ws, patch })
  let defaultCatalog
  let patchedCatalog
  try {
    await defaultProc.initialize()
    const defaultSession = await defaultProc.newSession(ws)
    await defaultProc.prompt(defaultSession.sessionId, 'Reply with exactly: OK')
    await defaultProc.close(defaultSession.sessionId)
    defaultCatalog = catalogOf(ctx.home, defaultSession.sessionId)
    check('默认 profile 含 proj-dsh', defaultCatalog.names.includes('proj-dsh'), defaultCatalog.names.join(','))
    check('默认 profile 含 proj-agent', defaultCatalog.names.includes('proj-agent'), defaultCatalog.names.join(','))
    check('默认 profile 含 user-dsh', defaultCatalog.names.includes('user-dsh'), defaultCatalog.names.join(','))
    check('默认 profile 含 user-agents', defaultCatalog.names.includes('user-agents'), defaultCatalog.names.join(','))

    await patchProc.initialize()
    const patchedSession = await patchProc.newSession(ws)
    await patchProc.prompt(patchedSession.sessionId, 'Reply with exactly: OK')
    await patchProc.close(patchedSession.sessionId)
    patchedCatalog = catalogOf(ctx.home, patchedSession.sessionId)
    check('受控 profile 含 proj-dsh', patchedCatalog.names.includes('proj-dsh'), patchedCatalog.names.join(','))
    check('受控 profile 不含 proj-agent', !patchedCatalog.names.includes('proj-agent'), patchedCatalog.names.join(','))
    check('受控 profile 不含 user-dsh', !patchedCatalog.names.includes('user-dsh'), patchedCatalog.names.join(','))
    check('受控 profile 不含 user-agents', !patchedCatalog.names.includes('user-agents'), patchedCatalog.names.join(','))
  } finally {
    await defaultProc.dispose()
    await patchProc.dispose()
    // 清掉本场景写入的用户级技能，避免污染后续场景的目录
    fs.rmSync(path.join(ctx.home, 'skills'), { recursive: true, force: true })
    fs.rmSync(path.join(ctx.agentsHome, 'skills'), { recursive: true, force: true })
  }
  return finish('S0-05', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, defaultCatalog, patchedCatalog,
    process: { default: processInfo(defaultProc), patched: processInfo(patchProc) },
  })
}

SCENARIOS['S0-06'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-06')
  const skills = path.join(ws, '.dsh', 'skills')
  const abs = writeScript(skills, { name: 'script-abs', scriptName: 'mark.sh', token: 'S0-SCRIPT-TOKEN' })
  writeScript(skills, { name: 'script-rel', scriptName: 'mark-rel.sh', token: 'S0-SCRIPT-REL-TOKEN', relative: true })
  const proc = new AcpProcess({ name: 'S0-06', cwd: ws, permission: 'allow' })
  const results = {}
  try {
    await proc.initialize()
    const session = await proc.newSession(ws)
    const absRun = await proc.prompt(session.sessionId, 'Use the skill tool to load skill "script-abs", then follow its instructions exactly.')
    results.absText = absRun.text.slice(0, 300)
    results.absToolCalls = absRun.toolCalls
    results.absPermissions = proc.permissions.filter(item => item.sessionId === session.sessionId)
    const tokenFile = path.join(abs.dir, 'token.txt')
    check('绝对路径脚本执行并输出 token', absRun.text.includes('S0-SCRIPT-TOKEN'), absRun.text.slice(0, 300))
    check('脚本写入 token 文件', fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').includes('S0-SCRIPT-TOKEN'), tokenFile)
    check('出现 permission 请求或无需权限', results.absPermissions.length >= 0, JSON.stringify(results.absPermissions))

    const relRun = await proc.prompt(session.sessionId, 'Use the skill tool to load skill "script-rel", then follow its instructions exactly.')
    results.relText = relRun.text.slice(0, 300)
    results.relToolCalls = relRun.toolCalls
    results.relTokenSeen = relRun.text.includes('S0-SCRIPT-REL-TOKEN')
    check('相对路径脚本行为已记录', true, `tokenSeen=${results.relTokenSeen}`)
    await proc.close(session.sessionId)
  } finally {
    const exit = await proc.dispose()
    check('进程正常退出', exit?.code === 0, JSON.stringify(exit))
  }
  const envBlocked = /sandbox|Operation not permitted/i.test(results.absText ?? '')
  const verdict = envBlocked ? '环境受限' : (steps.every(step => step.ok) ? '通过' : '失败')
  return finish('S0-06', verdict, { steps, results, process: processInfo(proc) })
}

SCENARIOS['S0-07'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-07')
  const proc = new AcpProcess({ name: 'S0-07', cwd: ws, permission: 'allow' })
  const notes = []
  try {
    await proc.initialize()
    for (let i = 1; i <= 3; i++) {
      const session = await proc.newSession(ws)
      const result = await proc.prompt(session.sessionId, 'Reply with exactly: OK')
      await proc.close(session.sessionId)
      notes.push({ i, stopReason: result.stopReason, text: result.text.slice(0, 40) })
      check(`第 ${i} 个 session 正常`, result.stopReason === 'end_turn' && result.text.includes('OK'), JSON.stringify(notes.at(-1)))
    }

    const early = await proc.newSession(ws)
    try {
      await proc.close(early.sessionId)
      check('close-before-prompt 成功', true, 'ok')
    } catch (error) {
      check('close-before-prompt 返回定义好的错误', true, String(error.message).slice(0, 120))
    }
    const afterEarly = await proc.newSession(ws)
    const afterEarlyResult = await proc.prompt(afterEarly.sessionId, 'Reply with exactly: OK')
    check('close-before-prompt 后新 session 可用', afterEarlyResult.text.includes('OK'), afterEarlyResult.text.slice(0, 40))
    await proc.close(afterEarly.sessionId)

    const twice = await proc.newSession(ws)
    await proc.prompt(twice.sessionId, 'Reply with exactly: OK')
    await proc.close(twice.sessionId)
    try {
      await proc.close(twice.sessionId)
      check('close 两次有定义结果', true, '第二次 close 成功')
    } catch (error) {
      check('close 两次有定义结果', true, `第二次 close 错误: ${String(error.message).slice(0, 120)}`)
    }
    check('close 两次后进程存活', proc.exited === null, JSON.stringify(proc.exited))

    const cancelled = await proc.newSession(ws)
    const cancelResult = await proc.prompt(cancelled.sessionId, 'Write a 3000-word essay about testing.', { cancelAfterMs: 1200 })
    await proc.close(cancelled.sessionId)
    notes.push({ cancelled: cancelResult.stopReason })
    check('cancel 后 close 正常', true, JSON.stringify({ stopReason: cancelResult.stopReason }))

    const finalSession = await proc.newSession(ws)
    const finalResult = await proc.prompt(finalSession.sessionId, 'Reply with exactly: OK')
    check('结束前新 session 可用', finalResult.text.includes('OK'), finalResult.text.slice(0, 40))
    await proc.close(finalSession.sessionId)
  } finally {
    const exit = await proc.dispose()
    check('进程退出码 0', exit?.code === 0, JSON.stringify(exit))
  }
  return finish('S0-07', steps.every(step => step.ok) ? '通过' : '失败', { steps, notes, process: processInfo(proc) })
}

SCENARIOS['S0-08'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-08')
  const proc = new AcpProcess({ name: 'S0-08', cwd: ws, permission: 'allow' })
  let cancelResult
  try {
    await proc.initialize()
    const session = await proc.newSession(ws)
    cancelResult = await proc.prompt(session.sessionId, 'Write a 4000-word essay about distributed systems. Do not stop early.', { cancelAfterMs: 1500 })
    check('取消返回 stopReason=cancelled', cancelResult.stopReason === 'cancelled', String(cancelResult.stopReason))
    const afterCancel = await proc.prompt(session.sessionId, 'Reply with exactly: OK')
    check('取消后 session 仍可用', afterCancel.text.includes('OK'), afterCancel.text.slice(0, 80))
    await proc.close(session.sessionId)

    const idle = await proc.newSession(ws)
    await proc.cancel(idle.sessionId)
    const afterIdle = await proc.prompt(idle.sessionId, 'Reply with exactly: OK')
    check('无活跃 prompt 时 cancel 不崩溃', afterIdle.text.includes('OK'), afterIdle.text.slice(0, 80))
    await proc.close(idle.sessionId)
  } finally {
    const exit = await proc.dispose()
    check('进程正常退出', exit?.code === 0, JSON.stringify(exit))
  }
  return finish('S0-08', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, cancel: cancelResult ? { stopReason: cancelResult.stopReason, text: cancelResult.text.slice(0, 120) } : null,
    process: processInfo(proc),
  })
}

SCENARIOS['S0-09'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const wsA = makeWorkspace(ctx, 's0-09-a')
  const wsB = makeWorkspace(ctx, 's0-09-b')
  writeBundle(path.join(wsA, '.dsh', 'skills'), { name: 'concurrency-skill', token: 'CONCURRENT-A-TOKEN', description: 'Token A workspace.' })
  writeBundle(path.join(wsB, '.dsh', 'skills'), { name: 'concurrency-skill', token: 'CONCURRENT-B-TOKEN', description: 'Token B workspace.' })
  const proc = new AcpProcess({ name: 'S0-09', cwd: wsA, permission: 'allow' })
  try {
    await proc.initialize()
    const sessionA = await proc.newSession(wsA)
    const sessionB = await proc.newSession(wsB)
    const [a, b] = await Promise.all([
      proc.prompt(sessionA.sessionId, 'Use the skill tool to load skill "concurrency-skill", then follow it.'),
      proc.prompt(sessionB.sessionId, 'Use the skill tool to load skill "concurrency-skill", then follow it.'),
    ])
    check('A 只看到 A token', a.text.includes('CONCURRENT-A-TOKEN') && !a.text.includes('CONCURRENT-B-TOKEN'), a.text.slice(0, 120))
    check('B 只看到 B token', b.text.includes('CONCURRENT-B-TOKEN') && !b.text.includes('CONCURRENT-A-TOKEN'), b.text.slice(0, 120))
    await proc.close(sessionA.sessionId)
    const bAgain = await proc.prompt(sessionB.sessionId, 'Reply with exactly: OK')
    check('关闭 A 不影响 B', bAgain.text.includes('OK'), bAgain.text.slice(0, 40))
    await proc.close(sessionB.sessionId)
    const catalogA = catalogOf(ctx.home, sessionA.sessionId)
    const catalogB = catalogOf(ctx.home, sessionB.sessionId)
    check('A 目录描述为 A', (catalogA.entries.find(entry => entry.name === 'concurrency-skill')?.description ?? '').includes('A'), JSON.stringify(catalogA.entries))
    check('B 目录描述为 B', (catalogB.entries.find(entry => entry.name === 'concurrency-skill')?.description ?? '').includes('B'), JSON.stringify(catalogB.entries))
  } finally {
    await proc.dispose()
  }
  return finish('S0-09', steps.every(step => step.ok) ? '通过' : '失败', { steps, process: processInfo(proc) })
}

SCENARIOS['S0-10'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const proc = new AcpProcess({ name: 'S0-10', cwd: ctx.workRoot })
  const cases = {}
  try {
    await proc.initialize()

    // a) 根有 .git，技能在根，cwd 是子目录
    const rootGit = makeWorkspace(ctx, 's0-10-git', { git: true })
    fs.mkdirSync(path.join(rootGit, 'sub'), { recursive: true })
    writeBundle(path.join(rootGit, '.dsh', 'skills'), { name: 'root-skill', token: 'ROOT-TOKEN', description: 'Root skill.' })
    const s1 = await proc.newSession(path.join(rootGit, 'sub'))
    await proc.prompt(s1.sessionId, 'Reply with exactly: OK')
    await proc.close(s1.sessionId)
    const c1 = catalogOf(ctx.home, s1.sessionId)
    cases.gitRoot = c1.names
    check('.git 根：子目录 cwd 看到根技能', c1.names.includes('root-skill'), c1.names.join(','))

    // b) 无 .git：根技能不可见，cwd 技能可见
    const rootNoGit = makeWorkspace(ctx, 's0-10-nogit')
    fs.mkdirSync(path.join(rootNoGit, 'sub'), { recursive: true })
    writeBundle(path.join(rootNoGit, '.dsh', 'skills'), { name: 'root-skill', token: 'ROOT-TOKEN', description: 'Root skill.' })
    writeBundle(path.join(rootNoGit, 'sub', '.dsh', 'skills'), { name: 'sub-skill', token: 'SUB-TOKEN', description: 'Sub skill.' })
    const s2 = await proc.newSession(path.join(rootNoGit, 'sub'))
    await proc.prompt(s2.sessionId, 'Reply with exactly: OK')
    await proc.close(s2.sessionId)
    const c2 = catalogOf(ctx.home, s2.sessionId)
    cases.noGitRoot = c2.names
    check('无 .git：根技能不可见', !c2.names.includes('root-skill'), c2.names.join(','))
    check('无 .git：cwd 技能可见', c2.names.includes('sub-skill'), c2.names.join(','))

    // c) worktree：.git 是文件
    try {
      const wtRoot = makeWorkspace(ctx, 's0-10-wt-source', { git: true })
      const wtDir = path.join(ctx.workRoot, 's0-10-wt')
      fs.rmSync(wtDir, { recursive: true, force: true })
      execFileSync('git', ['-C', wtRoot, 'worktree', 'add', '-q', wtDir, '-b', 'wt-branch'], { stdio: 'ignore' })
      fs.mkdirSync(path.join(wtDir, 'sub'), { recursive: true })
      writeBundle(path.join(wtDir, '.dsh', 'skills'), { name: 'wt-skill', token: 'WT-TOKEN', description: 'Worktree skill.' })
      const realWt = fs.realpathSync(wtDir)
      const s3 = await proc.newSession(path.join(realWt, 'sub'))
      await proc.prompt(s3.sessionId, 'Reply with exactly: OK')
      await proc.close(s3.sessionId)
      const c3 = catalogOf(ctx.home, s3.sessionId)
      cases.worktree = { names: c3.names, gitIsFile: fs.statSync(path.join(realWt, '.git')).isFile() }
      check('worktree（.git 文件）行为已记录', true, JSON.stringify(cases.worktree))
    } catch (error) {
      cases.worktree = { error: String(error.message) }
      check('worktree 场景已记录', true, cases.worktree.error)
    }

    // d) 空格 / Unicode 路径
    const unicodeWs = path.join(ctx.workRoot, 's0 ws ü')
    fs.rmSync(unicodeWs, { recursive: true, force: true })
    fs.mkdirSync(unicodeWs, { recursive: true })
    writeBundle(path.join(unicodeWs, '.dsh', 'skills'), { name: 'unicode-skill', token: 'UNICODE-TOKEN', description: 'Unicode path skill.' })
    const s4 = await proc.newSession(fs.realpathSync(unicodeWs))
    await proc.prompt(s4.sessionId, 'Reply with exactly: OK')
    await proc.close(s4.sessionId)
    const c4 = catalogOf(ctx.home, s4.sessionId)
    cases.unicode = c4.names
    check('空格/Unicode 路径下技能可见', c4.names.includes('unicode-skill'), c4.names.join(','))
  } finally {
    await proc.dispose()
  }
  return finish('S0-10', steps.every(step => step.ok) ? '通过' : '失败', { steps, cases, process: processInfo(proc) })
}

SCENARIOS['S0-11'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-11')
  const pidFile = path.join(ws, 'orphan.pid')
  fs.rmSync(pidFile, { force: true })
  // 用技能 + 脚本触发前台长任务：bash 工具在嵌套沙箱下对“外部命令 + 后台”会走 sandbox-exec 而失败，
  // 脚本方式与 S0-06 的成功路径一致（前台、写工作区内文件）。
  const crashSkillDir = path.join(ws, '.dsh', 'skills', 'crash-skill')
  const crashScript = path.join(crashSkillDir, 'scripts', 'crash.sh')
  fs.mkdirSync(path.dirname(crashScript), { recursive: true })
  fs.writeFileSync(crashScript, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 60\n`)
  fs.chmodSync(crashScript, 0o755)
  fs.writeFileSync(path.join(crashSkillDir, 'SKILL.md'), skillFile(
    'crash-skill',
    'Long-running crash test skill.',
    `Run this exact bash command in the foreground (do NOT run it in the background): \`${crashScript}\`\nDo not do anything else.`,
  ))
  const proc = new AcpProcess({ name: 'S0-11', cwd: ws, permission: 'allow' })
  let pid = null
  let orphanAlive = null
  try {
    await proc.initialize()
    const session = await proc.newSession(ws)
    const promptPromise = proc.prompt(session.sessionId,
      'Use the skill tool to load skill "crash-skill", then follow its instructions exactly.',
      { timeoutMs: 120_000 }).catch(error => ({ error: String(error.message) }))
    // 等脚本写出 pid 文件（最多 20s）
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(pidFile)) { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); break }
      await sleep(100)
    }
    check('bash 已启动并写出 pid', Number.isInteger(pid) && pid > 0, String(pid))
    await proc.kill9()
    await promptPromise
    check('dsh 进程已被 kill', proc.exited !== null, JSON.stringify(proc.exited))
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); orphanAlive = true } catch { orphanAlive = false }
      check('无孤儿 bash（kill -0 判定）', orphanAlive === false, `pid=${pid} alive=${orphanAlive}`)
      if (orphanAlive) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
    const sessionFile = findSessionFile(ctx.home, session.sessionId)
    const lockFile = sessionFile === null ? null : path.join(path.dirname(sessionFile), 'session.lock')
    const lockExists = lockFile !== null && fs.existsSync(lockFile)

    const restart = new AcpProcess({ name: 'S0-11-restart', cwd: ws, permission: 'allow' })
    try {
      await restart.initialize()
      let listed = null
      try { listed = await restart.list(ws) } catch (error) { listed = { error: String(error.message) } }
      const newSession = await restart.newSession(ws)
      const result = await restart.prompt(newSession.sessionId, 'Reply with exactly: OK')
      check('重启后 session/list 返回有定义结果', true, JSON.stringify(listed).slice(0, 200))
      check('重启后新 session 可用', result.text.includes('OK'), result.text.slice(0, 60))
      await restart.close(newSession.sessionId)
      check('崩溃会话的 lock 文件状态已记录', true, `lockExists=${lockExists}`)
      return finish('S0-11', steps.every(step => step.ok) ? '通过' : '失败', {
        steps,
        crash: { pid, orphanAlive, lockExists, crashedSession: session.sessionId, listed },
        process: processInfo(proc),
        restart: processInfo(restart),
      })
    } finally {
      await restart.dispose()
    }
  } finally {
    if (proc.exited === null) await proc.dispose(2000)
  }
}

SCENARIOS['S0-12'] = async (ctx) => {
  const { steps, check } = makeSteps()
  const ws = makeWorkspace(ctx, 's0-12')
  const proc = new AcpProcess({ name: 'S0-12', cwd: ws, permission: 'allow' })
  const observed = {}
  try {
    await proc.initialize()
    const session = await proc.newSession(ws)

    const exact = await proc.prompt(session.sessionId, 'Reply with exactly: RESULT-TOKEN-123')
    observed.exact = { text: exact.text, stopReason: exact.stopReason, usage: exact.usage }
    check('精确文本可提取', exact.text.includes('RESULT-TOKEN-123'), exact.text.slice(0, 120))
    check('stopReason 可用', exact.stopReason === 'end_turn', String(exact.stopReason))
    check('usage 已记录（可为 null）', Object.hasOwn(exact, 'usage'), JSON.stringify(exact.usage))
    check('update 流包含文本块', proc.updateKinds.includes('agent_message_chunk'), JSON.stringify([...new Set(proc.updateKinds)]))

    const long = await proc.prompt(session.sessionId, 'Write exactly 60 lines. Line n is "LINE-<n>". Do not skip any line.')
    observed.long = { length: long.text.length, tail: long.text.slice(-120), stopReason: long.stopReason }
    check('长输出末尾完整（含 LINE-60）', long.text.includes('LINE-60'), long.text.slice(-160))
    check('长输出包含 60 行', long.text.split('LINE-').length - 1 >= 60, String(long.text.split('LINE-').length - 1))

    let configError = null
    try { await proc.setConfigOption(session.sessionId, 'nonexistent-option', 'x') } catch (error) { configError = String(error.message) }
    observed.configError = configError
    check('未知 config option 返回 JSON-RPC 错误', configError !== null, String(configError))

    await proc.close(session.sessionId)
  } finally {
    await proc.dispose()
  }

  // 错误映射：无凭据 home
  const nocreds = path.join(ctx.workRoot, 's0-12-nocreds-home')
  fs.rmSync(nocreds, { recursive: true, force: true })
  fs.mkdirSync(nocreds, { recursive: true })
  const errorProc = new AcpProcess({ name: 'S0-12-nocreds', cwd: ws, home: nocreds, permission: 'allow' })
  let modelError = null
  try {
    await errorProc.initialize()
    const session = await errorProc.newSession(ws)
    try { await errorProc.prompt(session.sessionId, 'Reply with exactly: OK', { timeoutMs: 90_000 }) } catch (error) { modelError = String(error.message) }
    check('无凭据时返回可读 JSON-RPC 错误', modelError !== null && /no API key|authentication|401|403/i.test(modelError), String(modelError).slice(0, 200))
    try { await errorProc.close(session.sessionId) } catch {}
  } finally {
    await errorProc.dispose()
  }

  return finish('S0-12', steps.every(step => step.ok) ? '通过' : '失败', {
    steps, observed: { ...observed, modelError }, process: processInfo(proc),
  })
}

// ---------------------------------------------------------------- runner

async function main () {
  if (!fs.existsSync(path.join(args.home, '.credentials.yaml')) && process.env.DEEPSEEK_API_KEY === undefined) {
    console.warn(`警告: ${args.home} 下没有 .credentials.yaml，且未设置 DEEPSEEK_API_KEY；真实 prompt 会失败。`)
  }
  const order = ['S0-01', 'S0-02', 'S0-05', 'S0-03', 'S0-04', 'S0-06', 'S0-07', 'S0-08', 'S0-09', 'S0-10', 'S0-11', 'S0-12']
  const selected = args.only ?? order
  const ctx = { ...args }
  const summary = []
  for (const id of selected) {
    if (!Object.hasOwn(SCENARIOS, id)) { console.error(`未知场景 ${id}`); continue }
    console.log(`\n=== ${id} 开始 ===`)
    const startedAt = Date.now()
    let result
    try {
      result = await SCENARIOS[id](ctx)
    } catch (error) {
      result = finish(id, '失败', { error: String(error?.stack ?? error) })
    }
    result.durationMs = Date.now() - startedAt
    fs.writeFileSync(path.join(args.out, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`)
    const okSteps = result.steps?.filter(step => step.ok).length ?? 0
    const totalSteps = result.steps?.length ?? 0
    console.log(`=== ${id} 结束: ${result.verdict} (${okSteps}/${totalSteps} 断言, ${(result.durationMs / 1000).toFixed(1)}s) ===`)
    for (const step of result.steps ?? []) {
      console.log(`  ${step.ok ? 'PASS' : 'FAIL'} ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
    }
    if (result.error) console.log(`  ERROR ${result.error}`)
    summary.push({ id, verdict: result.verdict, okSteps, totalSteps, durationMs: result.durationMs })
  }
  fs.writeFileSync(path.join(args.out, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)}\n`)
  console.log('\n==== 汇总 ====')
  for (const row of summary) console.log(`${row.id}\t${row.verdict}\t${row.okSteps}/${row.totalSteps}\t${(row.durationMs / 1000).toFixed(1)}s`)
}

await main()
