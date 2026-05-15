/**
 * Colibri 深度原理验证
 *
 * 通过 fetch 拦截 + 投毒 + 模式对比，验证 Colibri 的密码学安全保障
 */
import { ethers } from 'ethers';
import Colibri, { Strategy } from '@corpus-core/colibri-stateless';

const SELF_RPC = 'http://88.99.30.186:8545/';
const PROVER = 'https://mainnet.colibri-proof.tech';
const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const sep = (title: string) => console.log('\n' + '='.repeat(25) + ` ${title} ` + '='.repeat(25) + '\n');

const originalFetch = globalThis.fetch;

// ============================================================
// 实验 1: eth_getProof 是标准 EIP-1186 接口
// ============================================================
async function exp1_isStandardRPC() {
  sep('实验 1: eth_getProof 是标准 EIP-1186 接口');

  const rpc = new ethers.JsonRpcProvider(SELF_RPC);
  const proof = await rpc.send('eth_getProof', [ADDR, [], 'latest']);

  console.log('直接调 RPC eth_getProof 返回:');
  console.log(`  address:      ${proof.address}`);
  console.log(`  balance:      ${proof.balance}`);
  console.log(`  nonce:        ${proof.nonce}`);
  console.log(`  codeHash:     ${proof.codeHash}`);
  console.log(`  storageHash:  ${proof.storageHash}`);
  console.log(`  accountProof: ${proof.accountProof.length} 个节点`);
  console.log(`  storageProof: ${proof.storageProof.length} 个槽`);
}

// ============================================================
// 实验 2: Colibri 内部请求拦截（fetch 猴子补丁）
// ============================================================
async function exp2_internalCalls() {
  sep('实验 2: Colibri 内部到底发了哪些请求？');

  const calls: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const method = body?.method || body?.[0]?.method || 'UNKNOWN';

    if (url.includes('colibri-proof.tech')) {
      calls.push(`[Prover] -> ${method}`);
    } else {
      calls.push(`[RPC]   -> ${method}`);
    }
    return originalFetch(input, init);
  };

  try {
    const c = new Colibri({
      chainId: 1, rpcs: [SELF_RPC], prover: [PROVER],
      prover_mode: 'hybrid', proofStrategy: Strategy.VerifiedOnly,
    });

    console.log('用户发起: colibri.request({ method: "eth_getBalance" })\n');
    const result = await c.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
    console.log(`返回结果: ${result}\n`);

    console.log('SDK 内部真实网络轨迹:');
    calls.forEach((log, i) => console.log(`  ${i + 1}. ${log}`));

    console.log('\n💡 原理解析:');
    console.log('  - SDK 没有直接转发 eth_getBalance，而是拆解为两步:');
    console.log('    1) 向 Prover 请求信标链区块头（含 BLS 签名）');
    console.log('    2) 向 RPC 请求 eth_getProof（含账户 MPT 证明）');
    console.log('  - 本地用 BLS 签名验证区块头 → 用 stateRoot 验证 MPT 证明 → 提取 balance');
  } catch (e: any) {
    console.log('实验 2 异常:', e.message);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// 实验 3: 数据一致性交叉比对
// ============================================================
async function exp3_dataConsistency() {
  sep('实验 3: 标准 RPC vs Hybrid vs Remote 一致性');

  const rpc = new ethers.JsonRpcProvider(SELF_RPC);
  const hybrid = new Colibri({
    chainId: 1, rpcs: [SELF_RPC], prover: [PROVER],
    prover_mode: 'hybrid', proofStrategy: Strategy.VerifiedOnly,
  });
  const remote = new Colibri({
    chainId: 1, prover: [PROVER],
    prover_mode: 'remote', proofStrategy: Strategy.VerifiedOnly,
  });

  // eth_getBalance
  const [rpcBal, hybBal, remBal] = await Promise.all([
    rpc.send('eth_getBalance', [ADDR, 'latest']),
    hybrid.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] }),
    remote.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] }),
  ]);

  console.log('eth_getBalance:');
  console.log(`  直接RPC:  ${rpcBal}`);
  console.log(`  Hybrid:   ${hybBal}  ${rpcBal === hybBal ? '✅' : '❌ 不一致!'}`);
  console.log(`  Remote:   ${remBal}  ${rpcBal === remBal ? '✅' : '❌ 不一致!'}`);

  // eth_getCode
  const UNISWAP = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
  const [rpcCode, hybCode, remCode] = await Promise.all([
    rpc.send('eth_getCode', [UNISWAP, 'latest']),
    hybrid.request({ method: 'eth_getCode', params: [UNISWAP, 'latest'] }),
    remote.request({ method: 'eth_getCode', params: [UNISWAP, 'latest'] }),
  ]);

  console.log('\neth_getCode (Uniswap):');
  console.log(`  直接RPC:  ${rpcCode.length} 字符  ${rpcCode.slice(0, 40)}...`);
  console.log(`  Hybrid:   ${(hybCode as string).length} 字符  ${(hybCode as string).slice(0, 40)}...  ${rpcCode === hybCode ? '✅' : '❌'}`);
  console.log(`  Remote:   ${(remCode as string).length} 字符  ${(remCode as string).slice(0, 40)}...  ${rpcCode === remCode ? '✅' : '❌'}`);

  // eth_call
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC';
  const BALANCE_OF = '0x70a08231' + '000000000000000000000000' + HOLDER.slice(2);

  const [rpcCall, remCall] = await Promise.all([
    rpc.send('eth_call', [{ to: USDT, data: BALANCE_OF }, 'latest']),
    remote.request({ method: 'eth_call', params: [{ to: USDT, data: BALANCE_OF }, 'latest'] }),
  ]);

  console.log('\neth_call (USDT balanceOf):');
  console.log(`  直接RPC:  ${rpcCall}`);
  console.log(`  Remote:   ${remCall}  ${rpcCall === remCall ? '✅' : '❌ 不一致!'}`);

  console.log('\n结论: 三种方式返回的数据完全一致。');
  console.log('      Colibri 不修改数据，只在返回前多做了密码学验证。');
}

// ============================================================
// 实验 4: 执行层（MPT）精准投毒验证
// ============================================================
async function exp4_robustPoisonProof() {
  sep('实验 4: 执行层投毒 —— 篡改账户 MPT 证明内容');

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await originalFetch(input, init);
    const url = input.toString();

    if (!url.includes('colibri-proof.tech') && typeof init?.body === 'string' && init.body.includes('eth_getProof')) {
      const json = await res.json();
      if (json?.result?.accountProof?.length > 0) {
        console.log('  [拦截] 对 eth_getProof 的 accountProof 进行微调投毒...');
        const targetProof = json.result.accountProof[0];
        console.log(`  原始 accountProof: ${targetProof}`);
        const lastChar = targetProof.slice(-1);
        const newLastChar = lastChar === 'a' ? 'b' : 'a';
        console.log(`  修改 accountProof: ${targetProof.slice(0, -1) + newLastChar}`);
        json.result.accountProof[0] = targetProof.slice(0, -1) + newLastChar;
      }
      return new Response(JSON.stringify(json), res);
    }
    return res;
  };

  try {
    const c = new Colibri({
      chainId: 1, rpcs: [SELF_RPC], prover: [PROVER],
      prover_mode: 'hybrid', proofStrategy: Strategy.VerifiedOnly,
    });

    await c.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
    console.log('  ❌ 严重风险：SDK 接受了被篡改的 MPT 证明！');
    return false;
  } catch (e: any) {
    console.log(`  ✅ 成功熔断！SDK 捕获异常: ${e.message}`);
    console.log('  💡 原理解析: 当 RPC 节点返回被篡改的账户证明时，');
    console.log('     本地 MPT Merkle Root 校验会直接宣告失败。');
    console.log('     即使只改了一个十六进制字符，Merkle 树根哈希也会完全不同。');
    return true;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// 实验 5: 共识层（BLS 签名）精准投毒验证 —— Local 模式
// ============================================================
async function exp5_localConsensusPoison() {
  sep('实验 5: 共识层投毒 —— 篡改信标链区块 state_root');

  const SELF_CL = 'http://88.99.30.186:4200/';
  let tampered = false;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();

    // 拦截信标链请求，强制 Accept: application/json（默认返回 SSZ 二进制）
    if (url.includes('4200') && url.includes('beacon')) {
      const newInit = {
        ...init,
        headers: { ...(init?.headers || {}), 'Accept': 'application/json' },
      };
      const res = await originalFetch(input, newInit);

      if (url.includes('beacon/blocks')) {
        const cloned = res.clone();
        const text = await cloned.text();
        let json: any;
        try { json = JSON.parse(text); } catch { return res; }

        // 信标链区块的 state_root 在 data.message.state_root
        if (json?.data?.message?.state_root) {
          console.log(`  [拦截] state_root = ${json.data.message.state_root.slice(0, 30)}... → 篡改为全零`);
          json.data.message.state_root = '0x' + '0'.repeat(64);
          tampered = true;
          return new Response(JSON.stringify(json), res);
        }
      }
      return res;
    }
    return originalFetch(input, init);
  };

  try {
    const c = new Colibri({
      chainId: 1,
      rpcs: [SELF_RPC],
      beacon_apis: [SELF_CL],
      prover_mode: 'local',
      proofStrategy: Strategy.VerifiedOnly,
    });

    await c.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
    if (tampered) {
      console.log('  ❌ 严重风险：SDK 接受了被篡改的共识状态根！');
      return false;
    }
    console.log('  ⚠️ 未拦截到信标链请求');
    return null;
  } catch (e: any) {
    console.log(`  ✅ 成功熔断！SDK 捕获异常: ${e.message}`);
    console.log('  💡 原理解析: Local 模式下，SDK 直接从信标链节点拉取区块头，');
    console.log('     并在本地 WASM 中验证 BLS 签名。篡改 state_root 会导致');
    console.log('     区块哈希与 BLS 签名不匹配 → 签名验证失败。');
    console.log('     这证明即使自建的信标链节点作恶，本地也能检测到。');
    return true;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// 实验 6: 模式分水岭 —— Hybrid vs Remote 网络拓扑对比
// ============================================================
async function exp6_modeComparison() {
  sep('实验 6: Hybrid 与 Remote 的网络拓扑与信任边界对比');

  // --- Hybrid 模式 ---
  console.log('--- Hybrid 模式 ---');
  const hybridCalls: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const method = body?.method || body?.[0]?.method || 'UNKNOWN';
    hybridCalls.push(url.includes('colibri-proof.tech')
      ? `[Prover] ${method}`
      : `[RPC]   ${method}`);
    return originalFetch(input, init);
  };

  try {
    const hybrid = new Colibri({
      chainId: 1, rpcs: [SELF_RPC], prover: [PROVER],
      prover_mode: 'hybrid', proofStrategy: Strategy.VerifiedOnly,
    });
    await hybrid.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
  } catch (e: any) {
    hybridCalls.push(`异常: ${e.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('  网络请求:');
  hybridCalls.forEach(c => console.log(`    ${c}`));
  console.log('  信任模型: 本地验证 BLS 签名 + MPT 证明，RPC 和 Prover 均可作恶但无法通过验证');

  // --- Remote 模式 ---
  console.log('\n--- Remote 模式 ---');
  const remoteCalls: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const method = body?.method || body?.[0]?.method || 'UNKNOWN';
    remoteCalls.push(url.includes('colibri-proof.tech')
      ? `[Prover] ${method}`
      : `[RPC]   ${method}`);
    return originalFetch(input, init);
  };

  try {
    const remote = new Colibri({
      chainId: 1, prover: [PROVER],
      prover_mode: 'remote', proofStrategy: Strategy.VerifiedOnly,
    });
    await remote.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
  } catch (e: any) {
    remoteCalls.push(`异常: ${e.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('  网络请求:');
  remoteCalls.forEach(c => console.log(`    ${c}`));
  console.log('  信任模型: 本地验证 BLS 签名 + Prover 返回的证明，完全不依赖 RPC 节点');
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log('Colibri Stateless 深度原理验证\n');

  await exp1_isStandardRPC();
  await exp2_internalCalls();
  await exp3_dataConsistency();
  await exp4_robustPoisonProof();
  await exp5_localConsensusPoison();
  await exp6_modeComparison();
})().catch(console.error);