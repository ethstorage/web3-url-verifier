import * as ethers from 'ethers';
import ColibriStateless from '@corpus-core/colibri-stateless';
import { computeEthStorageHashes, getKzg } from './blobs.js';
import type { TestCase } from './config.js';

const Colibri = (ColibriStateless as any).default || ColibriStateless;

const ERC5018_ABI = [
  'function countChunks(bytes memory name) view returns (uint256)',
  'function getChunkHashesBatch((bytes name, uint256[] chunkIds)[] fileChunks) view returns (bytes32[])',
];

// ─── 工具函数 ───────────────────────────────

function createSemaphore(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  function acquire(): Promise<() => void> {
    return new Promise(resolve => {
      if (running < limit) {
        running++;
        resolve(release);
      } else {
        queue.push(() => {
          running++;
          resolve(release);
        });
      }
    });
  }
  function release() {
    running--;
    const next = queue.shift();
    if (next) { running++; next(); }
  }
  return acquire;
}

function elapsed(start: number) { return ((Date.now() - start) / 1000).toFixed(1); }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── 类型 ───────────────────────────────────

interface VerifyResult {
  path: string;
  size: number;
  match: boolean;
  detail: string;
}

interface ProverResult {
  result: string | null;
  error?: string;
}

// ════════════════════════════════════════════════════════════
//  Web3URLVerifier
// ════════════════════════════════════════════════════════════

export class Web3URLVerifier {
  private erc5018: ethers.Interface;
  private colibriClient: any;
  private esProvider: ethers.JsonRpcProvider;
  private static _kzgReady = false;

  constructor(ethChainId: number, netConfig: { colibriProver: string; esRpc: string }) {
    this.erc5018 = new ethers.Interface(ERC5018_ABI);
    this.colibriClient = new Colibri({
      chainId: ethChainId,
      prover: [netConfig.colibriProver],
      include_code: true,
    });
    this.esProvider = new ethers.JsonRpcProvider(netConfig.esRpc);
  }

  async initKzg() {
    if (!Web3URLVerifier._kzgReady) { await getKzg(); Web3URLVerifier._kzgReady = true; }
  }

  // ════════════════════════════════════════════════════════
  //  主入口
  // ════════════════════════════════════════════════════════

  async verify(web3Url: string, testCase: TestCase): Promise<VerifyResult[]> {
    await this.initKzg();

    const { contract, esChainId, path: urlPath } = this._parseUrl(web3Url);
    const base = `https://${contract}.${esChainId}.w3link.io`;
    console.log(`   合约: ${contract} | ES Chain: ${esChainId}`);

    // === 发现 + 下载 ===
    const startDl = Date.now();
    console.log('   发现+下载中...');

    const fetched = new Map<string, Buffer>();
    const dlSem = createSemaphore(16);

    const startPath = urlPath;
    await this._crawl(base + startPath, startPath, base, fetched, dlSem, (n, total) => {
      if (n % 20 === 0 || n === total)
        process.stderr.write(`\r   发现+下载: ${n}/${total} (${elapsed(startDl)}s)    `);
    });

    // 去重：Gateway 在 / 返回 rootFile 内容，保留 rootFile 路径
    if (testCase.rootFile) {
      const rootPath = '/' + testCase.rootFile;
      if (rootPath !== '/' && fetched.has('/') && fetched.has(rootPath)) {
        fetched.delete('/');
      }
    }

    process.stderr.write(`\r   下载完成: ${fetched.size} 文件 | ${elapsed(startDl)}s\n`);

    // === 验证 ===
    const startV = Date.now();
    const vSem = createSemaphore(8);
    let vDone = 0;
    const total = fetched.size;
    const entries = [...fetched];

    const results = await Promise.all(entries.map(async ([relPath, content]) => {
      const release = await vSem();
      try {
        const r = await this._verifyFile(content, contract, relPath, testCase);
        vDone++;
        if (vDone % 50 === 0 || vDone === total)
          process.stderr.write(`\r   验证: ${vDone}/${total} (${elapsed(startV)}s)    `);
        return { path: relPath, size: content.length, ...r };
      } finally { release(); }
    }));

    const tVerify = Date.now() - startV;
    process.stderr.write(`\r   验证: ${vDone}/${total} (${elapsed(startV)}s)    \n`);

    this._printReport(testCase.name, contract, results, Date.now() - startDl - tVerify, tVerify);

    // Manual 模式：分析失败的根目录文件（通常因 Gateway 注入导致）
    if (testCase.resolveMode !== 'auto') {
      const failedRoot = results.filter(r => !r.match && (r.path === '/' || r.path === '/index.html'));
      if (failedRoot.length > 0) {
        console.log('📊 分析失败根目录文件...');
        for (const fail of failedRoot) {
          const gatewayContent = fetched.get(fail.path);
          if (!gatewayContent) continue;
          const contractContent = await this._fetchFileDirectly(contract, fail.path);
          if (contractContent && contractContent.length > 0) {
            this._diffContent(gatewayContent, contractContent);
          } else {
            console.log('    ❌ 无法从合约获取文件内容');
          }
        }
      }
    }

    return results;
  }

  // ════════════════════════════════════════════════════════
  //  爬取（两模式共用）
  // ════════════════════════════════════════════════════════

  private async _crawl(
    url: string,
    relPath: string,
    baseUrl: string,
    fetched: Map<string, Buffer>,
    dlSem: () => Promise<() => void>,
    onProgress: (n: number, total: number) => void,
  ) {
    let released = false;
    const release = await dlSem();
    try {
      if (fetched.has(relPath)) return;

      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return;

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) return;

      fetched.set(relPath, buf);
      onProgress(fetched.size, fetched.size);

      const ct = res.headers.get('content-type') || '';
      const isHtml = ct.includes('html') || relPath.endsWith('/') || relPath.endsWith('.html');
      if (!isHtml) return;

      release(); released = true;
      const html = buf.toString('utf-8');
      const rawLinks: string[] = [];

      // 提取 <script src>, <img src>, <video src> 等
      const srcRe = /<(?:script|img|video|audio|source|iframe|embed|track)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?>/gi;
      let m: RegExpExecArray | null;
      while ((m = srcRe.exec(html)) !== null) {
        if (m[1]) rawLinks.push(m[1]);
      }

      // 提取 <link href>
      const linkTagRe = /<link\b([^>]*?)>/gi;
      while ((m = linkTagRe.exec(html)) !== null) {
        const attrs = m[1];
        const relMatch = attrs.match(/\brel=["']([^"']+)["']/i);
        const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
        if (!hrefMatch) continue;
        const rel = relMatch ? relMatch[1].toLowerCase() : '';
        if (rel && (rel.includes('stylesheet') || rel.includes('icon'))) {
          rawLinks.push(hrefMatch[1]);
        }
      }

      // 根路径自动请求 favicon
      if (relPath === '/' || relPath.endsWith('/index.html')) {
        rawLinks.push('/favicon.ico');
      }

      // 路径规范化
      const links: string[] = [];
      for (const raw of rawLinks) {
        if (!raw || raw.startsWith('#') || raw.startsWith('data:') ||
            raw.startsWith('javascript:') || raw.startsWith('mailto:') ||
            raw.startsWith('http://') || raw.startsWith('https://') ||
            /\b:\/\//.test(raw)) continue;

        let absPath: string;
        if (raw.startsWith('/')) {
          absPath = raw;
        } else {
          const baseDir = relPath.replace(/\/[^/]*$/, '/');
          absPath = (baseDir + raw).replace(/\/\.\//g, '/');
          const parts = absPath.split('/').filter(Boolean);
          const resolved: string[] = [];
          for (const p of parts) {
            if (p === '..') resolved.pop();
            else resolved.push(p);
          }
          absPath = '/' + resolved.join('/');
        }
        const hashIdx = absPath.indexOf('#');
        if (hashIdx >= 0) absPath = absPath.slice(0, hashIdx);
        if (absPath.startsWith('/') && !absPath.includes('..')) {
          links.push(absPath);
        }
      }

      // 并行下载资源
      const resourcePaths = [...new Set(links)].filter(l => !fetched.has(l));
      await Promise.all(resourcePaths.map(async (l) => {
        const release2 = await dlSem();
        try {
          if (fetched.has(l)) return;
          const r = await fetch(baseUrl + l, { signal: AbortSignal.timeout(30000) });
          if (!r.ok) return;
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > 0) {
            fetched.set(l, b);
            onProgress(fetched.size, fetched.size);
          }
        } catch (_) { /* 忽略单个资源失败 */ } finally { release2(); }
      }));
    } catch (_) { /* 忽略请求失败 */ } finally {
      if (!released) release();
    }
  }

  // ════════════════════════════════════════════════════════
  //  文件验证分发
  // ════════════════════════════════════════════════════════

  private async _verifyFile(
    content: Buffer,
    contract: string,
    relPath: string,
    testCase: TestCase,
  ): Promise<{ match: boolean; detail: string }> {
    if (content.length === 0) return { match: false, detail: '空文件' };
    if (testCase.resolveMode === 'auto') {
      return this._verifyAutoFile(content, contract, relPath);
    }
    return this._verifyManualFile(content, contract, relPath, testCase);
  }

  // ════════════════════════════════════════════════════════
  //  Manual 模式：EthStorage KZG hash 验证
  // ════════════════════════════════════════════════════════

  private async _verifyManualFile(
    content: Buffer,
    contract: string,
    relPath: string,
    testCase: TestCase,
  ): Promise<{ match: boolean; detail: string }> {
    const storedName = (() => {
      if ((relPath === '/' || relPath === '/index.html') && testCase.rootFile)
        return testCase.rootFile;
      return relPath.startsWith('/') ? relPath.slice(1) : relPath;
    })();

    const hexName = ethers.hexlify(ethers.toUtf8Bytes(storedName));

    // Prover 查 countChunks
    const countRs = await this._proverCall(contract,
      this.erc5018.encodeFunctionData('countChunks', [hexName]));
    let chunkCount = 0;
    if (countRs.result && countRs.result !== '0x') {
      try { chunkCount = Number(ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], countRs.result)[0]); } catch (_) {}
    }
    if (chunkCount === 0) return { match: false, detail: '无chunk记录' };

    // Prover 批量查 getChunkHashesBatch
    const chunkIds = [...Array(chunkCount).keys()];
    const batchRs = await this._proverCall(contract,
      this.erc5018.encodeFunctionData('getChunkHashesBatch', [[{ name: hexName, chunkIds }]]));
    let contractHashes: string[] = [];
    if (batchRs.result && batchRs.result !== '0x') {
      try { contractHashes = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32[]'], batchRs.result)[0]; } catch (_) {}
    }

    // 本地 KZG hash
    let localHashes: string[];
    try { localHashes = (await computeEthStorageHashes(content)).hashes; }
    catch (err: any) { return { match: false, detail: `KZG错误: ${String(err).slice(0, 60)}` }; }

    for (let i = 0; i < localHashes.length; i++) {
      if (localHashes[i].toLowerCase() !== (contractHashes[i] || '').toLowerCase())
        return { match: false, detail: 'hash不匹配' };
    }
    return { match: true, detail: 'OK' };
  }

  /** Manual 模式：直接从 ES RPC 取文件内容（用于根目录注入分析） */
  private async _fetchFileDirectly(contract: string, fileName: string): Promise<Buffer | null> {
    try {
      const calldata = ethers.hexlify(ethers.toUtf8Bytes(fileName));
      const result = await this.esProvider.send('eth_call', [{ to: contract, data: calldata }, 'latest']);
      if (result === '0x' || result.length <= 2) {
        console.log('    ❌ 合约返回空内容');
        return null;
      }
      const cleanHex = result.startsWith('0x') ? result.slice(2) : result;
      const fullBuffer = Buffer.from(cleanHex, 'hex');
      return fullBuffer.length > 64 ? fullBuffer.subarray(64) : fullBuffer;
    } catch (err: any) {
      console.log(`    ❌ 从合约获取失败: ${String(err).slice(0, 80)}`);
      return null;
    }
  }

  /** Manual 模式：对比 Gateway 响应与合约原始响应（定位 Gateway 注入） */
  private _diffContent(gatewayContent: Buffer, contractContent: Buffer): void {
    const gatewayStr = gatewayContent.toString('utf-8');
    const contractStr = contractContent.toString('utf-8');

    const minLen = Math.min(gatewayStr.length, contractStr.length);
    let startIdx = -1;
    for (let i = 0; i < minLen; i++) {
      if (gatewayStr[i] !== contractStr[i]) { startIdx = i; break; }
    }
    if (startIdx < 0) { console.log('   内容完全一致'); return; }

    let gateEnd = gatewayStr.length - 1;
    let contEnd = contractStr.length - 1;
    while (gateEnd >= startIdx && contEnd >= startIdx) {
      if (gatewayStr[gateEnd] !== contractStr[contEnd]) break;
      gateEnd--; contEnd--;
    }

    const rawInjection = gatewayStr.slice(startIdx, gateEnd + 1);
    const compressed = rawInjection.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const showLen = 40;
    console.log(`  📍 检测到 Gateway 注入内容 (原始总长: ${rawInjection.length} 字节):`);
    console.log(`  注入内容: ${compressed.length <= showLen * 2 ? compressed : compressed.slice(0, showLen) + ' ... ' + compressed.slice(-showLen)}`);
  }

  // ════════════════════════════════════════════════════════
  //  Auto 模式：解析路径 → 构造 calldata → Prover → 对比
  // ════════════════════════════════════════════════════════

  /** 解析 Auto 路径，如 /render/78/0 → render(78, 0) */
  private _parseAutoPath(relPath: string): { funcName: string; params: string[] } | null {
    const parts = relPath.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    return { funcName: parts[0], params: parts.slice(1) };
  }

  /** 从函数名+参数构造 ABI calldata（数字→uint256，其他→string） */
  private _buildAutoCalldata(funcName: string, params: string[]): string {
    const types = params.map(p => /^\d+$/.test(p) ? 'uint256' : 'string');
    const values = params.map((p, i) => types[i] === 'uint256' ? BigInt(p) : p);
    return new ethers.Interface([`function ${funcName}(${types.join(',')})`]).encodeFunctionData(funcName, values);
  }

  /** Auto 模式：Gateway 内容 vs Prover eth_call 结果 */
  private async _verifyAutoFile(
    content: Buffer,
    contract: string,
    relPath: string,
  ): Promise<{ match: boolean; detail: string }> {
    if (relPath === '/' || relPath === '') return { match: true, detail: '根路径，跳过' };

    const pathInfo = this._parseAutoPath(relPath);
    if (!pathInfo) return { match: false, detail: `无法解析路径: ${relPath}` };

    let calldata: string;
    try { calldata = this._buildAutoCalldata(pathInfo.funcName, pathInfo.params); }
    catch (err: any) { return { match: false, detail: `calldata构造失败: ${String(err).slice(0, 60)}` }; }

    const proverRs = await this._proverCall(contract, calldata);
    if (!proverRs.result) return { match: false, detail: `Prover调用失败: ${proverRs.error}` };

    // 解码 Prover 返回值（优先 bytes，回退 string，最后当原始 hex）
    let proverBytes: Buffer;
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], proverRs.result);
      proverBytes = Buffer.from(decoded[0].slice(2), 'hex');
    } catch {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], proverRs.result);
        proverBytes = Buffer.from(decoded[0], 'utf-8');
      } catch {
        proverBytes = Buffer.from(proverRs.result.slice(2), 'hex');
      }
    }

    const match = content.equals(proverBytes);
    return { match, detail: match ? 'OK' : `内容不匹配 (gateway=${content.length}B, prover=${proverBytes.length}B)` };
  }

  // ════════════════════════════════════════════════════════
  //  共用工具
  // ════════════════════════════════════════════════════════

  /** 解析 web3:// URL */
  private _parseUrl(rawUrl: string): { contract: string; esChainId: number; path: string } {
    const m = rawUrl.match(/^web3:\/\/(0x[a-fA-F0-9]+)(?::(\d+))?(\/.*)?$/);
    if (!m) throw new Error(`无法解析: ${rawUrl}`);
    return { contract: m[1], esChainId: parseInt(m[2] || '1'), path: m[3] || '/' };
  }

  /** Prover 调用（带指数退避重试） */
  private async _proverCall(contract: string, calldata: string, maxRetries = 3): Promise<ProverResult> {
    const _w = console.warn;
    console.warn = () => {};
    try {
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          const r = await this.colibriClient.request({
            method: 'eth_call',
            params: [{ to: contract, data: calldata }, 'latest'],
          });
          return { result: r };
        } catch (err: any) {
          const msg = String(err).slice(0, 120);
          if (retry < maxRetries - 1 &&
              (msg.includes('memory access') || msg.includes('timeout') ||
               msg.includes('network') || msg.includes('connection'))) {
            await sleep(200 * Math.pow(2, retry));
            continue;
          }
          return { result: null, error: msg };
        }
      }
      return { result: null, error: 'max retries exceeded' };
    } finally { console.warn = _w; }
  }

  /** 打印摘要报告 */
  private _printReport(name: string, contract: string, results: VerifyResult[], tDownload: number, tVerify: number) {
    const passed = results.filter(r => r.match);
    const failed = results.filter(r => !r.match);
    const totalSize = results.reduce((s, r) => s + (r.size || 0), 0);

    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  ${name}  合约: ${contract}`);
    console.log('──────────────────────────────────────────────');
    console.log(`  文件: ${results.length} | ✅${passed.length} ❌${failed.length} | ${(totalSize/1024).toFixed(1)}KB`);
    console.log(`  下载: ${(tDownload/1000).toFixed(1)}s | 验证: ${(tVerify/1000).toFixed(1)}s`);

    const groups = new Map<string, { count: number; size: number; ok: number; fail: number }>();
    for (const r of results) {
      const parts = r.path.split('/').filter(Boolean);
      const key = parts.length > 1 ? `/${parts[0]}/` : (parts.length === 1 ? `/${parts[0]}` : '/');
      if (!groups.has(key)) groups.set(key, { count: 0, size: 0, ok: 0, fail: 0 });
      const g = groups.get(key)!;
      g.count++; g.size += (r.size || 0);
      r.match ? g.ok++ : g.fail++;
    }

    console.log(`  ${'目录'.padEnd(34)} | 文件 | 大小     | 状态`);
    for (const [p, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sz = g.size >= 1048576 ? `${(g.size/1048576).toFixed(1)}MB` : `${(g.size/1024).toFixed(1)}KB`;
      const st = g.fail > 0 ? `✅${g.ok} ❌${g.fail}` : `✅${g.ok}`;
      console.log(`  ${p.padEnd(32)} | ${String(g.count).padStart(4)} | ${sz.padStart(7)} | ${st}`);
    }

    if (failed.length > 0) {
      const reasons: Record<string, number> = {};
      for (const f of failed) { const k = f.detail; reasons[k] = (reasons[k] || 0) + 1; }
      console.log(`  失败: ${Object.entries(reasons).map(([k, v]) => `${v}x ${k}`).join(', ')}`);
      console.log(`  样本: ${failed.slice(0, 5).map(f => f.path).join(', ')}`);
    }
    console.log('══════════════════════════════════════════════\n');
  }
}