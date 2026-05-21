import config from './config.mjs';
import { Web3URLVerifier } from './src/web3url_verifier.mjs';

async function main() {
  const enabledCases = config.TEST_CASES?.filter(c => c.enabled !== false) || [];

  const verifier = new Web3URLVerifier();
  for (const testCase of enabledCases) {
    console.log(`\n\n🔷 测试用例: ${testCase.name}`);
    try {
      await verifier.verifyUrl(testCase.web3Url, { maxDepth: 2, testCase });
    } catch (err) {
      console.error(`\n💥 测试失败: ${err.message}`);
    }
  }
  console.log('\n\n🎉 所有测试完成');
  process.exit(0);
}

main().catch(err => {
  console.error(`\n💥 致命错误: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
