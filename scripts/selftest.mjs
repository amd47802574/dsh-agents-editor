#!/usr/bin/env node
/**
 * dsh-agents-editor 宿主半身自测。
 *
 * 不启动完整宿主：用假 webServer 抓取注册的路由，再以假 req/res 直接打
 * API，验证 读 / 写 / 冲突检测 / 备份 / 恢复 全链路。HOME/USERPROFILE
 * 重定向到临时目录，绝不触碰真实 ~/.dsh。
 *
 * 运行：node scripts/selftest.mjs
 * 退出码 0 = 全部通过。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-editor-selftest-'))
fs.mkdirSync(path.join(tmpHome, '.dsh'), { recursive: true })
// os.homedir() 在 Windows 读 USERPROFILE，POSIX 读 HOME；每次请求现取。
process.env.USERPROFILE = tmpHome
process.env.HOME = tmpHome

const mod = await import('../host.js')

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log('PASS ' + label) }
  else { failed += 1; console.error('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

// 假 webServer：记录 register 的路由并立即执行 effect。
const registered = []
mod.apply({
  inject(names, fn) {
    fn({
      webServer: { register(route) { registered.push(route); return () => {} } },
      effect(fn2) { fn2() },
      logger: null,
    })
  },
})

check('路由已注册', registered.length === 1 && registered[0].path === '/api/agents-editor')

const route = registered[0]

function callRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      on(event, fn) {
        if (event === 'data') for (const c of chunks) fn(c)
        if (event === 'end') fn()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(payload) {
        let json = null
        try { json = JSON.parse(payload ? String(payload) : '') } catch { /* 空响应 */ }
        resolve({ status: this.statusCode, json })
      },
    }
    Promise.resolve(route.handler(req, res)).then(() => {}, reject)
  })
}

const globalPath = path.join(tmpHome, '.dsh', 'AGENTS.md')

// 1. meta
{
  const r = await callRoute('GET', '/api/agents-editor/meta')
  check('GET /meta → 200', r.status === 200 && r.json?.ok === true)
  check('/meta 指向临时 HOME', r.json?.path === globalPath, r.json?.path)
}

// 2. 初始读取：文件不存在
{
  const r = await callRoute('GET', '/api/agents-editor/global')
  check('GET /global（缺失）→ exists:false', r.status === 200 && r.json?.exists === false && r.json?.content === null)
}

// 3. 首次保存（无备份）
{
  const r = await callRoute('PUT', '/api/agents-editor/global', { content: '# 规则 v1\n- 用中文回复\n' })
  check('PUT /global（首次）→ 200 且无备份', r.status === 200 && r.json?.exists === true && r.json?.backup === null)
  check('磁盘内容一致', fs.readFileSync(globalPath, 'utf8').includes('规则 v1'))
}

// 4. 正常二次保存（产生备份）
let modifiedAfterSecondSave = 0
{
  const first = await callRoute('GET', '/api/agents-editor/global')
  const r = await callRoute('PUT', '/api/agents-editor/global', {
    content: '# 规则 v2\n- 用中文回复\n- 产物进 dsh产物\n',
    baseModified: first.json.modified,
  })
  check('PUT /global（干净保存）→ 200 且有备份', r.status === 200 && typeof r.json?.backup === 'string')
  modifiedAfterSecondSave = r.json.modified
}

// 5. 外部修改后用过期 baseModified 保存 → 409
{
  fs.writeFileSync(globalPath, '# 外部改动\n', 'utf8')
  const r = await callRoute('PUT', '/api/agents-editor/global', { content: '# 覆盖\n', baseModified: modifiedAfterSecondSave })
  check('过期 baseModified → 409 冲突', r.status === 409 && r.json?.ok === false)
  check('冲突时磁盘未被改写', fs.readFileSync(globalPath, 'utf8') === '# 外部改动\n')
}

// 6. force 覆盖成功
{
  const r = await callRoute('PUT', '/api/agents-editor/global', { content: '# 强制覆盖\n', force: true })
  check('PUT force:true → 200', r.status === 200 && fs.readFileSync(globalPath, 'utf8') === '# 强制覆盖\n')
}

// 7. 备份清单 + 读取备份
{
  const list = await callRoute('GET', '/api/agents-editor/backups')
  const items = list.json?.items ?? []
  check('备份清单 ≥ 2 条', list.status === 200 && items.length >= 2, 'n=' + items.length)
  const newest = items[0]?.name
  const one = await callRoute('GET', '/api/agents-editor/backup?name=' + encodeURIComponent(newest))
  check('GET /backup → 返回内容', one.status === 200 && typeof one.json?.content === 'string')
}

// 8. 恢复备份
{
  const list = await callRoute('GET', '/api/agents-editor/backups')
  const oldest = list.json.items[list.json.items.length - 1].name
  const r = await callRoute('POST', '/api/agents-editor/restore', { name: oldest })
  check('POST /restore → 200', r.status === 200 && r.json?.ok === true)
  check('恢复后磁盘 = 备份内容', (await callRoute('GET', '/api/agents-editor/global')).json.content.includes('规则 v1'))
}

// 9. 非法输入
{
  const bad = await callRoute('PUT', '/api/agents-editor/global', { content: 42 })
  check('content 非字符串 → 400', bad.status === 400)
  const evil = await callRoute('GET', '/api/agents-editor/backup?name=..%2F..%2Fevil.md')
  check('路径穿越备份名 → 400', evil.status === 400)
  const unknown = await callRoute('GET', '/api/agents-editor/nope')
  check('未知路由 → 404', unknown.status === 404)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
fs.rmSync(tmpHome, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
