import { ethers } from 'ethers';
import Colibri, { Strategy } from '@corpus-core/colibri-stateless';

const SELF_RPC = 'https://eth-mainnet.g.alchemy.com/v2/_DtBtn6Ul_HQlSCzrRdGV';
const SELF_CL = 'http://88.99.30.186:4200/';
const PROVER = 'https://mainnet1.colibri-proof.tech';

const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const UNISWAP = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC';
const BALANCE_OF = '0x70a08231' + '000000000000000000000000' + USDT_HOLDER.slice(2);
const TX_HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';

const time = async <T>(fn: () => Promise<T>) => {
  const s = performance.now();
  const r = await fn();
  return { r, ms: performance.now() - s };
};

const short = (s: any, n = 60) => {
  if (s == null) return 'N/A';
  s = String(s);
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
};

const sep = (title: string) => console.log('\n' + '='.repeat(64) + `\n  ${title}\n` + '='.repeat(64) + '\n');

// ============================================================
// STAGE 0: 模式说明
// ============================================================
function explainModes() {
  sep('STAGE 0: Colibri 模式说明');

  console.log('┌──────────────┬──────────────────────────────────────────────────────────────┐');
  console.log('│ 模式         │ 说明                                                         │');
  console.log('├──────────────┼──────────────────────────────────────────────────────────────┤');
  console.log('│ Hybrid       │ RPC 取执行层数据 + Prover 取共识层头。                     │');
  console.log('│              │ 本地 WASM 验证 BLS 签名 + MPT 证明。                       │');
  console.log('├──────────────┼──────────────────────────────────────────────────────────────┤');
  console.log('│ Remote       │ 全部请求走 Prover，Prover 负责取数据+生成证明。              │');
  console.log('│              │ 本地只验证 Prover 返回的 BLS 签名 + MPT 证明。               │');
  console.log('│              │ 最省事，不依赖 RPC 节点，但依赖 Prover 可用性。              │');
  console.log('├──────────────┼──────────────────────────────────────────────────────────────┤');
  console.log('│ Local        │ CL 节点取信标链数据 + EL 节点取执行层数据。                  │');
  console.log('│              │ 本地 WASM 验证 BLS 签名 + MPT 证明。不依赖 Prover。         │');
  console.log('│              │ 执行层数据直接从 CL 节点 SSZ 解码，比 RPC JSON 更高效。      │');
  console.log('├──────────────┼──────────────────────────────────────────────────────────────┤');
  console.log('│ LightClient  │ = Hybrid + 后台轮询区块头保持缓存热度。                      │');
  console.log('│              │ 调用 startLightClient()/stopLightClient() 控制轮询。        │');
  console.log('│              │ 默认每 12s 拉取 eth_getBlockHeader（可配 fullBlock=true）。 │');
  console.log('│              │ 适合频繁查 tx/receipt 的场景，缓存命中时几乎零延迟。        │');
  console.log('└──────────────┴──────────────────────────────────────────────────────────────┘');

  console.log('\n💡 所有模式共用同一安全模型：');
  console.log('   通过同步委员会（Sync Committee，512 个验证者）的 BLS 聚合签名验证共识层数据。');
  console.log('   首次请求需拉取同步委员会公钥（约 285ms），之后增量更新即可。');
}

// ============================================================
// STAGE 1: 性能对比
// ============================================================
async function benchmark() {
  sep('STAGE 1: 性能对比（Alchemy RPC vs 4 种 Colibri 模式 × 7 个方法）');

  const selfRpc = new ethers.JsonRpcProvider(SELF_RPC);

  const hybrid = new Colibri({
    chainId: 1, rpcs: [SELF_RPC], prover: [PROVER],
    prover_mode: 'hybrid', proofStrategy: Strategy.VerifyIfPossible,
  });
  const remote = new Colibri({
    chainId: 1, prover: [PROVER],
    prover_mode: 'remote', proofStrategy: Strategy.VerifiedOnly,
  });
  const local = new Colibri({
    chainId: 1, rpcs: [SELF_RPC], beacon_apis: [SELF_CL],
    prover_mode: 'local', proofStrategy: Strategy.VerifiedOnly,
  });
  const lightClient = new Colibri({
    chainId: 1, rpcs: [SELF_RPC], beacon_apis: [SELF_CL],
    prover_mode: 'light_client', proofStrategy: Strategy.VerifiedOnly,
  });

  // ====== 同步阶段 ======
  console.log('── 同步阶段（首次请求需拉取同步委员会公钥 ~285ms）──\n');

  const syncResults = await Promise.allSettled([
    (async () => {
      const s = performance.now();
      await local.request({ method: 'eth_blockNumber', params: [] });
      return { mode: 'Local', ms: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      await lightClient.request({ method: 'eth_blockNumber', params: [] });
      return { mode: 'LightClient', ms: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      await remote.request({ method: 'eth_blockNumber', params: [] });
      return { mode: 'Remote', ms: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      await hybrid.request({ method: 'eth_blockNumber', params: [] });
      return { mode: 'Hybrid', ms: performance.now() - s };
    })(),
  ]);

  for (const r of syncResults) {
    if (r.status === 'fulfilled') {
      console.log(`  ${r.value.mode.padEnd(14)} 首次同步: ${r.value.ms.toFixed(0)}ms`);
    } else {
      console.log(`  ${(r as any).value?.mode || '?'} 首次同步: FAILED`);
    }
  }


  // ====== 预热 ======
  await Promise.allSettled([
    hybrid.request({ method: 'eth_blockNumber', params: [] }),
    remote.request({ method: 'eth_blockNumber', params: [] }),
    local.request({ method: 'eth_blockNumber', params: [] }).catch(() => {}),
    lightClient.request({ method: 'eth_blockNumber', params: [] }).catch(() => {}),
  ]);

  const RUNS = 5;
  const LOCAL_RUNS = 1;

  const tests = [
    {
      name: 'eth_blockNumber',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_blockNumber', []),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_blockNumber', params: [] }),
      support: { hybrid: true, remote: true, local: true, lightclient: true },
    },
    {
      name: 'eth_getBalance',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_getBalance', [ADDR, 'latest']),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] }),
      support: { hybrid: true, remote: true, local: true, lightclient: true },
    },
    {
      name: 'eth_getCode',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_getCode', [UNISWAP, 'latest']),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_getCode', params: [UNISWAP, 'latest'] }),
      support: { hybrid: false, remote: true, local: true, lightclient: false },
    },
    {
      name: 'eth_call (USDT balanceOf)',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_call', [{ to: USDT, data: BALANCE_OF }, 'latest']),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_call', params: [{ to: USDT, data: BALANCE_OF }, 'latest'] }),
      support: { hybrid: false, remote: true, local: false, lightclient: false },
    },
    {
      name: 'eth_getStorageAt',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_getStorageAt', [USDT, '0x0', 'latest']),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_getStorageAt', params: [USDT, '0x0', 'latest'] }),
      support: { hybrid: false, remote: false, local: false, lightclient: false },
    },
    {
      name: 'eth_getTransactionReceipt',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_getTransactionReceipt', [TX_HASH]),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_getTransactionReceipt', params: [TX_HASH] }),
      support: { hybrid: false, remote: true, local: false, lightclient: false },
    },
    {
      name: 'eth_getBlockByNumber',
      rpcFn: (p: ethers.JsonRpcProvider) => p.send('eth_getBlockByNumber', ['latest', false]),
      colibriFn: (c: Colibri) => c.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
      support: { hybrid: true, remote: true, local: true, lightclient: true },
    },
  ];

  const modes: { label: string; key: string; fn: (t: typeof tests[0]) => () => Promise<any>; runs: number }[] = [
    { label: '直接RPC', key: 'self', fn: (t) => () => t.rpcFn(selfRpc), runs: RUNS },
    { label: 'Hybrid', key: 'hybrid', fn: (t) => () => t.colibriFn(hybrid), runs: RUNS },
    { label: 'Remote', key: 'remote', fn: (t) => () => t.colibriFn(remote), runs: RUNS },
    { label: 'Local', key: 'local', fn: (t) => () => t.colibriFn(local), runs: LOCAL_RUNS },
    { label: 'LightClient', key: 'lightclient', fn: (t) => () => t.colibriFn(lightClient), runs: RUNS },
  ];

  const allRows: any[] = [];

  for (const t of tests) {
    console.log(`── ${t.name} ──`);

    const row: any = { 方法: t.name };

    for (const mode of modes) {
      if (mode.key !== 'self') {
        const sup = (t.support as any)[mode.key];
        if (sup === false) {
          console.log(`  ${mode.label.padEnd(14)} (不支持)`);
          row[mode.label] = 'N/A';
          continue;
        }
      }

      const times: number[] = [];
      let first: any = null;
      let errored = false;
      let errMsg = '';

      for (let i = 0; i < mode.runs; i++) {
        try {
          const { r, ms } = await time(mode.fn(t));
          times.push(ms);
          if (i === 0) first = r;
        } catch (e: any) {
          if (i === 0) { errored = true; errMsg = e.message?.slice(0, 120) || ''; }
          break;
        }
      }

      if (errored || times.length === 0) {
        console.log(`  ${mode.label.padEnd(14)} ERR: ${errMsg}`);
        row[mode.label] = 'ERR';
        continue;
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      const suffix = mode.runs === 1 ? ' (×1)' : '';
      row[mode.label] = `${avg.toFixed(0)}ms${suffix}`;
      console.log(`  ${mode.label.padEnd(14)} avg=${avg.toFixed(0)}ms  min=${min.toFixed(0)}ms  max=${max.toFixed(0)}ms  ${short(first, 40)}`);
    }

    allRows.push(row);
    console.log('');
  }

  console.log('══════════ 跑分总表 ══════════');
  console.table(allRows);

  // ====== 验证开销分析 ======
  console.log('\n── 验证开销分析（Colibri 各模式 vs 直接 RPC）──');
  for (const row of allRows) {
    const baseline = parseFloat(row['直接RPC']);
    if (isNaN(baseline)) continue;
    const parts: string[] = [];
    for (const mode of ['Hybrid', 'Remote', 'LightClient']) {
      const val = parseFloat(row[mode]);
      if (!isNaN(val)) {
        const diff = val - baseline;
        const pct = ((diff / baseline) * 100).toFixed(0);
        parts.push(`${mode}: ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}ms (${pct}%)`);
      }
    }
    if (parts.length) console.log(`  ${row['方法'].padEnd(30)} ${parts.join('  |  ')}`);
  }
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Colibri Stateless —— 性能对比与模式分析             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nEL: ${SELF_RPC}`);
  console.log(`CL: ${SELF_CL}`);
  console.log(`Prover: ${PROVER}`);

  explainModes();
  await benchmark();

  // ============================================================
  // 最终结论
  // ============================================================
  sep('最终结论');

  console.log('   ┌──────────────┬────────────────────────────────────────────────────┐');
  console.log('   │ 场景         │ 推荐模式                                            │');
  console.log('   ├──────────────┼────────────────────────────────────────────────────┤');
  console.log('   │ 日常使用     │ Remote —— 最省事，不依赖 RPC，性能可接受            │');
  console.log('   │ 最高安全     │ Local —— 自建 CL+EL，完全不依赖第三方 Prover        │');
  console.log('   │ 高频查询     │ LightClient —— 后台轮询缓存区块头，命中时零延迟     │');
  console.log('   │ 兼容过渡     │ Hybrid —— 保留 RPC 直连，逐步增加验证               │');
  console.log('   │ 纯性能       │ 直接 RPC —— 无验证，不推荐用于敏感数据              │');
  console.log('   └──────────────┴────────────────────────────────────────────────────┘\n');

  console.log('   - Hybrid:    EL 数据走 RPC，CL 数据走 Prover');
  console.log('   - Remote:    EL+CL 数据都走 Prover（最省事）');
  console.log('   - Local:     EL 数据走 CL 节点 SSZ 解码（最高效），CL 数据走 CL 节点');
  console.log('   - LightClient: = Hybrid + 后台每 12s 轮询区块头缓存（高频查询最优）\n');
})().catch(console.error);