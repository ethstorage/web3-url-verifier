import config from '../config.mjs';
import * as ethers from 'ethers';
import ColibriStateless from '@corpus-core/colibri-stateless';
import { Client } from 'web3protocol';
import { getDefaultChainList } from 'web3protocol/chains';
import { computeEthStorageHashes, getKzg } from './blobs.mjs';
import { createHash } from 'node:crypto';

const Colibri = ColibriStateless.default || ColibriStateless;

const RPC_URL = config.RPC_URL;
const ES_RPC_URL = config.ES_RPC_URL;
const COLIBRI_PROVER = config.COLIBRI_PROVER;
const SUPPORTED_CHAINS = config.SUPPORTED_CHAINS;

const ERC5018_ABI = [
  'function countChunks(bytes memory name) view returns (uint256)',
  'function getChunkHashesBatch((bytes name, uint256[] chunkIds)[] fileChunks) view returns (bytes32[])',
];

// ============================================================
function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT(${label},${ms}ms)`)), ms)
    ),
  ]);
}

function elapsed(start) { return Date.now() - start; }

function buildChainList() {
  const chains = getDefaultChainList();
  for (const [chainIdStr, info] of Object.entries(SUPPORTED_CHAINS)) {
    const chainId = parseInt(chainIdStr);
    const existing = chains.find(c => c.id === chainId);
    if (existing) {
      existing.rpcUrls = [info.rpcUrl];
    } else {
      chains.push({ id: chainId, rpcUrls: [info.rpcUrl] });
    }
  }
  return chains;
}

// ============================================================
class Web3URLVerifier {
  constructor() {
    const chainList = buildChainList();
    this.web3Client = new Client(chainList, { multipleRpcMode: 'parallel' });

    this.colibriClient = new Colibri({
      prover: COLIBRI_PROVER,
      include_code: true,
    });

    this.elRpc = new ethers.JsonRpcProvider(RPC_URL);
    this.esRpc = new ethers.JsonRpcProvider(ES_RPC_URL);
    this.erc5018 = new ethers.Interface(ERC5018_ABI);
  }

  // ---- 预热 KZG（首次 ~10s） ----
  async initKzg() { await getKzg(); }

  // ---- URL 解析 ----
  async parseUrl(rawUrl) {
    const { urlMainParts, chainId: parsedChainId } = this.web3Client.parseUrlBasic(rawUrl);
    let chainId = parsedChainId;

    const { contractAddress, chainId: updatedChainId } =
      await this.web3Client.determineTargetContractAddress(urlMainParts.hostname, chainId);
    chainId = updatedChainId;

    const { mode: resolveMode } = await this.web3Client.determineResolveMode(contractAddress, chainId);

    const parsedPath = await this.web3Client.parsePathForResolveMode(
      urlMainParts.path, resolveMode, chainId
    );
    const calldata = parsedPath.calldata || '0x';

    const chainInfo = SUPPORTED_CHAINS[chainId] || { name: `Chain #${chainId}`, colibriSupport: false };

    return {
      rawUrl, chainId, contractAddress, resolveMode, calldata,
      _chainInfo: chainInfo,
      _chainSupported: chainInfo.colibriSupport,
    };
  }

  // ---- RPC 下载（未验证） ----
  async rpcDownload(contractAddress, calldata) {
    const start = Date.now();
    try {
      const result = await this.elRpc.send('eth_call', [
        { to: contractAddress, data: calldata }, 'latest',
      ]);
      const ms = elapsed(start);
      const len = typeof result === 'string' ? (result.length - 2) / 2 : 0;
      return { result, ms, dataLen: len };
    } catch (err) {
      return { result: null, ms: elapsed(start), error: err.message?.slice(0, 120) };
    }
  }

  async esDownload(contractAddress, calldata) {
    const start = Date.now();
    try {
      const result = await this.esRpc.send('eth_call', [
        { to: contractAddress, data: calldata }, 'latest',
      ]);
      const ms = elapsed(start);
      const len = typeof result === 'string' ? (result.length - 2) / 2 : 0;
      return { result, ms, dataLen: len };
    } catch (err) {
      return { result: null, ms: elapsed(start), error: err.message?.slice(0, 120) };
    }
  }

  // ---- Prover 验证（可验证） ----
  async proverCall(contractAddress, calldata, timeoutMs = 60000) {
    const start = Date.now();
    try {
      const result = await withTimeout(
        this.colibriClient.request({
          method: 'eth_call',
          params: [{ to: contractAddress, data: calldata }, 'latest'],
        }),
        timeoutMs,
        'prover'
      );
      const ms = elapsed(start);
      const len = typeof result === 'string' ? (result.length - 2) / 2 : 0;
      return { result, ms, dataLen: len };
    } catch (err) {
      const msg = err.message?.includes('TIMEOUT')
        ? `TIMEOUT(${timeoutMs}ms)`
        : err.message?.slice(0, 120);
      return { result: null, ms: elapsed(start), error: msg };
    }
  }

  // ---- 解码 ----
  decodeResult(rawHex) {
    if (!rawHex || rawHex === '0x') return null;
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], rawHex);
      return Buffer.from(decoded[0].slice(2), 'hex');
    } catch {
      return Buffer.from(rawHex.slice(2), 'hex');
    }
  }

  // ---- HTML 资源发现 ----
  extractLinksFromHtml(html, baseWeb3Url) {
    const found = new Set();
    const attrRegex = /\b(?:href|src|action|poster|srcset)=["']([^"']+)["']/gi;
    let match;
    while ((match = attrRegex.exec(html)) !== null) {
      const r = this._resolveWeb3Link(baseWeb3Url, match[1]);
      if (r) found.add(r);
    }
    const srcsetRegex = /srcset=["']([^"']+)["']/gi;
    while ((match = srcsetRegex.exec(html)) !== null) {
      for (const entry of match[1].split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        const r = this._resolveWeb3Link(baseWeb3Url, url);
        if (r) found.add(r);
      }
    }
    const cssUrlRegex = /@import\s+["']([^"']+)["']|url\(["']?([^"')]+)["']?\)/gi;
    while ((match = cssUrlRegex.exec(html)) !== null) {
      const r = this._resolveWeb3Link(baseWeb3Url, match[1] || match[2]);
      if (r) found.add(r);
    }
    return [...found];
  }

  _resolveWeb3Link(baseUrl, link) {
    if (!link || link.startsWith('#') || link.startsWith('data:') ||
        link.startsWith('javascript:') || link.startsWith('mailto:') ||
        link.startsWith('http://') || link.startsWith('https://')) {
      return null;
    }
    if (link.startsWith('web3://') || link.startsWith('w3://')) return link;

    const baseMatch = baseUrl.match(/^(web3:\/\/[^/]+)/);
    if (!baseMatch) return null;
    const baseOrigin = baseMatch[1];

    if (link.startsWith('/')) return baseOrigin + link;

    const basePathMatch = baseUrl.match(/^(web3:\/\/[^/]+)(\/.*?)([^/]*)$/);
    if (!basePathMatch) return null;
    return baseOrigin + basePathMatch[2] + link;
  }

  // ---- Manual 模式：递归发现资源 ----
  async discoverManualResources(parsedRoot, baseUrl, visited = new Set(), depth = 0, maxDepth = 2) {
    if (depth > maxDepth || visited.has(baseUrl)) return [];
    visited.add(baseUrl);

    const resources = [{ url: baseUrl, parsedUrl: parsedRoot, depth }];

    if (depth > 0 && /\.(js|css|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|map|json|xml|webp|avif|mp3|mp4|webm)([#?]|$)/i.test(baseUrl.toLowerCase())) {
      return resources;
    }

    const fetchResult = await this.esDownload(parsedRoot.contractAddress, parsedRoot.calldata);
    if (!fetchResult.result) return resources;

    const raw = this.decodeResult(fetchResult.result);
    if (!raw) return resources;

    const str = raw.toString('utf-8');
    if (!/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(str)) return resources;

    const links = this.extractLinksFromHtml(str, baseUrl);
    for (const link of links.filter(l => !visited.has(l))) {
      try {
        const parsed = await this.parseUrl(link);
        if (parsed.contractAddress !== parsedRoot.contractAddress ||
            parsed.chainId !== parsedRoot.chainId) continue;
        const children = await this.discoverManualResources(parsed, link, visited, depth + 1, maxDepth);
        resources.push(...children);
      } catch (_) {}
    }
    return resources;
  }

  // ---- EthStorage 文件名映射 ----
  getStoredFileName(url, testCase) {
    const pathPart = url.replace(/^web3:\/\/[^/]+/, '') || '/';
    if ((pathPart === '/' || pathPart === '') && testCase?.rootFile) return testCase.rootFile;
    return pathPart.startsWith('/') ? pathPart.slice(1) : pathPart;
  }

  // ---- EthStorage：Prover 取 L1 合约 hash + 本地 KZG 对比 ----
  async verifyEthStorageData(fileData, parsedUrl, url, testCase) {
    const storedFileName = this.getStoredFileName(url, testCase);
    const hexName = ethers.hexlify(ethers.toUtf8Bytes(storedFileName));

    // Prover 查 countChunks
    const countCalldata = this.erc5018.encodeFunctionData('countChunks', [hexName]);
    const countRs = await this.proverCall(parsedUrl.contractAddress, countCalldata);
    let chunkCount = 0;
    if (countRs.result && countRs.result !== '0x') {
      try {
        chunkCount = Number(ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], countRs.result)[0]);
      } catch (_) {}
    }
    if (chunkCount === 0) {
      return {
        url, type: 'es',
        match: false, matchDetail: '文件无chunk',
        rpcMs: 0, rpcLen: fileData.length,
        proverMs: countRs.ms,
        proverLen: 0,
        chunkInfo: { fileSize: fileData.length, chunkCount: 0, filename: storedFileName, countMs: countRs.ms, batchMs: 0, kzgMs: 0 },
      };
    }

    // Prover 批量查 getChunkHashesBatch（一次请求）
    const chunkIds = [...Array(chunkCount).keys()];
    const batchCalldata = this.erc5018.encodeFunctionData('getChunkHashesBatch', [
      [{ name: hexName, chunkIds }],
    ]);
    const batchRs = await this.proverCall(parsedUrl.contractAddress, batchCalldata);
    let contractHashes = [];
    if (batchRs.result && batchRs.result !== '0x') {
      try {
        contractHashes = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32[]'], batchRs.result)[0];
      } catch (_) {}
    }

    // 本地 KZG hash
    const kzgStart = Date.now();
    let localHashes = [], localChunkCount = 0, kzgError = null;
    try {
      const res = await computeEthStorageHashes(fileData);
      localHashes = res.hashes;
      localChunkCount = res.chunkCount;
    } catch (err) {
      kzgError = err.message;
    }
    const kzgMs = elapsed(kzgStart);

    // 对比
    let match = true, matchDetail = '';
    if (kzgError) {
      match = false;
      matchDetail = `KZG计算失败: ${kzgError}`;
    } else if (localChunkCount !== chunkCount) {
      match = false;
      matchDetail = `chunk数量不匹配 (local:${localChunkCount} vs contract:${chunkCount})`;
    } else {
      for (let i = 0; i < localHashes.length; i++) {
        if (localHashes[i].toLowerCase() !== (contractHashes[i] || '').toLowerCase()) {
          match = false; break;
        }
      }
      matchDetail = match ? 'hash 匹配 ✅' : 'hash 不匹配 ❌';
    }

    return {
      url, type: 'es',
      match, matchDetail,
      rpcMs: 0, rpcLen: fileData.length,
      proverMs: countRs.ms + batchRs.ms,
      proverLen: 0,
      chunkInfo: {
        fileSize: fileData.length,
        chunkCount,
        filename: storedFileName,
        countMs: countRs.ms,
        batchMs: batchRs.ms,
        kzgMs,
        batchError: batchRs.error || null,
      },
    };
  }

  // ---- 并发下载 ----
  async downloadAllResources(allResources, parsedRoot, testCase) {
    const isAuto = parsedRoot.resolveMode === 'auto';

    const dlStart = Date.now();
    const requests = allResources.map(({ parsedUrl, url }) => {
      const fetcher = isAuto
        ? this.rpcDownload(parsedUrl.contractAddress, parsedUrl.calldata)
        : this.esDownload(parsedUrl.contractAddress, parsedUrl.calldata);
      return fetcher.then(r => ({
        url, parsedUrl,
        rawResult: r.result,
        dlMs: r.ms,
        dlLen: r.dataLen || 0,
        dlError: r.error,
        fileData: r.result ? this.decodeResult(r.result) : null,
      }));
    });

    const downloadResults = await Promise.all(requests);
    const dlMs = elapsed(dlStart);

    const failCount = downloadResults.filter(r => !r.rawResult || r.dlError).length;
    const totalBytes = downloadResults.reduce((s, r) => s + (r.dlLen || 0), 0);

    console.log(`   ${allResources.length} 资源 | ${formatBytes(totalBytes)} | ${formatMs(dlMs)}${failCount > 0 ? ` | ❌${failCount}` : ''}`);

    return { downloadResults, dlMs };
  }

  // ---- 并发验证 ----
  async verifyAllResources(downloadResults, parsedRoot, testCase) {
    const isAuto = parsedRoot.resolveMode === 'auto';

    const vfStart = Date.now();
    const verifyTasks = downloadResults.map(async (dl) => {
      const { url, parsedUrl, rawResult, dlMs, dlLen, dlError, fileData } = dl;

      if (!rawResult || dlError) {
        return {
          url, type: isAuto ? 'auto' : 'es',
          rpcMs: dlMs, rpcLen: dlLen || 0, rpcError: dlError || 'download_failed',
          proverMs: 0, proverLen: 0, proverError: null,
          match: false, matchDetail: '下载失败',
          chunkInfo: null,
        };
      }

      if (isAuto) {
        const proverRes = parsedUrl._chainSupported
          ? await this.proverCall(parsedUrl.contractAddress, parsedUrl.calldata)
          : { result: null, ms: 0, dataLen: 0, error: 'chain_unsupported' };

        let match = false, detail = '';
        if (rawResult && proverRes.result) {
          if (rawResult === proverRes.result) {
            match = true; detail = '精确匹配 ✅';
          } else {
            match = sha256(rawResult) === sha256(proverRes.result);
            detail = match ? '哈希匹配 ✅' : '不匹配 ❌';
          }
        } else {
          detail = proverRes.error === 'chain_unsupported' ? '⏭ 链不支持' : '⚠ 一侧失败';
        }

        return {
          url, type: 'auto',
          rpcMs: dlMs, rpcLen: dlLen, rpcError: null,
          proverMs: proverRes.ms, proverLen: proverRes.dataLen, proverError: proverRes.error || null,
          match, matchDetail: detail,
          chunkInfo: null,
        };
      } else {
        return this.verifyEthStorageData(fileData, parsedUrl, url, testCase);
      }
    });

    const verifyResults = await Promise.all(verifyTasks);
    const vfMs = elapsed(vfStart);

    const verified = verifyResults.filter(r => r.match).length;
    const fail = verifyResults.length - verified;
    console.log(`   ✅${verified}${fail > 0 ? ` ⚠${fail}` : ''} | ${formatMs(vfMs)}`);

    return { verifyResults, vfMs };
  }

  // ---- 主入口 ----
  async verifyUrl(web3Url, options = {}) {
    const { maxDepth = 2, testCase = null } = options;

    if (!Web3URLVerifier._kzgReady) {
      console.log('── 预热 KZG 可信设置（仅首次）──');
      await this.initKzg();
      Web3URLVerifier._kzgReady = true;
    }

    console.log('── Step 1: 解析 URL ──');
    const parsedRoot = await this.parseUrl(web3Url);

    let allResources = [];
    if (parsedRoot.resolveMode === 'auto') {
      allResources = [{ url: web3Url, parsedUrl: parsedRoot, depth: 0 }];
    } else {
      console.log('── Step 2: 递归发现资源 ──');
      allResources = await this.discoverManualResources(parsedRoot, web3Url, new Set(), 0, maxDepth);
      console.log(`   发现 ${allResources.length} 个资源 (深度 ≤ ${maxDepth})`);
    }

    console.log('── Step 3: 📥 RPC 下载 ──');
    const { downloadResults, dlMs } = await this.downloadAllResources(allResources, parsedRoot, testCase);

    console.log('── Step 4: 🔐 Prover 验证 ──');
    const { verifyResults, vfMs } = await this.verifyAllResources(downloadResults, parsedRoot, testCase);

    this.printSummary(verifyResults, dlMs, vfMs, parsedRoot);
    return verifyResults;
  }

  // ---- 汇总打印 ----
  printSummary(results, dlMs, vfMs, parsedRoot) {
    const isAuto = parsedRoot.resolveMode === 'auto';
    const mode = isAuto ? 'Auto' : 'EthStorage';
    const totalMs = dlMs + vfMs;

    const verified = results.filter(r => r.match).length;
    const fail = results.filter(r => !r.match).length;

    console.log('\n══════════════════════════════════════════════');
    console.log(`  Web3 URL 验证结果 (${mode})`);
    console.log(`  合约: ${parsedRoot.contractAddress} | 链: ${parsedRoot._chainInfo.name} (${parsedRoot.chainId})`);
    console.log('──────────────────────────────────────────────');
    console.log(`  📥 RPC 下载: ${formatMs(dlMs)}`);
    console.log(`  🔐 Prover 验证: ${formatMs(vfMs)} (${results.length} 资源并发)`);
    if (!isAuto) console.log('     注意: Prover 列是单文件串行耗时(count+batch)，vfMs 是并发墙钟');
    console.log(`  ⏱ 总计: ${formatMs(totalMs)}`);
    console.log(`  结果: ✅${verified}${fail > 0 ? ` ❌${fail}` : ''}`);
    console.log('──────────────────────────────────────────────');

    console.log('');
    console.log('| # | 资源'.padEnd(49) + ' | 大小   | RPC    | Prover | 状态 |');
    console.log('|' + '-'.repeat(3) + '|' + '-'.repeat(47) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|' + '-'.repeat(6) + '|');

    results.forEach((r, i) => {
      const short = r.url.length > 45 ? '...' + r.url.slice(-42) : r.url.padEnd(45);
      const size = String(formatBytes(r.rpcLen || 0)).padStart(6);
      const rpc = String(formatMs(r.rpcMs || 0)).padStart(6);
      const prv = String(formatMs(r.proverMs || 0)).padStart(6);
      const status = r.match ? '✅' : '⚠';
      console.log(`| ${String(i + 1).padStart(2)} | ${short} | ${size} | ${rpc} | ${prv} | ${status}  |`);
    });

    const esResults = results.filter(r => r.chunkInfo);
    if (esResults.length > 0) {
      console.log('\n--- EthStorage 详情 ---');
      console.log('  文件'.padEnd(28) + ' | 大小   | Chunks | count  | batch  | KZG   |');
      console.log('  ' + '-'.repeat(26) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|' + '-'.repeat(8) + '|');
      esResults.forEach(r => {
        const ci = r.chunkInfo;
        const name = ci.filename.length > 26 ? '...' + ci.filename.slice(-23) : ci.filename.padEnd(26);
        const size = String(formatBytes(ci.fileSize)).padStart(6);
        const chunks = String(ci.chunkCount).padStart(6);
        const cms = String(formatMs(ci.countMs)).padStart(6);
        const bms = String(formatMs(ci.batchMs)).padStart(6);
        const kms = String(formatMs(ci.kzgMs)).padStart(6);
        console.log(`  ${name} | ${size} | ${chunks} | ${cms} | ${bms} | ${kms} |`);
        if (ci.batchError) console.log(`    ⚠ batch 失败: ${ci.batchError}`);
      });
    }

    console.log('══════════════════════════════════════════════\n');
  }
}

// ============================================================
function formatMs(ms) {
  if (!ms || ms < 0) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatBytes(bytes) {
  if (!bytes) return '0B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export { Web3URLVerifier };
