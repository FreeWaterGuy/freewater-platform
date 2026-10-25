/**
 * The standard list of industries an ad can be filed under (docs/AI.md, "Ad rater"; docs/SWITCHES.md, "Ad ratings").
 *
 * WHERE IT COMES FROM, AND ITS LICENCE. This is FreeWater's own list, modelled on the top levels of the well-known
 * advertising and shopping taxonomies (the IAB Tech Lab Ad Product Taxonomy and Google's product taxonomy). It is not a
 * copy of either: the IAB Tech Lab's repository states a Creative Commons licence for its OpenRTB specification but not
 * clearly for the taxonomies, and Google's product taxonomy is published without a stated licence. So, as the founder
 * asked when a licence is unclear, we wrote our own list, part of this codebase and under its licence. Its ids never
 * change once used (benchmarks are kept for decades); a new industry gets a new id, and a retired one stays listed.
 *
 * On top of it each company keeps its own subcategories (editable, `ad_subcategories`): "menstrual care" under
 * personal care, "pizza" under restaurants.
 */

export const TAXONOMY = {
  id: 'fw-industries',
  version: '1',
  source: 'FreeWater’s own list, modelled on the top levels of the IAB Tech Lab Ad Product Taxonomy and Google’s product taxonomy (not a copy of either).',
  licence: 'Ours, part of this codebase: the IAB’s licence for its taxonomies isn’t stated clearly, and Google’s product taxonomy states none, so neither was copied.',
} as const;

/**
 * `words` are the clear signs of an industry (a taco is food, a dentist is health); `hints` are words that lean that
 * way but often mean something else ("show" is usually "show this at the counter", "home" is often "delivered home").
 * Both are matched as whole words, plurals too ("tacos" reads as "taco").
 */
export interface Industry { id: string; label: string; words: string[]; hints?: string[] }

/** The top-level industries. Ids are permanent. */
export const INDUSTRIES: readonly Industry[] = [
  { id: 'restaurants', label: 'Restaurants and takeout', words: ['restaurant', 'pizza', 'pizzeria', 'burger', 'taco', 'taqueria', 'burrito', 'tex-mex', 'mexican', 'cafe', 'café', 'coffee', 'espresso', 'latte', 'cappuccino', 'bakery', 'bagel', 'donut', 'doughnut', 'kolache', 'croissant', 'pastry', 'cupcake', 'diner', 'takeout', 'take-out', 'sandwich', 'sushi', 'ramen', 'pho', 'noodle', 'dumpling', 'bbq', 'barbecue', 'brisket', 'fries', 'wings', 'brunch', 'breakfast', 'food truck', 'hot dog', 'bistro', 'eatery', 'grill', 'catering', 'ice cream', 'gelato', 'frozen yogurt', 'thai', 'indian', 'italian', 'chinese', 'vegan'], hints: ['food', 'kitchen', 'lunch', 'dinner', 'menu', 'eat', 'chicken', 'slice', 'bowl', 'dessert'] },
  { id: 'groceries', label: 'Groceries and food shops', words: ['grocery', 'groceries', 'supermarket', 'produce', 'butcher', 'farmers market', 'fresh produce', 'co-op', 'deli'], hints: ['market', 'fresh', 'organic', 'produce'] },
  { id: 'drinks', label: 'Drinks (non-alcoholic)', words: ['soda', 'juice', 'kombucha', 'smoothie', 'energy drink', 'boba', 'bubble tea', 'lemonade', 'sparkling water'], hints: ['drink', 'drinks', 'water', 'tea', 'tap', 'hydrate'] },
  { id: 'alcohol', label: 'Beer, wine and spirits', words: ['alcohol', 'beer', 'wine', 'spirits', 'brewery', 'brewpub', 'taproom', 'winery', 'distillery', 'cocktail', 'liquor', 'pub', 'tequila', 'mezcal', 'whiskey', 'vodka', 'sake', 'sports bar', 'beer garden', 'beer flight'], hints: ['bar', 'happy hour', 'pint'] },
  { id: 'health', label: 'Health and medical', words: ['clinic', 'doctor', 'dental', 'dentist', 'orthodontist', 'pharmacy', 'medical', 'urgent care', 'chiropractor', 'chiropractic', 'physical therapy', 'optometrist', 'eye exam', 'pediatrician', 'physician', 'hospital', 'flu shot', 'vaccine', 'therapist', 'counseling'], hints: ['health', 'therapy', 'vision', 'teeth', 'smile', 'checkup'] },
  { id: 'personal-care', label: 'Beauty and personal care', words: ['beauty', 'skincare', 'salon', 'barber', 'barbershop', 'haircut', 'nails', 'manicure', 'pedicure', 'spa', 'massage', 'facial', 'waxing', 'lashes', 'makeup', 'cosmetics', 'tampon', 'menstrual', 'razor', 'tattoo'], hints: ['hair', 'personal care', 'wellness', 'period', 'glow'] },
  { id: 'fitness', label: 'Sports and fitness', words: ['fitness', 'gym', 'yoga', 'pilates', 'crossfit', 'workout', 'spin class', 'cycling', 'bike', 'bicycle', 'climbing', 'bouldering', 'martial arts', 'karate', 'jiu-jitsu', 'boxing', 'kayak', 'paddle', 'paddleboard', 'running', 'marathon', 'sports', 'tennis', 'golf', 'swim', 'outdoor gear'], hints: ['sport', 'training', 'studio', 'class', 'run', 'outdoor', 'outdoors'] },
  { id: 'apparel', label: 'Clothing and accessories', words: ['apparel', 'clothing', 'shoes', 'sneakers', 'fashion', 'jewelry', 'boutique', 'dress', 'jeans', 't-shirt', 'vintage clothing'], hints: ['shirt', 'wear', 'style'] },
  { id: 'home', label: 'Home and garden', words: ['furniture', 'garden', 'gardening', 'plant nursery', 'hardware', 'plumbing', 'plumber', 'roofing', 'roofer', 'hvac', 'air conditioning', 'electrician', 'handyman', 'remodel', 'kitchen remodel', 'flooring', 'mattress', 'decor', 'landscaping', 'lawn', 'pest control', 'house cleaning', 'maid', 'appliance'], hints: ['home', 'cleaning', 'plants'] },
  { id: 'real-estate', label: 'Real estate', words: ['real-estate', 'real estate', 'realtor', 'realty', 'homes for sale', 'open house', 'apartment', 'condo', 'for lease', 'property management'], hints: ['broker', 'rent', 'lease', 'listing', 'move-in'] },
  { id: 'automotive', label: 'Cars and automotive', words: ['automotive', 'car', 'auto repair', 'auto body', 'mechanic', 'dealer', 'dealership', 'tire', 'oil change', 'car wash', 'brake', 'detailing'], hints: ['auto'] },
  { id: 'transport', label: 'Rides and transport', words: ['taxi', 'rideshare', 'scooter', 'transit', 'bus', 'shuttle', 'limo'], hints: ['parking', 'airport', 'transport', 'ride', 'rides'] },
  { id: 'travel', label: 'Travel and hotels', words: ['hotel', 'motel', 'airline', 'vacation', 'resort', 'inn', 'bed and breakfast', 'cruise', 'getaway'], hints: ['travel', 'tour', 'trip', 'stay', 'flight'] },
  { id: 'entertainment', label: 'Entertainment and events', words: ['entertainment', 'concert', 'live music', 'movie', 'cinema', 'theater', 'theatre', 'festival', 'comedy', 'museum', 'tickets', 'nightlife', 'bowling', 'karaoke', 'escape room', 'art gallery'], hints: ['show', 'music', 'event', 'events', 'live', 'fun', 'night'] },
  { id: 'education', label: 'Education and classes', words: ['education', 'school', 'tutor', 'tutoring', 'university', 'college', 'lessons', 'academy', 'driving school', 'bootcamp'], hints: ['class', 'classes', 'learn', 'course'] },
  { id: 'finance', label: 'Banking, finance and insurance', words: ['finance', 'bank', 'credit union', 'insurance', 'loan', 'mortgage', 'tax prep', 'taxes', 'investing', 'financial advisor', 'cpa'], hints: ['money', 'savings', 'checking', 'tax'] },
  { id: 'tech', label: 'Phones, internet and technology', words: ['technology', 'cell phone', 'phone plan', 'internet', 'software', 'computer', 'wireless', 'electronics', 'broadband', 'fiber', 'wifi', 'laptop', 'phone repair'], hints: ['tech', 'app', 'online', 'phone'] },
  { id: 'retail', label: 'Shops and retail', words: ['gift shop', 'outlet', 'mall', 'bookstore', 'bookshop', 'books', 'florist', 'flowers', 'vinyl', 'record store', 'thrift'], hints: ['retail', 'shop', 'store', 'sale', 'gift', 'gifts'] },
  { id: 'pets', label: 'Pets', words: ['pet', 'dog', 'cat', 'puppy', 'kitten', 'vet', 'veterinary', 'veterinarian', 'grooming', 'kennel', 'dog walking'], hints: ['paws', 'boarding'] },
  { id: 'family', label: 'Kids and family', words: ['kids', 'children', 'baby', 'toys', 'daycare', 'childcare', 'preschool', 'nanny', 'playground'], hints: ['family', 'birthday party'] },
  { id: 'services', label: 'Local and professional services', words: ['lawyer', 'attorney', 'legal', 'accounting', 'laundry', 'laundromat', 'dry cleaning', 'movers', 'storage', 'printing', 'tailor', 'alterations', 'locksmith', 'photographer', 'notary', 'shoe repair'], hints: ['services', 'service', 'repair', 'moving'] },
  { id: 'jobs', label: 'Jobs and hiring', words: ['jobs', 'hiring', 'now hiring', 'careers', 'staffing', 'job fair'], hints: ['apply', 'join our team'] },
  { id: 'causes', label: 'Causes and nonprofits', words: ['nonprofit', 'non-profit', 'charity', 'donate', 'volunteer', 'foundation', 'food bank', 'fundraiser', 'animal shelter'], hints: ['cause', 'give'] },
  { id: 'civic', label: 'Government and civic', words: ['government', 'civic', 'county', 'vote', 'voting', 'library', 'public service', 'city of', 'recycling'], hints: ['city'] },
  { id: 'media', label: 'Media and news', words: ['news', 'newspaper', 'radio', 'podcast', 'magazine'], hints: ['media', 'story'] },
  { id: 'games', label: 'Games and gaming', words: ['games', 'gaming', 'video game', 'arcade', 'esports', 'board game'], hints: ['play'] },
  { id: 'other', label: 'Other', words: [] },
];

export const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id);
const byIndustry = new Map(INDUSTRIES.map((i) => [i.id, i]));
export const industryLabel = (id: string | null | undefined) => (id ? byIndustry.get(id)?.label ?? id : null);
export const isIndustry = (id: unknown): id is string => typeof id === 'string' && byIndustry.has(id);

/**
 * The business types advertisers pick or type (the advertiser sign-up list, the company's ad categories), and the
 * industry each one is. A clear one decides the industry; a broad one ("services", "retail", "wellness") only leans.
 */
const OWN_CLEAR: Record<string, string> = {
  food: 'restaurants', 'food-drink': 'restaurants', 'food-and-drink': 'restaurants', coffee: 'restaurants', dining: 'restaurants',
  drink: 'drinks', water: 'drinks', beverages: 'drinks', events: 'entertainment', auto: 'automotive', cars: 'automotive',
  news: 'media', nonprofit: 'causes', politics: 'civic', 'local-services': 'services', grocery: 'groceries',
};
const OWN_BROAD: Record<string, string> = { services: 'services', service: 'services', retail: 'retail', shop: 'retail', wellness: 'personal-care' };
/** How much each sign counts (see guessIndustry). */
const WEIGHT = { ownClear: 20, ownBroad: 2, ownWord: 4, word: 3, hint: 1 } as const;

/** One word in its plain form, so "tacos" reads as "taco" and "classes" as "class" (not "news" as "new"). */
const KEEP = new Set(['news', 'bus', 'gas', 'yes', 'this', 'its', 'his', 'plus', 'class', 'glass', 'dress', 'boss', 'chips', 'kids', 'outdoors', 'sports', 'games', 'books', 'jobs', 'nails', 'lashes', 'gifts', 'flowers', 'toys', 'jeans', 'shoes', 'sneakers', 'fries', 'wings', 'tickets', 'lessons', 'taxes', 'movers', 'children', 'paws', 'groceries', 'drinks', 'events', 'services', 'apparel', 'electronics', 'spirits', 'careers', 'rides']);
const stem = (w: string) => KEEP.has(w) || w.length <= 3 ? w : w.endsWith('ies') ? `${w.slice(0, -3)}y` : /(ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
/** Text as " word word ", lower case, apostrophes dropped ("Tito's" reads "titos"), each word in its plain form. */
const plain = (t: string) => ` ${t.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9é-]+/).filter(Boolean).map(stem).join(' ')} `;
/** Every sign, longest first: a phrase uses up its words, so "food bank" is a cause, not a bank, and "hot dog" isn't a pet. */
const SIGNS = INDUSTRIES.flatMap((i) => [...i.words.map((w) => ({ id: i.id, sign: plain(w), clear: true })), ...(i.hints ?? []).map((w) => ({ id: i.id, sign: plain(w), clear: false }))])
  .sort((a, b) => b.sign.length - a.sign.length);

/** The industries a text points at, each sign counted once: a clear word `word`, a lean `hint`. */
function signsIn(text: string, word: number, hint: number, into: Map<string, number>) {
  let t = plain(text);
  for (const s of SIGNS) {
    if (!t.includes(s.sign)) continue;
    into.set(s.id, (into.get(s.id) ?? 0) + (s.clear ? word : hint));
    t = t.split(s.sign).join('  ');
  }
}

/**
 * The likeliest industries for an ad, by rule. The advertiser's own business type comes first: a clear one ("food",
 * "pets", "Mexican restaurant") decides it. Then the ad's words, a clear sign of an industry ("tacos", "dentist")
 * counting three times a lean ("show", "home"), so "Two tacos for $5 — show this at the window" is food, not events.
 * Returns the primary and, when another industry is clearly there too (two clear signs), a secondary.
 */
export function guessIndustry(advertiserCategory: string, words: string[]): { primary: string; secondary: string | null } {
  const own = advertiserCategory.toLowerCase().trim();
  const score = new Map<string, number>();
  const add = (id: string, n: number) => score.set(id, (score.get(id) ?? 0) + n);
  const key = own.replace(/\s+/g, '-');
  if (OWN_BROAD[key]) add(OWN_BROAD[key], WEIGHT.ownBroad);
  else if (isIndustry(key) && key !== 'other') add(key, WEIGHT.ownClear);
  else if (OWN_CLEAR[key]) add(OWN_CLEAR[key], WEIGHT.ownClear);
  else if (key !== 'other') signsIn(own, WEIGHT.ownWord * WEIGHT.word, WEIGHT.ownWord * WEIGHT.hint, score);
  signsIn(words.join(' · '), WEIGHT.word, WEIGHT.hint, score);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || INDUSTRY_IDS.indexOf(a[0]) - INDUSTRY_IDS.indexOf(b[0]));
  const primary = ranked[0]?.[0] ?? 'other';
  const second = ranked.find(([id]) => id !== primary);
  return { primary, secondary: second && second[1] >= 2 * WEIGHT.word ? second[0] : null };
}
