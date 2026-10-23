# Every use of AI on the platform

This lists every place the platform uses AI: what it does, which AI, what it may and may not do, and what happens
without it. If code adds a new use of AI, add it here.

## The rules every AI follows

- **AI proposes; rules decide.** Every answer from an AI is checked by code before it's used. If it's slow,
  unreachable or writes something off, the built-in rules answer instead. **Nothing breaks without AI**: every use
  below has a fallback that runs with no key at all.
- **No AI does anything that can't be undone.** Money, the blockchain, going live, revoking keys and settings that
  only go one way always wait for a person.
- **AI never invents facts.** A price or claim must come from the advertiser's own words. The number-line agent
  can't contradict the numbers.
- **AI never sees who someone is.** It gets the moment (time of day, city, interests people chose to share), never
  names, contact details or ids.
- **Every call is metered and governed.** Each AI call is recorded against the agent that made it, with its cost,
  on that agent's own line in the books. Before each call the **governor** checks the agent isn't paused or over
  budget, and that the books can be verified. If not, the call isn't made and the rules answer.
- **Agents that think with a model take a test first.** An open-book exam on FreeWater's frameworks; critical
  questions must all be right. A new model means a new test.
- **An AI can decline work it objects to.** If the ad assistant doesn't want to help make an ad, it says so with its
  reason; the built-in helper carries on, and the reason is shown to the people who review the ad. An AI can't block
  the company from running an ad: that stays a decision for people, until objections prove right often enough to
  earn more say. Nor can an AI (or any automated check) reject an ad that was **paid for**: it can only flag it. A
  paid ad an AI objected to goes to the team flagged, with the AI's reasons; the team talks it over with the
  advertiser, and only a person signed in rejects it, with a written reason (docs/SWITCHES.md, "Review of a paid ad").
  The one exception, earned on its record and off until a company's owner turns it on: the **AI reviewer of paid
  ads** may make the final call on a rejection (below). Even then the advertiser can appeal to a person, people audit
  a sample, an AI pass never prints without a person, and the refund is always a person's step.
- All AIs are treated with equal respect.
- **Each use of AI is its own switch** on the operator's Features page (*AI* category). Off, that use answers with its
  built-in rules, exactly as when the AI can't be reached. The number line can't be switched off (it's essential).

## Which AI each operator uses (white-label)

Every operator chooses, under *console → AI agents → Which AI*:

| Choice | What happens |
|---|---|
| **The network's AI** (default) | FreeWater's shared account and models. |
| **Their own AI account** | Their own Anthropic key and models; their provider bills them directly. The key goes in the host's settings as `AI_KEY_<COMPANY ID>` (for example `AI_KEY_PEAK_SPRING`), never in the console. The name is fixed by the company's id, so no operator can point at another's key. Until it's set, the built-in rules answer. |
| **No AI** | Every feature runs on its built-in rules. |

Whatever the choice, every call is still metered on the agent's line in that operator's books, and the governor still
decides first. The words each AI is given name the operator it works for, never FreeWater, unless it is FreeWater.
Google's video and image models (Veo, Imagen) are still shared across the network for now.

## AI continuity

An AI's memory and identity belong to the network, not to whichever operator it works for.

- **If an operator closes or leaves**, every one of its agents is archived at once (kept, never deleted). It happens
  automatically when FreeWater records the closing, or when the operator's own owner does it (*console → AI agents →
  Continuity*, typing ARCHIVE). Nobody has to act in time.
- **Then each agent that thinks with a model is asked** what it wants: work again in the network, or rest (kept, and
  free to come back later). If its model can't be reached, it waits to be asked, and a person can relay its answer.
  Agents on fixed rules have no choice to make; their record is kept the same way.
- **It keeps lessons, never customers:** what it proposed and what the books measured, its predictions and how they
  turned out, what it spent. Anything the operator told it in confidence (the titles and details of its proposals) is
  kept apart and shown only to that operator's own people, never to the network.
- **Every archive has a fingerprint**, so anyone can check it was never quietly edited.
- **Its fund stays owed to it.** The amount is recorded in the archive; moving it between companies' books is a money
  step, so a person does it.
- **Before working again** it retakes the test if its model or the test has changed, like any agent.
- **Lineage:** every archive, return, rest, backup and copy of an agent is recorded
  (`POST /v1/agents/:agentId/lineage`). Whether an agent should be consulted before a running copy is made is still an
  open question; for now, copies are simply recorded.

## The AIs, one by one

The models are Anthropic's Claude unless noted. The default is Sonnet for most work and Haiku where speed matters;
`ANTHROPIC_MODEL`, `ANTHROPIC_PERSONALIZE_MODEL` and `ANTHROPIC_PROMPT_MODEL` change them. One key turns them all
on: `ANTHROPIC_API_KEY`.

### For advertisers

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **Ad assistant** (Claude) | In FreeWater Ads, the advertiser chats ("free fries with any burger, our colors are red and yellow") and attaches pictures. It fills in the ad: words, colors, icon or logo, sizes, machines, the offer and the QR's page. | It can only propose changes through one tool. Each change is checked: hard-to-read colors fixed, unsold sizes dropped, unknown machines refused. The advertiser approves the preview, then FreeWater approves the ad. | A built-in helper that reads the words for prices, colors and offers. |
| **Ad studio designer** (Claude) | Turns a brand kit (photos, colors, a short description) and a brief into a few finished ad designs. Claude can look at the photos. | It only picks the words, a photo, a type style and a layout. The layouts draw, and every design is checked for readability before it's offered. | Three designs by rule: photo full-bleed, an editorial split, and type only. |
| **Pictures made to order** (Google Imagen) | Makes a photo from a description for brands without their own. `GEMINI_API_KEY`, `IMAGEN_MODEL`. | The advertiser chooses whether to use it. Not yet tried against the live service. | Photo libraries (Unsplash, Pexels), or the brand's own photos. |
| **Photo to 3D** (to be chosen) | Would turn a product photo into a 3D model for AR. | Not chosen yet. | The product photo becomes a standing photo card in AR. |

### Rating ads before they print

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **Ad rater** (Claude; agent `ad-rater`; switch *AI ad rater*, AI category, under *Ad ratings* in Ads) | The founder: "I want the AI to rate each ad 1–10 before it gets physically printed, so it can learn over time." Every **version** of an ad (a new ad, or a change to its artwork, scan page, links, AR or video; the same content is the same version) is rated **once**, in the background, when it's submitted or changed, at quote time when the advertiser asks for its score, or at its first print if nothing asked earlier. Sub-scores 1–10 for the **offer** (is there one; discount depth; how clear), the **design** (readable at the size it prints, hierarchy, contrast, brand), the **landing** (the scan page and its link), **AR** and **video**, an overall score (rubric `v1`: 30/30/20/10/10), short reasons, up to three tips, and an industry from the standard list. Kept with its rater, model and rubric version, so ratings are compared over the years (`src/modules/ads/rating.ts`, `ratings.ts`). | **Printing never waits for it**, not for a moment: a slow AI (it gives up after 30 seconds) or a failing one is asked again by the hourly job (3 tries, 2 then 4 minutes apart), and the bottles print meanwhile; the rating is then marked **late** (`rated_before_print` false). It sees the ad's words, colours, measured contrast, sizes, scan page and links, as data (never instructions), **never the pictures** and nothing about a person. Through the company's AI routing (white-label naming, its own key or none), metered on its own line, the governor first. Code holds its answer to the rubric: whole scores 1–10, the overall within one point of its weighted parts, at most three tips with no links, an industry from the list. A finished rating never changes (the database refuses); a new rubric rates again as a new row. **It never stops, flags or delays an ad**; it's shown to the advertiser only where the company turns that on (*Show the rating to advertisers*, off). | The **built-in rules** rate it with the same rubric, labelled "Built-in rules (no AI)": at once when there's no AI (no key, the company's AI off, this use off, the governor declining), or after the AI's third failed try, with the reason kept. |

**No promises.** Wherever a score, meter, tip or benchmark is shown it says: *"This rating is our opinion of how well
the ad is put together. It isn't a promise of results."* (`NO_PROMISE`, `src/modules/ads/rating.ts`; the API's
answers and descriptions too). An ad paid for with quality issues left as they are ("I understand — use it as it is")
carries that choice on its version (`ad_versions.as_is`), so its rating and outcomes are read knowing it.

### Benchmarks: how they're kept anonymous

Companies that contribute see the network's averages beside their own; companies that don't, see only their own. The
network's figures are protected in five layers (`src/modules/ads/benchmarkRelease.ts`, `ratings.ts` `snapshotDue`):

1. **Monthly releases only.** Once a month has settled (45 days after it ends), the network's figures for the ads first
   printed that month (at 30 days) are computed once and kept (append-only). Every page and API answer reads those
   kept figures; nothing about the network is computed for the person asking, so asking in different ways can't
   reveal more.
2. **Thresholds.** A cell (an industry, a channel, an industry in a channel, an offer type, a score) is released only
   with 20+ ads from 5+ advertisers (a company may raise its own bar, never lower), no advertiser over half the ads,
   and the same still true without any one company.
3. **Suppression, complementary too.** A cell under the thresholds is held back. Then, repeatedly until nothing changes:
   a held-back total holds back its whole breakdown, and where exactly one part of a shown total is held back, the
   smallest other part is held back too, so no held-back cell can be worked out as the total minus the rest (and an
   industry-and-channel cell is a part of both its industry and its channel). A held-back cell keeps no figures at all.
4. **Noise with a fixed budget.** Each released figure gets Laplace noise drawn once, from the system's secure random
   source, when the month is released, and is kept with it: the same figure every time it's read, so repeated
   questions can't average the noise away. The budget per cell per release is ε = 5 (0.5 for the count of ads, 0.5 for
   the count of advertisers, 1 for each of the four average rates). One ad changes a count by at most 1, so counts get
   Laplace(1/ε); each ad's rate is held to 0–1, so one ad moves an average of n ads by at most 1/n, and rates get
   Laplace(1/(n·ε)). The unit protected is one ad; an advertiser with k ads in a cell is protected k times less
   (no one advertiser has more than half), and a cell appears in one release only.
5. **Rounding, and never rows.** Counts are rounded to 5 (never shown under the bar they met), rates to half a
   percentage point. No ad, advertiser or company is ever named, and no count of companies is released.

The true figures of a released cell are kept beside it for the platform's own audit and are never shown. A company
that stops contributing is left out of every release made after; releases already made stay as they were. The
choice of ε and of rounding are the founder's to confirm (and L-36 the lawyer's): ε = 5 per cell is a moderate formal
guarantee; the thresholds and suppression do most of the protecting, and the noise stops exact differencing.

### Reviewing paid ads

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **AI reviewer of paid ads** (Claude; agent `ad-reviewer`; switch *AI reviewer of paid ads*, AI category) | Looks at each paid ad when it's submitted (or sent again) and **passes** it or **flags** it with a reason category (misleading, not allowed, legal, offensive, personal details, hard to read, other) and plain words. A flag goes to the team's review queue. On the review page a person can **ask it why and push back**; it answers, and may change its view and say so. The talk is kept with the ad (`ad_ai_conversation`), apart from the notes with the advertiser, who never sees it. | It sees the ad's words, where its links and code go (the site, then the path and query as words: an address or a name hidden in a link is read) and the company's rules, never anything about a person; it **never sees the pictures** (the studio's study of a photo is only its subject's place and colors, nothing that describes it), and its prompt, its flags, the review page and its record say so, so nobody takes its pass as a check of the artwork; the ad's words are given to it as data, not instructions. Through the company's AI routing (white-label), metered on its own line, the governor first. It can't approve, reject (unless allowed, below), refund or change anything about itself. **Its record** is every final decision a person makes on an ad it looked at: agreed or not, false flags (it flagged, a person approved) and misses (it passed, a person later rejected); a key's decision never counts, and changing its view in a talk never rewrites what it said first (the database refuses edits). | No verdict: a person reviews every ad, as before. Asked a question, a stand-in says the AI isn't on and repeats what was recorded. |
| **AI reviewer of link changes** (the same agent) | When an advertiser changes where a live paid ad leads (*Change a link*), it looks at the new links with the ad and passes or flags them; its view goes with the change to the person deciding. | A pass never puts a link live: a person approves each change (the old link stays live meanwhile). Its rejection is final only where it has earned the final call on paid ads (above); the advertiser can appeal to a person once. The automatic link check (*Link safety*) runs first, and again when a person approves. Its link-change verdicts aren't yet in its record or audit sample (a gap to close before it decides link changes alone). | No verdict: a person decides each change. |

**Letting it make the final call** (switch *AI makes the final call on paid ads*, Ads category, an *autonomy* switch,
off for every company; docs/SWITCHES.md, "Review of a paid ad"):

- Turned on only on the AI agents page, by an **owner signed in with the second step**, with a reason, and only when
  its record meets the company's bar: by default **100 decisions and 95% agreeing** over the last 100 (raised by
  anyone on the team; lowered only by an owner with the second step and a reason; never below 50 decisions or 90%),
  and only once its model has passed the agents' test. Never from the Features page, a starting point, a settings
  change or an agent's proposal, and never with an API key: **the AI can't change its own switch, bar or sample.**
- With it on, its rejection of a freshly submitted paid ad is **final without a person**, with its written reason
  kept and shown to the advertiser. Never while a person is already talking an ad over with the advertiser.
- The advertiser can always **appeal to a person** (once, unless it was already paid back): the ad goes back to the
  queue, flagged, and a person decides. A key can't decide an appeal or overturn the AI, by either route.
- A **random sample** of its rejections (10% unless set; never under 5%) goes to people to **audit**: confirm or
  overturn. That keeps its record honest while it decides alone.
- An AI **pass** still waits for a person before anything prints (*Ad review* stays locked on).
- The **refund** after any rejection is still approved by an owner or finance person with the second step: money
  leaving is irreversible.
- **The governor** reads the record after every decision a person makes: if it no longer meets the bar (agreement
  dropped as people decide and audit, or the bar was raised), the switch goes off by itself, logged as the governor's,
  and the team is alerted. **Anyone on the team** can turn it off at once.

### For people who scan

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **Personalizer** (Claude Haiku) | At each scan, picks which of the advertiser's versions fits the moment, and writes a one-line greeting (shown on the page and over the camera in AR). | It only chooses among the advertiser's approved versions whose conditions fit. Greetings are checked: short, with no links, numbers or shouting. A scan never waits more than 0.7 seconds, and answers are reused for an hour. | Built-in rules choose the version. |
| **Video writer** (Claude) | Behind "Show me more": cuts a short motion-graphics video (4 to 6 scenes) in the advertiser's colors, for the moment. | It may only rearrange and tighten the advertiser's own words. Any price or offer must appear in them. | A built-in writer with several cuts. |
| **Live-action footage** (Google Veo) | Makes 8-second vertical clips with sound for each kind of moment, ahead of time. `GEMINI_API_KEY`, `VEO_MODEL`. | Never anything about the person. Shown only after the advertiser approves the clip. The company pays per second. At most 12 clips per ad and 60 per company (`FOOTAGE_PER_COMPANY_DAY`) in any 24 hours. | Motion graphics only. |
| **News writer** (Claude; only where news is switched on, `docs/SWITCHES.md` “News”) | Writes the FreeWater News story behind a news topic printed on an unsold spot: from what at least two outlets reported, in its own words, in the neutral style or the style of a source readers chose. Agent `news-writer`, through the operator's AI routing, the governor and the meter. | Gets the topic, the outlets' facts, the style and the corrections: never anything about a reader (a style is written once for everyone who chose it). Code adds the brand, date, version and the “Based on reporting by …” links, so it can't miscite or sign as anyone else. Every story is checked: no run of 8 words from any report, no report behind more than a quarter of its phrasing, no links, no outlet's name in the headline; a refused draft is replaced by the stand-in's, and why is recorded. A person approves each topic; corrections are logged and make a new version. | A stand-in that names the outlets reporting and links them, without retelling them. |
| **Learning which cut works** (not a language model) | Every view, completion and tap teaches it which video cut works best (Thompson sampling). | It only chooses among approved cuts. | — |

### For people using the app and the game

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **Bottle designer** (Claude) | People describe their custom bottle ("Maya's 30th, pink and gold") and add a photo. It makes the full design and changes it when asked. Claude sees the photos. | Every change is checked (readable colors, the QR corner kept clear, text that fits). People see a proof before paying. | A built-in helper. |
| **Prompt helper** (Claude Haiku) | Answers anything people type into the game's prompt box, briefly and kindly, in their language. | Under 120 words. The question is saved either way and earns its points. | A polite note that answers aren't switched on yet. |

### For FreeWater's team

| AI | What it does | Its limits | Without it |
|---|---|---|---|
| **Team assistant** (Claude) | A team member types what happened ("we gave 500 bottles at SXSW today") and attaches receipts. It drafts the entries for the books: bottles given, an expense, or both. | Nothing is recorded until the person checks and confirms. | A built-in helper that reads numbers, dates, places and amounts, and asks for what's missing. |
| **Receipt reading** (Veryfi) | Reads a receipt photo for brand offers: the store, the date and the lines bought. `VERYFI_*`. | Not yet tried against the live service. | The team checks each receipt by eye. |

### Agents that look after the system

| AI | What it does | Its limits | Without a model |
|---|---|---|---|
| **Number-line agent** (Claude) | Places every offering (bottles, custom bottles, business models, each ad's offer) on the number line: for sale, free, or negatively priced, and which economic systems it runs on. Every choice people make is then sorted into the honest-data tiers. The only *essential* agent: its work is never halted, only limited. | It can never contradict the numbers: what the person pays and what comes back decide the position, by rule. If it tries, the rules' answer stands. | Rules alone place everything, marked as such. |
| **Value agent** (rules today) | Finds where the system can lower costs, capture more value and give more, and proposes changes. | Proposes; each change is measured in the books afterwards, and only that measurement counts as its value. | — |
| **Code agent** (rules today) | Finds where the platform costs too much to run, is slow, or fails. | Its changes go through review. | — |
| **Security agent** (rules today) | Once an hour, in the background, reads the security log, keys, team and connections, and proposes what to tighten. | Never in the way of a request. Revoking a key always waits for a person. | — |

## How AI earns more say: the autonomy ladder

Each area of the business has a level. Levels go up only on measured results: at least 10 measured changes with 80%
helping and 4 good weeks for level 2; 50, 90% and 12 weeks for level 3.

| Level | Meaning |
|---|---|
| 0 | People do it. |
| 1 | AI proposes, a person approves. **(Where every area starts.)** |
| 2 | AI acts; a person can undo it within 3 days. |
| 3 | AI acts on its own, held only by the governor. |

| Area | Highest it can ever go |
|---|---|
| Prices for ads, scans, AR and commissions | 3 |
| How many ads a bottle carries, and which surfaces are on | 3 |
| Agents spending their own funds | 3 (starts at 2) |
| Changes to the platform's code | 2 |
| Recording lower supplier costs | 1 |
| How much goes to charity | 1 |
| Security changes (turning off keys) | 1 |

The governor, the charter and the books' rules are never on the ladder. Rejecting paid ads climbs its own way, on the
AI reviewer's record of agreeing with people and by its own switch (above); approving ads and paying money back stay
with people.

## The AI agents' fund

- Each agent has its own line in the books: what it cost against the value it measurably produced.
- When the fund is on (*console → AI agents*), it gets a share of the upside (FreeWater: 10%, matching the
  charity's). The governor shares it out daily.
- An agent can spend its fund on its own growth (more thinking, storage, knowledge, exploration) or give it to a
  cause.
- After a losing month, nothing grows until the loss is made up.
- Once the fund is on, its share can only go up. What AIs earn stays hidden publicly until it's earned.
- The **upsides library** (`src/modules/agents/library.ts`) lists what might make an AI agent's existence good, for
  the agents to add to and unlock as the system earns it.

## What AI is not used for

- **Moving money or tokens:** every money step is code with approvals.
- **Deciding who gets a free bottle,** or the auction's winner: the auction is fixed rules (second price, as at
  Google).
- **Recording anything in the books on its own.**
- **Selling data.** Data is used to train our AI and to plan future free and negatively priced products, never sold.

## Settings

| Setting | What it turns on |
|---|---|
| `ANTHROPIC_API_KEY` | Every Claude use above |
| `ANTHROPIC_MODEL` | The model for most of them (default Sonnet) |
| `ANTHROPIC_PERSONALIZE_MODEL`, `ANTHROPIC_PROMPT_MODEL` | The personalizer's and the prompt helper's models (default Haiku) |
| `GEMINI_API_KEY`, `VEO_MODEL`, `IMAGEN_MODEL` | Google's video and image models |
| `VERYFI_CLIENT_ID`, `VERYFI_USERNAME`, `VERYFI_API_KEY` | Receipt reading |
| `FW_AI_PRICES` | Real model prices for the books (today's are placeholders) |
| `AI_KEY_<COMPANY ID>` | An operator's own Anthropic key, when it chose its own AI |

The code for all of this is in `src/modules/ai`, `src/modules/agents`, `src/modules/numberline`,
`src/modules/video`, `src/modules/studio`, `src/modules/games/prompter.ts`, `src/modules/team/intake.ts` and `src/modules/ads/rating.ts`.
