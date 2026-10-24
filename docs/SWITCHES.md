# Launch, lock and unlock: every switch

This is the one place that lists everything you can turn on or off, who can do it, how long it takes, and how to turn
it off again. Read it before going live, and keep it open the first time you flip anything that involves money.

**The rules behind every switch**

- **Anything that moves money, touches the blockchain, or can't be undone starts switched off.** Nothing turns
  itself on.
- **Turning something off is always quick.** Turning it on is the slow, careful direction.
- **Only a person signed in can flip a money or one-way switch.** That covers money, offers, the blockchain, launch,
  giving, the giving promise, the AI agents' fund, minimum age, the prize game, data rules, security, which AI and
  how advertisers pay.
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
  fund switch off, whatever FreeWater's own switches are, and with its advertisers paying up front, every fee off.
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

(On a pilot server, `FW_FEATURES=pilot`, only the first two exist: see section 6.)

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

### How advertisers pay

**We don't print anything until it's paid for.** Each company sets this under *Ads and prices → How advertisers pay*
(the `adBilling` setting). FreeWater and every new company start like this:

| Setting | FreeWater (and every new company) | What it means |
|---|---|---|
| **Paying up front** (`requirePrepay`) | On | An advertiser pays by card for a number of bottles before its ad is reviewed. Only paid bottles print. |
| **Pricing** (`pricingMode`) | Flat | One price per bottle for each size: whole label $1, ½ 65¢, ⅓ 51¢, ¼ 42¢, ⅙ 33¢, ⅛ 24¢, 1/10 20¢, times the product's price factor (the 25 oz bottle is 1.25×). AR, video and scans are included at every size. The auction is for companies that bill after (below). |
| **Fee per scan** (`fees.scan`) | Off (25¢ when on) | Each its own switch and price. When one is on it's charged to the advertiser's card **once a day**, automatically; there's no invoice to wait on. A declined card pauses that advertiser's ads at once (the same pause as credit, below); they start again once the card works and the ad is turned back on. |
| **Fee per AR launch** (`fees.arLaunch`) | Off (40¢ when on) | |
| **Fee per box side** (`fees.boxFace`) | Off (the box side price, 40¢) | Off: box sides with a paid ad are included. |
| **Commission on sales** (`fees.commission`) | Off (3% when on) | Off: sales are still tracked and shown, never charged. |
| **Fee for changing an ad** (`changeFeeCents`) | $100 | Paid up front when the change is submitted. The new ad is reviewed before it prints; the bottles not printed yet carry it once approved. The fee is the guard against changes every day. |
| **Fee for changing a link** (`linkChangeFeeCents`; switch *Change a link (fee)*) | $50, on (a money switch: off for a new company until a person turns it on) | Changing where a live ad's code leads, paid up front once per change (pressing twice pays once; a second, different change while one waits is refused before it's charged). **The old link stays live** (no pause in printing) while the new one is checked automatically (*Link safety*), looked at by the AI reviewer and approved by a person (or rejected by the AI where it has earned the final call; the advertiser can appeal once). The fee is kept if the change is rejected (a founder decision to confirm). Off, or before the ad is live: free. The campaign's own settings and its versions can't change a live paid ad's links while it's on. |
| **Costly extras** (`extras`) | AI video clip (Veo): $3 cost, 50% markup = $4.50 a clip | Cost plus the markup, paid up front with the bottles; the advertiser sees it in the quote. No paid clip left, no clip made. What each use really cost is recorded; if an ad's extras cost more than it paid, the team is told (it's never billed more). |

**The advertiser, step by step:** make the ad in the chat → the review page shows the exact total (bottles × price,
plus extras) → **Pay and submit** charges the card (a total that changed since it was shown charges nothing) → the
company reviews it → it prints until every paid bottle is out ("N of M bottles out"). There's **no end date and no
cancel button**: pausing only delays. A failed or abandoned print gives its bottle back.

**Bottles in delivery packs and at machines** each draw one paid bottle from every paid ad on them; a pack's bottles
are printed one by one, so a pack of 12 with a paid ad on 6 of its bottles draws 6. A bottle whose label comes out
wrong at the packing check is reprinted with exactly the same ads and draws nothing more: the bad one is voided (its
books lines reversed, no paid bottle used, nothing to give back), and the advertiser is billed once, for the bottle
that went out (`Platform.reprint`; a crash in the middle is finished at the next start).

**Review of a paid ad** (the founder: "if review rejects a paid ad, that will need to be discussed with the FreeWater
team to ensure that it was rejected for a valid reason"). The money is already taken, so:

| Who | Can | Can't |
|---|---|---|
| An AI, an automated check, anything with an API key | **Flag** it, with reasons (a *reject* it sends becomes a flag) | Reject it, refund it |
| The team, signed in | Write to the advertiser in the ad's notes; approve it; **finally reject** it with a written reason (kept, shown to the advertiser) | Stop it and pay it back while it's flagged (refused: decide first) |
| The advertiser | Read and answer the notes; change the ad and send it again **at no change fee** while it's flagged | — |
| An owner or finance person, second step | Pay it back once it was finally rejected (*Stopping an ad*, below) | — |

While it's flagged the money stays held and nothing prints. An ad not paid up front is reviewed as before. This rule
is part of *Ad review* on the Features page, which is locked on.

**Who reviews ads** (`adReview.whoReviews`, *Console → Team*; a setting only a person signed in changes, kept in the
settings history). *Owners and ops* (`owners_ops`, the default and FreeWater's choice) or *owners only* (`owners`).
Reviewers always review; an ops person is a person signed in, so "a person decides" holds either way. With ops on,
an ops person reaches only the review screens' routes (*Ops → Review*: ads and their notes and AI talk, changed links
and link holds, approving or stopping filler and charity pieces), never with a key, never the AI reviewer's settings
or record, and never a refund (an owner or finance person with the second step). Ads aimed at fewer than 50 houses
stay with owners and reviewers. *Ops → Review* is shown only to people who review (`GET /v1/me` → `reviewsAds`).
Filler and charity pieces are decided in their own queue, never in the ads queue.

**The AI reviewer** (*AI reviewer of paid ads*, AI category; docs/AI.md). It looks at every paid ad as it comes in and
passes it or flags it with its reasons; a flag is a flag like any other (above). On the review page a person can ask
it why and push back; the talk is kept with the ad, apart from the notes with the advertiser. Every final decision a
person makes on an ad it looked at is its **record** (*AI agents → AI reviewer of paid ads*): "agreed with your team
on 96 of the last 100", by reason, false flags and missed problems. It reads the ad's words and where its links and code go (the
path and query as words); **it never sees the pictures**, and says so on the review page, in its flags and its
record: a person checks the artwork.

**AI makes the final call on paid ads** (Ads → Review; an *autonomy* switch; off for every company, FreeWater too):

| Who | Can | Can't |
|---|---|---|
| An owner, signed in with the second step, with a reason | Turn it on, on the AI agents page, only when the record meets the bar (100 decisions and 95% agreeing unless set) and the reviewer's model passed the agents' test | Turn it on from the Features page or a starting point |
| Anyone on the team, signed in | Turn it off at once; raise the bar or the audit sample | Lower them |
| An owner with the second step and a reason | Lower the bar or the sample, never under 50 decisions, 90% agreeing or a 5% sample | — |
| The governor | Turn it off by itself when the record drops below the bar (logged as the governor's; the team is alerted) | Turn it on |
| The AI, any API key | — | Change the switch, the bar or the sample; overturn the AI or decide an appeal |

With it on: the AI's rejection of a freshly submitted paid ad is final, with its written reason. The advertiser can
always **appeal to a person** (once; not after it was paid back): it goes back to the queue, flagged. A random
**sample** of its rejections (10% unless set) goes to the queue to audit: confirm, or overturn (it goes live). An AI
pass still waits for a person. **The refund after a rejection is still a person's step** (*Stopping an ad*, below).
Off (or when what it needs is off): its rejections are flags again.

**In the books:** the payment is the advertiser's money held for them (`prepaid:advertiser:<id>`, a liability); each
printed bottle moves its price to earned (`revenue:print`); a change fee is earned when paid
(`revenue:change_fee`); an extra used moves its price to `revenue:extras`. The daily reconciliation checks every
prepaid ad's paid, printed and printing bottles against the bottles themselves and the books, and each advertiser's
prepaid balance against what's left to print. The database refuses a prepaid balance below nothing and more bottles
printed than paid.

**Stopping an ad (FreeWater, not the advertiser).** *Ads → the ad → Stop and pay back*
(`POST /v1/ads/campaigns/<id>/stop` with a reason). Only an owner or finance person, signed in with the second step,
never an API key. Nothing more prints; the bottles not printed (at the price paid) and extras not used go back to
the card, once, and the books record it. A route buy paid partly with credit gets back to the card at most what the
card paid; the rest comes back as credit (credit is never cashed out). While bottles with the ad are printing it
waits: pause the ad first. An ad with every paid bottle out can't be changed (the change fee is never taken for a
change that could never print).

**Changing these settings** is a money switch: a person signed in, with the second step. Paying up front needs flat
pricing; turning it off brings back billing after the fact, with credit (below).

**On the Features page** (*Money and payments → How advertisers pay*), each part is a switch for that company:
*Advertisers pay up front* (`prepaid_ads`), *Bill advertisers afterwards (credit)* (`billed_after`, the setting
`requirePrepay` turned off), *Bidding* (`bidding`, pricing `auction`; needs billing afterwards), and *Fee per scan*,
*Fee per AR launch*, *Fee per box side*, *Commission on sales* (each fee's `on`). The linked ones are the setting
itself, so the page and *Ads and prices → How advertisers pay* always agree. Turning *Advertisers pay up front* off
turns its fees off with it; nothing can be paid for, so no new advertiser's ad prints, while ads already paid keep
printing until their bottles are out. Stopping an ad and paying it back, and finishing payments a restart cut off,
always work (*Settling money already in flight*). A new white-label company starts with all of these off (P13): its
own owners turn them on, with the second step. FreeWater: paying up front on, everything else off.

**Why daily, not weekly:** fees are charged in one batch a day so a card that stops working pauses the ads within a
day, and an advertiser never runs up more than a day of fees unpaid. Each day's batch is one charge per advertiser.

### Credit for advertisers (only when paying up front is off)

With paying up front turned off, advertisers are billed after the fact: each invoice covers what already printed (and
scans, AR launches, box sides, commission). So the platform doesn't decide who is good for the money; a person does,
and until they do it plays safe. Where paying up front is on, credit limits can't be set (there's nothing to lend),
and only the fee rules above apply.

| Rule | What it means |
|---|---|
| **Going live** | An ad is approved (or turned back on) only when its advertiser has a **card on file that hasn't been declined**, or a **credit limit** an owner or finance person set. Otherwise the reviewer sees `credit_needed` and why. The company's own house ads never need either. |
| **Credit limit** | `POST /v1/advertisers/<id>/credit-limit` with `limitCents` and a reason. Only an owner or finance person, signed in with the second step (never an API key). Each change is a new record (who, when, why); none is ever edited. 0 means no credit. With a limit set, it applies even with a card. |
| **Pausing** | Each hour, and at once when an invoice's card is declined, an advertiser's live ads **pause** when what it owes (unpaid and declined invoices plus charges not yet invoiced) is **more than its limit**, or, with no limit, when it owes anything and has no working card. The team is alerted and the advertiser's staff are emailed in plain words. |
| **Starting again** | Nothing restarts by itself. Once the advertiser pays, adds a working card, or a person raises the limit, the ad is turned back on (by the advertiser or a reviewer), which checks again. |
| **See where one stands** | `GET /v1/advertisers/<id>/credit`: card, limit, what it owes now. |

**For the founder to decide:** a card with no limit has no ceiling between invoices (the daily budgets still apply);
set a limit for card holders too if that's too loose. The demo's sample advertisers get a made-up $5,000 limit.
Before going live, set a limit or get a card for every real advertiser whose ads are running: with neither, their
ads pause within the hour once they owe anything.

**A bid's daily amount** (`dailyCapCents`, billed-after companies with the auction) caps only what its printed labels
cost each day. Scans, AR launches, box sides and sales commission are billed on top; advertisers are told so where
they set it.

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
| **Pause (token actions)** | Stops every token action at once (minting, conversions, withdrawals). Recorded on the chain. Printing and money go on. | *Blockchain → Pause now*. **Any one person, immediately, no wait.** It also pauses itself if the daily check finds the books and the chain disagree. To stop everything, use *Pause* on the main menu (below). |
| **Pause everything (the emergency stop)** | Stops, for this company, what it has switched on of: **printing new bottles** (orders, packs and delivery nights, the free bottle at a machine, paid custom bottles, labels kept ready offline), **money leaving** (charity payouts, paying owners, the agents' fund being shared out or spent, brand offers going live or paying out, gift cards, withdrawals, money partners, prize redemptions), and **every token action**. Each answers 423 `paused`; the offers job skips the company. Never stopped: settling money already moving (refunds, stopping a paid ad and paying it back, settling gift cards bought), scans, the books, the team. Kept in the books (`chain_actions`), so a restart keeps it. | *Pause* on the console's main menu, **whatever is switched on (the blockchain or not)**: `POST /v1/pause` with a reason. **Any one owner or finance person, immediately, no wait, never a key, no second step.** The page lists what it stops for your company (`GET /v1/pause`). The team is alerted. |
| **Unpause** | Ends every pause in force (the Blockchain page's and the emergency stop): token actions, printing and money run again. | *Pause → Propose unpausing* (or *Blockchain → Propose unpausing*): approved by other owners or finance people, then the wait. A pause pressed after it was proposed cancels it. |
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
| **Owners' second sign-in step** | Off | *Security* | Recommended on before going live. A **security switch** (section 8, *Security switches*): turning it on is quick; turning it off is its own change, by an owner signed in with the second step, with a reason (10+ characters). |
| **API keys** | — | *API keys* | Turn off a key at once if it might be lost. |
| **Label panel** | FreeWater: its real label; others: made from their brand | *Label panel* (`labelPanel`) | Every word, colour, logo, icon (uploaded, in order) and line of the company's panel. Refused if any line doesn't fit the panel of a product at its smallest print size; the message names the line. `null` puts back the one made from the brand. Not money: a key may change it. |
| **Label size and areas** | Each product's own (the 16 oz bottle: 8 × 4 in, panel 0.85 in on the right, bleed 1/16 in) | Products page per product; `labelGeometry` per company (by product id, or `*`) | Width, height, seam, panel width and side, bleed, image-safe and text-safe areas. Checked: the panel 0.6 in to a third of the label, the safe areas inside the label, and the panel's lines still fitting. Changing the ad area can change which layout templates fit (README, *The label*). |

### Delivery areas (ops console, *Areas*)

Each delivery area has its own settings. Only a signed-in ops person or owner changes them (never a key), and they
apply from the next night planned. Planning itself is always a person's press of *Plan and print this night*.

| Setting | Default | Range | What it does |
|---|---|---|---|
| **On** | Off | on / off | Off: the area is never planned. A new area starts off. Turning it off is immediate; its houses keep their place. |
| **Every how many days** | 7 (weekly) | 1–28 | A house is next due this many days after the night it was planned. Changing it moves each house's next date to its last plan plus the new number. |
| **Pack size** | 24 | 12 or 24 | Box and bottles printed for each house. |
| **Packs per house** | 1 | 1–6 | Every house, until its household tells us its size. |
| **Bottles a person a week** | 12 | 1–48, or empty | Once someone in the app says how many live there, the house gets enough boxes for this many bottles each a week, over the area's frequency. Empty: household size isn't used. |
| **Most packs per house** | 3 | 1–6 | The cap on the rule above. |
| **Boxes per van** | 100 | 1–1000 | The most boxes in one van (the company's payload and shift below also end a van's run). A house's boxes always go in one van. |
| **Polygon** | none | 3–500 corners | Houses added from CSV must fall inside it. |

The company's delivery settings (`delivery.*`, through `PATCH /v1/console/settings` by a person signed in; no
console field yet), each with its default and range (`src/modules/delivery/settings.ts`):

| Setting | Default | Range | What it does |
|---|---|---|---|
| `minutesPerStop` | 4 | 1–30 | Minutes at each house (park, carry, photograph, back), counted in each run's planned time. |
| `vanPayloadKg` | 900 | 100–5,000 | What a van carries, by weight. Boxes are weighed from their product (`weightKg`: a 24-pack of 16 oz bottles 12.2 kg, a 12-pack 6.2 kg; a box without one counts half a kilo a bottle). A cargo van's payload is about 1,000 kg; 900 leaves room for the driver and tools. 100 boxes of 24 (1.2 t) used to go in one van. |
| `maxShiftHours` | 8 | 2–14 | A run ends before driving there, the minutes at each house and the drive back would pass this. |
| `photoMaxMeters` | 150 | 25–2,000 | How far from the house the phone may be when a drop's photo is taken (below). |
| `skipWeeks` | 4 | 1–52 | A driver's skip for getting to the door lasts this many weeks (below). |
| `claimExpiryMonths` | 12 | 1–60 | A claim of a house ends after this many months without its person using the app. |
| `newClaimDays` | 7 | 1–60 | A stop by a claim younger than this shows to the team as a new claim. |
| `photoKeepDays` | 90 | 1–365 | Days a photo of a drop is kept (below). |

**One door, one house.** An address is read one way everywhere (houses, household data, route buys aimed at named
addresses, the keyed "no" to targeted ads; `src/core/address.ts`): the door is its number, street and unit, the USPS
way ("North Lamar Boulevard" is "N LAMAR BLVD"; "100 North St" keeps its name), without the town, state or ZIP code,
which are kept apart. A unit (Apt 2, #2, Suite 200) is its own field: two apartments imported as two houses are two
doors on one street. An address the company already has, but more than a kilometre from where a new CSV line puts it,
is held back and named (another town?), never merged. Houses saved before (with the ZIP code in their key) are
re-keyed when the server starts, and two that turn out to be one door are merged into the older one: the stricter
choice of the two holds (a stop or a skip), claims and blocks move over, the other is `merged` and never gets a box,
what was reserved on it comes back as credit, both histories say so and the team is told.

The rule in one line: packs = the most of *packs per house* and ⌈people × bottles a person a week × days ÷ 7 ÷ pack
size⌉, never more than *most packs per house* (`packsFor` in `src/modules/delivery/houses.ts`). With the defaults, a
24-pack a week: 1–2 people get one box, 3–4 get two, 5 or more get three.

A house stops getting packs only if someone there stops it in the app (at once, and they can start again), or a
driver marks it to skip for an access or safety problem and a person agrees (*Areas → driver skips to review*). A
skip for getting to the door (a locked gate, a dangerous animal, not safe, no safe place) lasts `delivery.skipWeeks`
(4 unless set) to the Monday after, then the house is tried again from the next night its route drives; "not a home"
stays until a person changes it. "No soliciting" signs are ignored (the founder's decision): opting out is only ever
done in the app. Houses are addresses, never people.

**Claiming a house** (the app's *Your house*): scanning the code on a box delivered there in the last 60 days, or
typing the whole box code printed with it (14 letters and numbers): on a printed box, on its info strip; on a plain
box (ads on boxes off), on its **box-code sticker** ("Box code: …", below). The short number in
the box's corner is never enough: anyone passing the porch can read it. Several people can claim one house; a new
claim of a house someone already claimed is shown to them in the app and told to the team. A claimant sees door
photos only from their claim on, never before (another household's). Stopping deliveries always works at once (the
founder's rule), but a stop by a claim younger than `delivery.newClaimDays` (7) shows to the team as *new claim*
(the house list's `stoppedByNewClaim`, the house's history, and an alert). A claim ends after
`delivery.claimExpiryMonths` (12) without its person using the app.

The company's switches for delivery areas (*Console → Features → Delivery*, section 8; `src/runtime/registry.ts`):

| Switch | FreeWater's choice | Needs | Who may change it | Off means |
|---|---|---|---|---|
| **Delivery areas (house after house)** | On | Home delivery | Any owner signed in | No area is planned, printed or alerted; the *Areas* page, its routes and the app's *Your house* are gone. Houses keep their place. |
| **More packs for bigger households** | On | Delivery areas | Any owner signed in | Every house gets the area's packs per house; the app doesn't ask how many live there. |
| **Ads know the house's street and area** | On | Delivery areas, Ads | Any owner signed in | The ad engine gets no house context; ads are chosen as for any pack on that route. |
| **Drivers skip a house, with a reason** | On | The driver app, Delivery areas | Any owner signed in | No *Skip this house* button; the driver uses *Problem at this stop* and the house stays on the next plan. On, the reasons are only real access or safety problems (a locked gate, a dangerous animal, not safe, no safe place to leave it) or not a home: never a sign on the door or what someone says there (people stop it in the app). |
| **Photo at the door** (`door_photos`) | On | The driver app | Any owner signed in | No photos are taken; nothing else changes. Photos already kept are still deleted on time. |
| **Photo proof of each drop** (`drop_photo_proof`, new in catalogue 4) | On | Photo at the door | Any owner signed in | The scan at the right door is enough. On: a box is delivered only with the driver's photo of it where it was left, taken **after** the box was scanned at that door (the scan alone answers `photo_required` and is remembered; a photo from before it, on the way, doesn't count), with the driver app's camera (not picked from the phone's gallery), and, when the phone gives its location, within `delivery.photoMaxMeters` (150 m) of the house (farther is refused: take it at the door). With no location, or one too vague to tell, it counts and is marked *unverified location* for the team on the run. An ops person or owner, signed in and not the driver, can still vouch for a drop scanned at its door, with a reason. Delivered with its photo is delivered: theft from the porch afterwards isn't a failed delivery. |

**Photos of drops** show people's homes: re-encoded without the phone's hidden data, 8 MB and 40 megapixels at most,
seen only by the team and by someone who proved in the app the house is theirs, never by advertisers, and deleted
after the company's keep: **Days a photo of a drop is kept** (`delivery.photoKeepDays`, 1 to 365, 90 unless set; a
person signed in changes it through `PATCH /v1/console/settings`, no console field yet). The deleting job
(`drop-photos`) is part of the locked *Privacy rules by place*, so it runs whatever the switches say.
| **Houses block ads** | On | Delivery areas | Any owner signed in | No blocking in the app's *Your house*; and no route buys aimed at fewer than 50 houses (they need it). |

Companies that existed before these switches see them as **New** and off until their own people decide.

### Delivery boxes (Features → Delivery → *Ads on boxes*; Company → *Delivery boxes*)

The founder (2026-10-23): "The boxes have not been printed on to date. They are black at this time. But we will
ultimately want to have ads on those as time goes on. The inside of the box will be black, at least for now, but if
someone who white-labels wanted to, they should be able to adjust that... and the same for the bottom of the box. I
don't have the exact 24-pack dimensions; keep that fluid and adjustable."

| Switch / setting | FreeWater | Off means / range |
|---|---|---|
| **Ads on boxes** (`box_ads`) | **Off** (also off in *Delivery + printed ads*, in the pilot, and for every new company, which copies FreeWater) | Boxes are plain: no box print job and no panel; no box side is quoted or sold (`box_sides_off`), and a whole-box route buy covers its bottles only and says so (`plainBox` on the quote); the ad assistant never offers or sets boxes (its tool can't); drafts, previews and ads print on bottles only ("Prints on: Bottles"); the portal has no *On a box* tab and no box-sides option. Each pack still gets its **box code** (`pack.boxCode`): the driver's scan, a house's claim and the pack's receipt page work as before, from its **box-code sticker** (below). On: the four sides (less the info strip's side) are sold, each with its own code. Migration 076 turned FreeWater's starting choice off on existing servers (a person's choice is left alone). |
| **Box top / front / back / right** | On (under *Ads on boxes*) | That side isn't sold. |
| **Box code sticker** (`box_code_sticker`, new in catalogue 6) | **On** (FreeWater and the pilot; a new company copies it; an existing one decides, off until it does) | With ads on boxes off, each pack gets exactly one small sticker printed by the same printer with its bottles (`<pack>-sticker`, job key `<pack>:sticker:<try>`, so a resumed print never prints a second one; two failures in a row leave the pack *composed*, like a box that won't print): the pack's QR (the same address the info strip's code holds on a printed box), "Box code: XXXX XXXX XXXX XX" to type in, and the drivers' stop code and box number, every word outlined. The packing check lists it ("Put the box-code sticker on the front, top-right corner": the routes page, the pack, `POST /v1/packs/:id/verify`); `GET /v1/packs/:id/sticker.svg` prints it again. The driver app knows the box from the sticker's code (`boxCode` on each stop of the run); a household claims its house with it. With ads on boxes on, the code is on the info strip and there's no sticker. Off: plain boxes carry no code (drivers type the box number from the run sheet; a household can't claim its house from the box). `src/modules/packs/sticker.ts`. |
| **Box sizes and colours** (`boxes`, per pack size 6, 12, 24) | Nothing set | Outside length, width and height, 1–60 in each (unset: the platform's standard box of that size; no real size is assumed). Inside and bottom colours, `#RRGGBB` (black unless set; ads there may come later). The side with the info strip (left, right, front or back; left unless set; that side is never sold) and its width, 0.5–60 in and no wider than its side (the whole side unless set). The box-code sticker: width and height 1.25–6 in (2 × 2 unless set; no bigger than its side where the box's size is set), its side (front, back, left, right or top; front unless set) and spot (top-left, top-right, center, bottom-left, bottom-right; top-right unless set), its colour (white) and its words' (black): dark on light, at least 4.5 to 1, so the code reads. Saved field by field; `null` clears one. The box is drawn with these only while *Ads on boxes* is on; the sticker only while it's off (`src/modules/packs/boxSettings.ts`). |

### Buying on delivery routes

Advertisers buy pieces of the labels on bottles going to houses in the delivery areas (`src/modules/ads/routeBuys.ts`;
README, "Buying on delivery routes"). Paid up front like every ad here; every size gets the same technology.

| What | How it works |
|---|---|
| **Kinds** | *Spread*: N bottles shared over an area, streets or a shape on the map. *Blanket*: one piece on one bottle in every box at every house there. *Whole box*: every bottle in a house's box (and its sides, if chosen, only where ads on boxes are on; otherwise the box is plain and the buy covers its bottles only). *Chosen houses*: named by address, a number of bottles at each. Each for 1 to 26 weeks (Monday to Sunday; the company's `adBilling.limits.maxRouteWeeks`, 1 to 52), from next week. Only weekly areas that are on. One buy holds at most 50,000 pieces, reserved in pieces of 5,000 rows inside one transaction (all of it or none). |
| **The price** | Exact before paying: pieces × the size's price (*Ads and prices*: whole label $1 … 1/10 20¢) × the product's factor, plus box sides at the box side price (40¢), less any credit. The card is charged that or nothing. One charge is at most the company's `adBilling.limits.maxChargeCents` ($10,000 unless set; bottles paid up front too): above it the advertiser is told plainly to buy less or contact the team (splitting into weekly or monthly charges isn't built). AR, video and scans are included. |
| **Room** | A bottle is one label: what's sold on it never passes the whole label or ten pieces, only in mixes the bottle can print, never an ad twice, never two competitors (the database refuses more than a whole label). Blanket and whole-box buys skip a house whose box is already taken that week and don't charge for it; a buy that can't fit is refused with what's left. |
| **First paid wins** | Paying reserves each piece on a bottle under a lock on each house and week, checked against what's committed then. Of two payments for the last space, the second is charged nothing and shown the new price. A declined card lets its space go at once. No bidding for houses while pricing is flat. |
| **At print time** | Each bottle of a house's pack carries exactly the pieces reserved for it, each printed once; the rest of the label gets other paid ads, then the unsold-space list (never the house ad). A route ad never prints anywhere else. |
| **When a house stops** | Pieces that can't go out (the house stopped or was skipped, blocked the business or every ad aimed at it alone, the week went by before they printed, the box came back) come back: a buy aimed at **one house** gets a **refund** of that part to the card, approved by an owner or finance person with the second step (`POST /v1/ops/route-refunds/:id/approve`; the list is `GET /v1/ops/route-refunds`, no console page yet); any other buy gets **credit for other houses**, used first on the advertiser's next route buy (not on a one-house buy, so a refund never exceeds what the card paid). Credit is part of the money the advertiser paid up front: listed per advertiser in the books (*reconciliation*, `route_credit`: got, used, expired, left) and in their portal. It lasts `adBilling.limits.creditExpiryDays` (none unless set, 30 to 3,650); expired credit is recorded once and booked out of the advertiser's money as income (`revenue:expired_credit`). A house **skipped for a while** (an access skip) keeps its pieces: those in the weeks it's skipped move to its first delivery after, within the buy, where there's room on a bottle (the same rules as buying); what can't move comes back as credit. Nobody pays for a house that stopped. Runs daily (job `route-buys`), at once when a house stops or blocks, and on `POST /v1/ops/route-settle`. |
| **Fewer than 50 houses** | A **small-audience** buy (the company's number, 50 or more: the setting `adRules.smallAudienceHouses` through `PATCH /v1/console/settings`, no console field yet; it can be raised, never lowered below 50): only with the switch below on; only a business the company verified (`POST /v1/advertisers/:id/verify`, an owner or reviewer signed in); no names, street addresses, phone numbers, emails or personal messages in the ad (checked when paying and again when approved, on everything the ad says: its artwork's words with character references decoded and letters set apart read together, invisible and full-width characters folded, and where its links and code go, the path and query read as words); approved by an owner or reviewer signed in, never an API key (the review queue marks it); never a house that blocked ads aimed at it alone or said no to targeted ads, and only houses on a route known to be in the US (its `country`/`state`; unknown gets the strictest rules). A buy that **names** houses, however many, also leaves out every house that said no to targeted ads. The report shows the day only and no scans or saves, and what came back reads "the house is no longer on the route for this ad" (never that it stopped or blocked). Sensitive kinds of data are never targetable (household data refuses them). |
| **Proof** | *Where it went*: streets and houses reached (streets with fewer than 5 houses shown together), each drop's time and rough place from the driver's scan (to about 100 m), scans by area, what came back. Never which house or who lives there, and never a photo of a drop. |

The switches (*Console → Features*, category Ads, *Buying on delivery routes*):

| Switch | FreeWater | A new company | Needs | Off means |
|---|---|---|---|---|
| **Buying on delivery routes** (`route_buying`) | On | Off (money) | Advertisers pay up front, Delivery areas | Nothing new can be bought on routes. Pieces already bought still print; what can't go out still comes back (*Settling money already in flight*, always on). |
| **Bottles spread over an area** / **Every house on the route** / **A whole box** / **Chosen houses** | On | On (once the above is on) | Buying on delivery routes | That kind can't be quoted or bought. |
| **Buys aimed at fewer than 50 houses** (`route_small_audience`) | On | Off | Buying on delivery routes, Houses block ads | Every route buy must reach at least 50 houses. |
| **Aim route buys by household data** (`route_attribute_targeting`) | Off (needs *Ads aimed at houses*, off) | Off | Ads aimed at houses | Route buys are by place only. When on: whole areas only (no streets, shape or named houses) and 50 houses or more, refused without a count otherwise; the report lists no drops. |
| **Delivery report for route buys** (`route_proof`) | On | On | Delivery areas | No *Where it went* report. |

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

## 6. Whole areas off on this server (host settings, `FW_FEATURES`)

Separate from every switch above: the host's settings can take whole areas out of the server, so a small launch
exposes only what it uses. `FW_FEATURES=pilot` is the preset for the first pilot; `FW_FEATURES_OFF=lottery,offers`
(a comma list) switches off more. Unset, everything is on except **news**, which starts off everywhere until the host
sets `FW_FEATURES_ON=news` (below).

| Rule | How |
|---|---|
| **Off means gone, not refused.** | The area's addresses aren't registered (404, not in the API description), its background jobs aren't scheduled, and the screens hide it. |
| **Steps that would switch an area on can't be proposed or run.** | With `token` off: going live with the token, minting and switching the chain on. With `token_conversion`, `withdrawals` or `gift_cards` off: their steps under *Launch*. Going live with points, pause and unpause always stay. |
| **It only takes away.** | Every switch inside an area that's on still starts off and works as above. |
| **Only the host's settings change it, with a restart.** | Never the console, never a key. |
| **A typo can't leave something on.** | An unknown name stops a production start. |
| **Nothing is deleted.** | Switching an area back on brings back everything it had. |
| **It's the outer limit of each company's switches.** | A company can't turn on on its Features page (section 8) what the host has off. |

The pilot keeps bottles, ads, scans, AR, attribution, the app (points included), delivery, the portals and consoles,
giving, the open books, accounts, data rights, transparency, the games and launch up to *live with points*.
It switches off the token, conversion, withdrawals, gift cards, money partners, the AI agents' fund, the operator
network, the prize game, Veo footage, brand offers and **machines** (the Austin pilot is door-to-door delivery; machines
come later: the app offers no machine, the scan page no "free water near me"). The full table, with the reason for each, is in
`docs/RUNNING.md` (*The pilot*); the areas and their routes are in `src/runtime/features.ts`.

### News (built, off until it's rolled out)

FreeWater News on unsold spots (`src/modules/news`) is the one area that starts **off** with no settings at all: the
founder wants it "toggled off… rolled out over time with proper testing". It takes the host's area and the company's
own switches on its Features page (§8, category News), all off, for every company, FreeWater included:

| Switch | Who | What it does |
|---|---|---|
| `FW_FEATURES_ON=news` | The host's settings, with a restart | Without it the news routes don't exist (404), no news prints, nothing runs. It's also off in the pilot preset; naming it here brings it back there on purpose. `FW_FEATURES_OFF=news` always wins. |
| **FreeWater News** (`news`, kept in the settings as `news.on`) | An owner signed in (never a key) | Without it, on a server that has news: topics can be prepared and approved, but nothing prints and the public pages answer `news_off`. Turning it off is immediate and takes the switches below with it: bottles already out open a plain card, no story. |
| **News topics on unsold spots** (`news_cards`; needs News and *Approved fillers*) | An owner signed in | Off: approved topics stay ready, nothing prints. |
| **Readers choose their sources** (`news_sources`) | An owner signed in | Off: everyone reads the neutral version and the source pages answer `feature_off`. |
| **News writer** (`ai_news_writer`, category AI; needs News) | An owner signed in | Off: the stand-in that only names and links the reporting. |

When both are on: an unsold spot can carry a news **topic** and its photo ("Austin City Council: the latest"; never a
claim that goes stale). A person on the team approves each topic before it can print. The code is permanent and opens
the newest version of the story, months later too. Stories are written by our AI (the *News writer*, `docs/AI.md`)
from at least two outlets, in its own words, cited and linked, under the company's own name; a stand-in points to the
reporting when there's no AI. Readers choose favourite sources (the first sets the style; none gets the neutral
version; never guessed). Every story has *Report an error* and its corrections; corrections are logged and make a new
version. Advertisers can keep an ad off bottles with news (`POST /v1/campaigns/:id/news-adjacency`).

### Unsold space (Ads → *Unsold space*)

The founder: "every piece of real estate on these labels needs to be a third-party ad and never the FreeWater stuff,
other than all the way to the right in the tiny black area." So the ad area **never** carries the company's own ads:
not its house ad, not "your ad here", not its own messages, not its news. That holds in the engine, in every
preview, on delivery packs and box sides, on machine prints and around route pieces; a guard after the engine
(`keepOwnOut`) holds it for any engine a company plugs in. The black panel on the right is the company's own.

A piece nobody bought is filled from the company's **list**, in its order (console: Ads and prices → *Unsold space*:
add, remove, reorder; saved as the `unsold` setting by a person signed in, never a key). FreeWater's order, which every
company starts with:

| # | Kind | What prints | Rules |
|---|---|---|---|
| 1 | **Former advertisers** | One of their past approved ads, free, as a **bonus** | Only an advertiser that paid before and isn't running an ad now, only an ad that's over (an ad paused with paid bottles left isn't). Only ads **still current**: approved, never stopped by the company or held for unpaid bills; no offer end that passed or can't be read ("ends Sunday"), no date on it that passed; an ad showing a price or a discount with no date only within 90 days of last printing paid (prices go stale). Its code opens the advertiser's **current** page. Never billed, never drawn from or counted against a paid ad, shown to the advertiser as **bonus bottles** (`GET /v1/ads/bonus`). The advertiser can say no in its portal (`POST /v1/ads/bonus`, allowed unless it does); the team can refuse an advertiser, with a reason (`POST /v1/console/advertisers/:id/bonus`). Advertisers take turns (the one with the fewest bonus pieces goes next). |
| 2 | **Approved filler ads** | An advertiser's ad it offered free for unsold spots | `fillers` and `filler_offers` on; a person approved it; it stops when its ad stops. |
| 3 | **Charity partners** | A charity's piece (Well Aware) | `unsold_charity` on; a person approved it. |
| 4 | **Ads you picked** | Approved third-party ads the team chose | Never the company's own; the same "still current" and say-no rules. |

Every piece still fits the bottle: never two competitors, never one advertiser twice (nor beside its own paid ad), the
categories the company, the product and the person ruled out, where and on what the ad may print, the house's blocks,
never on a bottle in the no-ads control. When nothing on the list fits a piece, the engine uses a **tidier template
with fewer pieces** (paid pieces first: among labels that earn the same, the one with fewest blank pieces wins); only
if that's impossible does a **plain, blank-coloured piece** print, and the team gets an alert (`unsold-blank:<company>`,
at most every 30 minutes) and a count on the console. The no-ads control's plain label alerts nobody.

| Switch (Features page) | FreeWater | What it does |
|---|---|---|
| **What fills unsold space, in order** (`unsold_order`, a setting) | the four above | The list (console: Ads and prices). |
| **Approved filler ads** (`fillers`), **Advertisers offer ads for unsold spots** (`filler_offers`), **Charity partners' pieces** (`unsold_charity`) | on | Those kinds on the list. |
| **Your own ads in unsold space** (`own_house_ads`, `unsold.ownAds`) | **off, and can't be turned on** | A white-label company may allow its own pieces (its messages, news, then its house ad) after its list. Off for every company unless it turns it on. |
| **Hold delivery bottles for paid ads** (`unsold_hold`, `unsold.hold.on`) | off | See below. |
| **Days bottles are held** (`unsold_hold_days`, `unsold.hold.days`) | 7 (1 to 30) | For the company, and per delivery area (`unsold.hold.areas`). |

**Holding for paid ads (delivery only).** Machines print on the spot, so there's nothing to hold. For delivery, hold
means: **a night more than the hold's days away isn't planned or printed yet** (so paid route pieces can still be bought
on its bottles); once the night is within the days, it is planned and printed in full, and the list fills what's
unsold. Nothing is taken or marked while held, and the night before delivery is always within (the days are at least
1), so a hold never costs a house its delivery. Per area, `unsold.hold.areas[<area>]` can hold or not hold, with its
own days. What the last planning held back is in `app.delivery.held`.

These switches replace the house ad that used to fill unsold space, so they count as part of the first catalogue:
every company, white-label too, starts with FreeWater's choices (`src/modules/fillers/unsold.ts`, `test/unsold-space.test.ts`).

### Houses that haven't signed up (all off until a person turns them on)

Features page, category Data & targeting: **Ads aimed at houses** (`house_targeting`), and under it **Area
statistics** (`area_data`) and **Bought household data** (`household_data`). All three start off for every company.
Off, `HouseholdService.audienceForHouse` returns nothing about the house (the engine prints untargeted), nothing is
imported, and the area and import routes answer `feature_off`. Deleting by source or import, a house's opt-out and
residents' download and erase always work (they sit under *Privacy rules by place* and *People's rights*, locked on).

---

## 7. Keys for outside companies (in the host's settings)

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
| Safe Browsing for ad links | `SAFE_BROWSING_API_KEY` | A stand-in that says so; the list, redirects and page checks still run (*Link safety*) |

Never send a key by email or chat. A minting key for the real Solana network is refused: minting there is signed
only in Squads.

---

## 8. Features page (every switch, per company)

*Console → Features* is where a company (FreeWater or any white-label licensee) chooses what it runs. Every feature on
the platform is a switch there, in categories, in plain words. The list lives in one place, `src/runtime/registry.ts`;
the page, the checks and the tests all read it.

**Categories** (each has a main switch, with finer switches grouped beneath): Printing, Ads, AR & video, Design
studio, Delivery, Machines, Points & rewards, Games, News, Data & targeting, AI, Money & payments, Transparency,
Charity & giving, Partners & developers, Blockchain. Then two that are always on: *Safety, law and people's rights*
and *The platform's core*. About 130 switches today, including each fee (which links to its page under *Ads and
prices*).

| Rule | How |
|---|---|
| **Off for a company means off for that company only.** | Its routes refuse that company's requests (404 `feature_off`, the same for every caller), its background jobs skip that company, its screens hide it (they read `GET /v1/public/features?company=`), and the engine doesn't use it (ads off: only the house ad prints; a size or box side off: not sold; a plug-in off: the advertiser's simple card; an AI use off: the built-in rules). |
| **The host's settings stay the outer limit.** | A company can't turn on what `FW_FEATURES` has off (section 6); the page says "switched off on this server". |
| **Turning a switch off turns off everything that needs it.** | The page shows the list before saving. Turning the parent back on doesn't turn those back on by itself: each is chosen again. |
| **Turning off is quick.** | Any owner signed in. Never a key (a key never changes a switch). |
| **Paid bottles always go out.** | Turning off *Printing bottles*, *Ads on bottles*, an ad size or the label layouts a size needs holds back the paid bottles that need it; the preview says how many first. They print again once it's back on, or an owner or finance person stops each ad and pays back what wasn't printed (*Settling money already in flight*). |
| **Turning on follows the usual rules.** | Any owner signed in; money, chain and one-way switches need the second sign-in step; gift cards, withdrawals and the chain are turned on only by their approved steps under *Launch* and *Blockchain* (the page links there). |
| **An AI deciding on its own is earned, never switched on here.** | *Autonomy* switches (*AI makes the final call on paid ads*) are turned on only on their own page, by an owner with the second step, on the AI's record (the page says where); turning them off works here too, and anyone on the team can turn them off on their page. |
| **One-way stays one-way.** | The AI agents' fund and the giving promise, once on, show "On for good". |
| **Security is never weakened in passing.** | *Security switches* (below) are never part of a starting point, a bundle of changes, a restored settings version or an agent's proposal. |
| **Locked items are shown, never switchable.** | The safety governor ("we are never removing a safety governor"), the number line, the pause switch, approvals and waits, the launch stages, the minimum age, privacy rules by place (strictest when unknown), people's rights to their data, the books' audit trail and append-only journals, settling money already in flight, ad review, machines' print limits, the security log. |
| **One source of truth.** | Switches that already had a setting (the games, the prize game, offers paying out, dollar credit, the chain, open books, the live feed…) are *linked*: they stay in the company's settings and the page changes them through the same checks. A change made on any settings page shows in the switches' history too. |
| **Every change is kept.** | Who, when, from, to, why (optional) and where (this page, a settings page, an approved step, a starting point), append-only: `GET /v1/console/features/history`. |
| **Transparent.** | `GET /v1/console/features` is the company's own state. A company may turn on *Publish our feature list*; then `GET /v1/public/companies/<id>/features` shows it (a new company starts with it off). |

**Defaults.** A new company starts as a copy of FreeWater's choices *at that moment*, except anything with money, the
chain or no way back, which starts off (P13): its own people turn those on through the steps above. Companies that
existed before the page kept exactly what they had. When FreeWater changes a choice later, existing companies don't
change. A switch added later is marked **New** for existing companies and stays off until they decide; FreeWater gets
its own choice.

**Starting points** (preview first, then apply): *Full FreeWater*, *Design studio only* (the studio exports print-ready
files: `POST /v1/studio/export`, an SVG at real size in inches), *Delivery + printed ads*, *Machines + printed ads*. A
starting point never turns on a money, chain or one-way switch, and never touches a security switch; those are listed for a person to turn on, with
what sits under them (for *Delivery + printed ads*: *Money and payments*, *Advertiser invoices and cards*, *Advertisers
pay up front*, then *Buying on delivery routes*; and *Giving*, set on its own page). With those on, a new company has
the Austin pilot's setup: house-after-house delivery with photo proof, printed ads at every size on bottles (boxes plain, as FreeWater's),
route buying, fillers, AR and scans; no machines, fees, bidding or news (`test/spec-pilot-setup.test.ts`). Unsold space
starts with FreeWater's list (former advertisers, fillers, charity, picks) and never the company's own ads.

**Security switches** (`security` in `src/runtime/registry.ts`): switches whose being off weakens the company's
security: *Owners need a second sign-in step* and *Link safety* (the safety governor, ad review, the pause switch, the
security log and approvals are locked on). Turning one **on** is quick. Turning one **off** is done only on its own (a
change with anything else in it is refused whole), by an owner signed in **with the second sign-in step**, with a
written reason of at least 10 characters; it's kept in the switches' history and the team is alerted. A starting point
never changes one (the preview says "Left on"), turning off its parent leaves its own choice as it was (it's off with
the parent and back with it), a settings version put back that would turn one off is refused, and so is any other save
that skips these checks (an agent's proposal). `test/security-switches.test.ts` checks every starting point, preset
and bundle.

**The page:** the main switches as cards, the starting points, *Every switch* (categories → groups → switches) with a
search box and filters (on, off, different from FreeWater, locked, new); each switch shows what it does, what it
needs, what turning it off also turns off, FreeWater's choice and who may change it. It works on a phone.

### Design it yourself (Design studio → *Design it yourself*; Ads → *QR colours and styles*)

| Switch | FreeWater | What it does |
|---|---|---|
| *Design it yourself* (`design_yourself`) | On | "I'll design it myself" beside the assistant and the studio when making an ad. Off: not offered; drafts in that mode can't be made, and the upload page and its routes are closed. |
| *Template downloads* (`template_downloads`, under it) | On | A template per size and shape on each product (PDF, SVG, 300-dpi PNG) from the label geometry the printer uses. |
| *Upload your own artwork* (`artwork_upload`, under it) | On | Uploads on the upload page and in the ad chat (the chat is refused the same way when it's off), each matched to its size and checked, with one-tap fixes. |
| *QR colours and styles* (`qr_styles`) | On | The advertiser's colour and logo in their code, only if it scans. Off: plain black codes. The code is always ours. |
| *Change a link (fee)* (`link_change_fee`, Money) | On | See *How advertisers pay*. |

All new in catalogue 6: an existing company sees them as new and decides; FreeWater has them on. PDF needs the PDF tools
(poppler-utils) on the server; set `PDF_TOOLS=off` to refuse PDFs on purpose.

**Paying with "Fix these" (the founder: advertisers may pay anyway).** When the check says *Fix these* and every issue
is about quality (small or faint words, no bleed, low resolution, words outside the text-safe line, something in the QR
box, see-through parts, fonts not embedded), the upload page shows the issues and a box: **"I understand — use it as it
is"**. Ticking it (a person signed in, never a key: `POST /v1/ads/drafts/:id/artwork/as-is`) records who, when and the
issues of each file (by code); then the ad can be paid for and submitted. The choice is kept with the ad
(`Campaign.asIs`), shown to the reviewer in the review queue, and kept with the ad's version (`ad_versions.as_is`), so
ratings and outcomes are read knowing it. A new file, or a file whose issues change, needs the tick again. **Never
overridable:** a file that can't print at all (no size it fits, two it might be, too large), an unsafe link (*Link
safety*) and the content policy (a person reviews every ad as before).

### Link safety (Ads → Review → *Link safety*)

The founder: every link an ad leads to is approved before it goes live, "what if they changed it to porn or malware".
Code: `src/modules/ads/linkSafety.ts`, the list `src/modules/ads/link-blocklist.txt`. Threat model: *Link destinations*.

| Switch | FreeWater | Every company | What it does |
|---|---|---|---|
| **Link safety** (`link_safety`) | on | **on** (new and existing: `since: 1`) | Every link an ad leads to is checked automatically before a person reviews it, and every live link again each day. Turned off **only by an owner signed in with the second sign-in step, on its own, with a written reason** (10+ characters; a security switch, section 8), recorded in the switches' history, and the team is alerted; a starting point never turns it off. Off: only the basic checks run (https, no password, no address or private name), and people still review every link. |

**What is checked, every link** (a new ad's, a changed link, a QR code's static address, a version's link: anything an
ad leads to, by every route: the ad chat and upload page, `POST /v1/campaigns`, `PATCH /v1/campaigns/:id`, `PATCH
…/codes`, *Change a link*):

1. **On its face:** https only (an `http://` link is taken as its `https://` address), no user name or password, no
   numeric address (any form), no `localhost`, `.local`, `.internal` or single-word name, no unusual port (flagged).
2. **The list:** adult, malware and phishing domains and **link shorteners or QR redirect services** that hide where
   people end up (their subdomains too), plus the company's own blocked domains (`adRules.linkBlocked`). A company can
   allow a shortener for itself (`adRules.linkAllowed`), never an adult, malware or phishing domain.
3. **Followed from our server:** every redirect (at most 5, 4 seconds each, 256 KB read), each hop's name looked up and
   **refused if any address points into a private network** (IPv4 and IPv6, IPv4 inside IPv6 too), the request then made
   to that same checked address (never looked up again), each hop checked by 1 and 2 again; a page that refreshes
   itself elsewhere counts as a redirect.
4. **The last page:** an error, a download instead of a page (refused), a page labelled adult (refused), adult words in
   its title or description (flagged).
5. **Google Safe Browsing** when the host sets `SAFE_BROWSING_API_KEY` (a match is refused); without a key a stand-in
   answers (it knows only Google's own test pages) and every result says so.

**Results:** *pass*, *flag* (a person decides, with the reasons in the review) or *refuse* (it can't be used: nothing is
charged or changed). Every check is recorded (`link_checks`, append-only): what, why, where it ended up, for which ad.

**Changing a link on a live ad:** the old link stays live; the new one is checked, paid once (the fee), looked at by
the AI reviewer and decided by a person (*Ops → Ad review → Link changes*, `GET/POST /v1/review/link-changes`; a person
signed in, never a key), or rejected by the AI where it has earned the final call (appeal once). At approval the link
is checked again: one that turned unsafe since can't be approved.

**Every day** (job `link-safety`): every live ad's links are checked again. A link that turned bad (refused, or now
reading as adult) **sends that ad's code to a holding page** ("This link is being checked"), stops its links from being
followed (old links handed out before too), makes new bottles carry our own code, and alerts the team. A person clears
it with what they checked (`POST /v1/review/link-holds/:campaignId/release`), only once it checks safe again; or an
approved link change that leaves nothing unsafe ends it. Holds are kept (`link_holds`). Already-printed *static* codes
go straight to the advertiser's site and can't be held: a reason to keep static codes off.

**Updating the list:** edit `src/modules/ads/link-blocklist.txt` (one `kind domain` per line; its header says how), run
`npx vitest run test/link-safety.test.ts`, deploy. The next daily check holds any live ad that now leads somewhere
listed. A company's own domains go in its settings (`adRules.linkBlocked` / `linkAllowed`).

### Label layouts (Ads → Label layouts, on the Features page)

Every label is one of 16 tidy templates (`src/modules/ads/layouts.ts`). Each is a switch, shown with a small picture
(the standard product's label, cut that way). The section also holds the most ads on one bottle and each product's
own choice.

| Rule | How |
|---|---|
| **A layout needs its sizes.** | Each layout switch depends on the size switches it uses: turning a size off turns its layouts off (listed in the preview); turning the size back on doesn't turn them back on by itself. |
| **At least one stays on while ads are on.** | A switch change, a lower *most ads on one bottle* or a product's choice that would leave the standard product (or that product) with no usable layout is refused, in plain words. With *Ads on bottles* off, nothing is cut and nothing is refused. |
| **Most ads on one bottle** | 1 to 10 (FreeWater 10). Templates with more pieces are greyed, with the reason. Saved in the settings (`adRules.maxAdsPerUnit`); the Ads and prices page links here. |
| **Per product** | *On each product* narrows the layouts one product uses (`adRules.productLayouts`, by product id, the company's own or shared ones only). A product without a choice, and every new product, uses all the company's layouts. Templates too thin or too small for a product's label are off there anyway, greyed with the reason. |
| **Paid pieces are never stranded silently.** | A change that leaves paid bottles without a layout for their size says how many first (Features preview); a settings save that would do it is refused (409 `paid_pieces_stranded`) until the count is sent back as `confirmStranded`, and putting back an old settings version that would do it is refused (make the change here). Paid bottles wait and print once a layout holds them, or a person stops the ad and pays it back; route pieces that can no longer share a label come back as credit when their bottles print. |
| **Everything reads the same rule** | The engine, previews, the sizes an advertiser can choose, bottle and route quotes and route capacity, the studio and sample labels (`Platform.layoutsOf`). Box sides are unaffected. |
| **History** | Layout switches and *Most revenue per bottle* like any switch; the most ads on one bottle (from → to) and each product's choice (on each layout, "only on <product>") are logged in the switches' history too. |
| **Defaults** | FreeWater: every layout on, 10 ads, every paid ad gets its turn. A new company copies FreeWater's layout choices and its choice for shared products (none of these is money). Companies that existed before keep every layout (`since: 1`: these narrow what they already printed, so they aren't "new, off until decided"). |

**How each label is filled** (*Ads → Selling space → Most revenue per bottle*, a switch kept in the settings as
`adRules.placement`; a person changes it, never a key). Off: *every paid ad gets its turn* (the ad first in line goes
on, then the best-earning layout around it). On: *most revenue per bottle*, the best-earning layout among the paid ads
that fit, with a fair-turn bound: a paid ad left off `adRules.fairTurnBottles` bottles in a row where it fits (20
unless set, 2 to 1,000) goes on the next bottle first, the longest-waiting first. The waiting counts live in memory:
after a restart they start again, so a turn comes at most one bound late.

### Ad ratings (Ads → *Ad ratings*; the AI's own switch under AI)

The founder: "Even with the switch turned off, I want the AI to rate each ad 1–10 before it gets physically printed, so
it can learn over time." Code: `src/modules/ads/rating.ts` (the rubric and the raters), `ratings.ts` (when, outcomes,
calibration, benchmarks), `categories.ts` (the industries). Console: *Ad ratings* and *Benchmarks*.

| Switch | FreeWater | New company | Company that already existed | What it does |
|---|---|---|---|---|
| **Ad ratings** (`ad_ratings`) | on | copies FreeWater (on) | **on** (as the founder asked; a white-label company may turn it off) | Every ad version rated 1–10 once, in the background, before its first print; followed to its results; filed under an industry. Off: nothing rated or followed for that company. |
| **Show the rating to advertisers** (`ad_rating_feedback`, under it) | **off** | copies (off) | off | The advertiser sees the score, a meter (Poor 1–3, Average 4–5, Good 6–7, Excellent 8–10) and up to three tips, on the review page before paying and on each ad in the portal, always with the words below. Its own request, after the page: it never stands between the advertiser and paying, and never stops an ad. Off: its two routes are off (404 `feature_off`) and the portal shows nothing. |

**No promises.** Wherever a rating, score, meter, tip or benchmark is shown (the advertiser's portal, the console's
*Ad ratings* and *Benchmarks* pages, every API answer and API description that carries one, the advertiser's own data
download) it says: *"This rating is our opinion of how well the ad is put together. It isn't a promise of results."*
(`NO_PROMISE`, `src/modules/ads/rating.ts`). Ratings and benchmarks are guidance, not guarantees
(`docs/ADVERTISER-TERMS.md`, a draft for the lawyer; COMPLIANCE L-40).
| **AI ad rater** (`ai_ad_rater`, AI category) | on | copies (on) | on | Claude rates (through the company's AI routing). Off, or no AI: the built-in rules rate, labelled so. |

**When a version is rated.** A version is the ad's content: artwork, scan page and its links, AR, video (`contentHash`).
It's rated once, the first time any of these happens: the ad is submitted (or changed through the API or the codes
page), the advertiser asks for its score at quote time, or a bottle with it prints. **Printing never waits.** If the AI
is slow (30 seconds) or fails, the print goes ahead and the hourly job (`ad-ratings`) asks again, 2 then 4 minutes later;
after the third failure, the rules rate it, with the reason kept. A version first printed before its rating was done is
marked **rated late**, shown on the *Ad ratings* page. Changing only how many bottles or where is not a new version.

**Industries.** FreeWater's own list of 27 top-level industries (`src/modules/ads/categories.ts`), modelled on the
IAB Tech Lab Ad Product Taxonomy and Google's product taxonomy but not a copy of either: neither states a licence
clearly, so we wrote our own. Its ids never change. Each version gets a primary industry (the rules' guess from what the
advertiser said it is and the ad's words; the AI's choice when it rates), an optional second one, and optionally one
of the company's **own subcategories** (added and archived by a person on the *Ad ratings* page; never deleted). A
person's choice carries over to the ad's next versions. Every change is logged (`ad_category_changes`). Features kept
with each version: offer type and size, AR, video, a link, sizes, and how it goes out (delivery, machines, events).

**Outcomes and calibration.** Each version is followed by the window in which it was the ad's current one: bottles
printed (voided ones left out), bottles scanned, scans, AR launches, link clicks, sales and their value, by channel
(machine, delivery, event). *So far* is refreshed hourly; the 7-, 30- and 90-day horizons (bottles of those first days
and what they did in the 14 days after) are written once and never change. The *Ad ratings* page holds each score
against its ads' scan and sale rates (ads with 100+ bottles), with the rank correlation, by rater and rubric: "how
well the rating predicts results".

### Benchmarks (Data & targeting → *Benchmarks*)

| Switch | FreeWater | New company | Company that already existed | What it does |
|---|---|---|---|---|
| **Contribute to the network's benchmarks** (`benchmarks_contribute`) | on | copies (on) | **off until it decides** (new: its advertisers' results joining a pool is its own decision) | Its ads' results join the network's averages, as anonymous aggregates. Off: they're left out of every monthly release made from then on (releases already made stay as they were), and the company sees only its own figures (give to get). |
| **Benchmarks page** (`benchmarks_view`) | on | copies (on) | off until it decides | The *Benchmarks* console page and its routes. |

**The method.** Each ad counts once: its rates over the bottles of its first 30 days (7, 90 or so far can be chosen),
once it has 100+ bottles. Grouped by industry, channel, industry and channel, offer type, and (the company's own only)
its subcategories. Each figure is the average of the ads' rates (each ad equal). The company's own figures are its
own, live. **The network's figures are released once a month only** (ads first printed that month, at 30 days, once
the month has settled: 45 days after it ends) and kept (`ad_benchmark_snapshots`, append-only); nothing about the
network is computed for the person asking. **A network cell is released only when** at least **20 ads** from at least
**5 advertisers** stand behind it, **no advertiser has more than half** of the ads, and the same is still true
**without any one company** (so nobody can subtract themselves to see someone else's). Then (`src/modules/ads/benchmarkRelease.ts`;
the method in `docs/AI.md`, "Benchmarks: how they're kept anonymous"): **complementary suppression** (where one part of
a total is held back, the smallest other part is too; a held-back total holds back its breakdown), **Laplace noise**
drawn once per release with a fixed budget per cell (ε = 5: 0.5 for each count, 1 for each rate) and kept, so asking
again gives the same figures, and **rounding** (counts to 5, never shown under the bar; rates to half a point). A
company may raise the bar for itself (anyone on its team raises it; an owner lowers it back, with a reason; never under
20 and 5, held by the database too): a released figure under its own bar isn't shown to it. Each figure shows the month
it's from. Never an ad, an advertiser or a company in the network's figures, and no count of companies. Never sold.

### How to add a feature

1. Add one `sw({...})` entry to `SWITCHES` in `src/runtime/registry.ts`: id, category and group, plain-words label and
   description, `default` (FreeWater's choice), `dependsOn`, and `risk: 'money' | 'chain' | 'one_way'` if it moves
   money, touches the chain or can't be undone. If its state already lives in the settings, make it `kind: 'linked'`
   with a `link` (don't copy state). Give it `since: CATALOGUE + 1` and raise `CATALOGUE`.
2. Say what it owns: `routes` (`"METHOD /url"` exactly as registered), `jobs` (names in `src/server/main.ts`), console
   `pages`, experience `plugins`; or check it in the engine with `app.companyFeatures.on(companyId, '<id>')` (AI:
   pass the id as the `use` of `withCompany`).
3. Add new routes to the route table in `docs/THREAT-MODEL.md` §6 as usual.
4. Run `npx vitest run test/features-registry.test.ts`: a route, job, console page, screen or plug-in that belongs to
   no switch, a switch that is enforced nowhere, or a missing parent fails it. Each main switch is also turned off in
   turn to check the rest keeps working.
