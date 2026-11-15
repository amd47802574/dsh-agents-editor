/**
 * dsh-agents-editor — Client half（浏览器半身）。
 *
 * 在设置面板新增「全局规则」分区：查看并编辑宿主全局规则文件
 * ~/.dsh/AGENTS.md（对所有会话生效的那份）。数据走本插件宿主半身
 * 挂载的 /api/agents-editor/* 同源路由：
 *   - 读取 / 保存（Ctrl+S / Tab 缩进），保存前服务端自动备份；
 *   - 外部修改冲突检测（读入后文件被别处改动 → 409，可一键覆盖或先重读）；
 *   - 备份清单浏览、只读预览与一键恢复；
 *   - 有未保存更改时拦截页面刷新。
 *
 * 手写 ModuleLoader bundle：无构建步骤，仅依赖 shell 已提供的 react。
 * 颜色全部来自主题变量（带兜底值），浅色 / 深色主题都成立。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agents-editor',
  factory: require => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const NS = 'agents-editor'
    const API = '/api/agents-editor'
    const inject = ['slots', 'locale']

    // ── dictionaries ────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '全局规则',
        title: '全局规则编辑器',
        missing: '文件尚不存在，保存后自动创建。',
        modified: '修改于 {time}',
        missingFile: '文件不存在',
        reload: '重新加载',
        save: '保存',
        saving: '保存中…',
        savedPlain: '已保存',
        backupSaved: '已保存（自动备份 {name}）',
        dirty: '未保存更改',
        hintCtrlS: 'Ctrl+S 保存',
        conflictTitle: '文件已被外部修改',
        conflictBody: '你读入之后，文件在别处被改动过。覆盖保存会丢失外部改动；建议先「重新加载」比对后再决定。',
        overwrite: '仍要覆盖保存',
        backups: '历史备份（{n}）',
        backupEmpty: '暂无备份 —— 第一次保存后这里会出现自动备份。',
        view: '查看',
        restore: '恢复',
        previewing: '预览备份 {name}',
        closePreview: '关闭预览',
        restoreDone: '已从 {name} 恢复',
        saveFailed: '操作失败：{msg}',
        loadFailed: '读取失败：{msg}',
      },
      en: {
        nav: 'Global rules',
        title: 'Global rules editor',
        missing: 'File does not exist yet; it will be created on first save.',
        modified: 'Modified {time}',
        missingFile: 'missing',
        reload: 'Reload',
        save: 'Save',
        saving: 'Saving…',
        savedPlain: 'Saved',
        backupSaved: 'Saved (backup {name})',
        dirty: 'Unsaved changes',
        hintCtrlS: 'Ctrl+S to save',
        conflictTitle: 'File changed externally',
        conflictBody: 'The file was modified elsewhere after you loaded it. Overwriting loses those changes; consider reloading first.',
        overwrite: 'Overwrite anyway',
        backups: 'Backups ({n})',
        backupEmpty: 'No backups yet — the first save creates one automatically.',
        view: 'View',
        restore: 'Restore',
        previewing: 'Previewing {name}',
        closePreview: 'Close preview',
        restoreDone: 'Restored from {name}',
        saveFailed: 'Operation failed: {msg}',
        loadFailed: 'Failed to read: {msg}',
      },
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = [
      '.age-page{display:flex;flex-direction:column;gap:12px;padding:4px 2px 16px;color:var(--dsw-alias-label-primary,#1c1e21);font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.age-title{font-size:15px;font-weight:600}',
      '.age-head{display:flex;flex-direction:column;gap:4px}',
      '.age-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.age-path{font-family:Consolas,"JetBrains Mono",Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7078);word-break:break-all}',
      '.age-muted{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px}',
      '.age-warn{color:var(--dsw-alias-state-warning-primary,#b7791f);font-size:12px}',
      '.age-editor{min-height:420px;resize:vertical;width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1c1e21);font:13px/1.6 Consolas,"JetBrains Mono",Menlo,"Cascadia Code",monospace;tab-size:2;white-space:pre;overflow:auto;outline:none}',
      '.age-editor:focus{border-color:var(--dsw-alias-state-business-primary,#4f6ef7)}',
      '.age-readonly{background:var(--dsw-alias-bg-layer-2,#f5f6f7)}',
      '.age-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.age-flex{flex:1}',
      '.age-dirty{color:var(--dsw-alias-state-warning-primary,#b7791f);font-size:12px;font-weight:600}',
      '.age-hint{opacity:.8}',
      '.age-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#1c1e21);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.age-btn:hover{border-color:var(--dsw-alias-state-business-primary,#4f6ef7);color:var(--dsw-alias-state-business-primary,#4f6ef7)}',
      '.age-btn:disabled{opacity:.45;cursor:default}',
      '.age-btn-primary{background:var(--dsw-alias-state-business-primary,#4f6ef7);border-color:var(--dsw-alias-state-business-primary,#4f6ef7);color:var(--dsw-alias-label-on-accent,#ffffff)}',
      '.age-btn-primary:hover{color:var(--dsw-alias-label-on-accent,#ffffff);filter:brightness(1.08)}',
      '.age-btn-danger{color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.age-btn-danger:hover{border-color:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.age-btn-sm{padding:2px 8px;font-size:11px;border-radius:6px}',
      '.age-conflict{border:1px solid var(--dsw-alias-state-warning-primary,#b7791f);background:rgba(183,121,31,.10);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12px}',
      '.age-conflict p{margin:0;color:var(--dsw-alias-label-secondary,#6b7078)}',
      '.age-conflict-actions{display:flex;gap:8px}',
      '.age-status{border-radius:8px;padding:6px 10px;font-size:12px}',
      '.age-status-ok{background:rgba(47,158,110,.12);color:var(--dsw-alias-state-success-primary,#2f9e6e)}',
      '.age-status-warn{background:rgba(183,121,31,.12);color:var(--dsw-alias-state-warning-primary,#b7791f)}',
      '.age-status-err{background:rgba(214,69,69,.12);color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.age-backups{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px;padding:8px 12px;font-size:12px}',
      '.age-backups summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7078)}',
      '.age-backup-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}',
      '.age-backup-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.age-backup-name{font-family:Consolas,Menlo,monospace;font-size:11px}',
      '.age-preview{display:flex;flex-direction:column;gap:8px}',
      '.age-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}',
      '.age-gap{flex:1}',
    ].join('\n')

    // ── helpers ─────────────────────────────────────────────────────────────
    async function api(path, options) {
      const res = await fetch(API + path, options)
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        const error = new Error(payload?.error || 'HTTP ' + res.status)
        error.status = res.status
        error.payload = payload
        throw error
      }
      return payload
    }

    function fmtBytes(n) {
      const v = Number(n) || 0
      return v < 1024 ? v + ' B' : (v / 1024).toFixed(1) + ' KB'
    }

    function fmtTime(ms) {
      const v = Number(ms)
      return v > 0 ? new Date(v).toLocaleString() : ''
    }

    function makeT(ctx) {
      const raw = ctx.locale.bind(NS)
      return (key, vars) => {
        let text = raw(key)
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.split('{' + k + '}').join(String(v))
        return text
      }
    }

    // ── page ────────────────────────────────────────────────────────────────
    function EditorPage(props) {
      const { t } = props
      const [file, setFile] = useState(null)        // 服务端读到的文件状态
      const [draft, setDraft] = useState('')        // 正在编辑的文本
      const [phase, setPhase] = useState('loading') // loading | ready | error
      const [loadError, setLoadError] = useState('')
      const [saving, setSaving] = useState(false)
      const [conflict, setConflict] = useState(false)
      const [status, setStatus] = useState(null)    // { tone, text }
      const [backups, setBackups] = useState([])
      const [preview, setPreview] = useState(null)  // { name, content }
      const fileRef = useRef(null)

      const dirty = file !== null && draft !== file.content

      const load = useCallback(async () => {
        setPhase('loading')
        setPreview(null)
        setConflict(false)
        setStatus(null)
        try {
          const data = await api('/global')
          fileRef.current = data
          setFile(data)
          setDraft(data.content ?? '')
          setPhase('ready')
        } catch (error) {
          setLoadError(error.message)
          setPhase('error')
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const refreshBackups = useCallback(async () => {
        try {
          const data = await api('/backups')
          setBackups(data.items ?? [])
        } catch { /* 备份通道不可用不阻塞编辑 */ }
      }, [])

      useEffect(() => { void refreshBackups() }, [refreshBackups])

      const save = useCallback(async (force = false) => {
        const current = fileRef.current
        if (current === null || saving) return
        setSaving(true)
        try {
          const data = await api('/global', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: draft, baseModified: current.modified, force }),
          })
          const next = { ...current, exists: true, content: draft, bytes: data.bytes, modified: data.modified }
          fileRef.current = next
          setFile(next)
          setConflict(false)
          setStatus({ tone: 'ok', text: data.backup ? t('backupSaved', { name: data.backup }) : t('savedPlain') })
          void refreshBackups()
        } catch (error) {
          if (error.status === 409) {
            setConflict(true)
            setStatus({ tone: 'warn', text: t('conflictTitle') })
          } else {
            setStatus({ tone: 'err', text: t('saveFailed', { msg: error.message }) })
          }
        } finally {
          setSaving(false)
        }
      }, [draft, saving, t, refreshBackups])

      const restore = useCallback(async (name) => {
        if (saving) return
        setSaving(true)
        try {
          await api('/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          const fresh = await api('/global')
          fileRef.current = fresh
          setFile(fresh)
          setDraft(fresh.content ?? '')
          setPreview(null)
          setConflict(false)
          setStatus({ tone: 'ok', text: t('restoreDone', { name }) })
          void refreshBackups()
        } catch (error) {
          setStatus({ tone: 'err', text: t('saveFailed', { msg: error.message }) })
        } finally {
          setSaving(false)
        }
      }, [saving, t, refreshBackups])

      const view = useCallback(async (name) => {
        try {
          const data = await api('/backup?name=' + encodeURIComponent(name))
          setPreview({ name, content: data.content ?? '' })
        } catch (error) {
          setStatus({ tone: 'err', text: t('saveFailed', { msg: error.message }) })
        }
      }, [t])

      // Ctrl+S / Cmd+S 保存；Tab 插入两个空格。
      const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void save(false)
          return
        }
        if (event.key === 'Tab' && !event.shiftKey && preview === null) {
          event.preventDefault()
          const el = event.currentTarget
          const start = el.selectionStart ?? 0
          const end = el.selectionEnd ?? 0
          const next = draft.slice(0, start) + '  ' + draft.slice(end)
          setDraft(next)
          requestAnimationFrame(() => { try { el.selectionStart = el.selectionEnd = start + 2 } catch { /* 已重渲染 */ } })
        }
      }

      // 有未保存更改时拦截整页刷新/关闭。
      useEffect(() => {
        if (!dirty) return
        const guard = (event) => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', guard)
        return () => window.removeEventListener('beforeunload', guard)
      }, [dirty])

      if (phase === 'loading') {
        return h('div', { className: 'age-page' }, h('p', { className: 'age-muted' }, '…'))
      }
      if (phase === 'error') {
        return h('div', { className: 'age-page' },
          h('p', { className: 'age-status age-status-err' }, t('loadFailed', { msg: loadError })),
          h('div', null, h('button', { className: 'age-btn', onClick: () => { void load() } }, t('reload'))))
      }

      return h('div', { className: 'age-page' },
        h('div', { className: 'age-head' },
          h('div', { className: 'age-title' }, t('title')),
          h('div', { className: 'age-sub' },
            h('span', { className: 'age-path' }, file.path),
            file.exists
              ? h('span', { className: 'age-muted' }, t('modified', { time: fmtTime(file.modified) }) + ' · ' + fmtBytes(file.bytes))
              : h('span', { className: 'age-warn' }, t('missing')))),
        conflict
          ? h('div', { className: 'age-conflict' },
              h('b', null, t('conflictTitle')),
              h('p', null, t('conflictBody')),
              h('div', { className: 'age-conflict-actions' },
                h('button', { className: 'age-btn', onClick: () => { void load() } }, t('reload')),
                h('button', { className: 'age-btn age-btn-danger', onClick: () => { void save(true) }, disabled: saving }, t('overwrite'))))
          : null,
        preview
          ? h('div', { className: 'age-preview' },
              h('div', { className: 'age-preview-head' },
                h('b', null, t('previewing', { name: preview.name })),
                h('span', { className: 'age-flex' }),
                h('button', { className: 'age-btn age-btn-danger', onClick: () => { void restore(preview.name) }, disabled: saving }, t('restore')),
                h('button', { className: 'age-btn', onClick: () => setPreview(null) }, t('closePreview'))),
              h('textarea', { className: 'age-editor age-readonly', value: preview.content, readOnly: true, spellCheck: false, wrap: 'off' }))
          : h('textarea', {
              className: 'age-editor',
              value: draft,
              onChange: (event) => { setDraft(event.target.value); setStatus(null); setConflict(false) },
              onKeyDown,
              spellCheck: false,
              wrap: 'off',
              placeholder: file.exists ? '' : t('missing'),
            }),
        status ? h('div', { className: 'age-status age-status-' + status.tone }, status.text) : null,
        h('div', { className: 'age-foot' },
          h('span', { className: 'age-muted' }, (draft.split('\n').length) + ' 行 · ' + fmtBytes(new TextEncoder().encode(draft).length)),
          dirty ? h('span', { className: 'age-dirty' }, t('dirty')) : null,
          h('span', { className: 'age-flex' }),
          h('span', { className: 'age-muted age-hint' }, t('hintCtrlS')),
          h('button', { className: 'age-btn', onClick: () => { void load() }, disabled: saving }, t('reload')),
          h('button', {
            className: 'age-btn age-btn-primary',
            onClick: () => { void save(false) },
            disabled: saving || !dirty,
          }, saving ? t('saving') : t('save'))),
        h('details', { className: 'age-backups' },
          h('summary', null, t('backups', { n: backups.length })),
          backups.length === 0
            ? h('p', { className: 'age-muted' }, t('backupEmpty'))
            : h('ul', { className: 'age-backup-list' }, backups.map(b => h('li', { key: b.name },
                h('span', { className: 'age-backup-name' }, b.name),
                h('span', { className: 'age-muted' }, fmtBytes(b.bytes) + ' · ' + fmtTime(b.modified)),
                h('button', { className: 'age-btn age-btn-sm', onClick: () => { void view(b.name) } }, t('view')),
                h('button', { className: 'age-btn age-btn-sm age-btn-danger', onClick: () => { void restore(b.name) }, disabled: saving }, t('restore')))))))
    }

    // ── registration ────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = makeT(ctx)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'agents-editor: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-agents-editor')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'agents-editor: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agents-editor',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, props => h(EditorPage, { ...props, t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'agents-editor'
    return module.exports
  },
})
