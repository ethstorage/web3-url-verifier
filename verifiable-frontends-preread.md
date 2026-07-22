# Verifiable Frontends: Pre-read

*For the call with Fredrik and the Access Layer cluster. Full technical write-up: [verifiable-frontends.md](https://github.com/ethstorage/web3-url-verifier/blob/main/verifiable-frontends.md)*

---

## The problem

Users trust a dapp's contracts, but the frontend is served from a centralized host. If that frontend is compromised, it can drain funds no matter how secure the contracts are. And today, users have no way to check that the page they loaded is the page the team actually deployed.

## The idea

Serve the frontend from on-chain storage, addressable via [`web3://`](https://eips.ethereum.org/EIPS/eip-4804) (ERC-4804). On-chain, the frontend is controlled by the same keys as the dapp's contracts, so it inherits a trust root users already rely on. The user's client then verifies, using a light client, that the content it received is exactly that on-chain data.

Content is still fetched through a gateway today, since browsers can't read on-chain data natively. The point is that the gateway no longer has to be trusted. Verification happens locally, so a compromised gateway is detectable.

## It works today

We have a working PoC ([web3-url-verifier](https://github.com/ethstorage/web3-url-verifier)). It's a CLI that fetches content via `web3://`, verifies it against the on-chain data through [Colibri](https://github.com/corpus-core/colibri-stateless) (corpus-core's stateless light client), and reports whether it matches what was deployed. The verification path works end to end.

And it isn't tied to one storage backend. Two deployment models work today, both addressed through `web3://` and checked through the same verification path:

| Storage | Live example |
|---|---|
| Ethereum-native (uploaded via calldata, stored in contract code, on L1 or an L2) | [vitalikblog.eth.1.w3link.io](https://vitalikblog.eth.1.w3link.io/) (Arbitrum Nova) |
| EthStorage + L1 | [eth-store.eth.1.web3gateway.dev](https://eth-store.eth.1.web3gateway.dev/) |

The second model is worth a word of explanation. [EthStorage](https://ethstorage.io/) is a storage L2: it provides large, low-cost programmable storage, secured by Ethereum L1. This suits full frontends, where storing everything in Ethereum-native storage would be too expensive. A small commitment on L1 anchors the data, so it stays verifiable through the same light-client path.

**Scope.** Our focus is on-chain storage. IPFS-hosted frontends are a possible extension but low priority. Traditional hosting (Vercel, Cloudflare) is out of scope, since there's nothing on-chain to verify against.

## Where it's going

Three stages from here, each making verification easier to reach for a normal user:

1. **Today.** Gateway fetch, user verifies locally with a separate tool.
2. **Next.** Verification inside the wallet the user already has, surfaced as a trust indicator, roughly the role SSL played for the web.
3. **Eventually.** Native browser support for `web3://` and verification, at which point no wallet integration is needed.

---

## What we'd like to discuss

**1. Is this direction worth pursuing?** We'd love to hear how the cluster sees this problem, and whether our approach fits the shape of it. Any feedback on what we're missing, or where you'd push differently, would be very useful as we plan next steps.

**2. Does this sequence of next steps make sense?** To keep the burden on wallets minimal, we plan to do the following ourselves:

- **Package the PoC as an SDK** so a wallet can add verification without reimplementing it.
- **Build a reference extension** on top of the SDK, as a working example wallets can follow. Not an end product in itself, but a way to surface the unknowns early:

    - The main open question is whether Chrome's extension model lets us intercept the data returned for every request a page makes. A single site pulls many html/css/js resources, and each one has to be verified.
    - If that isn't allowed, the fallback is to have the extension separately fetch and verify all the data for the current URL. This is weaker, since it verifies a second copy rather than the exact bytes the user's browser received.
    - There may be further constraints we only find once we build, which is exactly why we want to do this early.
- **Resolve the Colibri licensing question.** The concern raised earlier is that integrating Colibri may require wallets to sign a separate license agreement. We build on Colibri, so this matters to us directly. We're happy to approach corpus-core to understand what agreement they require, and whether the terms can be relaxed for wallet integrators. We'd also gladly coordinate with whoever on your side is already in touch with them.

With this in place, a wallet's only job is to integrate the SDK, following the reference extension, and show the verification result to the user.

**3. What's the most effective path to wallet adoption?**

- Is standardization the right path? A standard for how verifiable frontends are declared and verified (an ERC, for example) would let multiple wallets adopt a common interface, rather than each building something bespoke.
- Are there teams or people you'd suggest we talk to as we move toward wallet integration?
