# FreeWater platform: what it does

## In one paragraph

FreeWater gives people free, high-quality bottled water, paid for by the ads on the bottle. Each bottle is printed on
the spot with up to ten ads, and each ad has its own QR code. When someone scans a code they get the advertiser's
page, an offer, a 3D model to view in AR, or a way to buy. Advertisers pay up front for a number of bottles at a
flat price per size, with AR, video and scans included, and exactly that many bottles go out with their ad. Taps on
links are counted, never billed. Part of every
bottle's money goes to clean-water wells through Well Aware, and the books are open for anyone to check. This
platform is the software that runs all of it. Other companies can also run it under their own brand.

## The big pieces

**1. The bottle**
- It takes an order, picks the ads (flat prices for the pilot; an auction like Google's for a company that chooses
  it), lays out a print-ready label, prints it and drops the bottle. Only bottles an advertiser paid for carry its ad.
- The label is cut into near-square pieces, from the whole label down to a tenth, always in one of 16 tidy layouts.
  No two competitors share a bottle. Each company chooses which layouts it uses (on its Features page, with a picture
  of each), per product too, the most ads on one bottle (1 to 10), and whether each paid ad takes its turn or the
  best-earning layout wins (with a fair turn for any ad left waiting).
- It works for any drink and any size. There are samples for a 16 oz bottle, a 25 oz bottle and a 12 oz can.
- Advertisers make an ad three ways: with the assistant, in the studio, or **designing it themselves**: a template
  for every size (PDF, SVG, PNG, from the printer's own numbers), their own files uploaded in the chat or on an upload
  page, each matched to its size and checked with a plain Pass or Fix these (and one-tap fixes), then shown on a real
  label before paying. The QR code is always ours; they choose where it leads and its colour (only if it scans), and
  changing a link on a live ad costs a fee ($50 for FreeWater).
- Every piece of the label is another business's ad, never FreeWater's own (only the black panel on the right is
  ours). Spots nobody buys are filled from a list in the order we choose: former advertisers' past ads (still current,
  free, as a bonus they can say no to), approved filler ads, Well Aware and other charity partners, ads we pick. If
  nothing fits, a tidier layout with fewer pieces; a blank piece only as a last resort, and we're told. Delivery
  bottles can be held a few days for paid ads (off by default), never costing anyone their delivery.
  **FreeWater News** (a topic on the bottle, the newest story behind its code) is built but switched off until it's
  rolled out.
- Ads for houses that haven't signed up can use area statistics and household data from a data company (never
  sensitive kinds, never sold), with what residents chose to share preferred.

**2. The machines (Model 6)** (built; switched off in the pilot, which is door-to-door delivery: machines come later)
- The software that runs inside the vending machine: its screen, printing, faults and keeping going when the
  internet drops.
- You have to be standing at the machine to get a bottle, and there's a daily limit per person.
- *Planned, not built:* app users order 1 to 10 minutes ahead, the bottle is printed just for them, and scanning the
  machine releases theirs; bottles not picked up go to a side tray anyone can take from, counted as untargeted
  (`docs/REQUIREMENTS.md`, "Machines").

**3. Home delivery**
- The pilot: **house after house** on streets FreeWater chooses (about 1,000 homes in Austin to start). Nobody signs
  up; every house gets a free 24-pack a week unless someone there stops it in the app. How often, pack size and packs
  per house are set per area, and bigger households get more once they tell us their size.
- Signs on the door ("no soliciting") are ignored: people who don't want free water stop it in the app and we skip
  their house. Drivers can skip a house only for a real access or safety problem (a locked gate, a dangerous animal,
  no safe place to leave it) or because it isn't a home; a person reviews it.
- **Advertisers buy the routes**, paid up front at an exact price: N bottles spread over an area, one bottle in every
  box at every house, a whole box (every bottle and its sides), or chosen houses (as little as a tenth of one label at
  one house), for chosen weeks, by area, street, a shape on the map or address, optionally by household data. Every
  piece is reserved on a real bottle when paid, so nothing is sold twice (first paid wins), and printed once, at that
  house. If a house stops or blocks the ad, the advertiser gets that part back (credit for other houses, or a refund
  for a one-house buy). Buys for fewer than 50 houses get stricter review, a verified business and no names or
  addresses in the ad. Advertisers see streets, drop times and scans by area, never a house or a person.
- Later, and for people who join the app: free 6, 12 and 24 packs on a schedule they choose.
- Every bottle in a pack is different, and the box itself carries ads.
- Each night is planned: routes are set, boxes are packed and checked, and the van is loaded so the next stop is
  always by the door.
- The driver app only marks a delivery done when the right box is scanned at the right house **and** the driver took
  a photo of it on the doorstep (or a person on the team vouches for it, with a reason). Delivered with its photo is
  delivered: a box taken from the porch afterwards isn't our failure. The photos show people's homes, so only the team
  and the people who live there see them, never advertisers; nothing hidden in the phone's file is kept; and they're
  deleted after 90 days (each company can set 1 to 365).
- A bottle whose label comes out wrong at the packing check is reprinted with exactly the same ads; the bad one never
  counts against an advertiser, who pays once, for the bottle that went out.

**4. Scanning, AR and buying**
- Our own QR codes. They can't be faked or guessed, and every scan reaches us first.
- Pages that need no app to install.
- Three kinds of AR: in your space, on the bottle, and a "living label" over the real one.
- A buy button inside AR.
- Sales are matched to the exact bottle through tracked clicks and one-time coupons.

**5. The FreeWater app**
- Get a free bottle at a machine and see every bottle you've had.
- Set up home delivery, or stop (and restart) the free water left at your house.
- Design your own paid bottle by chatting (birthdays, weddings, teams).
- A **Wallet** for points, credit and later the token.

**6. FreeWater Ads (for advertisers)**
- Advertisers sign up in a minute and make an ad by chatting with the AI, which can't break anything because every
  change is checked.
- They preview the ad at every size, see the exact price, and **pay up front** by card for a number of bottles.
  Then it's approved twice: once by them and once by FreeWater. Only paid bottles print, and they see "N of M bottles
  out" until every one is. There's no end date and no cancelling; pausing only delays.
- Changing a running ad costs a fee ($100 by default), paid up front; the new ad is reviewed before it prints.
- If FreeWater stops an ad, a person on the team pays back the bottles not printed, to the card.
- If review has a concern about a paid ad, an AI or automated check can only flag it. The team talks it over with
  the advertiser (and can ask the AI why) in notes both see; the advertiser can fix it for free meanwhile; only a
  person rejects it, with a written reason, and only then is a refund offered. The money stays held and nothing prints
  until it's settled. Once the AI reviewer has earned it with its record, an owner may let it make the final call on
  rejections (off to start, for every company); the advertiser can still appeal to a person, and every refund is
  still approved by a person.
- Fees on top (per scan, per AR launch, per box side, commission on sales) each have their own switch and are off.
  Turned on, they're charged to the card each day, and a declined card pauses the ads at once.
- Brands can fund **offers** for people.

**7. The game**
- A visual, fun game of real products, name-brand food first. Players pick one, tap the QR, try AR, and send video
  or written feedback.
- It teaches FreeWater what people actually want. The most popular picks can "come true" as real products.
- Answers earn points, and points are the same whichever item someone picks, so answers stay honest.

**8. Points, credit and the token**
- Points come from scans, games and feedback. Dollar credit is paid only from money a brand has really sent.
- Gift cards through Tremendous, once people approve turning them on (they start off).
- Later, the FreeWater token on **Solana**. On the real network it can only be created by people signing together
  in a Squads vault, never by the server alone.
- Everything goes through three stages, in order: **testing** (with bots and a full reset), **live with points**,
  and **live with the token**.

**9. Open books and giving**
- Every cent is in double-entry books that can only be added to, never edited.
- A public site shows the money in, the money out and the giving, down to a single bottle.
- Each day and each hour gets a fingerprint published to GitHub, so nobody can quietly rewrite the past.
- Charity transfers are tracked and sent.
- A live public feed shows activity, and never names anyone.

**10. Data, privacy and the law**
- It collects everything the law allows, using the US as the maximum.
- Each person gets the privacy law of where they are. A company can be stricter, never looser, and the strictest
  rules apply when we don't know where someone is.
- People can download or erase their data. It's used to train our AI and plan future free products, and it is
  never sold.
- Each person chooses how much to share: **full, medium or lite**. Everything works the same at every level; only
  full earns points, once, where the law allows.

**11. Running the company**
- **The console** for owners: every setting with its history, the team, keys, machines, giving, and every
  on/off switch.
- **The ops console** for the daily work: ad review, machines, routes, deliveries and the books.
- **The developer portal**, API keys and webhooks for partners.
- **The prize game** (off until a lawyer approves it).
- An **AI agents' fund** (10% of the upside, matching charity).
- **AI that's white-label any way:** each operator uses the network's AI, its own, or none. An AI's memory belongs to
  the network: if an operator closes, its agents are archived, never deleted, and each chooses what's next.

## How it's built

- One server (TypeScript) and one Postgres database. It's tested by about 800 automatic tests on every change.
- **Swappable parts:** every part can be replaced, including the database, the printer, payments, messages, maps,
  the AI, gift cards and the blockchain. Until a real provider is chosen, a safe stand-in runs and says so.
- **White-label:** another company can run it all with its own brand, prices, giving and rules, and can never see
  anyone else's data.

## The safety rules

- Anything involving money, the blockchain, or that can't be undone starts **off**. It needs people to approve it
  and a waiting period.
- Turning anything off is always immediate.
- Safety limits never come off.

Every use of AI is in `docs/AI.md`. Why joining the network beats licensing is in `docs/NETWORK.md`. The full rules are in `docs/REQUIREMENTS.md`, and every switch is in `docs/SWITCHES.md`.

## Where it stands

All the software above is built and tested. What's still needed before launch is mostly accounts and people:
- hosting;
- providers for payments, messages and maps;
- the label printer;
- a lawyer;
- 2 more approvers for token steps.

Withdrawals to people's own wallets aren't built yet. Prices in the code are placeholders. `docs/GO-LIVE.md` has
the full list.
