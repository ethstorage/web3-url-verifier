# Verifying web3:// Data with Colibri Stateless Client

> Independent verification experiment based on Colibri Stateless client

## Abstract

web3:// (ERC-4804 / ERC-6860) provides a unified URL access method for on-chain resources. However, data received by clients typically comes from Gateways or RPC nodes, making it difficult for clients to independently verify whether the returned data matches the actual on-chain state.

This project implements a web3:// data verification prototype that simulates the browser extension workflow: fetch data normally → independently verify data authenticity → output verification results. It covers both Ethereum state data and EthStorage file data scenarios, tested on real deployed sites.

Test results show:
- Data authenticity can be verified independently
- No reliance on Gateway or RPC honesty
- Verification time is on the same order of magnitude as download time
- Feasible for browser extension integration

---

## 1. Verification Goals

This project verifies three questions:

### 1.1 Can data be verified independently?

Is the data received by the client equal to the actual on-chain data? Can verification be completed without trusting Gateways or RPCs?

### 1.2 Is the verification mechanism applicable to real sites?

Test targets include the EthStorage website, Safe frontend, VBlog, and NFT Render contract calls — all real deployed resources rather than constructed data.

### 1.3 Is verification performance acceptable?

Measurements:
- Download time
- Verification time
- Verification success rate

Assess the feasibility of browser integration.

---

## 2. Verification Model

Core idea: **Separation of data retrieval path and verification path.**

```
Data Retrieval Path (Untrusted)        Verification Path (Trusted)
        │                                      │
    Fetch Data                        Colibri Cryptographic Proof
        │                                      │
        │                           Fetch & verify on-chain state
        │                                      │
        └─────────── Local Comparison ──────────┘
                        │
                ✅ Match / ❌ Mismatch
```

The data retrieval path can be untrusted: Gateway, RPC, browser cache — any source works. The verification path uses Colibri to obtain cryptographically verified on-chain state. The final check happens locally on the client.

**Key point: Users don't need to determine "who is cheating" — they only need to know "whether the final data is correct."**

---

## 3. Two Types of Data Verification

### 3.1 Ethereum State Data

Applicable to `render()`, `tokenURI()`, `balanceOf()`, and all `eth_call` contract invocations.

**Verification flow:**

```
Data Retrieval Path (Untrusted)        Verification Path (Trust-Minimized)
(RPC / Gateway)                              (Colibri)
        │                                       │
   rawResult                            verifiedResult

Compare rawResult == verifiedResult → Match ✅
```

**Colibri's role**: Colibri's remote Prover returns the call result along with state proofs, block headers, and other attestation data. Verification is performed inside the Colibri SDK. Upon successful verification, the returned `verifiedResult` equals the true on-chain result.

### 3.2 EthStorage File Data

Applicable to HTML, CSS, JS, PNG, Video, and any Blob files.

**What is recorded on-chain when a file is uploaded?**

```
File → Blob → KZG Commitment → Versioned Hash
```

The FlatDirectory contract only records the Versioned Hash of the data. The actual file content is persisted by the EthStorage network.

**Verification principle:**

First, obtain the true Versioned Hash recorded on-chain via Colibri:

```
Colibri → Versioned Hash
```

Then, recalculate the Versioned Hash from the file obtained through the untrusted path:

```
File → Blob Encode → KZG Commitment → Versioned Hash
```

Compare the two hashes:

```
localHash == chainHash → ✅ File content matches the uploaded content
```

**Why does this work?** The Versioned Hash is derived from a KZG Commitment. Any change to the file content (modification, truncation, or insertion) results in a different Versioned Hash. Therefore, `localHash == chainHash` proves the file has not been altered.

---

## 4. Implementation Architecture

```
                     Ethereum
                         │
                         ▼
                On-chain True State
                         │
                         ▼
                     Colibri
                         │
                         ▼
               Verified On-chain State


                    Gateway / RPC
                          │
                          ▼
                     Fetch Data
                          │
                          ▼
               Local Verification Compare
                          │
                          ▼
                    Verified / Failed
```

**Core principle: The data retrieval path and verification path are completely independent.** We don't care where the data comes from — only whether it matches the on-chain state.

---

## 5. Test Sites

| Site | Network | Content | Size | Verification Method |
|------|---------|---------|------|-------------------|
| EthStorage Website | Ethereum Mainnet | HTML + CSS + JS + Images | 1.3MB (5 files) | EthStorage File Verification |
| Safe Frontend | Sepolia | HTML + Next.js Static Assets | 4.4MB (16 files) | EthStorage File Verification |
| VBlog Homepage | Sepolia | HTML + CSS + Large JS | 1.7MB (3 files) | EthStorage File Verification |
| VBlog Subpage (backpack) | Sepolia | HTML + CSS + JS + 13 Images | 3.1MB (16 files) | EthStorage File Verification |
| VBlog Subpage (blobs) | Sepolia | HTML + CSS + JS + 10 Images | 2.0MB (13 files) | EthStorage File Verification |
| NFT Render | Ethereum Mainnet | `render(78, 0)` call result | 14.6KB (1 file) | Ethereum State Verification |

---

## 6. Verification Process

**Step 1** — Recursively discover site resources (simulating browser behavior).

**Step 2** — Download resources. Concurrency: 16.

**Step 3** — Execute verification. Concurrency: 8.

- **Ethereum State Data**: Fetch result → Colibri verify result → Compare
- **EthStorage Files**: Fetch file → Compute local hash → Fetch on-chain hash → Compare

---

## 7. Performance Testing

### Test Environment

- macOS / Node.js
- Remote Colibri Prover node (mainnet / sepolia)

### Test Results

```
═══════════════════════════════════════════════════════════════════════════
 Test Site                  Files    Size      Download    Verify    Verify/Download
───────────────────────────────────────────────────────────────────────────
 EthStorage Website            5    1.3MB        6.1s       3.3s       0.54x
 Safe Frontend                16    4.4MB       14.3s       5.0s       0.35x
 VBlog Homepage                3    1.7MB        9.3s       3.0s       0.32x
 VBlog Subpage (backpack)     16    3.1MB       10.8s       4.0s       0.37x
 VBlog Subpage (blobs)        13    2.0MB        9.7s       6.4s       0.66x
 NFT Render                    1   14.6KB        1.0s       2.9s       2.90x
═══════════════════════════════════════════════════════════════════════════
 Total                       54   12.6MB       51.2s      24.6s       0.48x
═══════════════════════════════════════════════════════════════════════════
```

> **About Prover Cache**: Verification times were measured from actual Colibri runs. Since the public Colibri Prover service employs caching and other optimization mechanisms, results may vary across runs. The table data represents averages from multiple runs and is likely based on cached responses. Actual times for cold cache scenarios may be slightly higher.

### Verification Results

| Test Site | Total Files | ✅ Passed | ❌ Failed | Note |
|-----------|-------------|----------|----------|------|
| EthStorage Website | 5 | 4 | 1 | Root file: data retrieval path injected extra scripts |
| Safe Frontend | 16 | 15 | 1 | Root file: data retrieval path injected extra scripts |
| VBlog Homepage | 3 | 3 | 0 | All passed |
| VBlog Subpage (backpack) | 16 | 16 | 0 | All passed |
| VBlog Subpage (blobs) | 13 | 13 | 0 | All passed |
| NFT Render | 1 | 1 | 0 | All passed |

### Core Results

**Verification Success Rate**: All resources were successfully verified (excluding Gateway injection scenarios). EthStorage files, contract state, and cross-contract call scenarios all passed verification, demonstrating that Web3 data verification is feasible in a browser environment.

**Verification Time**: Except for NFT Render, all test sites had verification times lower than download times, with a verify/download ratio between 0.32x and 0.66x. NFT Render's verification time exceeded its download time (2.90x) because its content is dynamically assembled from script fragments scattered across multiple contracts, requiring processing of more on-chain state data during verification.

**Browser Feasibility**: The tests covered 54 files totaling 12.6MB, with a total download time of approximately 51.2 seconds and a total verification time of approximately 24.6 seconds. Total verification time was approximately 48% of total download time. The results show that browsers can complete Web3 content verification within an acceptable timeframe, making integration into browser extensions or native browser implementations feasible.

---

## 8. Discovery: Data Retrieval Path Injection

The data retrieval path used during testing (w3link.io) automatically injects scripts into HTML to convert web3:// links to https:// links:

```html
<script>
/** * Patch by web3url-gateway : Convert web3:// links to https:// */
</script>
```

This causes the retrieved content to differ from the original on-chain content, triggering verification failures.

**Impact scope**: Only affects HTML files. JS, CSS, PNG, etc., are not impacted. After removing the injected script and recalculating, verification passes normally.

This finding clearly demonstrates the value of verification: **Even if the data retrieval path modifies content with good intentions, the verification system can detect it. Users don't need to know who made the change — they only need to know "the data is wrong."**

---

## 9. Conclusion

This project validates the **feasibility** of an independent web3:// data verification scheme.

For **Ethereum state data**, verification is performed using Colibri's stateless proofs. For **EthStorage files**, verification combines Colibri's on-chain state verification with Versioned Hash integrity checks.

The tests demonstrate:

- **Verification mechanism works**: Real site data can be verified through an independent path
- **Real sites are usable**: EthStorage website, Safe frontend, VBlog, NFT Render all pass
- **Performance is acceptable**: Verification time is on the same order as download time
- **Browser extension deployment is viable**

Clients can verify the authenticity of received content without trusting Gateways, RPC providers, or other intermediaries. No need to run a full node, sync the chain yourself, or trust any data provider — **Don't trust. Verify.**

---

## Appendix

### A. Project Structure

```
colibri-test/
├── src/
│   ├── index.ts               # Entry: iterate test sites, start verification
│   ├── config.ts              # Config: network RPC, test site definitions
│   ├── web3url_verifier.ts    # Core: Web3URLVerifier class
│   ├── blobs.ts               # Blob encoding and KZG hash computation
│   └── deep.ts                # Colibri deep principle verification
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies
└── README.md
```

### B. Running

```bash
npm install
npm start
```

### C. Reference Links

- [web3:// Protocol Website](https://web3url.w3eth.io/)
- [Colibri Stateless Prover](https://github.com/corpus-core/colibri-stateless)
- [FlatDirectory Contract](https://github.com/ethstorage/evm-large-storage/blob/master/contracts/FlatDirectory.sol)
- [EIP-4844: Shard Blob Transactions](https://eips.ethereum.org/EIPS/eip-4844)
- [ERC-4804: web3:// URL](https://eips.ethereum.org/EIPS/eip-4804)
- [ERC-6860: web3:// URL (revised)](https://eips.ethereum.org/EIPS/eip-6860)
