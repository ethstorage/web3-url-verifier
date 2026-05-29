import * as ethers from 'ethers';
import ColibriStateless from '@corpus-core/colibri-stateless';
import { computeEthStorageHashes, getKzg } from './blobs.mjs';

const Colibri = ColibriStateless.default || ColibriStateless;
const ERC5018_ABI = [
  'function countChunks(bytes memory name) view returns (uint256)',
  'function getChunkHashesBatch((bytes name, uint256[] chunkIds)[] fileChunks) view returns (bytes32[])',
];

function createSemaphore(limit) {
  let running = 0;
  const queue = [];
  const release = () => { running--; const n = queue.shift(); if (n) { running++; n(); } };
  return () => new Promise(r => {
    if (running < limit) { running++; r(release); }
    else queue.push(() => { running++; r(release); });
  });
}

function elapsed(start) { return ((Date.now() - start) / 1000).toFixed(1); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class Web3URLVerifier {
  constructor(ethChainId, netConfig) {
    this.ethChainId = ethChainId;
    this.erc5018 = new ethers.Interface(ERC5018_ABI);
    this.colibriClient = new Colibri({
      chainId: ethChainId,
      prover: [netConfig.colibriProver],
      include_code: true,
    });
    this.esProvider = new ethers.JsonRpcProvider(netConfig.esRpc); // ES RPC provider
  }

  async initKzg() {
    if (!Web3URLVerifier._kzgReady) { await getKzg(); Web3URLVerifier._kzgReady = true; }
  }

  async verify(web3Url, testCase) {
    await this.initKzg();

    const { contract, esChainId } = this._parseUrl(web3Url);
    const base = `https://${contract}.${esChainId}.w3link.io`;
    console.log(`   合约: ${contract} | ES Chain: ${esChainId}`);

    // Step 1: 并行发现+下载
    const startDl = Date.now();
    console.log('   发现+下载中...');

    const fetched = new Map();    // relPath -> Buffer
    const dlSem = createSemaphore(16);

    await this._crawl(base, '/', base, fetched, dlSem, (n, total) => {
      if (n % 20 === 0 || n === total)
        process.stderr.write(`\r   发现+下载: ${n}/${total} (${elapsed(startDl)}s)    `);
    });

    // 去重: / 和 /rootFile 是同一个文件，Gateway 在 / 返回 rootFile 内容
    if (testCase?.rootFile) {
      const rootPath = '/' + testCase.rootFile;
      if (rootPath !== '/' && fetched.has('/') && fetched.has(rootPath)) {
        fetched.delete('/');
      }
    }

    process.stderr.write(`\r   下载完成: ${fetched.size} 文件 | ${elapsed(startDl)}s\n`);

    // Step 2: prover 验证
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

    // Step 3: 对失败的根目录文件进行对比分析（额外分析，不计入总耗时）
    const failedRoot = results.filter(r => !r.match && (r.path === '/' || r.path === '/index.html'));
    if (failedRoot.length > 0) {
      console.log(`📊 分析失败根目录文件...`);
      for (const fail of failedRoot) {
        const gatewayContent = fetched.get(fail.path);
        if (!gatewayContent) continue;
        // 直接调用合约获取整个文件内容（利用 fallback 机制）
        const contractContent = await this._fetchFileDirectly(contract, fail.path);
        if (contractContent && contractContent.length > 0) {
          this._diffContent(gatewayContent, contractContent);
        } else {
          console.log('    ❌ 无法从合约获取文件内容');
        }
      }
    }
    return results;
  }

  // 递归并行爬取 gateway
  async _crawl(url, relPath, baseUrl, fetched, dlSem, onProgress) {
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
      const links = [];
      const re = /\b(?:href|src)=["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const raw = m[1];
        if (!raw || raw.startsWith('#') || raw.startsWith('data:') ||
            raw.startsWith('javascript:') || raw.startsWith('mailto:') ||
            raw.startsWith('http://') || raw.startsWith('https://') ||
            /\b:\/\//.test(raw)) continue;

        let absPath;
        if (raw.startsWith('/')) {
          absPath = raw;
        } else {
          const baseDir = relPath.replace(/\/[^/]*$/, '/');
          absPath = (baseDir + raw).replace(/\/\.\//g, '/');
          const parts = absPath.split('/').filter(Boolean);
          const resolved = [];
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

      const tasks = [...new Set(links)]
          .filter(l => !fetched.has(l))
          .map(l => this._crawl(baseUrl + l, l, baseUrl, fetched, dlSem, onProgress));
      await Promise.all(tasks);
    } catch (_) {} finally {
      if (!released) release();
    }
  }

  _parseUrl(rawUrl) {
    const m = rawUrl.match(/^web3:\/\/(0x[a-fA-F0-9]+)(?::(\d+))?(\/.*)?$/);
    if (!m) throw new Error(`无法解析: ${rawUrl}`);
    return { contract: m[1], esChainId: parseInt(m[2] || '1') };
  }

  async _verifyFile(content, contract, relPath, testCase) {
    if (content.length === 0) return { match: false, detail: '空文件' };

    const storedName = (() => {
      if ((relPath === '/' || relPath === '/index.html') && testCase?.rootFile)
        return testCase.rootFile;
      return relPath.startsWith('/') ? relPath.slice(1) : relPath;
    })();

    const hexName = ethers.hexlify(ethers.toUtf8Bytes(storedName));
    const countRs = await this._proverCall(contract,
        this.erc5018.encodeFunctionData('countChunks', [hexName]));
    let chunkCount = 0;
    if (countRs.result && countRs.result !== '0x') {
      try { chunkCount = Number(ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], countRs.result)[0]); } catch (_) {}
    }
    if (chunkCount === 0) return { match: false, detail: '无chunk记录' };

    const chunkIds = [...Array(chunkCount).keys()];
    const batchRs = await this._proverCall(contract,
        this.erc5018.encodeFunctionData('getChunkHashesBatch', [[{ name: hexName, chunkIds }]]));
    let contractHashes = [];
    if (batchRs.result && batchRs.result !== '0x') {
      try { contractHashes = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32[]'], batchRs.result)[0]; } catch (_) {}
    }

    // 清理 Gateway 注入的脚本后再计算 hash
    const cleanedContent = this._stripGatewayInjection(content, relPath);
    let localHashes;
    try { localHashes = (await computeEthStorageHashes(cleanedContent)).hashes; }
    catch (err) { return { match: false, detail: `KZG错误: ${err.message.slice(0, 60)}` }; }

    for (let i = 0; i < localHashes.length; i++) {
      if (localHashes[i].toLowerCase() !== (contractHashes[i] || '').toLowerCase())
        return { match: false, detail: 'hash不匹配' };
    }
    return { match: true, detail: 'OK' };
  }

  async _proverCall(contract, calldata, maxRetries = 3) {
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
        } catch (err) {
          const errorMsg = err.message?.slice(0, 120);
          // 如果是内存访问错误或网络错误，重试
          if (retry < maxRetries - 1 && 
              (errorMsg.includes('memory access') || 
               errorMsg.includes('timeout') || 
               errorMsg.includes('network') ||
               errorMsg.includes('connection'))) {
            await sleep(200 * Math.pow(2, retry));  // 指数退避: 200ms, 400ms, 800ms
            continue;
          }
          return { result: null, error: errorMsg };
        }
      }
      
      return { result: null, error: 'max retries exceeded' };
    } finally { 
      console.warn = _w; 
    }
  }

  // 直接调用合约获取文件内容（利用 fallback 机制）
  async _fetchFileDirectly(contract, fileName) {
    try {
      // 先尝试直接使用文件名作为 calldata
      const calldata = ethers.hexlify(ethers.toUtf8Bytes(fileName));
      const result = await this.esProvider.send('eth_call', [{ to: contract, data: calldata }, 'latest']);
      if (result === '0x' || result.length <= 2) {
        console.log('    ❌ 合约返回空内容');
        return null;
      }

      // 解析返回的文件内容
      const cleanHex = result.startsWith('0x') ? result.slice(2) : result;
      const fullBuffer = Buffer.from(cleanHex, 'hex');
      // 返回 Buffer，去掉前 64 字节（返回值前缀）
      if (fullBuffer.length > 64) {
        return fullBuffer.subarray(64);
      }
      return fullBuffer;
    } catch (err) {
      console.log(`    ❌ 从合约获取失败: ${err.message.slice(0, 80)}`);
      return null;
    }
  }

  // 剥离 Gateway 注入的 web3url 转换脚本
  _stripGatewayInjection(content, relPath) {
    const isHtml = relPath.endsWith('/') || relPath.endsWith('.html') || relPath === '/';
    if (!isHtml) return content;

    const str = content.toString('utf-8');

    // 使用正则表达式查找 </head> 和 <body> 之间可能有空白字符的情况
    const headBodyMatch = str.match(/<\/head>\s*<body>/i);
    if (!headBodyMatch) return content;

    const headBodyMarker = headBodyMatch[0];
    const afterHeadBodyIdx = str.indexOf(headBodyMarker) + headBodyMarker.length;

    // 查找 body 开始后第一个 script 标签（非自闭合）
    const scriptRegex = /<script([^>]*)>(.*?)<\/script>/is;
    scriptRegex.lastIndex = afterHeadBodyIdx;
    const scriptMatch = scriptRegex.exec(str);

    if (scriptMatch) {
      const fullScriptTag = scriptMatch[0];
      const scriptContent = scriptMatch[2];
      
      // 检查这个 script 是否是 Gateway 注入的
      if (scriptContent.includes('web3url') ||
          scriptContent.includes('Patch by web3url-gateway')) {
        // 移除这个注入的脚本
        const stripped = str.slice(0, afterHeadBodyIdx) + str.slice(afterHeadBodyIdx + fullScriptTag.length);
        return Buffer.from(stripped, 'utf-8');
      }
    }

    return content;
  }

  // 对比两个内容，找出差异
  _diffContent(gatewayContent, contractContent) {
    const gatewayStr = gatewayContent.toString('utf-8');
    const contractStr = contractContent.toString('utf-8');
    
    // 找第一个差异位置
    const minLen = Math.min(gatewayStr.length, contractStr.length);
    let startIdx = -1;
    for (let i = 0; i < minLen; i++) {
      if (gatewayStr[i] !== contractStr[i]) {
        startIdx = i;
        break;
      }
    }

    let gateEnd = gatewayStr.length - 1;
    let contEnd = contractStr.length - 1;
    while (gateEnd >= startIdx && contEnd >= startIdx) {
      if (gatewayStr[gateEnd] !== contractStr[contEnd]) {
        break;
      }
      gateEnd--;
      contEnd--;
    }

    const rawInjection = gatewayStr.slice(startIdx, gateEnd + 1);
    // 4. 压缩：去掉换行符、回车符，并将连续的多个空格合并为一个空格
    const compressedInjection = rawInjection.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    // 5. 精简打印：只保留开头 20 字和结尾 20 字
    const showLen = 40;
    console.log(`  📍 检测到 Gateway 注入内容 (原始总长: ${rawInjection.length} 字节):`);
    if (compressedInjection.length <= showLen * 2) {
      console.log(`  注入内容: ${compressedInjection}`);
    } else {
      const head = compressedInjection.slice(0, showLen);
      const tail = compressedInjection.slice(-showLen);
      console.log(`  注入内容: ${head} ... ${tail}`);
    }
  }

  _printReport(name, contract, results, tDownload, tVerify) {
    const passed = results.filter(r => r.match);
    const failed = results.filter(r => !r.match);
    const totalSize = results.reduce((s, r) => s + (r.size || 0), 0);

    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  ${name}  合约: ${contract}`);
    console.log('──────────────────────────────────────────────');
    console.log(`  文件: ${results.length} | ✅${passed.length} ❌${failed.length} | ${(totalSize/1024).toFixed(1)}KB`);
    console.log(`  下载: ${(tDownload/1000).toFixed(1)}s | 验证: ${(tVerify/1000).toFixed(1)}s`);

    const groups = new Map();
    for (const r of results) {
      const parts = r.path.split('/').filter(Boolean);
      const key = parts.length > 1 ? `/${parts[0]}/` : (parts.length === 1 ? `/${parts[0]}` : '/');
      if (!groups.has(key)) groups.set(key, { count: 0, size: 0, ok: 0, fail: 0 });
      const g = groups.get(key);
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
      const reasons = {};
      for (const f of failed) { const k = f.detail; reasons[k] = (reasons[k] || 0) + 1; }
      console.log(`  失败: ${Object.entries(reasons).map(([k,v]) => `${v}x ${k}`).join(', ')}`);
      console.log(`  样本: ${failed.slice(0,5).map(f => f.path).join(', ')}`);
    }
    console.log('══════════════════════════════════════════════\n');
  }
}
