export default {
  NETWORKS: {
    1: {
      elRpc: 'http://88.99.30.186:8545',
      esRpc: 'https://rpc.mainnet.ethstorage.io:9545',
      colibriProver: 'https://mainnet.colibri-proof.tech',
    },
    11155111: {
      elRpc: 'http://65.108.230.142:8545',
      esRpc: 'http://65.108.230.142:9546',
      colibriProver: 'https://sepolia.colibri-proof.tech',
    },
  },
  TEST_CASES: [
    {
      name: 'Mainnet EthStorage',
      web3Url: 'web3://0x1e9796FA683cBDaA29B5fD5267FebED6D4b9124b:333/',
      chainId: 1,
      rootFile: 'index.html',
    },
    {
      name: 'safe',
      web3Url: 'web3://0x90A5629c3D7EbC48Be3012210a1b1c229432884a:3333/',
      chainId: 11155111,
      rootFile: 'index.html',
    },
    {
      name: 'vblog',
      web3Url: 'web3://0xc96dfda0171acdd1f176c7856fce01be690ea100:3333/',
      chainId: 11155111,
      rootFile: 'index.html',
    }
  ]
};
