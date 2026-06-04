# 从信任到验证：web3:// 数据可验证性探索

> 面向浏览器客户端的独立验证方案

## 摘要

web3://（ERC-4804 / ERC-6860）为链上资源提供了类似 HTTP 的统一访问方式，使客户端能够通过 URL 访问链上状态、智能合约返回内容以及基于
EthStorage 等系统存储的文件资源。

然而，无论采用 Gateway 还是未来浏览器原生支持 web3://，数据最终都需要通过 RPC 节点从区块链网络获取。对于客户端而言，数据到达过程中经过的
Gateway、RPC 节点或其他中间组件都可能返回错误或被篡改的数据。

因此，真正需要解决的问题并不是数据从哪里获取，而是：**客户端如何独立验证最终拿到的数据是否与链上真实状态一致。**

本项目实现了一个 web3:// 数据验证原型，其形态更接近浏览器插件：

- 数据通过普通 Gateway 获取
- 验证通过独立路径完成
- 最终在客户端本地完成校验

核心思想是： **数据获取路径与验证路径分离。**

针对不同类型的数据，本项目采用两种验证方式：

- Ethereum 状态数据通过 Colibri 无状态证明验证
- EthStorage 文件通过 Colibri 验证链上状态，再结合 Versioned Hash 完成完整性验证

整个验证过程不依赖 Gateway、RPC 或其他数据提供方的诚实性。

项目基于多个真实部署站点进行了测试，并测量了验证性能，验证了 web3:// 内容独立验证方案的工程可行性。

---

## 1. 背景

### 1.1 web3:// 的作用

传统 Web 的访问方式：浏览器 → HTTP → Web Server → Content。

而 web3:// 提供了一种面向区块链资源的统一 URL 访问标准：浏览器 → web3:// → Blockchain → Content。

web3:// 本身并不负责存储数据。

它更接近于：
> HTTP 是访问 Web 资源的统一协议，而 web3:// 是访问链上资源的统一协议。

### 1.2 问题：客户端无法验证数据真实性

内容部署到链上之后，挑战在于数据从链上到用户手中的真实性。当前访问链路如下：

```
Browser → [Gateway] → RPC → Blockchain
```

问题：**这个链路上的任何一环都可能作恶。**

- **RPC 节点**：可以返回任意结果，客户端无法区分
- **Gateway**：可以在转发过程中篡改内容

即使未来浏览器原生支持 web3:// 协议、去掉 Gateway 这一层，但RPC 作恶的风险依然存在，**
根本问题是客户端缺少独立验证数据真实性的能力**。

对于客户端而言，并不需要区分错误来自 Gateway 还是 RPC。 客户端只关心一个问题：最终获得的数据是否与链上真实数据一致。

### 1.3 本项目目标

本项目并不尝试构建新的存储系统或替代 Gateway。目标只有一个：**让客户端能够独立验证最终拿到的数据是否与链上真实数据一致。**

核心思路是**数据获取路径与验证路径分离**：

```
数据获取路径（不可信）         验证路径（可信）
     ↓                            ↓
 Gateway / RPC / ...           Colibri 密码学证明
     ↓                            ↓
  拿到的数据                    链上真实状态
     ↓                            ↓
     └──────── 本地比对 ──────────┘
                  ↓
          ✅ 一致 / ❌ 不一致
```

从架构上看，它更接近一个浏览器插件：拦截数据获取 → 独立验证 → 告知用户结果。

---

## 2. 验证架构

```
                              ┌──────────────┐
                              │  Ethereum    │
                              │  State       │
                              └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                │
            ┌──────────────┐ ┌──────────────┐         │
            │ 数据获取路径    │ │ Colibri      │         │
            │ (不可信)       │ │ (密码学验证)   │         │
            │              │ │              │         │
            │ Gateway/RPC  │ │ 状态证明      │         │
            │ 拿到数据      │ │ Versioned    │         │
            │              │ │ Hash         │         │
            └──────┬───────┘ └──────┬───────┘         │
                   │                │                 │
                   ▼                ▼                 │
            ┌─────────────────────────────────────┐   │
            │         本地验证引擎                  │   │
            │                                     │   │
            │  Ethereum 状态数据:                  │   │
            │    数据获取结果 vs Colibri 证明结果    │   │
            │                                     │   │
            │  EthStorage 文件:                   │   │
            │    本地重算 Hash vs 链上 Hash         │   │
            └─────────────────────────────────────┘   │
                                     │                │
                                     ▼                │
                              Verified / Failed
```

**核心思想**：数据获取路径可以是任意不可信来源（Gateway、RPC 等），验证路径通过 Colibri
从链上获取可信参照，两者独立在本地比对。**验证结果不依赖数据获取路径的诚实性。**

---

## 3. 两类数据验证方式

虽然 web3:// 存在 Auto / Manual 等解析模式，但对于验证系统而言，更重要的是数据最终存储在哪里。本项目覆盖两类数据。

### 3.1 Ethereum 状态数据验证

对于合约调用（eth_call），返回结果直接来源于 Ethereum 状态。

**验证流程**：

```
数据获取路径                验证路径
（不可信 RPC/Gateway）      （Colibri 密码学证明）
     ↓                          ↓
  eth_call                   eth_call
     ↓                          ↓
  rawResult            verifiedResult

比较 rawResult == verifiedResult → 匹配 ✅
```

**Colibri 在这里做什么？** Colibri 不是普通 RPC。当客户端发起 eth_call 时，Colibri
会同时返回调用结果、状态证明和区块头信息。客户端验证区块头合法性、状态根合法性和调用证明合法性，验证失败则直接报错。因此：**
Colibri 返回成功 = 结果已经通过密码学验证。**

### 3.2 EthStorage 文件验证

对于通过 EthStorage 存储的文件(HTML、JS、CSS、PNG...)，其内容并不保存在 Ethereum 状态中。

**上传过程中:**：

```
File → 编码为 Blob → EIP-4844 Transaction 提交 → Ethereum Contract → EthStorage 持久化存储
```

**同时:**：

```
Blob → KZG Commitment → Versioned Hash → Ethereum 合约 Mapping
```

实际文件内容存储在 EthStorage 网络中，而 Ethereum 合约仅保存 Versioned Hash。

**为什么不能直接验证 Blob？** EIP-4844 Blob 是临时数据，经过一段时间后会被以太坊删除，因此无法通过 Ethereum RPC
再次获取原始文件。但上传时生成的 Versioned Hash 会永久保存在链上。因此验证目标变成：**验证拿到的文件是否对应链上记录的
Versioned Hash。**

**验证流程**：

```
数据获取路径                验证路径
（不可信 Gateway/RPC）      （Colibri + 链上查询）
     ↓                          ↓
  文件内容                  Versioned Hash
     ↓
本地重新计算
     ↓
Versioned Hash

比较 localHash == chainHash → 匹配 ✅
```

---

## 4. 测试站点

本项目验证了多个真实部署站点：

| 站点                 | 网络               | 类型         | 模式 |
|--------------------|------------------|------------|------|
| EthStorage Website | Ethereum Mainnet | 官网         | Manual |
| Safe Website       | Sepolia          | Safe 前端    | Manual |
| VBlog Website      | Sepolia          | vitalik 博客 | Manual |
| NFT Render Example | Ethereum Mainnet | 合约方法调用     | Auto |

---

## 5. 验证流程

### Step 1：站点发现

从 `/` 开始，解析 HTML 中的 `href`、`src`、`link` 等标签，递归发现子资源（模拟浏览器行为，不下载超链接跳转的子页面）。

### Step 2：数据获取

通过 Gateway 下载 HTML、JS、CSS、PNG、JSON 等资源（Demo 以 Gateway 为数据获取路径实例，实际可替换为任意来源）。并发数：16。

### Step 3：独立验证

并发数：8。

- **Ethereum 状态数据**：数据获取路径结果 vs Colibri 密码学证明结果
- **EthStorage 文件**：数据获取路径文件 vs 链上 Versioned Hash（本地重计算）

### Step 4：失败分析

当验证失败时，打印差异、输出位置、定位原因，用于分析数据不一致的具体来源。

---

## 6. 性能测试

### 测试环境

- macOS
- Node.js
- 远程 Colibri Prover 节点

### 测试结果

```
═══════════════════════════════════════════════════════════════════════
 测试用例              文件数    数据量      下载耗时    验证耗时
───────────────────────────────────────────────────────────────────────
 Mainnet EthStorage       5    1.3MB        7.1s       4.4s
 Safe                    16    4.5MB       15.3s      17.1s
 VBlog                    3    1.7MB        9.9s       2.0s
 Render Example (Auto)    1   14.6KB        1.9s       3.2s
═══════════════════════════════════════════════════════════════════════
 总计                    25    7.5MB       34.2s      26.7s
═══════════════════════════════════════════════════════════════════════
```

### 验证结果

| 测试用例 | 总文件 | ✅ 通过 | ❌ 失败 | 说明 |
|---------|-------|--------|--------|------|
| Mainnet EthStorage | 5 | 4 | 1 | 根文件 Gateway 注入导致 |
| Safe | 16 | 15 | 1 | 根文件 Gateway 注入导致 |
| VBlog | 3 | 3 | 0 | 全部通过 |
| Render Example (Auto) | 1 | 1 | 0 | 全部通过 |

### 核心发现

**验证耗时接近下载耗时。** 验证耗时约为下载耗时的 0.2x ~ 1.1x，对于浏览器场景可接受。

**缓存命中后性能进一步提升。** 当 Colibri 已缓存相关状态时，验证耗时约为下载耗时的 1/3，瓶颈主要变为本地 KZG 计算。

**VBlog 全部通过。** 3 个文件包含 HTML、CSS 和一个 1.7MB 的 JS 文件，全部验证通过，说明方案能够支持真实网站规模。

**Auto 模式验证通过。** Colibri 返回的结果自带密码学证明，无需额外本地计算，验证流程最简洁。

---

## 7. 测试中发现：Gateway 注入脚本

当前 Demo 以 w3link.io Gateway 作为数据获取路径。测试中发现：w3link.io 会对 HTML 自动注入脚本，将 web3:// 链接转换为
Gateway 的 https:// 链接：

```html

<script>
	Convert
	web3:// links to gateway URLs
</script>
```

导致拿到的内容 ≠ 链上原始内容，从而触发验证失败。

**影响范围**：仅影响 HTML 文件，不会影响 JS、CSS、PNG 等静态资源。

**处理方式**：验证时移除注入脚本后再进行哈希计算，验证恢复正常。这一发现也说明：即使 Gateway
出于善意目的注入内容，验证系统也能将其识别为"与链上不一致"。

---

## 8. 结论

本项目证明：**客户端无需运行全节点，也无需信任 Gateway 或 RPC。**

仅通过：

- Colibri 提供的无状态证明
- Ethereum 链上元数据
- 本地密码学验证

即可独立确认获取到的数据是否与链上记录一致。

- 对于 **Ethereum 状态数据**：Colibri + 状态证明完成验证
- 对于 **EthStorage 文件**：Versioned Hash + 本地重计算完成验证

实际测试覆盖 25 个文件（约 7.5MB 数据），全部验证通过或能够明确解释不一致原因（Gateway 注入脚本）。

性能测试表明：验证耗时接近下载耗时，已经具备浏览器插件级别落地的可行性。无论未来浏览器是通过 Gateway 转发还是原生支持 web3:
// 协议直连 RPC，相同的验证逻辑都可以集成到客户端，实现真正意义上的可验证链上网页访问。

web3:// 解决的是“如何定位链上内容”，而本项目探索的是“如何验证获取到的内容是否正确”。

---

## 附录

### A. 项目结构

```
colibri-test/
├── src/
│   ├── index.ts               # 入口：遍历测试用例，启动验证
│   ├── config.ts              # 配置：网络 RPC、测试用例定义
│   ├── web3url_verifier.ts    # 核心：Web3URLVerifier 类
│   ├── blobs.ts               # Blob 编码与 KZG 哈希计算
│   └── deep.ts                # Colibri 深度原理验证
├── tsconfig.json              # TypeScript 配置
├── package.json               # 依赖
└── README.md
```

### B. 运行

```bash
npm install
npm start
```

### C. 参考链接

- [web3:// 协议官网](https://web3url.w3eth.io/)
- [web3:// 协议文档（resolve mode）](https://docs.web3url.io/web3-url-structure/resolve-mode)
- [Colibri Stateless Prover](https://github.com/corpus-core/colibri-stateless)
- [FlatDirectory 合约](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/FlatDirectory.sol)
- [EIP-4844: Shard Blob Transactions](https://eips.ethereum.org/EIPS/eip-4844)
- [ERC-4804: web3:// URL](https://eips.ethereum.org/EIPS/eip-4804)
- [ERC-6860: web3:// URL (revised)](https://eips.ethereum.org/EIPS/eip-6860)
