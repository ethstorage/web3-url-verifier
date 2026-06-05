export interface NetworkConfig {
  elRpc: string;
  esRpc: string;
  colibriProver: string;
}

export interface TestCase {
  name: string;
  web3Url: string;
  chainId: number;
  /** 'manual' = FlatDirectory/EthStorage, 'auto' = contract method call */
  resolveMode: 'manual' | 'auto';
  rootFile?: string;
}

export interface Config {
  NETWORKS: Record<number, NetworkConfig>;
  TEST_CASES: TestCase[];
}

const config: Config = {
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
      resolveMode: 'manual',
      rootFile: 'index.html',
    },
    {
      name: 'safe',
      web3Url: 'web3://0x90A5629c3D7EbC48Be3012210a1b1c229432884a:3333/',
      chainId: 11155111,
      resolveMode: 'manual',
      rootFile: 'index.html',
    },
    {
      name: 'vblog',
      web3Url: 'web3://0xc96dfda0171acdd1f176c7856fce01be690ea100:3333/',
      chainId: 11155111,
      resolveMode: 'manual',
      rootFile: 'index.html',
    },
    {
      name: 'vblog - backpack',
      web3Url: 'web3://0xc96dfda0171acdd1f176c7856fce01be690ea100:3333/general/2022/06/20/backpack.html',
      chainId: 11155111,
      resolveMode: 'manual',
      rootFile: 'index.html',
    },
    {
      name: 'vblog - blobs',
      web3Url: 'web3://0xc96dfda0171acdd1f176c7856fce01be690ea100:3333/general/2024/03/28/blobs.html',
      chainId: 11155111,
      resolveMode: 'manual',
      rootFile: 'index.html',
    },
    {
      name: 'NFT render',
      web3Url: 'web3://0x79a7aa92314fda49262649c6aef543fb0a652243:1/render/78/0',
      chainId: 1,
      resolveMode: 'auto',
    },
  ],
};

export default config;
