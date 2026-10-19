import type { StudioSpec } from '../studio/layout';

// What the games ask about. Real brands and products appear as plain cards (names only, no logos or packaging), so a
// pick says what people really prefer. Each company can replace or extend this list; it's data, not code.

export interface CatalogItem {
  id: string; name: string; brand?: string; kind: 'product' | 'service' | 'genre' | 'place' | 'platform';
  /** Its own usual price in cents (a BMW isn't priced like a Chevy). Otherwise the category's. */
  cents?: number;
  /** The Wikipedia article whose photo shows it, when its name alone isn't the article's title. */
  wiki?: string;
  /** A photo the company uploaded for it (an asset id): used before any other. */
  image?: string;
}
export interface Category {
  id: string;
  name: string;
  /** The question on the screen. */
  ask: string;
  items: CatalogItem[];
  /** How often it comes up, relative to the others: name-brand food most, then things we could one day offer, then the rest. */
  weight?: number;
  /** Prices make sense here (a cereal has a price; a music genre doesn't). */
  priced: boolean;
  /** Usual price in cents, for the price setups (a rough shelf price). */
  usualCents?: number;
  /**
   * Where its photos come from: 'wiki' (Wikipedia's freely licensed photo of that exact model), 'food' (Open Food
   * Facts' package photos), 'stock' (a photo library, for things like a banana or a beach town), or 'none' (a name
   * card, for genres and app logos).
   */
  images?: 'wiki' | 'food' | 'stock' | 'none';
}

/** "Brand|Name", optionally "|cents|Wikipedia title". */
const items = (kind: CatalogItem['kind'], list: string[]): CatalogItem[] =>
  list.map((s) => {
    const parts = s.split('|');
    const [brand, name] = parts.length > 1 ? [parts[0] || undefined, parts[1]!] : [undefined, parts[0]!];
    const cents = parts[2] ? Number(parts[2]) : undefined;
    return { id: slug(`${brand ?? ''} ${name}`), name, ...(brand ? { brand } : {}), kind, ...(cents ? { cents } : {}), ...(parts[3] ? { wiki: parts[3] } : {}) };
  });
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

export const defaultCatalog: Category[] = [
  { id: 'cereal', weight: 5, name: 'Cereal', ask: 'Breakfast time: which bowl is yours?', priced: true, usualCents: 499, images: 'food', items: items('product', ['Kellogg’s|Frosted Flakes', 'General Mills|Cheerios', 'Post|Honey Bunches of Oats', 'General Mills|Cinnamon Toast Crunch', 'Kellogg’s|Froot Loops', 'Quaker|Oatmeal Squares', 'Kashi|GO Original', 'Nature’s Path|Flax Plus']) },
  { id: 'snacks', weight: 5, name: 'Snacks', ask: 'Snack attack: grab one!', priced: true, usualCents: 399, images: 'food', items: items('product', ['Lay’s|Classic Chips', 'Doritos|Nacho Cheese', 'Cheetos|Crunchy', 'Pringles|Original', 'Goldfish|Cheddar', 'SkinnyPop|Popcorn', 'KIND|Dark Chocolate Nuts', 'RXBAR|Chocolate Sea Salt']) },
  { id: 'candy', weight: 5, name: 'Candy', ask: 'Sweet tooth: pick your treat!', priced: true, usualCents: 229, images: 'food', items: items('product', ['Snickers|King Size', 'Reese’s|Peanut Butter Cups', 'M&M’s|Peanut', 'Kit Kat|Bar', 'Skittles|Original', 'Twix|Bar', 'Hershey’s|Milk Chocolate', 'Sour Patch Kids|Bag']) },
  { id: 'drinks', weight: 5, name: 'Drinks', ask: 'Thirsty? Grab one!', priced: true, usualCents: 249, images: 'food', items: items('product', ['Coca-Cola|Classic', 'Pepsi|Cola', 'Dr Pepper|Original', 'Sprite|Lemon-Lime', 'Gatorade|Cool Blue', 'Red Bull|Energy Drink', 'LaCroix|Pamplemousse', 'Liquid Death|Mountain Water']) },
  { id: 'ice_cream', weight: 4, name: 'Ice cream', ask: 'Brain freeze: which pint?', priced: true, usualCents: 549, images: 'food', items: items('product', ['Ben & Jerry’s|Cherry Garcia', 'Häagen-Dazs|Dulce de Leche', 'Breyers|Natural Vanilla', 'Halo Top|Birthday Cake', 'Blue Bell|Homemade Vanilla', 'Talenti|Sea Salt Caramel Gelato', 'Tillamook|Mudslide', 'Magnum|Double Chocolate Bars']) },
  { id: 'bars', weight: 4, name: 'On the go', ask: 'Running late: grab one!', priced: true, usualCents: 199, images: 'food', items: items('product', ['Pop-Tarts|Frosted Strawberry', 'Nature Valley|Oats ’n Honey', 'Clif|Chocolate Chip', 'KIND|Peanut Butter Dark Chocolate', 'belVita|Blueberry', 'Nutri-Grain|Strawberry', 'Quest|Cookies & Cream', 'Larabar|Peanut Butter Cookie']) },
  { id: 'pizza', weight: 4, name: 'Pizza', ask: 'Pizza night: who’s delivering?', priced: true, usualCents: 1_399, images: 'wiki', items: items('service', ['Domino’s|Pepperoni Pizza|1399|Domino’s', 'Pizza Hut|Pepperoni Pizza|1499|Pizza Hut', 'Papa John’s|Pepperoni Pizza|1499|Papa John’s', 'Little Caesars|Hot-N-Ready|699|Little Caesars', 'Marco’s|Pepperoni Magnifico|1499|Marco’s Pizza']) },
  { id: 'coffee', weight: 3, name: 'Coffee', ask: 'Coffee run: where are you going?', priced: true, usualCents: 525, images: 'stock', items: items('service', ['Starbucks|Latte', 'Dunkin’|Iced Coffee', 'McDonald’s|McCafé Latte', 'Peet’s|Cold Brew', 'Dutch Bros|Golden Eagle', 'Tim Hortons|Double-Double']) },
  { id: 'fast_food', weight: 5, name: 'Fast food', ask: 'Lunch is on us: what are you having?', priced: true, usualCents: 699, images: 'wiki', items: items('product', ['McDonald’s|Cheeseburger|299|Cheeseburger', 'McDonald’s|Big Mac|599|Big Mac', 'Chick-fil-A|Chicken Sandwich|579|Chick-fil-A', 'Taco Bell|Crunchwrap Supreme|599|Crunchwrap Supreme', 'Wendy’s|Baconator|899|Baconator', 'Chipotle|Burrito Bowl|1095|Chipotle Mexican Grill', 'Burger King|Whopper|649|Whopper', 'Panda Express|Orange Chicken|899|Orange chicken']) },
  { id: 'fruit', weight: 3, name: 'Fruit and fresh food', ask: 'Fresh pick: which one?', priced: true, usualCents: 99, images: 'stock', items: items('product', ['Banana', 'Apple', 'Orange', 'Grapes (a bag)', 'Baby carrots', 'Avocado', 'Strawberries (a box)', 'Blueberries (a box)']) },
  { id: 'dairy', weight: 3, name: 'Dairy and alternatives', ask: 'Fridge raid: grab one!', priced: true, usualCents: 449, images: 'food', items: items('product', ['Chobani|Greek Yogurt', 'Oatly|Oat Milk', 'Fairlife|Milk', 'Silk|Almond Milk', 'Tillamook|Cheddar', 'Babybel|Mini Cheese']) },
  { id: 'frozen', weight: 3, name: 'Frozen food', ask: 'Freezer aisle: what goes in the cart?', priced: true, usualCents: 599, images: 'food', items: items('product', ['DiGiorno|Pepperoni Pizza', 'Amy’s|Bean Burrito', 'Lean Cuisine|Chicken Alfredo', 'Ben & Jerry’s|Half Baked', 'Häagen-Dazs|Vanilla', 'Eggo|Waffles']) },
  { id: 'cars', weight: 2, name: 'Cars', ask: 'Keys are yours: which one do you drive home?', priced: true, usualCents: 3_500_000, images: 'wiki', items: items('product', ['Toyota|RAV4|3025000|Toyota RAV4', 'Honda|Civic|2495000|Honda Civic', 'Tesla|Model Y|4499000|Tesla Model Y', 'Ford|F-150|3910000|Ford F-Series', 'Chevrolet|Equinox|2860000|Chevrolet Equinox', 'Hyundai|Ioniq 5|4260000|Hyundai Ioniq 5', 'Subaru|Outback|2989500|Subaru Outback', 'BMW|3 Series|4570000|BMW 3 Series']) },
  { id: 'phones', weight: 2, name: 'Phones', ask: 'New phone, free: which one?', priced: true, usualCents: 79_900, images: 'wiki', items: items('product', ['Apple|iPhone|79900|iPhone', 'Samsung|Galaxy S|79999|Samsung Galaxy S series', 'Google|Pixel|79900|Google Pixel', 'Motorola|Moto G|19999|Moto G', 'OnePlus|Nord|29999|OnePlus Nord']) },
  { id: 'streaming', weight: 2, name: 'Streaming', ask: 'Free for a year: which one?', priced: true, usualCents: 1_599, images: 'none', items: items('service', ['Netflix', 'YouTube Premium', 'Disney+', 'Max', 'Prime Video', 'Hulu', 'Apple TV+', 'Peacock']) },
  { id: 'music', weight: 1, name: 'Music', ask: 'Road trip: what’s playing?', priced: false, images: 'stock', items: items('genre', ['Hip-hop', 'Pop', 'Country', 'Rock', 'R&B', 'Latin', 'EDM', 'Jazz', 'Classical', 'K-pop']) },
  { id: 'movies', weight: 1, name: 'Movies', ask: 'Movie night: what are we watching?', priced: false, images: 'stock', items: items('genre', ['Comedy', 'Action', 'Horror', 'Romance', 'Documentary', 'Sci-fi', 'Animated', 'Drama']) },
  { id: 'social', weight: 1, name: 'Social apps', ask: 'You’ve got 5 minutes: which app?', priced: false, images: 'none', items: items('platform', ['Instagram', 'TikTok', 'YouTube', 'Snapchat', 'X', 'Facebook', 'Reddit', 'Pinterest', 'Threads', 'Discord']) },
  { id: 'creators', weight: 1, name: 'Creators', ask: 'Which creators do you watch most?', priced: false, images: 'stock', items: items('genre', ['Cooking', 'Gaming', 'Fitness', 'Comedy', 'Beauty', 'Tech reviews', 'Travel', 'Personal finance', 'DIY and home', 'Sports']) },
  { id: 'travel', weight: 1, name: 'Travel', ask: 'Free trip: where to?', priced: true, usualCents: 120_000, images: 'stock', items: items('place', ['Beach town', 'Big city', 'National park', 'Ski trip', 'Theme park', 'Road trip', 'Cruise', 'Abroad']) },
  { id: 'sports', weight: 1, name: 'Sports', ask: 'Game day: what’s on?', priced: false, images: 'stock', items: items('genre', ['NFL', 'NBA', 'Soccer', 'MLB', 'College football', 'UFC', 'F1', 'WNBA', 'NHL', 'Tennis']) },
];

/**
 * How a choice is offered: the price frames. The same product can be for sale, free (paid for by ads or a sponsor),
 * cheaper than usual, or negatively priced (you'd be paid, or a cause would be).
 */
export type Frame =
  | { kind: 'for_sale'; cents: number }
  | { kind: 'discounted'; cents: number; usualCents: number }
  | { kind: 'free_ads' }
  | { kind: 'free_sponsor' }
  | { kind: 'negative'; youGetCents?: number; causeCents?: number };

export function frameText(f: Frame) {
  const $ = (c: number) => (c >= 100_000 ? `$${Math.round(c / 100).toLocaleString('en-US')}` : c >= 100 ? `$${(c / 100).toFixed(2)}` : `${c}¢`);
  switch (f.kind) {
    case 'for_sale': return $(f.cents);
    case 'discounted': return `${$(f.cents)} (usually ${$(f.usualCents)})`;
    case 'free_ads': return 'Free (paid for by ads)';
    case 'free_sponsor': return 'Free (a brand pays)';
    case 'negative': return [f.youGetCents ? `Free, and you get ${$(f.youGetCents)}` : 'Free', f.causeCents ? `${$(f.causeCents)} goes to a cause` : ''].filter(Boolean).join(' · ');
  }
}

/** Where a price setup sits on the number line. */
export function frameNet(f: Frame): number {
  switch (f.kind) {
    case 'for_sale': return f.cents;
    case 'discounted': return f.cents;
    case 'free_ads': case 'free_sponsor': return 0;
    case 'negative': return -((f.youGetCents ?? 0) + (f.causeCents ?? 0));
  }
}

/**
 * The tier a choice would sit in if it were real (Abundance Engineering, chapter 10), from how it was offered: paying
 * while a free or negatively priced option was right there is brand commitment (5); the free one among free ones is
 * revealed preference (3); negatively priced, values-weighted (4a when the operator picked the cause, 4b when the
 * person gets the money); for sale against only priced options is constrained (1).
 */
export function structuralTier(chosen: Frame, others: Frame[]): '1' | '3' | '4a' | '4b' | '5' {
  const net = frameNet(chosen);
  if (net > 0) return others.some((o) => frameNet(o) <= 0) ? '5' : '1';
  if (net < 0) return chosen.kind === 'negative' && chosen.youGetCents ? '4b' : '4a';
  return '3';
}

/** Made-up brands for the "which ad works" rounds: they never run anywhere, so nobody is billed and nothing is real. */
export const fictionalAds: { id: string; spec: StudioSpec }[] = [
  { id: 'f-sundown', spec: { brand: 'Sundown Tacos', kicker: 'NEW ON 6TH STREET', headline: 'Two tacos. One dollar. Tonight.', sub: 'Show this at the counter after 9pm.', offer: '2 for $1', colors: { paper: '#1D1A2F', ink: '#FFF4E0', accent: '#FF7A3D' }, type: 'condensed', look: 'type', icon: 'taco' } },
  { id: 'f-greenhouse', spec: { brand: 'Greenhouse Grocer', headline: 'Free bananas, every morning', sub: 'One per person, before 10am.', offer: 'Free', colors: { paper: '#F4F1E6', ink: '#1F3A2B', accent: '#F2C230' }, type: 'serif', look: 'band', icon: 'bag' } },
  { id: 'f-voltline', spec: { brand: 'Voltline', kicker: 'CHARGING', headline: 'Your first charge is on us', sub: 'Any Voltline station in town.', offer: 'First charge free', colors: { paper: '#0E1B2C', ink: '#E8F4FF', accent: '#3DD6F5' }, type: 'grotesk', look: 'frame', icon: 'bolt' } },
  { id: 'f-pawpals', spec: { brand: 'Paw Pals', headline: 'A free walk for your dog', sub: 'Book a walker near you.', offer: 'First walk free', colors: { paper: '#FFF6EC', ink: '#3A2416', accent: '#E85D75' }, type: 'serif', look: 'type', icon: 'paw' } },
  { id: 'f-northbeat', spec: { brand: 'Northbeat Radio', kicker: 'LIVE THIS FRIDAY', headline: 'Free show at the park', sub: 'Gates at 6. Bring a blanket.', colors: { paper: '#12121A', ink: '#FFFFFF', accent: '#B388FF' }, type: 'condensed', look: 'band', icon: 'music' } },
  { id: 'f-brightsmile', spec: { brand: 'Bright Smile Dental', headline: 'Cleanings for $0 with any plan', sub: 'Open Saturdays.', offer: '$0 cleaning', colors: { paper: '#EEF7FB', ink: '#0B2E40', accent: '#2BB3A3' }, type: 'grotesk', look: 'frame', icon: 'tooth' } },
  { id: 'f-slice', spec: { brand: 'Corner Slice', headline: 'Buy a slice, we give one away', sub: 'Every slice you buy feeds someone nearby.', offer: '1 for 1', colors: { paper: '#FFF1E0', ink: '#2A1205', accent: '#D7262E' }, type: 'serif', look: 'type', icon: 'pizza' } },
  { id: 'f-brewhaus', spec: { brand: 'Brewhaus', kicker: 'COFFEE', headline: 'Bring the bottle, get a free refill', sub: 'Any size, any day.', offer: 'Free refill', colors: { paper: '#2B1B12', ink: '#F7EBDD', accent: '#E3A857' }, type: 'grotesk', look: 'band', icon: 'coffee' } },
];
