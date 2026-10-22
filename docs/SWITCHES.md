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

**Claiming a house** (the app's *Your house*): scanning the code on the side of a box delivered there in the last 60
days, or typing the whole box code printed under it on the side panel (14 letters and numbers). The short number in
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

### Buying on delivery routes

Advertisers buy pieces of the labels on bottles going to houses in the delivery areas (`src/modules/ads/routeBuys.ts`;
README, "Buying on delivery routes"). Paid up front like every ad here; every size gets the same technology.

| What | How it works |
|---|---|
| **Kinds** | *Spread*: N bottles shared over an area, streets or a shape on the map. *Blanket*: one piece on one bottle in every box at every house there. *Whole box*: every bottle in a house's box (and its sides, if chosen). *Chosen houses*: named by address, a number of bottles at each. Each for 1 to 26 weeks (Monday to Sunday; the company's `adBilling.limits.maxRouteWeeks`, 1 to 52), from next week. Only weekly areas that are on. One buy holds at most 50,000 pieces, reserved in pieces of 5,000 rows inside one transaction (all of it or none). |
| **The price** | Exact before paying: pieces × the size's price (*Ads and prices*: whole label $1 … 1/10 20¢) × the product's factor, plus box sides at the box side price (40¢), less any credit. The card is charged that or nothing. One charge is at most the company's `adBilling.limits.maxChargeCents` ($10,000 unless set; bottles paid up front too): above it the advertiser is told plainly to buy less or contact the team (splitting into weekly or monthly charges isn't built). AR, video and scans are included. |
| **Room** | A bottle is one label: what's sold on it never passes the whole label or ten pieces, only in mixes the bottle can print, never an ad twice, never two competitors (the database refuses more than a whole label). Blanket and whole-box buys skip a house whose box is already taken that week and don't charge for it; a buy that can't fit is refused with what's left. |
| **First paid wins** | Paying reserves each piece on a bottle under a lock on each house and week, checked against what's committed then. Of two payments for the last space, the second is charged nothing and shown the new price. A declined card lets its space go at once. No bidding for houses while pricing is flat. |
| **At print time** | Each bottle of a house's pack carries exactly the pieces reserved for it, each printed once; the rest of the label gets other paid ads, approved fillers, then the house ad. A route ad never prints anywhere else. |
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
giving, the open books, accounts, data rights, transparency, machines, the games and launch up to *live with points*.
It switches off the token, conversion, withdrawals, gift cards, money partners, the AI agents' fund, the operator
network, the prize game, Veo footage and brand offers. The full table, with the reason for each, is in
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

### Filler for unsold spots (each piece approved by a person)

Two switches on the Features page (category Ads, *Unsold spots*): **Approved fillers for unsold spots** (`fillers`,
on for FreeWater; "new", so off until it decides, for a company that existed before it) and under it **Advertisers
offer ads for unsold spots** (`filler_offers`). Off: the plain house ad. Works with news off.

Spots nobody bought get an approved filler before the generic house ad: the company's own messages, charity
messages (Well Aware), advertisers' ads offered free for unsold spots (`POST /v1/campaigns/:id/filler-offer`), and,
only while news is on, news topics. Every piece is pending until a person approves it (`POST /v1/fillers/:id/approve`,
signed in); retiring is immediate. Never billed. Never on a bottle in the no-ads control; an advertiser's filler
follows its own ad's rules (categories, competitors, the person's "never show me") and stops when its ad stops. A
label nobody bought at all is one full-wrap piece, which only the company's own, charity and news pieces fit.

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
| **Paid bottles always go out.** | Turning off *Printing bottles*, *Ads on bottles* or an ad size holds back the paid bottles that need it; the preview says how many first. They print again once it's back on, or an owner or finance person stops each ad and pays back what wasn't printed (*Settling money already in flight*). |
| **Turning on follows the usual rules.** | Any owner signed in; money, chain and one-way switches need the second sign-in step; gift cards, withdrawals and the chain are turned on only by their approved steps under *Launch* and *Blockchain* (the page links there). |
| **An AI deciding on its own is earned, never switched on here.** | *Autonomy* switches (*AI makes the final call on paid ads*) are turned on only on their own page, by an owner with the second step, on the AI's record (the page says where); turning them off works here too, and anyone on the team can turn them off on their page. |
| **One-way stays one-way.** | The AI agents' fund and the giving promise, once on, show "On for good". |
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
starting point never turns on a money, chain or one-way switch; those are listed for a person to turn on, with
what sits under them (for *Delivery + printed ads*: *Money and payments*, *Advertiser invoices and cards*, *Advertisers
pay up front*, then *Buying on delivery routes*; and *Giving*, set on its own page). With those on, a new company has
the Austin pilot's setup: house-after-house delivery with photo proof, printed ads at every size on bottles and boxes,
route buying, fillers, AR and scans; no machines, fees, bidding or news (`test/spec-pilot-setup.test.ts`).

**The page:** the main switches as cards, the starting points, *Every switch* (categories → groups → switches) with a
search box and filters (on, off, different from FreeWater, locked, new); each switch shows what it does, what it
needs, what turning it off also turns off, FreeWater's choice and who may change it. It works on a phone.

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
