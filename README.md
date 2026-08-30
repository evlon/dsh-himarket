# dsh-himarket

把 [HiMarket](https://github.com/higress-group/himarket)（企业 AI 能力市场）接入 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的桥接插件。

- **同步已订阅的 MCP Server** → 自动注册成模型可调用的工具（`mcp__<name>__<tool>`）
- **一键安装已发布的 Skill** → 落盘到 `~/.dsh/skills/`，装完即可用，无需重启
- **小白友好**：设置页一个「HiMarket」卡片 + 对话式入口（说「同步 HiMarket」「安装 xx 技能」即可）

## 给同事（小白）用：三步

1. 打开 DSH Web → **设置 → HiMarket**。
2. 填三样：**HiMarket 地址**、**用户名**、**密码**（找 HiMarket 管理员要开发者账号），点「保存」。
3. 点「**同步能力**」，然后：
   - 已订阅的 MCP 工具会自动出现在对话里，直接说「用 xxx 查一下…」即可；
   - 想装技能，点技能卡片上的「**安装**」，装完在对话里说「帮我用 xx 技能…」。

> 也可以在对话里直接说「同步 HiMarket」或「安装 xx 技能」，效果一样。

## 给 DSH 管理员：安装

```sh
# 方式一：公司内网 registry 发布后
dsh plugin --profile web add dsh-himarket

# 方式二：本地源码（开发）
dsh plugin --profile web add link:E:/path/to/dsh-himarket
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 里加一行（`dsh plugin add` 会自动写）：

```yaml
- insert:
    - id: himarket
      name: dsh-himarket
```

重启 `dsh web`，刷新页面，设置里会出现「HiMarket」卡片。

## 配置

所有配置走 DSH 的 settings（`~/.dsh/settings.yaml`，热加载），也可以在桥接行里给默认值：

```yaml
- insert:
    - id: himarket
      name: dsh-himarket
      config:
        skillInstallDir: ''   # 留空 = ~/.dsh/skills；可改成公司统一技能目录
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 空 | HiMarket 后端地址（不含尾斜杠），如 `http://10.0.0.8:8080` |
| `username` | 空 | 开发者账号用户名 |
| `password` | 空 | 开发者账号密码（明文，仅存本机 settings.yaml） |
| `skillInstallDir` | 空 | Skill 安装根；留空回退 `~/.dsh/skills` |

## 架构与实现要点

- **不发布服务**：桥接只消费 `webServer`/`tools`/`settings`，放 host 平面、行 loose、无 isolate realm（与 `dsh-matrix` 同形）。
- **MCP 复用官方客户端**：不重造 MCP 客户端，运行时经 `createRequire(ctx.baseUrl)` + 动态 `import()` 解析 `@deepseek-ai/dsh-mcp-client`，用 Cordis `ctx.plugin()` 动态建/拆 fiber，`serverName` 由 HiMarket `name` 清洗得到。
- **Skill 靠写文件生效**：下载 ZIP → 系统 `bsdtar` 解压 → 定位 `SKILL.md` → 落盘 `~/.dsh/skills/<name>/`，由 DSH 自带的 `@deepseek-ai/dsh-skill-filesystem` 扫描发现（无需重启）。
- **凭证走 settings**：与 DSH Web 的 Models 页同一机制，热加载、重启自动恢复。
- **HiMarket API 契约**（由 HiMarket 后端提供，本插件只做字段容错）：
  - `POST /developers/login` → `{code, data:{access_token}}`
  - `GET /cli-providers/market-mcps` → `{data:{mcpServers:[{name,url,transportType}], authHeaders}}`
  - `GET /cli-providers/market-skills` → `{data:{items:[{productId,name,description}]}}`
  - `GET /skills/{productId}/download` → ZIP

## 开发

```sh
pnpm install
pnpm build        # tsc 编译 src → lib
pnpm test         # 单元测试（node --test tests/）
```

- host 端源码在 `src/`（TypeScript，编译到 `lib/`）。
- 浏览器端 bundle 是手写 UMD，在 `lib/client/index.js`（不经过 tsdown/Vite，与 `dsh-plugin-hub` 同款）。
- 端到端冒烟：`node tests/mock-himarket.mjs 18080` 起假后端，再对运行中的 web 实例调 `/himarket/save-config`、`/himarket/sync`、`/himarket/install-skill`。

## 已知限制

- `stdio` 型 MCP 暂不支持（HiMarket 的 `market-mcps` 目前只暴露 http 型 URL）。
- 密码明文存本机 `settings.yaml`（与 DSH Models 页的 apiKey 同一风险等级）；后续可换 token 直填或系统凭据库。
- `transportType: sse` 统一按 `streamable-http` 处理（官方 mcp-client 的 Streamable HTTP 传输兼容 SSE 端点）。
- 清空配置需重启或重新 sync 才会完全清除内存态（token 已在 save-config 清空时一并处理）。

## 许可

MIT
