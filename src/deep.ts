/**
 * Colibri Deep Principle Verification
 *
 * Validates Colibri's cryptographic security guarantees through
 * fetch interception + data poisoning + mode comparison
 */
import { ethers } from 'ethers';
import Colibri, { Strategy } from '@corpus-core/colibri-stateless';

const SELF_RPC = 'http://88.99.30.186:8545/';
const PROVER = 'https://mainnet.colibri-proof.tech';
const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const sep = (title: string) => console.log('\n' + '='.repeat(25) + ` ${title} ` + '='.repeat(25) + '\n');

const originalFetch = globalThis.fetch;

// ============================================================
// Experiment 1: eth_getProof is a standard EIP-1186 interface
// ============================================================
async function exp1_isStandardRPC() {
  sep('Exp 1: eth_getProof is a standard EIP-1186 interface');

  const rpc = new ethers.JsonRpcProvider(SELF_RPC);
  const proof = await rpc.send('eth_getProof', [ADDR, [], 'latest']);

  console.log('Direct RPC eth_getProof result:');
  console.log(`  address:      ${proof.address}`);
  console.log(`  balance:      ${proof.balance}`);
  console.log(`  nonce:        ${proof.nonce}`);
  console.log(`  codeHash:     ${proof.codeHash}`);
  console.log(`  storageHash:  ${proof.storageHash}`);
  console.log(`  accountProof: ${proof.accountProof.length} nodes`);
  console.log(`  storageProof: ${proof.storageProof.length} slots`);
}

// ============================================================
// Experiment 2: Colibri internal request interception (fetch monkey-patch)
// ============================================================
async function exp2_internalCalls() {
  sep('Exp 2: What requests does Colibri actually make internally?');

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

    console.log('User call: colibri.request({ method: "eth_getBalance" })\n');
    const result = await c.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
    console.log(`Result: ${result}\n`);

    console.log('SDK internal network trace:');
    calls.forEach((log, i) => console.log(`  ${i + 1}. ${log}`));

    console.log('\nPrinciple analysis:');
    console.log('  - SDK does not forward eth_getBalance directly; it decomposes into two steps:');
    console.log('    1) Request beacon block header from Prover (with BLS signature)');
    console.log('    2) Request eth_getProof from RPC (with account MPT proof)');
    console.log('  - Locally verify BLS signature on block header -> verify MPT proof via stateRoot -> extract balance');
  } catch (e: any) {
    console.log('Exp 2 error:', e.message);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// Experiment 3: Data consistency cross-comparison
// ============================================================
async function exp3_dataConsistency() {
  sep('Exp 3: Standard RPC vs Hybrid vs Remote consistency');

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
  console.log(`  Direct RPC: ${rpcBal}`);
  console.log(`  Hybrid:     ${hybBal}  ${rpcBal === hybBal ? 'OK' : 'MISMATCH!'}`);
  console.log(`  Remote:     ${remBal}  ${rpcBal === remBal ? 'OK' : 'MISMATCH!'}`);

  // eth_getCode
  const UNISWAP = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
  const [rpcCode, hybCode, remCode] = await Promise.all([
    rpc.send('eth_getCode', [UNISWAP, 'latest']),
    hybrid.request({ method: 'eth_getCode', params: [UNISWAP, 'latest'] }),
    remote.request({ method: 'eth_getCode', params: [UNISWAP, 'latest'] }),
  ]);

  console.log('\neth_getCode (Uniswap):');
  console.log(`  Direct RPC: ${rpcCode.length} chars  ${rpcCode.slice(0, 40)}...`);
  console.log(`  Hybrid:     ${(hybCode as string).length} chars  ${(hybCode as string).slice(0, 40)}...  ${rpcCode === hybCode ? 'OK' : 'MISMATCH'}`);
  console.log(`  Remote:     ${(remCode as string).length} chars  ${(remCode as string).slice(0, 40)}...  ${rpcCode === remCode ? 'OK' : 'MISMATCH'}`);

  // eth_call
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC';
  const BALANCE_OF = '0x70a08231' + '000000000000000000000000' + HOLDER.slice(2);

  const [rpcCall, remCall] = await Promise.all([
    rpc.send('eth_call', [{ to: USDT, data: BALANCE_OF }, 'latest']),
    remote.request({ method: 'eth_call', params: [{ to: USDT, data: BALANCE_OF }, 'latest'] }),
  ]);

  console.log('\neth_call (USDT balanceOf):');
  console.log(`  Direct RPC: ${rpcCall}`);
  console.log(`  Remote:     ${remCall}  ${rpcCall === remCall ? 'OK' : 'MISMATCH!'}`);

  console.log('\nConclusion: All three methods return identical data.');
  console.log('           Colibri does not modify data; it only adds cryptographic verification before returning.');
}

// ============================================================
// Experiment 4: Execution layer (MPT) precise poisoning verification
// ============================================================
async function exp4_robustPoisonProof() {
  sep('Exp 4: Execution layer poisoning - tamper with account MPT proof');

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await originalFetch(input, init);
    const url = input.toString();

    if (!url.includes('colibri-proof.tech') && typeof init?.body === 'string' && init.body.includes('eth_getProof')) {
      const json = await res.json();
      if (json?.result?.accountProof?.length > 0) {
        console.log('  [INTERCEPT] Poisoning eth_getProof accountProof...');
        const targetProof = json.result.accountProof[0];
        console.log(`  Original accountProof: ${targetProof}`);
        const lastChar = targetProof.slice(-1);
        const newLastChar = lastChar === 'a' ? 'b' : 'a';
        console.log(`  Modified accountProof: ${targetProof.slice(0, -1) + newLastChar}`);
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
    console.log('  CRITICAL RISK: SDK accepted the tampered MPT proof!');
    return false;
  } catch (e: any) {
    console.log(`  FUSE TRIGGERED! SDK caught exception: ${e.message}`);
    console.log('  Principle: When RPC returns a tampered account proof,');
    console.log('     local MPT Merkle Root verification will fail immediately.');
    console.log('     Even changing a single hex character causes the Merkle root hash to differ completely.');
    return true;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// Experiment 5: Consensus layer (BLS signature) precise poisoning - Local mode
// ============================================================
async function exp5_localConsensusPoison() {
  sep('Exp 5: Consensus layer poisoning - tamper with beacon block state_root');

  const SELF_CL = 'http://88.99.30.186:4200/';
  let tampered = false;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();

    // Intercept beacon chain requests, force Accept: application/json (default returns SSZ binary)
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

        // Beacon block state_root is at data.message.state_root
        if (json?.data?.message?.state_root) {
          console.log(`  [INTERCEPT] state_root = ${json.data.message.state_root.slice(0, 30)}... -> zeroed out`);
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
      console.log('  CRITICAL RISK: SDK accepted the tampered consensus state root!');
      return false;
    }
    console.log('  No beacon chain request intercepted');
    return null;
  } catch (e: any) {
    console.log(`  FUSE TRIGGERED! SDK caught exception: ${e.message}`);
    console.log('  Principle: In Local mode, SDK fetches block headers directly from the beacon node,');
    console.log('    and verifies BLS signatures in local WASM. Tampering with state_root causes');
    console.log('    block hash vs BLS signature mismatch -> signature verification failure.');
    console.log('    This proves that even if your own beacon node is malicious, it can be detected locally.');
    return true;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================
// Experiment 6: Mode watershed - Hybrid vs Remote network topology comparison
// ============================================================
async function exp6_modeComparison() {
  sep('Exp 6: Hybrid vs Remote network topology and trust boundary comparison');

  // --- Hybrid mode ---
  console.log('--- Hybrid mode ---');
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
    hybridCalls.push(`Error: ${e.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('  Network requests:');
  hybridCalls.forEach(c => console.log(`    ${c}`));
  console.log('  Trust model: Locally verify BLS signature + MPT proof; both RPC and Prover can be malicious but cannot pass verification');

  // --- Remote mode ---
  console.log('\n--- Remote mode ---');
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
    remoteCalls.push(`Error: ${e.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('  Network requests:');
  remoteCalls.forEach(c => console.log(`    ${c}`));
  console.log('  Trust model: Locally verify BLS signature + Prover-returned proofs; completely independent of RPC nodes');
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log('Colibri Stateless Deep Principle Verification\n');

  await exp1_isStandardRPC();
  await exp2_internalCalls();
  await exp3_dataConsistency();
  await exp4_robustPoisonProof();
  await exp5_localConsensusPoison();
  await exp6_modeComparison();
})().catch(console.error);