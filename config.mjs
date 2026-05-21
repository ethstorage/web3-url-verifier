export default {
  RPC_URL: 'http://88.99.30.186:8545',
  ES_RPC_URL: 'https://rpc.mainnet.ethstorage.io:9545',
  COLIBRI_PROVER: ['https://mainnet.colibri-proof.tech'],

  NUM_RUNS: 5,
  WARMUP_RUNS: 1,

  SUPPORTED_CHAINS: {
    1: { name: 'Ethereum Mainnet', colibriSupport: true, rpcUrl: 'http://88.99.30.186:8545' },
  },

  TEST_CASES: [
    {
      name: 'Art Blocks (Auto 模式)',
      enabled: true,
      web3Url: 'web3://0x79a7AA92314FDa49262649C6aef543FB0a652243/render/78/0',
    },
    {
      name: 'Mainnet EthStorage Manual 网站',
      enabled: true,
      web3Url: 'web3://0x1e9796FA683cBDaA29B5fD5267FebED6D4b9124b/',
      isEthStorage: true,
      chainId: 1,
      rootFile: 'index.html',
    },
  ],

  WEBSITE_CASES: [],
};
