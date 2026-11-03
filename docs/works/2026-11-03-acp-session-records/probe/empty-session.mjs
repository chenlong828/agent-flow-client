#!/usr/bin/env node
/**
 * 研究用探针：在指定 DSH_HOME 下建立一个空 ACP session 并立即 close。
 * 不发送 prompt，因此不会调用模型，也不需要凭据。
 *
 * 用法：
 *   node empty-session.mjs <dsh-bin.js> <home> <cwd>
 * 输出：
 *   新建的 sessionId（一行）
 */
import { spawn } from 'node:child_process'

const [entry, home, cwd] = process.argv.slice(2)
if (entry === undefined || home === undefined || cwd === undefined) {
  console.error('usage: node empty-session.mjs <dsh-bin.js> <home> <cwd>')
  process.exit(2)
}

const child = spawn(process.execPath, [entry, '--profile', 'acp'], {
  cwd,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let nextId = 0
const pending = new Map()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    const message = JSON.parse(line)
    if (message.id === undefined || message.method !== undefined) continue
    const settle = pending.get(message.id)
    pending.delete(message.id)
    if (settle !== undefined) settle(message)
  }
})

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, (message) => {
      if (message.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => reject(new Error(`${method}: timeout`)), 30_000).unref()
  })
}

child.stderr.pipe(process.stderr)

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const created = await request('session/new', { cwd, mcpServers: [] })
  await request('session/close', { sessionId: created.sessionId })
  console.log(created.sessionId)
} finally {
  child.stdin.end()
  await new Promise((resolve) => child.once('exit', resolve))
}
