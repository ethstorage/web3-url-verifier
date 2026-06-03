import config from './config.js';
import { Web3URLVerifier } from './web3url_verifier.js';

async function main() {
  for (const testCase of config.TEST_CASES) {
    const chainId = testCase.chainId || 1;
    const netConfig = config.NETWORKS[chainId];

    if (!netConfig) {
      console.error(`未知链配置: ${chainId}，跳过 ${testCase.name}`);
      continue;
    }

    const verifier = new Web3URLVerifier(chainId, netConfig);
    console.log(`\n🔷 ${testCase.name} (eth_chain=${chainId})`);
    console.log(`   URL: ${testCase.web3Url}`);

    try {
      await verifier.verify(testCase.web3Url, testCase);
    } catch (err) {
      console.error(`💥 ${testCase.name} 失败: ${err}`);
    }
  }
  console.log('\n🎉 完成');
}

main().catch(err => { console.error(err); process.exit(1); });