# dsh-agents-editor — 全局规则编辑器

在 DeepSeek Harness 的设置面板里新增一个「全局规则」分区，直接查看和编辑宿主全局规则文件 `~/.dsh/AGENTS.md`（对所有会话生效的那份）。

## 功能

- **可视化编辑**：等宽编辑器，Ctrl+S 保存，Tab 缩进，行数 / 字节实时统计；
- **自动备份**：每次保存前把当前内容备份到 `~/.dsh/agents-editor/backups/`，可随时回退；
- **冲突检测**：读入后文件在别处被改动（例如会话里让智能体改了规则）→ 保存时返回 409，可选「覆盖」或「重新加载」；
- **备份预览与恢复**：备份清单按时间倒序，支持只读预览与一键恢复（恢复前会把当前内容再备份一份，永远可撤销）；
- **未保存保护**：有未保存更改时拦截页面刷新 / 关闭。

## 结构

| 文件 | 说明 |
| --- | --- |
| `host.js` | 宿主半身：挂载 `/api/agents-editor/*` 同源路由，读写 AGENTS.md 与备份目录 |
| `client.js` | 浏览器半身：注册 `settings.section` 分区，React 编辑器界面 |
| `cordis.patch.yml` | bundle 层 insert 锚点，把宿主半身挂进插件树 |
| `locale/*.json` | 插件详情页元信息 |
| `scripts/selftest.mjs` | 宿主 API 自测（假 webServer + 假请求，跑通读/写/冲突/备份/恢复全链路） |

## 安装（desktop profile）

1. 本目录（或 GitHub 仓库）放进 `~/.dsh/profiles/desktop` 的依赖：

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   {
     "dependencies": {
       "dsh-agents-editor": "link:F:/desktop/草稿文件/dsh产物/dsh-agents-editor"
       // 或装 GitHub 版：
       // "dsh-agents-editor": "github:amd47802574/dsh-agents-editor"
     },
     "dsh": { "profile": { "bundles": [ "dsh-agents-editor", /* … */ ] } }
   }
   ```

2. `pnpm install` 后重启 DSH，设置面板出现「全局规则」分区。

## API 一览（前缀 `/api/agents-editor`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/meta` | 版本与目标路径 |
| GET | `/global` | 读全局规则 |
| PUT | `/global` | 保存（`content` 必填；`baseModified` 冲突检测；`force` 强制覆盖） |
| GET | `/backups` | 备份清单（新→旧） |
| GET | `/backup?name=…` | 读一份备份 |
| POST | `/restore` | 从备份恢复 |

备份名严格白名单（`AGENTS.md-YYYYMMDD-HHmmss-hex.md`），杜绝路径穿越。

## 自测

```bash
node scripts/selftest.mjs
```

## License

MIT
