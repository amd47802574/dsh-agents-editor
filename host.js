/**
 * dsh-agents-editor — Host half（宿主半身）。
 *
 * 给浏览器端设置分区提供数据通道：读写全局规则文件 ~/.dsh/AGENTS.md
 * （对所有会话生效的那份）。路由挂在宿主 webserver 上，与 DSH 其余
 * /api 同源同鉴权；文件操作只针对全局规则文件与本插件的备份目录。
 *
 * 路由一览（前缀 /api/agents-editor）：
 *   GET  /meta                 插件元信息（版本、目标路径）
 *   GET  /global               读全局规则（存在性、内容、字节、修改时间）
 *   PUT  /global               保存（可选冲突检测 baseModified；先备份再原子写）
 *   GET  /backups              自动备份清单（新→旧）
 *   GET  /backup?name=…        读一份备份的内容（备份名严格白名单）
 *   POST /restore              从备份恢复（恢复前先把当前内容再备份一份）
 *
 * 安全模型：备份名白名单校验杜绝路径穿越；写入走「临时文件 + rename」
 * 原子替换；每次覆盖前自动备份，误改可随时回退。
 *
 * @module dsh-agents-editor
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** Cordis 插件名，用于 Loader 诊断日志。 */
export const name = 'agents-editor'

const VERSION = '1.0.0'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const PREFIX = '/api/agents-editor'
const BACKUP_NAME = /^AGENTS\.md-\d{8}-\d{6}-[0-9a-f]{4}\.md$/

/** 全局规则文件路径（每次现取，测试可重定向 HOME/USERPROFILE）。 */
function globalPath() {
  return path.join(os.homedir(), '.dsh', 'AGENTS.md')
}

/** 自动备份目录。 */
function backupDir() {
  return path.join(os.homedir(), '.dsh', 'agents-editor', 'backups')
}

/** 取文件状态，不存在返回 exists:false。 */
function statFile(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, bytes: st.size, modified: st.mtimeMs }
  } catch {
    return { exists: false, bytes: 0, modified: 0 }
  }
}

function readGlobal() {
  const p = globalPath()
  const st = statFile(p)
  return { path: p, ...st, content: st.exists ? fs.readFileSync(p, 'utf8') : null }
}

/** 时间戳形如 20261115-210530。 */
function stamp() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

function newBackupName() {
  return `AGENTS.md-${stamp()}-${crypto.randomBytes(2).toString('hex')}.md`
}

/** 备份当前全局规则（存在才备份），返回备份名或 null。 */
function backupCurrent() {
  const p = globalPath()
  if (!fs.existsSync(p)) return null
  const dir = backupDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = newBackupName()
  fs.copyFileSync(p, path.join(dir, name))
  return name
}

/** 原子写入：同目录临时文件 + rename 替换。 */
function writeGlobal(content) {
  const p = globalPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = path.join(path.dirname(p), `.agents-editor-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, p)
}

/** 备份清单，新→旧。 */
function listBackups() {
  const items = []
  try {
    for (const n of fs.readdirSync(backupDir())) {
      if (!BACKUP_NAME.test(n)) continue
      const st = fs.statSync(path.join(backupDir(), n))
      items.push({ name: n, bytes: st.size, modified: st.mtimeMs })
    }
  } catch { /* 目录尚不存在 = 无备份 */ }
  items.sort((a, b) => b.modified - a.modified)
  return items
}

function readBackup(name) {
  if (typeof name !== 'string' || !BACKUP_NAME.test(name)) throw httpError(400, 'invalid backup name')
  const p = path.join(backupDir(), name)
  if (!fs.existsSync(p)) throw httpError(404, `backup "${name}" not found`)
  return fs.readFileSync(p, 'utf8')
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** 收集请求体（上限 2MB）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(httpError(413, 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 保存：冲突检测 → 备份当前 → 原子写入。 */
function saveGlobal({ content, baseModified, force }) {
  if (typeof content !== 'string') throw httpError(400, 'content must be a string')
  const st = statFile(globalPath())
  const clientBase = Number(baseModified)
  if (
    force !== true &&
    baseModified !== undefined &&
    Number.isFinite(clientBase) &&
    st.exists &&
    Math.abs(st.modified - clientBase) > 1.5
  ) {
    const error = httpError(409, 'the file changed since you loaded it')
    error.current = { ...st, content: fs.readFileSync(globalPath(), 'utf8') }
    throw error
  }
  const backup = backupCurrent()
  writeGlobal(content)
  return { ...statFile(globalPath()), backup }
}

async function handle(method, sub, query, req, res) {
  if (sub === '/meta' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: VERSION, path: globalPath(), home: os.homedir() })
  }
  if (sub === '/global' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...readGlobal() })
  }
  if (sub === '/global' && method === 'PUT') {
    let body
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { throw httpError(400, 'request body must be JSON') }
    return sendJson(res, 200, { ok: true, ...saveGlobal(body) })
  }
  if (sub === '/backups' && method === 'GET') {
    return sendJson(res, 200, { ok: true, items: listBackups() })
  }
  if (sub === '/backup' && method === 'GET') {
    const name = query.get('name')
    const content = readBackup(name)
    return sendJson(res, 200, { ok: true, name, content })
  }
  if (sub === '/restore' && method === 'POST') {
    let body
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { throw httpError(400, 'request body must be JSON') }
    const content = readBackup(body.name)
    // 恢复前把当前内容也备份一份，恢复动作本身永远可撤销。
    return sendJson(res, 200, { ok: true, restored: body.name, ...saveGlobal({ content, force: true }) })
  }
  throw httpError(404, `no route for ${method} ${sub}`)
}

/** 无宿主依赖：webServer 在自己的 fiber 里就绪后再挂路由。 */
export const inject = []

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(() => server.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local')
          let sub = url.pathname
          // 兼容两种派发方式：handler 拿到完整路径或去掉前缀的剩余路径。
          if (sub.startsWith(PREFIX)) sub = sub.slice(PREFIX.length) || '/'
          await handle(req.method ?? 'GET', sub, url.searchParams, req, res)
        } catch (error) {
          const statusCode = Number(error?.statusCode) || 500
          if (statusCode >= 500) console.error('[agents-editor]', error)
          try {
            sendJson(res, statusCode, { ok: false, error: error?.message ?? String(error) })
          } catch { /* 响应已发出 */ }
        }
      },
    }), 'agents-editor: api routes')
    try {
      const logger = typeof scoped.logger === 'function' ? scoped.logger('agents-editor') : null
      logger?.info?.('agents-editor: API 已挂载 ' + PREFIX + '，目标文件 ' + globalPath())
    } catch { /* 日志通道不可用不影响挂载 */ }
  })
}
