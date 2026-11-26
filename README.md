# OpenRouter Cost Router for Codex

用最近的实际 token 用量，在所选 OpenRouter 模型的公开端点之间比较预计请求费用。插件提供启动和诊断指引，请求路由由本地网关执行。Codex 通过网关读取 OpenRouter 的模型目录，可以用 `/model` 点选模型。

## 启动 Codex

需要 Node.js 22.13 或更新版本、Codex CLI，以及已在终端设置的 `OPENROUTER_API_KEY`。项目使用 Node.js 内置模块。

在想交给 Codex 的项目目录运行启动器。

```bash
node /home/sjy/openrouter-cost-router/plugins/openrouter-cost-router/cli.mjs codex
```

首次启动使用 DeepSeek V4.1 Flash 1017。可用 `-m` 指定其他 OpenRouter 模型 ID，或启动后用 `/model` 切换。启动器将本地网关配置传给这次 Codex 进程，退出 Codex 时一同关闭。

```bash
OPENROUTER_ROUTER_MAX_CACHE_READ=0.001 \
OPENROUTER_ROUTER_IGNORE=wafer,sail-research \
node /home/sjy/openrouter-cost-router/plugins/openrouter-cost-router/cli.mjs codex -m deepseek/deepseek-v4.1-flash-1017
```

## 路由规则

- 读取所选模型的端点报价，并用最近七天内最多 40 条该模型请求估算未缓存输入、缓存读写和输出 token 数。新模型先根据请求长度估算输入，输出从 512 token 起估。收到完整用量后更新本地样本。
- 使用每家端点的单价估算整次费用。某个端点有近期样本时，用其观测到的缓存读写比例。如果当前会话近期已有请求，比较其他端点时把当次缓存读取按冷缓存估算。
- 默认所有符合请求条件且有报价的端点参与，包括可明确选中的 Flex 端点。根据报价目录声明的能力、请求里的供应商限制和预算筛选，再按预计费用从低到高选择。
- 默认仅在 OpenRouter 报告限流或无符合条件端点时尝试同等估算价的端点。可将 `OPENROUTER_ROUTER_FALLBACK_RATIO` 设为例如 `1.2`，允许尝试预计最多贵 20% 的端点。没有符合条件的端点时返回错误。
- `OPENROUTER_ROUTER_MAX_CACHE_READ` 按美元／百万缓存读取 token 设上限。按有效报价筛选，并检查可能的长上下文价格和 Flex 降到标准档的情况。报价缓存 60 秒。实际账单还会受调价、缓存命中量和输出长度影响。

默认数据库位于 `~/.local/state/openrouter-cost-router/usage.sqlite`，也可用 `OPENROUTER_ROUTER_DB` 指定其他路径。用量按 API Key 分开，记录模型、端点、计费 token 数和会话标识的哈希。`OPENROUTER_ROUTER_WINDOW` 可调整样本数。

## 独立运行网关

供已经运行的 Codex 客户端或桌面应用连接。

```bash
node /home/sjy/openrouter-cost-router/plugins/openrouter-cost-router/cli.mjs serve 17863
```

在 Codex 用户配置顶层设置 `model_provider` 和 `model`，并加入供应商表。

```toml
model = "deepseek/deepseek-v4.1-flash-1017"
model_provider = "openrouter-cost-router"

[model_providers.openrouter-cost-router]
name = "OpenRouter Cost Router"
base_url = "http://127.0.0.1:17863/v1"
model_catalog_url = "http://127.0.0.1:17863/v1/models"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
supports_websockets = false
```

网关打印实际地址。用 `/status` 查看最低的几个费用估算、实际请求的端点和记录到的 token 用量。

```bash
curl -fsS 'http://127.0.0.1:17863/status' \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

网关使用 OpenRouter 的 HTTP Responses API 和 SSE。选择具有公开端点报价的具体模型 ID。`openrouter/auto`、`@preset/...` 和一次请求中定义的备用模型列表需要先解析为具体模型。使用 `previous_response_id` 的请求需要之前的响应也经过这个网关。

## 安装 Codex 操作技能

```bash
codex plugin marketplace add /home/sjy/openrouter-cost-router
codex plugin add openrouter-cost-router@local-openrouter
```

安装后可调用 `$openrouter-cost-router` 获取启动和诊断指引。模型请求通过上面的启动器或独立网关接入。

## 测试

```bash
cd /home/sjy/openrouter-cost-router
node --test
```

测试使用模拟 OpenRouter 的端点报价和流式响应。本机允许绑定回环端口时，可用 `OPENROUTER_TEST_LOOPBACK=1 node --test` 验证 HTTP 转发。
