# Verifiable Frontends: Pre-read

*For the call with Fredrik and the Access Layer cluster. Full technical write-up: [verifiable-frontends.md](https://github.com/ethstorage/web3-url-verifier/blob/main/verifiable-frontends.md)*

**Agenda**

1. Our approach, and where it stands today.
2. How it compares to WEBCAT.
3. If we want to take an active part in this, what would you suggest?

---

## The problem

Users trust a dapp's contracts. The frontend, though, is served from a centralized host.

If that frontend is compromised, it can drain funds — however secure the contracts are. And today, a user has no way to check that the page they loaded is the page the team actually deployed.

## The idea

Serve the frontend from on-chain storage, addressed via [`web3://`](https://eips.ethereum.org/EIPS/eip-4804) (ERC-4804).

On-chain, the frontend is controlled by the same keys as the dapp's contracts. So it inherits a trust root users already rely on. The client then uses a light client to verify that what it received is exactly that on-chain data.

Content still comes through a gateway today, since browsers can't read chain data natively. But the gateway no longer has to be trusted. Verification happens locally, so a compromised gateway shows up.

## It works today

**The verification path works end to end.** Our PoC ([web3-url-verifier](https://github.com/ethstorage/web3-url-verifier)) is a CLI. It fetches content via `web3://`, verifies it against the on-chain data through [Colibri](https://github.com/corpus-core/colibri-stateless), and reports whether it matches what was deployed. Colibri is corpus-core's stateless light client.

**It covers two deployment models.** Both are addressed through `web3://`, and both go through that same verification path.

| Storage | Live example |
|---|---|
| Ethereum-native (uploaded via calldata, stored in contract code, on L1 or an L2) | [vitalikblog.eth.1.w3link.io](https://vitalikblog.eth.1.w3link.io/) (Arbitrum Nova) |
| EthStorage + L1 | [eth-store.eth.1.web3gateway.dev](https://eth-store.eth.1.web3gateway.dev/) |

The second one needs a word of explanation. [EthStorage](https://ethstorage.io/) is a storage L2: large, low-cost programmable storage, secured by Ethereum L1. That suits full frontends, where keeping everything in Ethereum-native storage gets expensive. A small commitment on L1 anchors the data, so the same light-client path still verifies it.

Beyond these two, IPFS-hosted frontends are a possible extension, but low priority. Traditional hosting like Vercel or Cloudflare is out of scope — there's nothing on-chain to verify against.

**Getting this into a browser is where we are now.** We built a capture-only Chrome extension ([web3-verifier-extension](https://github.com/ethstorage/web3-verifier-extension)) to settle the biggest unknown first: can an extension see the data returned for *every* request a page makes? A single site pulls many html/css/js resources, and each one has to be verified.

It can. The Chrome DevTools Protocol (`chrome.debugger`) gives us every response body.

The cost is the `debugger` permission, and the "extension is debugging this browser" banner that comes with it. That banner only appears on gateway URLs, while capture is running.

Verification isn't wired into the extension yet. That's the next step.

**Where this ends up** is verification the user never has to think about. First inside the wallet they already have, shown as a trust indicator — roughly the role SSL played for the web. That's why a shared standard for wallets matters. Eventually, native browser support for `web3://` would remove the need for wallet integration at all.

## On WEBCAT

We saw the [1TS grant to the Freedom of the Press Foundation](https://blog.ethereum.org/2026/08/05/1ts-grant) for WEBCAT last week, and spent some time going through the architecture. It's good news for this problem generally.

Two observations.

**The two designs are closer than they look.** WEBCAT's extension already runs a light client. It verifies CometBFT consensus signatures, then a Merkle proof of state against the `AppHash` in the block header. Then it checks each asset's hash against a signed manifest.

That's very close in shape to what we do with Colibri against Ethereum. The difference is how much has to be built underneath it — because Ethereum already provides what WEBCAT had to construct.

| | WEBCAT | Ours |
|---|---|---|
| The registry behind the name | a purpose-built permissioned chain, updated by oracles that fetch `enrollment.json` over DNS/HTTPS | ENS — already a registry on Ethereum, nothing to build |
| Who may publish | signers + threshold declared in `enrollment.json` | the content contract's own access control — its owner / multisig |
| How the client checks it | light client on that chain | light client on Ethereum (Colibri) |
| Where the content lives | the site's own server | on-chain (Ethereum-native or EthStorage) |
| What it protects | integrity | integrity, plus availability |

**We read this as a specialization, not an alternative.** WEBCAT has to serve any website, including ones whose only identity is a DNS name. A DNS name carries nothing on-chain. So a whole registry has to be built around it: `enrollment.json` on the server, an oracle set watching it over HTTPS, and a permissioned chain to hold the result.

It needs a manifest too, because the content sits off-chain and has to be committed to.

Our case is simpler. An ENS name resolves straight to the contract that holds the frontend, and that same contract controls who may update it.

So both layers collapse. *Who may publish* is answered by the contract's own access control. *What was published* is the contract's state, not a commitment to something stored elsewhere. Nothing to stand up, no oracle or validator set to keep honest, no signer list to declare.

One more difference: availability. WEBCAT's content still sits on one origin server. Integrity survives a compromise, but the site can still be taken down. On-chain content can be served by anyone, and every gateway verifies identically.

**→ Does that read right to you? We've only had a week with their design.**

---

## What we'd like to discuss

**If we want to take an active part in this, what would you suggest?** Two follow-ups we're preparing, and we'd welcome your read on both.

**1. Taking part in the ERC discussion.** The grant includes "an ERC standard so wallet developers have a standard to follow." We'd like to be part of that while it's being drafted. An introduction to whoever is leading it would help.

What we'd like to see is simple. The ERC shouldn't hard-code a single registry. A site should be able to declare where the client looks up who may publish it. For us that answer is ENS and the content contract, checked with an Ethereum light client.

That way frontend code stored on-chain fits inside the standard, instead of sitting outside it.

**→ Does that match how you see the ERC coming together? And who should we be talking to?**

**2. The Colibri licensing question.** The concern raised earlier is that integrating Colibri may require wallets to sign a separate [license agreement](https://github.com/corpus-core/colibri-stateless/blob/dev/README.md). We build on Colibri, so this matters to us directly.

We're happy to approach corpus-core ourselves — to find out what agreement they require, and whether the terms can be relaxed for wallet integrators.

**→ Is anyone on your side already in touch with them, or should we go ahead?**

**3. Anything else you'd suggest?** Those are the two we've thought of. You have a much better view of what's already moving here than we do.

**→ Is there work underway we should know about, or people we should be talking to? And if you'd push us somewhere different, we'd like to hear that too.**
