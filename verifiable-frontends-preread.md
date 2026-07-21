# Verifiable Frontends: Pre-read

*For the call with Fredrik and the Access Layer cluster. Full technical write-up: [verifiable-frontends.md](https://github.com/ethstorage/web3-url-verifier/blob/main/verifiable-frontends.md)*

---

## The problem

Users trust a dapp's contracts, but the frontend is served from a centralized host. A compromised frontend can drain funds no matter how secure the contracts are, and today users have no way to check that the page they loaded is the page the team deployed.

## Our approach

Serve frontends from on-chain storage, addressable via [`web3://`](https://eips.ethereum.org/EIPS/eip-4804) (ERC-4804), and let the user verify on the client side, using a light client, that the content they received is exactly the data stored on-chain.

Content is still fetched through a gateway today, since browsers can't read on-chain data natively. The point is that the gateway no longer has to be trusted: verification happens locally, so a compromised gateway is detectable.

Built on [Colibri](https://github.com/corpus-core/colibri-stateless), corpus-core's stateless light client. Two deployment models work today, both addressed through `web3://`:

| Storage | Live example |
|---|---|
| Ethereum-native (uploaded via calldata, stored in contract code, on L1 or an L2) | [vitalikblog.eth.1.w3link.io](https://vitalikblog.eth.1.w3link.io/) (Arbitrum Nova) |
| EthStorage + L1 | [eth-store.eth.1.web3gateway.dev](https://eth-store.eth.1.web3gateway.dev/) |

**Out of scope:** content that isn't addressable on-chain. Frontends on IPFS or traditional hosting (Vercel, Cloudflare) can't be verified this way, which today is most of them. Our current focus is making it easy for teams to deploy to on-chain storage rather than verifying arbitrarily hosted content.

## Where we are

A working PoC ([web3-url-verifier](https://github.com/ethstorage/web3-url-verifier)): a CLI that fetches content via `web3://`, verifies it against the on-chain data through Colibri, and reports whether it matches what was deployed. The verification path works end to end. Not yet packaged as an SDK or integrated into any extension or wallet.

Three stages from here, each removing more trust assumptions:

1. **Today.** Gateway fetch, user verifies locally with a separate tool.
2. **Next.** Verification inside the wallet the user already has, surfaced as a trust indicator, roughly the role SSL played for the web.
3. **Eventually.** Native browser support for `web3://` and verification, at which point no wallet integration is needed.

A dedicated extension isn't a viable end product at any stage; most users install as few extensions as possible.

---

## What we'd like to discuss

**1. Is this direction worth pursuing?** We'd love to hear how the cluster sees this problem and whether our approach fits the shape of it. Feedback on what we're missing, or where you'd push differently, would be very useful as we plan next steps.

**2. Does this sequence of next steps make sense?**

- **Package the PoC as an SDK** so wallets can integrate verification without reimplementing it.
- **Build a reference extension** on top of it. Not as the end product, but to surface the unknowns early, particularly whether an extension can reliably intercept and verify page content and what Chrome's constraints are. Solving that once makes wallet integration much cheaper later.
- **Resolve the Colibri licensing question.** We build on Colibri, so this matters to us directly. Happy to approach corpus-core to understand what agreement they require and whether terms can be relaxed for wallet integrators, and to coordinate with whoever on your side is already in touch with them.

**3. What's the most effective path to wallet adoption?**

- Is standardization the right path, say an ERC for verifiable frontend attestation, so multiple wallets can adopt a common interface rather than each doing something bespoke?
- Are there teams or people you'd suggest we talk to as we move toward wallet integration?
