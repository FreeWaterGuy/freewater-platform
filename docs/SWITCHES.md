# Launch, lock and unlock: every switch

This is the one place that lists everything you can turn on or off, who can do it, how long it takes, and how to turn
it off again. Read it before going live, and keep it open the first time you flip anything that involves money.

**The rules behind every switch**

- **Anything that moves money, touches the blockchain, or can't be undone starts switched off.** Nothing turns
  itself on.
- **Turning something off is always quick.** Turning it on is the slow, careful direction.
- **Only a person signed in can flip a money or one-way switch.** That covers money, offers, the blockchain, launch,
  giving, the giving promise, the AI agents' fund, minimum age, the prize game, data rules, security and which AI.
  A service key (the kind a machine or a script uses) can't, and neither can it approve an AI agent's proposal,
  fund a reserve, correct an entry, or record anything on the team page.
- **Minimum age, the AI agents' fund and (once live) the blockchain's approval rules only ever go up.**
- **Steps that can't be undone need people to approve them, then a wait.** Going live with the token, turning points
  into tokens, gift cards and withdrawals each need at least 2 other owners or finance people who were already on the
  team when the step was proposed. Then there's a wait of at least 24 hours (48 by default), so a mistake or a stolen
  login can be caught. Approvals expire after two weeks.
- **Approvers count from when they got the role.** Only people who already held the owner or finance role when a
  step was proposed (and still hold it) can approve it. Finance people can propose, approve and press pause; running a
  step, cancelling it and going live with points stay with owners.
- **New companies always start safe.** A new licensee starts in testing with every money, blockchain, offer and AI
  fund switch off, whatever FreeWater's own switches are.
- **Machines have a print limit** (6 a minute and 1,500 a day by default; *Machines* settings), so a stolen machine key
  can't bill advertisers at scale. Revoke a lost machine's key at once.
- **The safety limits never come off.** The pause switch, the daily check of the books, the approval rules and the
  points cap can be made stricter, never weaker, while things are live.

Where things are: the **console** is at `/console` (sign in as an owner). Most switches live under
**Points and rewards** in its menu: *Launch*, *Points and credit*, *Brand offers*, *The games*, *Blockchain*. Keys
for outside companies live in the host's settings (the environment), never in the code or the console; see
`docs/RUNNING.md` for the full list.

> **Today FreeWater has one owner.** Going live with points needs only you. Every step involving the real token
> (and gift cards, and withdrawals) needs 2 *other* owners or finance people. Invite them under **Team** before you
> need them: only people who were on the team *before* a step was proposed can approve it.

---

## 1. The three stages

You go through them in order and never back.

| Stage | What it means | How you get there | Can it be undone? |
|---|---|---|---|
| **Testing** (where every company starts) | Everything works, but points are marked as test points. You can run bots and wipe everything. | Automatic. | — |
| **Live with points** | Real people earn placeholder points, rewards and offers. No more resetting. | *Launch → Propose going live*. Only you (an owner, signed in). It can run **24 hours** after you propose it. Test data is wiped as it goes live. | **No.** |
| **Live with the token** | Points can become the FreeWater token on Solana, held in FreeWater's custody. | *Launch → Propose going live with the token*. **2 other people approve**, then the wait (48 hours by default). This also switches the blockchain on. | **No.** |

To run an approved step: open *Launch* (or *Blockchain*), find it under **Waiting**, and press **Run it now** once the
wait is over. Anyone on the team can cancel a step before it runs.

### In testing

- **Run bots:** *Launch → Test with bots*. Choose how many (up to 200) and how many screens each (up to 60). Bots
  play like people, scan bottles for points and send feedback. They're always marked as bots, and they never bill an
  advertiser or count toward giving.
- **Wipe all test data:** *Launch → Reset*. Type `RESET` and press the button. It wipes every wallet, game answer,
  offer claim, hourly seal, test blockchain entry and every bot. It keeps settings, products, offers, money a brand
  really sent into its reserve, and any pause. Must be done by a person signed in. Only possible in testing.
- **Try the blockchain safely:** with the Solana test-network keys set (`SOLANA_DEVNET_*`), minting in testing uses
  Solana's free test network: a real chain, with play money. Without them, a stand-in runs and says so.

---

## 2. Money switches

| Switch | Off means | Turn on | Turn off | Where |
|---|---|---|---|---|
| **Dollar credit** | No one can be paid credit. | An owner, signed in. | Same, any time. | *Points and credit → Money switches* |
| **Brand offers** | Offers can be drafted, but none go live and nothing pays out. | An owner, signed in. Each offer still needs your approval. | Same, any time. Approved claims wait, unpaid, until it's back on. | *Points and credit → Money switches*; approve offers in *Brand offers* |
| **Gift cards** (spending credit on gift cards) | Credit can't be spent. | *Launch → Propose turning on gift cards*: 2 other people approve, then the wait. Only after going live. | *Points and credit → Money switches → Gift cards*, any time. Turning on again needs new approvals. | |
| **Withdrawals** (people moving tokens to their own wallets) | Tokens stay in custody. | *Launch → Propose turning on withdrawals*: approvals and the wait, after going live with the token. | *Launch → Turn withdrawals off*, any time. | |
| **Points into tokens** (a one-time conversion) | — | *Launch → Propose the conversion*, with the rate (1,000,000 units = 1 token): approvals, the wait, then signing in Squads. One at a time. | Cancel it before it runs. Once signed and recorded, it's done. | |

**Brand reserves:** credit is never paid from thin air. When a brand's money has really arrived, record it under
*Points and credit → Brand reserves*. Credit and offer payouts come only from that reserve, never more than it holds.

**Points settings** (*Points and credit*): what each action earns, the daily limit per person, and what points are
called. Points are the same whichever item someone picks. The cap (500 million) can never change.

---

## 3. The blockchain

| Control | What it does | Who, how |
|---|---|---|
| **Switch on** | Hourly seals go to the chain as well as GitHub; token steps can run. | Happens with *going live with the token*, or *Blockchain → Propose switching the chain on* (approvals and the wait). |
| **Switch off** | Nothing touches a blockchain; seals go to GitHub only. | *Blockchain → Switch the chain off now*. Immediate. |
| **Pause** | Stops every token action at once (minting, conversions, withdrawals). Recorded on the chain. | *Blockchain → Pause now*. **Any one person, immediately, no wait.** It also pauses itself if the daily check finds the books and the chain disagree. |
| **Unpause** | Lets token actions run again. | *Blockchain → Propose unpausing*: approvals and the wait. |
| **Mint** | Makes new tokens into custody. | Proposed, approved, waited, then **signed by the key holders in Squads**. The server can never mint on the real network by itself. Not allowed while live with points (only in testing or with the token). |

**Signing in Squads (the real network):** when an approved mint or conversion runs, its status becomes *signing* and
the console shows **Copy transaction**. The key holders import it into Squads and sign it there. Then paste the
transaction's signature back into the console and press **Check and record**. It is checked on Solana (our note on
the transaction, the exact amount, into custody, by the vault) before the books change. A step waiting for
signatures can't be cancelled for a week (reject it in Squads instead).

**The daily check** compares the token count in the books with the token count on the chain. If they differ,
everything pauses and the team is alerted. See *Blockchain → Last daily check*.

**Hourly seals:** every hour of the wallet books gets one fingerprint, including the hour before, published to
GitHub (and the chain when it's on). Anyone can check their own entry at
`/v1/public/wallet/<company>/proof/<entry id>`. *Blockchain → Seals intact* rebuilds them all from the books.

---

## 4. Everything else you can switch

| Switch | Default | Where | Notes |
|---|---|---|---|
| **The games** | On (in testing) | *The games → On or off* | Off: the Play page says so and nothing is asked or kept. Nothing else on bottles changes. |
| **Picks that may come true** | None | *The games → Picks that may come true* | Tick a category, and its screens say so. *Make the winner come true* needs at least 20 views of the winner, real people only. |
| **Prize game** | Off | *Prize game* | |
| **AI agents' fund** | Off | *AI agents* | Once on, its share can only go up. The governor runs either way. |
| **Giving** | Per company | *Giving* | With the giving promise on, it can be raised, never lowered. |
| **Data and privacy** | US preset | *Data and privacy* | A company can be stricter than the law where each person is, never looser. Unknown location means the strictest rules. |
| **How much each person shares** | Asked once | The app (*Wallet*, then *Me*) | Full, medium or lite, chosen by each person. Only full earns points, once, where paying for data is allowed. Each level is the person's own yes or no; their law still applies on top. |
| **Which AI** | The network's | *AI agents → Which AI* | The network's AI, your own (key in host settings as `AI_KEY_<ID>`), or none. Nothing stops working either way. |
| **Archive our agents** | — | *AI agents → Continuity* | Only if the company is closing or leaving. A person signed in types ARCHIVE. Can't be undone: the archive is kept for good. |
| **Minimum age** | 13 (higher where the law says) | settings (`minimumAge`) | Can only go up (13 to 21). |
| **Transparency** | Per company | *Transparency* | |
| **Owners' second sign-in step** | Off | *Security* | Recommended on before going live. |
| **API keys** | — | *API keys* | Turn off a key at once if it might be lost. |

Every settings change is saved as a version. *History* shows who changed what, and can put an earlier version back
(a version that changes money or blockchain settings must be put back by a person, and passes the same checks).

---

## 5. If something goes wrong

1. **Something odd with tokens?** *Blockchain → Pause now*. One person, immediate.
2. **Offers or credit paying out wrongly?** *Points and credit → Money switches*: turn off **Brand offers** and/or
   **Dollar credit**. Payouts stop at once; approved claims wait.
3. **A login or key may be stolen?** *API keys*: turn off the key. *Team*: remove the person. Cancel anything under
   *Launch → Waiting* or *Blockchain → Approvals* that you didn't expect (the wait is there for exactly this).
4. **A wrong points or credit entry?** It's fixed with a correcting entry, never an edit (`POST /v1/wallet/correct`).
   The books keep both.
5. **Withdrawals or gift cards?** Turn them off (section 2). Turning them on again needs fresh approvals.

---

## 6. Keys for outside companies (in the host's settings)

Each switches from a stand-in to the real company once its key is set. No code changes. The full list is in
`docs/RUNNING.md`.

| What | Settings | Without them |
|---|---|---|
| Solana test network | `SOLANA_DEVNET_MINT`, `SOLANA_DEVNET_PAYER`, `SOLANA_DEVNET_MINT_AUTHORITY` | A stand-in chain |
| Solana real network | `SOLANA_MINT`, `SOLANA_PAYER`, `SOLANA_CUSTODY` (the Squads vault), `SOLANA_RPC_URL`, `SOLANA_TOKEN_PROGRAM` | Token steps can't run |
| Gift cards (Tremendous) | `TREMENDOUS_API_KEY`, `TREMENDOUS_FUNDING_SOURCE`, `TREMENDOUS_SANDBOX` | A stand-in; its cards say TEST |
| Reading receipts (Veryfi) | `VERYFI_CLIENT_ID`, `VERYFI_USERNAME`, `VERYFI_API_KEY` | Your team checks each receipt by eye |
| Where visitors are | `GEOIP_DB` (MaxMind file) or `TRUST_GEO_HEADERS=1` behind Cloudflare | Everyone gets the strictest rules |
| Sanctioned countries | `SANCTIONED_COUNTRIES` | Cuba, Iran, North Korea, Syria |
| Product photos for the games | `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` (generic items) | Wikipedia and Open Food Facts still work; generic items show name cards |

Never send a key by email or chat. A minting key for the real Solana network is refused: minting there is signed
only in Squads.
