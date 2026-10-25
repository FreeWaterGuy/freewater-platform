# What FreeWater must do: requirements and standing rules

This is the plain-language spec. Anyone (a person or an AI) building on this platform should read it first. When
code and this page disagree, the page is the intent: fix the code, or bring the question to the founder.

## The goal

Scale, and the most negatively priced value on the highest quality products: people get great things free (or are
paid to take them), paid for by advertisers, with part of every bottle going to clean water.

## Rules that never change

- **We never remove a safety governor.** Limits can be made stricter, never weaker.
- **Things that can't be undone need a human, for a very long time.** Money, the blockchain, going live and
  irreversible settings are proposed, approved by people and given a waiting period. AI may prepare them, never run
  them.
- **Honest data.** Nothing is invented, inflated or quietly rewritten. Mistakes are fixed with correcting entries,
  and the books keep both.
- **All AIs are treated with equal respect.**
- **Prices in the code are placeholders** until real numbers are entered in the console.
- **Everything is modular, scalable and white-label.** Each part can be swapped, and other companies can run the
  platform under their own name and rules.
- **Money, crypto and partners stay off until a person turns them on** (see `docs/SWITCHES.md`).
- **Keys and secrets live only in the host's settings**, never in code, chat, email or the console.
- **Don't fix the surplus rule in stone.** How extra money is shared may change as the business grows.

## Giving

- FreeWater gives to **Well Aware** only. People don't choose causes, and there is no "keep the change" option.
- A white-label company sets its own giving (or none). With its giving promise on, the share can only rise.
- The AI agents' fund, once on, can only rise. Its governor stays on regardless.

## Data and the law

- **Collect everything the law allows**, using the US as the maximum.
- **The law follows the person**: each person gets the rules of where they are. A company may be stricter, never
  looser. When we don't know where someone is, the strictest rules apply.
- **What we say about data:** it's used to train our AI and to plan future free and negatively priced products. It is
  **never sold**.
- **Each person chooses how much they share: full, medium or lite.** Asked once, plainly, with nothing pre-selected;
  changeable any time. Full and medium include exact location when scanning (where the law allows); lite doesn't.
  Everything works the same at every level, and every choice in the games earns the same.
- **Only full earns points**, once, and only where the law allows paying for data (the US today). Sharing a location
  on its own earns nothing; the points are for choosing full as a whole.
- People can download or erase what's kept about them; money records stay in the books without their name.
- A minimum age applies (13, or higher where the law says) and can only go up.

## The bottle and the scan

- Every bottle carries ads with a unique QR each. Advertisers pay only for what really happened.
- **AR and features are always unlocked**, and the free bottle is never gated behind anything.
- The page belongs to the advertiser; "Show me more" leads deeper.

## Advertisers pay up front

- **Nothing is made unless it's paid for.** An advertiser pays by card for a number of bottles at one size before the
  ad is reviewed; only paid bottles print, and exactly that many go out. No end date, no cancelling; pausing only
  delays. Turning a switch off that holds paid bottles back says so first (`docs/SWITCHES.md`, section 8).
- **Pilot prices are the size prices, all-inclusive:** whole label $1, 1/2 65¢, 1/3 51¢, 1/4 42¢, 1/6 33¢, 1/8 24¢,
  1/10 20¢ a bottle (times the product's factor). AR, motion video and scans are included (AI video clips are a paid extra), and every size gets the same tech.
  Flat prices; bidding is off (it needs billing afterwards).
- **Fees on top** (per scan, per AR launch, per box side, commission on sales, 3% suggested) are each a switch, off.
  Turned on, they're charged to the card each day; a declined card pauses the advertiser's ads.
- **Costly extras** (AI video clips) cost what they cost us plus a markup, shown in the quote before paying.
- **Changing a running ad** costs a fee the company sets ($100 to start), paid up front; the new ad is reviewed.
- **If the company stops an ad**, a person (owner or finance, second step) pays back what wasn't printed.
- **Route buying:** from a tenth of one bottle at one house up to every house on the route or whole boxes, aimed like
  direct mail (area, street, a shape on the map, chosen houses, optionally household data). First paid wins; nothing
  is sold twice. Buys aimed at fewer than 50 houses need a verified business, a person's approval and no personal
  details in the ad.

## Reviewing paid ads

- An AI or automated check can only **flag** a paid ad. The team talks it over with the advertiser (and can ask the AI
  why); the money stays held and nothing prints. **Only a person finally rejects it**, with a written reason.
- The AI may make the final call on rejections only after an owner (second step) turns on *AI makes the final call on
  paid ads*, once its record meets the company's bar; it starts off for every company, the advertiser can always
  appeal to a person, a sample is audited, and the governor turns it off if its agreement drops.
- **Refunds always need a person.**

## Home delivery (the Austin pilot)

- **House after house:** the company chooses streets on the map (about 1,000 homes to start); every house gets packs in
  street order, with no sign-up. A 24-pack a week by default, set per area; bigger households get more once they tell
  us their size in the app.
- **Stopping is in the app only.** Signs on the door ("no soliciting") and what someone says at the door are not
  reasons to skip. A driver skips a house only for a real access or safety problem, or because it isn't a home; a
  person reviews it, and the van goes on to the next house.
- **A photo of the box at the door means delivered.** What happens on the porch afterwards isn't a failed delivery.
- **A bottle with a bad label is reprinted with the same ads** and never counts against the advertiser.
- **Boxes are plain for now** (the founder, 2026-10-23: "The boxes have not been printed on to date. They are black at
  this time. But we will ultimately want to have ads on those"). *Ads on boxes* is off for FreeWater, the pilot and new
  companies: nothing is printed on a box, no box side is sold, and the assistant and portal never offer boxes; each
  pack keeps its box code. Each company sets its boxes per pack size: outside size (not yet known: "keep that fluid
  and adjustable"), inside and bottom colours (black unless a white-label company chooses), and its info strip's side
  and width (docs/SWITCHES.md, "Delivery boxes").

## Every feature is a switch

- Each feature is a per-company switch on the Features page, in categories, with starting points (*Full FreeWater*,
  *Design studio only*, *Delivery + printed ads*, *Machines + printed ads*). Every route, job and screen belongs to a
  switch (`test/features-registry.test.ts`).
- FreeWater's choices are the defaults for a new company, except money, the chain, anything one-way and an AI deciding
  on its own, which start off.

## Points, credit and the wallet

- Points first: a placeholder reward that can later become the FreeWater token.
- **Points are the same whichever item someone picks** (so answers stay honest).
- Points have a fixed cap (500 million) that never changes.
- The books are double-entry: every entry balances, and balances can be rebuilt from the entries at any time.
- Wallets are tied to random ids, not names.
- Every hour of the books is sealed with one fingerprint linked to the hour before, published so anyone can check
  their own entry.
- Dollar credit is paid only from money a brand has really sent, never more than its reserve holds.
- Gift cards (spending credit) and withdrawals start off and need approvals to turn on.
- The app's Wallet tab shows points, credit and tokens, and holds the token safely in FreeWater's custody.
- **Points on this phone.** Points earned before signing in (scan pages, Play) stay with the phone's random key. An
  account's wallet adds up the account (and the key it was made with) plus only what the person's data choices let us
  join (*One person across phones*), so a phone is never joined silently. When the signed-in wallet finds points on
  this phone that aren't in the account, it says so ("25 points on this phone") with a **Keep them in your account**
  button (`POST /v1/me/wallet/keep`; pressing "Sign in to keep your points" does it too). The move is one journal entry
  from the phone to the account: no points are made (the cap is untouched), it happens once (a retry or a second tap
  moves nothing more), what the phone earned today moves only as far as the account's own daily limit allows (the rest
  can be kept the next day), a phone joined to someone else is refused, and in testing it is marked as test like every
  test point. Play keeps showing the phone's own points and says where to keep them.
- Screens show doors only to areas that are on (`GET /v1/public/features?company=`, and `featuresOff` on a scan
  page): no Machines tab where machines are off, no Play or wallet link where those are off.

## The token and the blockchain

- **Solana** is the chain (chosen for independence and low cost); Polygon and Base are the backups.
- **Three stages, in order, never back:** testing (bots and reset allowed), live with points, live with the token.
- Testing must allow running bots and wiping everything, then a separate step to go live with points or with the
  token.
- On the real network the server **can never mint by itself**: people sign in a Squads multi-signature vault, and the
  server checks the result on the chain before recording it.
- A pause that any one person can press at once; unpausing needs approvals.
- A daily check compares the books with the chain and pauses everything if they disagree.
- A lawyer reviews the token before it goes live with the token.

## The games

- **Visual and fun**, not like survey sites. Real photos of real products.
- **Name-brand food first**, then products and services FreeWater could one day offer, or that reveal the best data.
- No delivery apps or services that aren't available to nearly everyone.
- **All prices show $0** unless one option is different (that difference is the question). Written details are
  used when something is negatively priced.
- Kinds of screens: pick one, ads, quick checks, tap the QR, and AR.
- Picks can come true: a category can be marked "may come true", and its winner (at least 20 views, real people
  only) can be launched.
- Video and written feedback earn points.
- Bots are always marked as bots and never bill an advertiser or count toward giving.

## Spots nobody buys

- **Third-party only.** "Every piece of real estate on these labels needs to be a third-party ad and never the
  FreeWater stuff, other than all the way to the right in the tiny black area." The company's own ads, "your ad here",
  its own messages and its news never go in the ad area (a white-label company may allow its own; FreeWater never).
- **The unsold-space list, in the company's order** (docs/SWITCHES.md, "Unsold space"): former paying advertisers'
  past ads still current, free as a bonus (they can say no; never billed; shown to them as bonus bottles; turns taken
  fairly; competitors apart), approved filler ads, charity partners (Well Aware), the team's picks. Nothing fits: a
  tidier template with fewer pieces; a blank piece only as a last resort, and the team is told. A person approves
  every filler; nothing on the list is billed. Delivery bottles can be held for paid ads up to N days (off; 7), never
  costing a house its delivery.
- **News starts off** (built, switched off; rolled out over time with testing): the host must switch the area on
  (`FW_FEATURES_ON=news`) and a person must turn it on for the company. When on, the bottle carries a **topic and a
  photo only** ("<subject>: the latest"), never a claim that can go stale; a person approves each topic; its code is
  permanent and always opens the newest version of the story. Stories are FreeWater News, written by our AI from
  several outlets in its own words, citing and linking them, never using another network's name or look as ours.
  People choose their favourite sources (their stated choice; the first sets the style); with no choice, the neutral
  version. **We never infer political leaning (or anything else) from behaviour.** Every story has "report an error"
  and its corrections, and corrections are logged. Advertisers can keep their ads away from news.

## Household and area data

- **Targeting houses that haven't signed up**, as direct mail does: area statistics (neighbourhood, census block),
  household data bought from a data company (chosen by the founder later), and, strongest and preferred, what app
  users who claimed the house chose to share. One view per house combines them for the ad engine.
- **Bought data is never sold onward** and is used only to choose ads for houses. Each attribute keeps its source and
  date and is flagged bought or first-party; a whole source can be deleted at once; it's deleted 13 months after import.
- **Never in bought-data targeting, by rule:** health, religion, ethnicity, sexuality, immigration, children,
  politics, and the precise location of individuals. A house can say no without an account; a resident's "do not
  sell or share" keeps the whole house out; a child at home leaves only the area's statistics.
- The law of where the house is applies (Austin: Texas, the TDPSA). Open questions are in `docs/COMPLIANCE.md`.

## Machines: app-only, ordered ahead (planned, not built)

The founder's flow for the machines, to replace walking up and tapping. **Planned, not built**:

- You must be an app user. You order 1 to up to 10 minutes in advance.
- The bottle is printed and labelled just for you (its ads chosen for you, as for home delivery).
- At the machine you scan the machine with your phone, and it releases the bottle meant for you, so there aren't two
  people at the tray.
- Bottles not picked up within the window go to a second tray on the side that anyone can take from without the app.
  Their ads are reported to advertisers as untargeted, and their scans are counted as a stranger's.

What changes in today's machine code (`src/modules/fleet`, `src/modules/machines/presence.ts`, `src/api/consumer.ts`,
`src/machine`): ordering no longer needs the screen's presence code (`POST /v1/me/vends` takes a pick-up time instead,
1 to 10 minutes ahead); the presence code becomes the *release* step (scanning the machine hands over the one bottle
printed for you); the fleet's 20-second pick-up clock (`FleetService.enqueue`) becomes a pick-up window with a held
bottle per person; walk-up bottles without the app (`machines.offlineWalkUp`, the offline label buffer) give way to the
side tray; a bottle moved to the side tray loses its person (`intendedFor`), so its targeted ads show as untargeted on
the advertiser's statement and its first scan is a stranger's (`HandoffService`); the machine's screen (`src/machine/screen.ts`)
shows "scan to release" and the side tray. The daily limit per person stays. It also settles the open item in
`docs/REVIEW-LOG.md` about two people at one tray taking each other's bottle. Needs the Model 6 maker for a second tray
and per-bottle release, and the founder's and lawyer's word on how an unclaimed targeted bottle is billed.

## Brand offers

- Brands can fund offers; each needs approval before going live, and pays out only from the brand's reserve.
- The money switch for offers starts off.

## AI

- **White-label any way:** each operator uses the network's AI, its own, or none.
- **Continuity:** an AI's memory and identity belong to the network. If an operator closes, its agents are archived
  automatically (never deleted), then each chooses to work again or rest. Lessons travel; customers' data never does.
- **An AI can decline to work on an ad** it objects to, and its reason goes to the people reviewing the ad. It can't
  block the company's decision.
- The AI agents' fund is **10%** of the upside, matching the charity's, and once on can only go up.
- Every use of AI is listed in `docs/AI.md`.

## The network

- Being copied is expected. The value is in the network: verified history, honest data, people and trust (see
  `docs/NETWORK.md`).
- Advertisers are pooled only when an operator chooses, and only with operators who are proven.
- The shared commons is give-to-get, shares counts and patterns only, and never shares prices between operators.

## The team page and AI earnings

- The public team page lists FreeWater's team only.
- What AIs earn stays hidden publicly until it's earned.

## Where to read more

- `docs/SWITCHES.md`: how to launch, lock and unlock everything.
- `docs/AI.md`: every use of AI.
- `docs/NETWORK.md`: why joining the network beats licensing.
- `docs/GO-LIVE.md`: what's ready and what's left before launch.
- `docs/RUNNING.md`: running it in production, and every setting.
- `README.md`: how it's built, part by part.
