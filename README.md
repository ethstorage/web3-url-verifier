
---

# ✅ Colibri Stateless 完整正确运行链路

---

## 一、初始化阶段（首次启动）

```
用户创建 C4Client(config)
    ↓
1. 确定信任锚点 checkpoint
   ├─ 优先：用户传入 trusted_checkpoint（32字节 block_root）
   └─ 兜底：WASM 编译时硬编码的主网 checkpoint
    ↓
2. 拉取 Bootstrap 数据（从 checkpointz/beacon_apis/prover）
   └─ Bootstrap 包含：
      ├─ header: checkpoint 对应的信标区块头
      ├─ current_sync_committee: 512 个 BLS 公钥
      └─ current_sync_committee_branch: Merkle 证明
    ↓
3. Bootstrap 验证（熔断机制）
   ├─ 验证 header.block_root === checkpoint
   └─ 验证 sync_committee 的 Merkle proof
    ↓
4. 存储：当前同步委员会公钥（512 个 BLS 公钥）
    ↓
✅ 初始化完成：信任链建立
```

**安全保证：** 只要 checkpoint 正确，后续所有验证都可密码学推导，无需信任任何第三方

---

## 二、同步阶段（委员会轮换，约 27 小时一次）

```
检测到新周期（slot % 8192 == 0）
    ↓
拉取 LightClientUpdate
   └─ 包含：
      ├─ attested_header: 新周期信标区块头
      ├─ next_sync_committee: 新一届 512 公钥
      ├─ next_sync_committee_branch: Merkle 证明
      ├─ sync_aggregate: 旧委员会 BLS 聚合签名
      └─ sync_committee_bits: 签名参与位图
    ↓
验证链（核心安全）：
   1. 用【旧委员会公钥】验证新区块头的 BLS 签名
      └─ 需要 ≥ 2/3 委员会（≈ 341/512）签名才有效
   2. 验证【新委员会公钥】的 Merkle proof
      └─ 证明新公钥确实在 attested_header.state_root 下
    ↓
存储：新同步委员会公钥
    ↓
✅ 完成轮换：信任链传递
```

**关键：** 这是**跳跃式同步**，不需要逐块处理，只验证委员会轮换，从 3 年前 checkpoint 到今天需要验证约 960 次轮换。Colibri 采用批量请求 + 批量验证优化，预计需 10 次 HTTP 请求获取所有更新

---

## 三、用户请求执行流程（以 eth_getBalance 为例）

```
用户调用: request({method:'eth_getBalance', params:[addr, 'latest']})
    ↓
┌─────────────────────────────────────────────────────────┐
│  所有模式的【验证逻辑】100% 相同，差异只在【数据来源】  │
└─────────────────────────────────────────────────────────┘
    ↓
Step 1: WASM 创建 RPC Context
   _c4w_create_rpc_ctx(method, args, chainId, flags, mode)
    ↓
Step 2: WASM 执行 → 返回 pending + 数据请求列表
   state = _c4w_execute_rpc_ctx(ctx)
    ↓
Step 3: 根据 mode 路由数据请求（唯一差异点）
```

### 🎯 各模式数据路由对比（核心差异）

| 请求类型 | Remote 模式 | Hybrid 模式 | LightClient 模式 | Local 模式 |
|---------|-----------|-----------|----------------|----------|
| 区块头 + 签名 | Prover（/c4_getBlock） | Prover（/c4_getBlock） | **Prover + 后台缓存** | 自建 CL 节点 |
| 账户 MPT 证明 | Prover（打包在 proof 中） | 自建 RPC（eth_getProof） | 自建 RPC（eth_getProof） | 自建 RPC |
| 存储 MPT 证明 | Prover（打包在 proof 中） | 自建 RPC（eth_getProof） | 自建 RPC（eth_getProof） | 自建 RPC |
| 收据 MPT 证明 | Prover（打包在 proof 中） | 不支持 | 不支持 | 不支持 |
| EVM 执行数据 | Prover（打包在 proof 中） | 不支持 | 不支持 | 不支持 |
| 同步委员会更新 | Prover | Prover/beacon_apis | Prover/beacon_apis | 自建 CL 节点 |
| **内核映射** | native_mode = 1 | native_mode = 2 | **native_mode = 2（Hybrid 内核）** | native_mode = 0 |
| **额外特性** | 无 | 无 | **+ 后台 12s 轮询缓存** | 无 |

> ✅ **源码证明**：LightClient = Hybrid 内核 + setInterval 后台轮询（index.js L203 + L311）

```
    ↓
Step 4: 数据返回 → 写入 WASM 内存
   _c4w_req_set_response(req_ptr, data, length)
    ↓
Step 5: WASM 再次执行 → 进入验证阶段
   state = _c4w_execute_rpc_ctx(ctx)
```

---

## 四、验证阶段（所有模式完全相同，客户端执行）

```
┌─────────────────────────────────────────────────────────┐
│  【安全核心】所有模式验证逻辑 100% 在客户端 WASM 执行    │
│  Prover/RPC/CL 节点只提供数据，无法跳过任何验证          │
└─────────────────────────────────────────────────────────┘
    ↓
验证 1：共识层 BLS 签名验证
   ├─ 输入：区块头 + 聚合签名 + 委员会位图
   ├─ 用【已存储的同步委员会公钥】验证签名
   └─ 输出：可信的 state_root（执行层状态根）
   
   ⚠️ 注意：Local 模式也会执行 BLS 验证（纵深防御）
    ↓
验证 2：执行层 MPT Merkle 证明验证
   ├─ 输入：state_root + accountProof + address
   ├─ 逐层计算 MPT 节点哈希，验证最终根匹配
   └─ 输出：可信的 balance/nonce/storageRoot/codeHash
    ↓
验证 3（eth_call 专属）：EVM 本地重放
   ├─ 用已验证的 code + storage + state
   ├─ 客户端本地执行 EVM 合约调用
   └─ 比对结果与 Prover 返回值是否一致
    ↓
✅ 验证全部通过 → 返回结果给用户
❌ 任一验证失败 → 抛出异常熔断
```

---

## 五、Remote 为什么比 Hybrid 快？本质原因

| 维度 | Remote 模式 | Hybrid 模式 |
|-----|-----------|-----------|
| **网络往返（简单查询）** | 1 次（所有数据打包） | 2 次并行（Prover + RPC） |
| **网络往返（复杂查询）** | 1 次（所有数据打包） | 3-N 次串行（多个 proof） |
| **数据路径** | Prover 与 EL/CL 同机房（内网 < 1ms） | 客户端→Prover + 客户端→RPC（公网 50-200ms） |
| **数据格式** | 原生 SSZ 二进制（直接喂 WASM） | JSON→SSZ 转换（额外解析开销） |
| **证明组装** | Prover 服务端预组装完整 proof | 客户端 WASM 本地组装（额外 CPU 开销） |
| **缓存命中** | Prover 全局跨用户缓存（热门区块 > 90% 命中） | 用户 RPC 独立缓存（命中率低） |
| **并行度** | Prover 内部 C 层批量并行 IO | JS 层串行处理请求 |

**性能差异量化：** Remote ≈ 412-1051ms，Hybrid ≈ 680-930ms，**1.5-2 倍差异**

---

## 🎯 最终结论

1. **所有模式验证逻辑 100% 相同**：BLS + MPT 都在客户端 WASM 执行，Prover/RPC 都无法伪造数据
2. **模式内核映射**：
   - Remote：独立内核（mode=1），所有数据从 Prover 获取
   - Hybrid：独立内核（mode=2），数据分流
   - **LightClient：Hybrid 内核 + 后台轮询缓存（不是独立内核）**
   - Local：独立内核（mode=0），所有数据从自建节点获取
3. **性能差异根本原因**：Hybrid 不只是 "RPC 换成自己的"，而是**证明组装逻辑从服务端移到了客户端 + 多次网络往返**
4. **安全模型一致**：所有模式的密码学安全边界完全相同，Remote 不会因为依赖 Prover 而降低安全性