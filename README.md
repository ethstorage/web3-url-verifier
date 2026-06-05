# web3:// 数据可验证性探索

> 基于 Colibri Stateless 客户端独立验证实验

## 摘要

web3://（ERC-4804 / ERC-6860）为链上资源提供统一的 URL 访问方式，但客户端获取到的数据通常来自 Gateway 或 RPC 节点，无法确认结果是否与链上真实状态一致。

本项目实现了一个 web3:// 数据验证原型，模拟浏览器插件的工作模式：正常获取数据 → 独立验证数据真实性 → 输出验证结果。项目覆盖 Ethereum 状态数据和 EthStorage 文件数据两类场景，并在真实部署站点上进行了测试。

测试结果表明：
- 数据真实性可以独立验证
- 不依赖 Gateway 或 RPC 的诚实性
- 验证耗时与下载耗时处于同一量级
- 具备浏览器插件集成可行性。

---

## 1. 验证目标

本项目验证三个问题：

### 1.1 数据是否能够独立验证

客户端拿到的数据是否等于链上真实数据？是否能够在不信任 Gateway 和 RPC 的情况下完成验证？

### 1.2 验证机制是否适用于真实站点

测试对象包括 EthStorage 官网、Safe 前端、VBlog 博客、NFT Render 合约调用，均为真实部署资源而非构造数据。

### 1.3 验证性能是否可接受

测量
- 下载耗时
- 验证耗时
- 验证成功率

评估浏览器集成可行性。

---

## 2. 验证模型

核心思想：**数据获取路径与验证路径分离。**

```
数据获取路径（不可信）               验证路径（可信）
        │                               │
    获取数据                     Colibri 密码学证明
        │                               │
        │                         获取并验证链上真实状态
        │                               │
        └─────────── 本地比较 ───────────┘
                        │
                ✅ 一致 / ❌ 不一致
```

数据获取路径可以是不可信的：Gateway、RPC、浏览器缓存——任何来源都可以。验证路径通过 Colibri 获取经过密码学验证的链上状态。最终在客户端本地完成校验。

**关键点：用户不需要判断"谁在作恶"，只需要知道"最终拿到的数据对不对"。**

---

## 3. 两类数据验证

### 3.1 Ethereum 状态数据

适用于`render()`、`tokenURI()`、`balanceOf()` 等所有 `eth_call` 合约调用。

**验证流程：**

```
数据获取路径                      验证路径
（RPC / Gateway）                （Colibri）
        │                              │
   rawResult                  verifiedResult

比较 rawResult == verifiedResult → 匹配 ✅
```

**Colibri 的作用**：Colibri 的远程 Prover 返回调用结果、状态证明和区块头等证明信息。并在 Colibri SDK内部进行验证，验证通过后返回的 `verifiedResult` 即等于链上真实结果。

### 3.2 EthStorage 文件数据

适用于 HTML、CSS、JS、PNG、Video 等任意 Blob 文件。

**文件通过Blob上传后链上都保存什么？**

```
File → Blob → KZG Commitment → Versioned Hash
```

FlatDirectory 合约只记录数据的 Versioned Hash，真正的文件内容由 EthStorage 网络持久化保存。

**验证原理：**

首先通过 Colibri 获取链上记录的真实 Versioned Hash：

```
Colibri → Versioned Hash
```

然后对不可信方式获取到的文件重新计算 Versioned Hash：

```
File → Blob Encode → KZG Commitment → Versioned Hash
```

比较两个Hash：

```
localHash == chainHash → ✅ 文件内容与上传内容一致
```

**为什么可行？** Versioned Hash 来源于 KZG Commitment。文件内容发生任何变化（修改、删除、新增），都会导致 Versioned Hash 改变。因此 `localHash == chainHash` 即可证明文件未被修改。

---

## 4. 实现架构

```
                     Ethereum
                         │
                         ▼
                     链上真实状态
                         │
                         ▼
                     Colibri
                         │
                         ▼
                   已验证链上状态


                    Gateway / RPC
                          │
                          ▼
                       获取数据
                          │
                          ▼
                       本地验证比较
                          │
                          ▼
                    Verified / Failed
```

**核心原则：数据获取路径与验证路径完全独立。** 不关心数据从哪里来，只关心数据是否与链上一致。

---

## 5. 测试站点

| 站点 | 网络 | 内容 | 数据量 | 验证方式 |
|------|------|------|--------|---------|
| EthStorage 官网 | Ethereum Mainnet | HTML + CSS + JS + 图片 | 1.3MB（5 文件） | EthStorage 文件验证 |
| Safe 前端 | Sepolia | HTML + Next.js 静态资源 | 4.4MB（16 文件） | EthStorage 文件验证 |
| VBlog 首页 | Sepolia | HTML + CSS + 大体积 JS | 1.7MB（3 文件） | EthStorage 文件验证 |
| VBlog 子页（backpack） | Sepolia | HTML + CSS + JS + 13张图片 | 3.1MB（16 文件） | EthStorage 文件验证 |
| VBlog 子页（blobs） | Sepolia | HTML + CSS + JS + 10张图片 | 2.0MB（13 文件） | EthStorage 文件验证 |
| NFT Render | Ethereum Mainnet | `render(78, 0)` 调用结果 | 14.6KB（1 文件） | Ethereum 状态验证 |

---

## 6. 验证流程

**Step 1** — 递归发现站点资源（模拟浏览器行为）。

**Step 2** — 下载资源。并发数：16。

**Step 3** — 执行验证。并发数：8。

- **Ethereum 状态数据**：获取结果 → Colibri 验证结果 → 比较
- **EthStorage 文件**：获取文件 → 本地计算 Hash → 获取链上 Hash → 比较

---

## 7. 性能测试

### 测试环境

- macOS / Node.js
- 远程 Colibri Prover 节点（mainnet / sepolia）

### 测试结果

```
═══════════════════════════════════════════════════════════════════════════
 测试站点                文件数    数据量      下载耗时    验证耗时    验证/下载
───────────────────────────────────────────────────────────────────────────
 EthStorage 官网             5    1.3MB        6.1s       3.3s      0.54x
 Safe 前端                  16    4.4MB       14.3s       5.0s      0.35x
 VBlog 首页                  3    1.7MB        9.3s       3.0s      0.32x
 VBlog 子页（backpack）      16    3.1MB       10.8s       4.0s      0.37x
 VBlog 子页（blobs）         13    2.0MB        9.7s       6.4s      0.66x
 NFT Render                  1   14.6KB        1.0s       2.9s      2.90x
═══════════════════════════════════════════════════════════════════════════
 总计                      54   12.6MB       51.2s      24.6s      0.48x
═══════════════════════════════════════════════════════════════════════════
```

> **关于 Prover 缓存**：验证耗时基于 Colibri 实际运行结果统计。由于公开 Colibri 的 Prover 服务存在缓存等优化机制，不同时间测试结果有一定波动，表中数据为多次运行后的平均值，且大概率是缓存命中后的耗时，冷缓存下实际耗时可能略高于表中数值。

### 验证结果

| 测试站点 | 总文件 | ✅ 通过 | ❌ 失败 | 说明 |
|---------|-------|--------|--------|------|
| EthStorage 官网 | 5 | 4 | 1 | 根文件：数据获取路径注入额外脚本 |
| Safe 前端 | 16 | 15 | 1 | 根文件：数据获取路径注入额外脚本 |
| VBlog 首页 | 3 | 3 | 0 | 全部通过 |
| VBlog 子页（backpack） | 16 | 16 | 0 | 全部通过 |
| VBlog 子页（blobs） | 13 | 13 | 0 | 全部通过 |
| NFT Render | 1 | 1 | 0 | 全部通过 |

### 核心结果

**验证成功率**：所有资源均验证成功（Gateway 注入场景除外）。EthStorage 文件、合约状态以及跨合约调用场景均能够完成验证，证明浏览器环境下的 Web3 数据验证是可行的。

**验证耗时**： 除 NFT Render 外，所有测试网站的验证耗时均低于下载耗时，验证/下载比介于 0.32x～0.66x 之间。 NFT Render 的验证耗时高于下载耗时（2.90x），原因在于其返回内容由多个合约中的脚本片段动态拼接生成，验证时需要处理更多链上状态数据，因此开销明显高于普通静态资源。

**浏览器可行性**： 测试共覆盖 54 个文件、12.6MB 数据，总下载耗时约 51.2 秒，总验证耗时约 24.6 秒，验证开销约为下载开销的 48%。 结果表明，浏览器能够在可接受时间内完成 Web3 内容验证，具备集成至浏览器插件或原生浏览器实现的可行性。

---

## 8. 测试中发现：数据获取路径注入内容

测试中使用的数据获取路径（w3link.io）会对 HTML 自动注入脚本，将 web3:// 链接转换为 https:// 链接：

```html
<script>
/** * Patch by web3url-gateway : Convert web3:// links to https:// */
</script>
```

导致拿到的内容与链上原始内容不一致，触发验证失败。

**影响范围**：仅影响 HTML 文件，JS、CSS、PNG 等不受影响。验证时移除注入脚本后重新计算，验证恢复正常。

这一发现很好地说明了验证的价值：**即使数据获取路径出于善意目的修改了内容，验证系统也能识别出来。用户不需要知道是谁改的，只需要知道"数据不对"。**

---

## 9. 结论

本项目验证了 web3:// 数据独立验证方案的**可行性**。

对于 **Ethereum 状态数据**，使用 Colibri 无状态证明完成验证。对于 **EthStorage 文件**，使用 Colibri 验证链上状态 + Versioned Hash 完整性校验完成验证。

测试表明：

- **验证机制有效**：真实站点数据可通过独立路径验证
- **真实站点可用**：EthStorage 官网、Safe 前端、VBlog、NFT Render 全部通过
- **性能可接受**：验证耗时与下载耗时同一量级
- **具备浏览器插件落地条件**

客户端无需信任 Gateway 或 RPC，即可验证最终获取数据的真实性。不需要运行全节点，不需要自己同步链，不需要信任任何数据提供方——**从信任到验证**。

---

## 附录

### A. 项目结构

```
colibri-test/
├── src/
│   ├── index.ts               # 入口：遍历测试站点，启动验证
│   ├── config.ts              # 配置：网络 RPC、测试站点定义
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
- [Colibri Stateless Prover](https://github.com/corpus-core/colibri-stateless)
- [FlatDirectory 合约](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/FlatDirectory.sol)
- [EIP-4844: Shard Blob Transactions](https://eips.ethereum.org/EIPS/eip-4844)
- [ERC-4804: web3:// URL](https://eips.ethereum.org/EIPS/eip-4804)
- [ERC-6860: web3:// URL (revised)](https://eips.ethereum.org/EIPS/eip-6860)
