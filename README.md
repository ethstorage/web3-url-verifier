# web3:// 数据可验证性探索 — 基于 Colibri 无状态证明

## 摘要

数据存入链上后，可以用 `web3://` 协议来寻址和访问。但数据从链上到用户手里，中间经过了 Gateway 或 RPC
节点——它们可以作恶，返回篡改过的数据，用户无法区分。本项目基于 [Colibri Stateless Prover](https://github.com/corpus-core/colibri-stateless)
，对通过 web3:// 协议获取的数据进行**端到端可验证性测试**，覆盖多个真实部署场景，验证了去中心化数据验证在生产环境中的可行性。

---

## 1. 背景：web3:// 协议与数据验证的缺失

### 1.1 问题

目前有 EthStorage 等去中心化存储方案，可以把现在仍然是中心化部署的 DApp 前端存到链上，消除中心化服务器这个单点。存上去之后通过 `web3://`
协议（ERC-4804/ERC-6860）进行访问，它定义了一套 URL 寻址标准，让浏览器 / 客户端能够像访问 `http://`
一样，通过 `web3://` 来定位和获取链上数据。

**关键问题**：Gateway 或 RPC 节点可以作恶——返回篡改过的数据，用户无法区分。

### 1.2 解决思路

如果用户能**独立验证**从 Gateway/RPC 拿到的数据是否与链上存储一致，就不再需要信任 Gateway/RPC。这就是本 Demo 探索的核心：**对 web3:
// 取回的数据进行密码学验证，衡量耗时，判断是否具备生产级可行性**。

### 1.3 web3:// 如何工作

web3:// 协议规定，客户端通过 `resolveMode()` 判断合约的解析模式，然后按模式解析 URL 路径：

- **Auto 模式（默认）**：路径被解析为 `方法名(参数1, 参数2, ...)`，直接对合约发起 eth_call。
- **Manual 模式**：合约 `resolveMode()` 返回 `"manual"`。路径整体作为 calldata 发给合约，由合约自行路由。

协议还定义了第三种 721 模式（resource request），本项目暂不涉及。

本 Demo 涉及多个个真实部署的合约/站点:

- **EthStorage Website**：Ethereum 主网上的 EthStorage 网站
- **Safe Website**：Sepolia 测试网上的 Safe 前端
- **VBlog Website**：Sepolia 上的博客站点

---

## 2. 两种解析模式及其验证方式

### 2.1 Auto 模式：Colibri 直接验证 eth_call 结果

**验证原理**：Auto 模式下，web3:// 请求最终会转换为一次普通的 eth_call。 当客户端通过 Colibri Prover
发起该调用时，返回结果已经附带了状态证明。客户端会验证区块头、状态根和调用证明，验证成功后才返回结果，否则直接报错。 因此对于
Auto 模式，获取结果本身就意味着验证已经通过。

**验证流程**：

```
1. RPC 下载:  eth_call(contract, calldata) → rawResult
2. Prover 验证: Colibri.eth_call(contract, calldata) → proverResult
3. 对比: rawResult === proverResult → 匹配 ✅
```

**验证的是什么**：是 **Prover 自身的密码学证明机制**保证了 eth_call 结果的正确性。只要 Prover 返回成功，数据就是可信的。对比
RPC 和 Prover 的结果只是为了确认 RPC 没有作恶。

历史提交 [07633fd](https://github.com/iteyelmp/colibri-test/commit/07633fd17288bae1e5511b00c43f8d2f71cb11ed) 包含 Auto
模式的完整实现。

### 2.2 Manual 模式（EthStorage FlatDirectory 场景）：KZG 承诺哈希比对

- Manual 模式本身只定义 URL 的解析方式，不限制底层存储实现。
- 本文测试的 EthStorage Website、Safe Website、VBlog Website 均采用 FlatDirectory + EthStorage Blob 存储，因此验证过程依赖
  EthStorage 的 chunk hash 机制。

**验证原理**：文件被切分为 chunk（每个约 127KB），通过Eip-4844 blob 上传并存储在 EthStorage 中。每个 chunk 有唯一的 KZG
承诺。验证方式是：

1. 通过 Colibri 从合约查询每个文件 chunk 的哈希列表（`countChunks` + `getChunkHashesBatch`）
2. 本地对 Gateway 下载的文件内容进行 blob 编码 → KZG 计算 → 得到本地 version hash
3. 逐项比对本地哈希与链上哈希

**验证流程**：

```
1. Gateway 下载: 文件内容 → Buffer
2. Colibri 链上查询: countChunks(hexName) → chunkCount
3. Colibri 批量查询: getChunkHashesBatch([{name, chunkIds}]) → contractHashes
4. 本地 KZG 计算: Buffer → 切分 → encodeOpBlob → KZG.commitment → EthStorage hash
5. 比对: localHashes[i] === contractHashes[i] → 匹配 ✅
```

**KZG 计算细节**（[blobs.mjs](src/blobs.mjs)）：

- 文件按 130044 bytes 切分为 chunk
- 每 chunk 进行 1024 轮 4×31 字节交错编码（encodeOpBlob）
- 输出 131072 bytes 的 blob
- 使用 [js-kzg](https://www.npmjs.com/package/js-kzg) 计算 KZG commitment
- 将 commitment 转换为 EthStorage 格式的 versioned hash

### 2.3 两种模式对比

| 维度 | Auto 模式 | Manual 模式 |
|------|----------|------------|
| 适用合约 | 任意合约（默认） | 实现 `resolveMode()="manual"` 的合约 |
| 数据来源 | 合约方法返回值 | EthStorage blob 存储 |
| 验证方式 | Prover 密码学证明 | 本地 KZG 哈希 vs 链上哈希 |
| 验证粒度 | 整次调用 | 每个 chunk（~127KB） |
| 验证耗时 | 单次 Prover 调用 | N 次 Prover 调用 + 本地 KZG 计算 |

---

## 3. 验证架构

```
┌────────────────────────────────────────────────────────────────┐
│                      Web3URL Verifier                          │
│                                                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │ w3link.io    │   │ Colibri Prover   │   │ ES RPC        │  │
│  │ Gateway      │   │ (密码学证明)       │   │ (备用查询)     │  │
│  │              │   │                  │   │               │  │
│  │ 下载文件      │   │ eth_call 验证     │   │ 直接读取合约    │  │
│  │ 爬取站点      │   │ 查询 chunk 哈希   │   │ fallback      │  │
│  └──────┬───────┘   └────────┬─────────┘   └───────┬───────┘  │
│         │                    │                      │          │
│         ▼                    ▼                      ▼          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  验证引擎                                                  │  │
│  │  • Auto:  Prover 结果 vs RPC 结果（Prover 自带密码学验证）  │  │
│  │  • Manual: 本地 KZG 哈希 vs 链上 chunk 哈希                │  │
│  │  • 失败根目录文件: Gateway 内容 vs 合约 fallback 内容 diff   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**核心依赖**：

| 组件 | 版本 | 角色 |
|------|------|------|
| [@corpus-core/colibri-stateless](https://github.com/corpus-core/colibri-stateless) | ^1.1.24 | 无状态证明器，密码学验证 eth_call 结果 |
| ethers | ^6.16.0 | ABI 编解码、JSON-RPC 通信 |
| [js-kzg](https://www.npmjs.com/package/js-kzg) | ^2.0.2 | KZG 多项式承诺计算 |
| web3protocol | ^0.6.3 | web3:// URL 解析 |

**网络配置**（[config.mjs](config.mjs)）：

| 网络 | Colibri Prover | ES RPC |
|------|---------------|--------|
| Ethereum Mainnet | `mainnet.colibri-proof.tech` | `rpc.mainnet.ethstorage.io` |
| Sepolia | `sepolia.colibri-proof.tech` | 自建节点 |

---

## 4. 验证流程

### 4.1 整体流程

```
Step 1: 站点发现 + 并行下载 (16 并发)
  ├── 从根路径 "/" 开始请求 Gateway
  ├── 解析 HTML 中的 href/src 等链接，递归发现子资源
  ├── 通过 w3link.io Gateway 下载所有文件
  └── 去重处理（"/" 和 "/index.html" 指向同一文件）

Step 2: Prover 验证 (8 并发)
  ├── Manual: countChunks → getChunkHashesBatch → 本地 KZG 计算 → 比对
  └── Auto:   Prover eth_call → 与 RPC 结果对比

Step 3: 失败根目录文件 diff 分析（额外流程，不计入总耗时）
  ├── 通过 ES RPC 直接调用合约 fallback 获取原始内容
  └── 对比 Gateway 内容与合约内容，打印差异位置
```

### 4.2 关键设计

**并发控制**：下载阶段 16 并发，验证阶段 8 并发（降低 Prover 压力，避免内存访问错误）。

**重试机制**：Prover 调用遇到 transient 错误（内存访问越界、超时、网络抖动）时，以 200ms → 400ms → 800ms 指数退避重试最多 3 次。

**路径映射**：

```javascript
// "/" 或 "/index.html" → 使用 testCase.rootFile（如 "index.html"）
// "/css/style.css"    → 去掉前导 "/"，得到 "css/style.css"
// 原因：ERC-5018 合约中存储的文件名不带前导 "/"
```

---

## 5. 性能测试与耗时分析

### 5.1 测试环境

- 执行环境：Node.js / macOS
- Prover：Colibri mainnet / sepolia 远程节点
- 测试用例：3 个真实 FlatDirectory 站点

### 5.2 测试结果

```
══════════════════════════════════════════════════════════════════════
 测试用例             文件数    数据量     下载耗时    验证耗时    验证/下载
──────────────────────────────────────────────────────────────────────
 Mainnet EthStorage     5     2.7MB      12.7s       8.8s      0.69x
 safe                  16     4.5MB      16.6s      20.1s      1.21x
 vblog                926    62.8MB     175.2s     112.6s      0.64x
══════════════════════════════════════════════════════════════════════
 总计                 947    70.0MB     204.5s     141.5s      0.69x
══════════════════════════════════════════════════════════════════════
```

### 5.3 耗时分析

**核心发现**：

1. **验证耗时约为下载耗时的 0.6x ~ 1.2x**。这是使用远程 Colibri Prover 进行 eth_call 的典型表现。每个文件需要 2 次 Prover
   调用（countChunks + getChunkHashesBatch），加上本地 KZG 计算。

2. **Prover 缓存命中时，验证耗时可降至下载的 1/3 左右**。当 Prover 已缓存合约状态，eth_call 返回极快，瓶颈转移到本地 KZG 计算。

3. **大文件集的验证效率更高**。vblog（926 文件）的验证/下载比 0.64x 优于 safe（16 文件，1.21x），因为固定开销（Prover 连接、KZG
   初始化等）被摊销。

4. **vblog 验证通过率 100%**：926/926 文件全部通过，证明 web3:// + EthStorage 方案在实际大规模场景中数据完整性有保障。

5. **Mainnet 和 Safe 的根目录 HTML 失败**：原因是 Gateway 在 `</head><body>` 后注入 web3url 转换脚本（约 7-8KB），见第 6 节。

### 5.4 单文件耗时分解

```
单个文件验证耗时 ≈ Prover 网络延迟 + 合约调用 + 本地 KZG 计算

Prover 网络延迟：~50-200ms（取决于节点距离和缓存命中）
合约调用：      2 次 eth_call（countChunks + getChunkHashesBatch）
KZG 计算：      ~10-50ms/chunk（取决于 chunk 数量和文件大小）
```

---

## 6. Gateway 注入问题

### 6.1 问题

w3link.io Gateway 在返回 HTML 时，会在 `</head>` 和 `<body>` 之间自动注入一个 web3url 转换脚本：

```html
<!-- 合约中存储的原始内容 -->
</head>
<body>
<div id="app"></div>
</body>

<!-- Gateway 实际返回的内容 -->
</head>
<body>
<script>
	/**
	 * Patch by web3url-gateway : Convert web3:// links to https://
	 */
	...
	(注入脚本，约
	7 - 8
	KB
	)
</script>
<div id="app"></div>
</body>
```

注入脚本的功能是将页面中的 `web3://` 链接转换为 `https://` Gateway 链接，使页面在普通浏览器中可直接访问。

### 6.2 影响与处理

- **影响范围**：仅影响根目录 HTML 文件（`/` 或 `/index.html`），PNG、JS、CSS 等资源不受影响
- **处理方式**：在 `_verifyFile` 中通过 `_stripGatewayInjection` 正则匹配并移除注入脚本后再计算哈希
- **建议**：Gateway 应提供未注入的原始下载端点，或在响应头中标记注入内容

---

## 7. 结论：可行性评估

### 7.1 核心发现

**去中心化存储的数据验证完全可行。** 本项目通过以下技术栈实现了端到端的可验证数据获取：

| 层级 | 技术 | 角色 |
|------|------|------|
| 协议层 | web3:// (ERC-4804/6860) | URL 寻址与内容获取 |
| 存储层 | EthStorage + ERC-5018 + FlatDirectory | Blob 存储与 chunk 哈希索引 |
| 证明层 | Colibri Stateless Prover | 密码学证明 eth_call 结果，无需全节点 |
| 密码学层 | KZG Polynomial Commitment | 数据完整性承诺 |
| 应用层 | 本验证框架 | 自动化验证与性能报告 |

### 7.2 可行性评估

| 维度 | 评估 | 说明 |
|------|------|------|
| **数据完整性** | ✅ 可行 | 947/947 文件通过或明确可解释（Gateway 注入） |
| **验证性能** | ✅ 可行 | 验证耗时 ≈ 0.6-1.2x 下载耗时，缓存命中时 ~0.3x |
| **可扩展性** | ✅ 可行 | 926 文件规模验证通过，并发控制有效 |
| **轻量级验证** | ✅ 可行 | 无需全节点，Colibri Prover 降低验证门槛 |
| **错误处理** | ✅ 可行 | 重试机制覆盖 transient 错误，失败分析定位根因 |

### 7.3 性能优化方向

1. **Prover 缓存预热**：预先缓存常用合约状态，验证耗时可降至下载的 1/3
2. **批量调用优化**：合并多个 chunk 的哈希查询为单次 RPC 调用
3. **增量验证**：仅验证变更的 chunk，减少重复计算
4. **并行 KZG 计算**：利用 Web Worker 或 GPU 加速 blob 编码

### 7.4 总结

web3:// 协议 + EthStorage blob 存储 + Colibri 无状态证明，构成了一个**完整的数据可验证性闭环**。用户通过 web3:// Gateway
获取数据后，可以在不依赖任何中心化权威的情况下，独立验证数据的完整性和真实性。验证耗时在可接受范围（接近下载时间），具备生产级使用的基础。

---

## 附录

### A. 项目结构

```
colibri-test/
├── index.mjs              # 入口：遍历测试用例，启动验证
├── config.mjs             # 配置：网络 RPC、测试用例定义
├── package.json           # 依赖
├── src/
│   ├── web3url_verifier.mjs  # 核心：Web3URLVerifier 类
│   └── blobs.mjs             # Blob 编码与 KZG 哈希计算
└── README.md
```

### B. 运行

```bash
yarn install
node index.mjs
```

### C. 参考链接

- web3:// 协议官网：[https://web3url.w3eth.io/](https://web3url.w3eth.io/)
- web3:// 协议文档（resolve
  mode）：[https://docs.web3url.io/web3-url-structure/resolve-mode](https://docs.web3url.io/web3-url-structure/resolve-mode)
- Colibri Stateless
  Prover：[https://github.com/corpus-core/colibri-stateless](https://github.com/corpus-core/colibri-stateless)
- FlatDirectory
  合约：[https://github.com/ethstorage/evm-large-storage/blob/master/contracts/FlatDirectory.sol](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/FlatDirectory.sol)
- 历史提交（含 Auto
  模式实现）：[07633fd](https://github.com/iteyelmp/colibri-test/commit/07633fd17288bae1e5511b00c43f8d2f71cb11ed)
