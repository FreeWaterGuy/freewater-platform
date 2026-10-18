# Honest Data Labs (deck of 2 September 2026)

_Josh Cliffords. Transcribed from the slides. The authority on measurement design: how to set up an environment so the choices people make in it measure what they actually want. The funding ask is left out. Every figure here is an example or a cited estimate for context, never a fact about FreeWater._

## Slide 1: The economy has never directly measured what people actually want

Purchase data records choices under affordability constraints. Honest Data Labs is building an instrument that observes demand at positive, zero, and negative prices. The number line runs from get paid (negative price) through zero price to pay (positive price).

## Slide 2: Every purchase contains preference plus constraint

A receipt records the choice that won inside a budget, not necessarily the choice that would have won without it. Household A wants A and can afford A, B and C, and buys A. Household B also wants A, but can afford only B and C, and buys B. Same underlying preference, different observed purchase. The transaction mixes want with constraint.

## Slide 3: More data does not fix the measurement

In simulations, conventional purchase records and free-choice observation sit on different learning curves. Free-choice observation (Tier 3 data) recovers more of people's preferences, and the gap widened at every duration tested: four years of conventional records still did not reach twelve months of free choice. More observations of the same regime cannot recover information that the regime systematically hides.

## Slide 4: Reconstructing the missing preference fails silently

To recover a household's latent preference from purchases, a model needs three things: the household's utility function (how it values attributes and substitutes), its true category budget (what it can actually spend on this category this week), and the assortment process (why these products were available and the alternatives were not). In the real world companies can estimate pieces of these; they do not know all three perfectly, and the failure can remain silent. There is no unconstrained behavioral ground truth to validate whether a reconstruction is actually right.

## Slide 5: What honest data is

Most big data lives in Tiers 1 and 2. Honest data is Tiers 3, 4 and 5. Tier 1, constrained data: choices shaped by price, measuring what people can afford, not what they truly want (positive price). Tier 2, compliance data: choices shaped by gates, measuring what people will tolerate to get something free (gated free). Tier 3, revealed preference: choices made when products are free, showing what people actually want (free). Tier 4, values-weighted preference: choices made when products are negatively priced or better than free, showing what people value, support, or redirect value toward (negative price). Tier 5, brand commitment signal: choices made when paid products compete against free alternatives, showing loyalty strong enough to overcome free (paid versus free versus negatively priced). Honest data captures what traditional datasets miss: what people actually want, value, and stay loyal to.

## Slide 6: Direction is useful; distance is more valuable

Tier 3 reveals what wins: a free choice gives an ordering (at zero price, A wins over B). Tiers 4 and 5 reveal how strongly the person prefers it: a priced tradeoff reveals strength. If option B returns value, step the value up: at one cent the person still chooses A, at five cents still A, at twelve cents they choose B. That is the crossing point. Now we know not just which option wins but how far apart the choices are. Tier 4 asks how much value makes you switch. Tier 5 asks how much cost you will accept to stay.

## Slide 7: Tier 3 can be simulated; Tiers 4 and 5 have to be discovered

The mechanism behind free choice can be modeled; the human value thresholds cannot. For Tier 3 we know the mechanism being tested: the budget constraint blocks access to some preferred options; the income distribution can be varied across households; the utility form can be varied to stress-test the mechanism; the assortment rule can be changed to test what remains identifiable. For Tiers 4 and 5 we do not know the distributions: who moves gradually, who stays until a sharp threshold, who switches at almost any returned value, who never switches, and who is repelled by a donation or cause. The next experiment has to involve real humans making repeated, real economic choices.

## Slide 8: Build the instrument

A real store where price can move above zero, to zero, or below zero, and behavior is observed repeatedly in the same household. The store is not the product: it is the environment that generates observations conventional datasets do not contain, with real products and real consumption. Three price regimes for the same household: positive (what will someone still pay for?), free (what wins when affordability stops deciding access?), and negative (how much returned value makes someone switch?). The store is not the product; it is the instrument that produces the data.

## Slide 9: Why groceries first

Groceries are the cheapest high-frequency laboratory for measuring real human demand: weekly repetition (the same households make choices again and again), real substitutes (products compete inside the same category and occasion), a large choice space (a single store can expose hundreds of preference tradeoffs), a known price reference (existing prices already give a dollar scale to the experiment), and real consumption (behavior reflects what people take home and use, not answers). Frequency of observation is high, experimental cost per observation is low, and longitudinal data accumulates fast. The point is not groceries; it is to establish the measurement where it is cheapest and fastest to observe repeatedly. A result that holds only in groceries is a fact about groceries; the same result in a second domain is evidence about people.

## Slide 10: A lot of waste begins before production starts

If the demand signal is wrong, efficiency downstream cannot recover the unit that should never have been made: wrong measurement leads to a wrong forecast, wrong production, and inventory, spoilage and waste. Cited estimates for scale (not claims that all of it is addressable): global retail inventory distortion of about $1.77 trillion (7.2% of retail sales in a 2023 estimate), with inaccurate demand planning one identified cause; and about $1 trillion of annual food waste, associated with roughly 8 to 10% of global greenhouse-gas emissions. As automation lowers the cost of making, the value of knowing what to make goes up. The cheapest unit is the one never made.

## Slide 11: Companies pay for the measurement

The goods are the cost of measurement; the data is the product. The beachhead is brands and manufacturers, who already spend heavily to decide what to make before they make it: product and portfolio testing, demand measurement, launch prediction, production planning, and assortment decisions. Downstream, one measurement layer serves multiple decision systems: the manufacturer, retail and inventory, forecasting, and AI training and evaluation. Nearest existing market categories for context: about $56 billion of traditional market research inside a broader global insights industry of over $150 billion, which is not the ceiling on downstream value.

## Slide 12: The founder and the precursor

FreeWater proved the economic mechanism: brands can fund zero-priced physical products. Honest Data turns that mechanism into a measurement system.

## Slide 13: The first real-world demand observatory

The experiment that cannot be run honestly in software: a few hundred households observed continuously for about two years across three price regimes. What it answers: Does the Tier 3 effect survive in real human behavior? Where does purchase-based preference recovery break down? What do Tier 4 crossing-point distributions actually look like? What will people still pay to preserve a preference against free? Does the new signal improve downstream commercial decisions? If it works, it is not a grocery company; it is a new demand-measurement layer.
