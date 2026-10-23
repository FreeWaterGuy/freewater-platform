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

export interface Industry { id: string; label: string; words: string[] }

/** The top-level industries. Ids are permanent. `words`: what an advertiser's own category or ad words often say. */
export const INDUSTRIES: readonly Industry[] = [
  { id: 'restaurants', label: 'Restaurants and takeout', words: ['restaurant', 'food', 'pizza', 'burger', 'taco', 'cafe', 'café', 'coffee', 'bakery', 'diner', 'takeout', 'sandwich', 'sushi', 'bbq', 'fries', 'latte', 'brunch', 'kitchen'] },
  { id: 'groceries', label: 'Groceries and food shops', words: ['grocery', 'groceries', 'market', 'supermarket', 'produce', 'deli', 'butcher', 'farmers'] },
  { id: 'drinks', label: 'Drinks (non-alcoholic)', words: ['drinks', 'water', 'soda', 'juice', 'tea', 'kombucha', 'energy drink', 'smoothie', 'tap'] },
  { id: 'alcohol', label: 'Beer, wine and spirits', words: ['alcohol', 'beer', 'wine', 'spirits', 'brewery', 'winery', 'cocktail', 'liquor'] },
  { id: 'health', label: 'Health and medical', words: ['health', 'clinic', 'doctor', 'dental', 'dentist', 'pharmacy', 'medical', 'therapy', 'urgent care', 'vision'] },
  { id: 'personal-care', label: 'Beauty and personal care', words: ['beauty', 'personal care', 'skincare', 'salon', 'barber', 'hair', 'nails', 'spa', 'tampon', 'tampons', 'menstrual', 'period', 'razor', 'cosmetics', 'wellness'] },
  { id: 'fitness', label: 'Sports and fitness', words: ['fitness', 'gym', 'yoga', 'pilates', 'sport', 'sports', 'running', 'cycling', 'climbing', 'bikes'] },
  { id: 'apparel', label: 'Clothing and accessories', words: ['apparel', 'clothing', 'shoes', 'fashion', 'jewelry', 'boutique', 'shirt'] },
  { id: 'home', label: 'Home and garden', words: ['home', 'furniture', 'garden', 'hardware', 'cleaning', 'plumbing', 'roofing', 'decor', 'mattress'] },
  { id: 'real-estate', label: 'Real estate', words: ['real-estate', 'real estate', 'realtor', 'homes for sale', 'apartment', 'rent', 'lease', 'open house'] },
  { id: 'automotive', label: 'Cars and automotive', words: ['automotive', 'car', 'cars', 'auto', 'dealer', 'tires', 'oil change', 'car wash'] },
  { id: 'transport', label: 'Rides and transport', words: ['transport', 'taxi', 'ride', 'rides', 'rideshare', 'scooter', 'transit', 'bus', 'parking', 'shuttle', 'airport'] },
  { id: 'travel', label: 'Travel and hotels', words: ['travel', 'hotel', 'motel', 'airline', 'flight', 'vacation', 'tour', 'resort'] },
  { id: 'entertainment', label: 'Entertainment and events', words: ['entertainment', 'music', 'concert', 'movie', 'cinema', 'theater', 'theatre', 'festival', 'show', 'tickets', 'nightlife', 'comedy', 'museum', 'books'] },
  { id: 'education', label: 'Education and classes', words: ['education', 'school', 'class', 'classes', 'course', 'tutor', 'university', 'college', 'lessons'] },
  { id: 'finance', label: 'Banking, finance and insurance', words: ['finance', 'bank', 'credit union', 'insurance', 'loan', 'mortgage', 'tax', 'investing'] },
  { id: 'tech', label: 'Phones, internet and technology', words: ['tech', 'technology', 'phone', 'internet', 'software', 'app', 'computer', 'wireless', 'electronics'] },
  { id: 'retail', label: 'Shops and retail', words: ['retail', 'shop', 'store', 'gift', 'gifts', 'outlet', 'mall'] },
  { id: 'pets', label: 'Pets', words: ['pets', 'pet', 'dog', 'cat', 'vet', 'veterinary', 'grooming'] },
  { id: 'family', label: 'Kids and family', words: ['family', 'kids', 'children', 'baby', 'toys', 'daycare', 'childcare'] },
  { id: 'services', label: 'Local and professional services', words: ['services', 'service', 'lawyer', 'legal', 'accounting', 'repair', 'laundry', 'dry cleaning', 'moving', 'storage', 'printing'] },
  { id: 'jobs', label: 'Jobs and hiring', words: ['jobs', 'hiring', 'careers', 'now hiring', 'staffing'] },
  { id: 'causes', label: 'Causes and nonprofits', words: ['nonprofit', 'charity', 'cause', 'donate', 'volunteer', 'foundation'] },
  { id: 'civic', label: 'Government and civic', words: ['government', 'civic', 'city', 'county', 'vote', 'library', 'public service'] },
  { id: 'media', label: 'Media and news', words: ['media', 'news', 'newspaper', 'radio', 'podcast', 'magazine'] },
  { id: 'games', label: 'Games and gaming', words: ['games', 'gaming', 'video game', 'arcade', 'esports'] },
  { id: 'other', label: 'Other', words: [] },
];

export const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id);
const byIndustry = new Map(INDUSTRIES.map((i) => [i.id, i]));
export const industryLabel = (id: string | null | undefined) => (id ? byIndustry.get(id)?.label ?? id : null);
export const isIndustry = (id: unknown): id is string => typeof id === 'string' && byIndustry.has(id);

/**
 * The likeliest industries for an ad, by rule: the advertiser's own category first (it's what they told us), then the
 * ad's words. Returns the primary and, when another industry is clearly there too, a secondary.
 */
export function guessIndustry(advertiserCategory: string, words: string[]): { primary: string; secondary: string | null } {
  const own = advertiserCategory.toLowerCase().trim();
  // Words as plain lower-case runs, so "Pizza!" and "pizza" read the same.
  const text = ` ${words.join(' ').toLowerCase().replace(/[^a-z0-9é-]+/g, ' ')} `;
  const score = new Map<string, number>();
  for (const i of INDUSTRIES) {
    let s = 0;
    // What the advertiser said it is weighs most, but a few clear words in the ad can outweigh it.
    if (own !== 'other' && (i.id === own || i.words.includes(own) || i.words.includes(own.replace(/-/g, ' ')))) s += 3;
    for (const w of i.words) if (text.includes(` ${w} `)) s += 1;
    if (s) score.set(i.id, s);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || INDUSTRY_IDS.indexOf(a[0]) - INDUSTRY_IDS.indexOf(b[0]));
  const primary = ranked[0]?.[0] ?? 'other';
  const second = ranked[1];
  return { primary, secondary: second && second[1] >= 2 ? second[0] : null };
}
