import { describe, expect, it } from 'vitest';
import { guessIndustry, isIndustry } from '../src/modules/ads/categories';

/**
 * The built-in categorizer on typical local businesses (docs/AI.md, "Ad rater"): the advertiser's own business type
 * first, then the ad's words, a clear sign counting more than a lean. Each row is [business type as the advertiser gave
 * it, the advertiser's name and the ad's words, the industry it must land in].
 */
const LOCAL: [string, string[], string][] = [
  // Food and drink: the walkthrough's taco truck filed under events was the bug.
  ['food', ["Tito's Tacos", 'Two tacos for $5', 'Every Tuesday', 'Show this at the window', 'Live music on the patio'], 'restaurants'],
  ['Mexican food', ["Tito's Tacos", 'Taco Tuesday', 'Show this code at the truck'], 'restaurants'],
  ['other', ["Tito's Tacos", 'Two tacos for $5 every Tuesday', 'Show this at the window'], 'restaurants'],
  ['food-drink', ['Slice House', 'Free slice with any large pizza', 'Show this at the counter'], 'restaurants'],
  ['food truck', ['Patty Wagon', 'Smash burgers and fries', 'Find us at the festival'], 'restaurants'],
  ['coffee', ['Bean There', '$1 off any latte', 'Open early'], 'restaurants'],
  ['bakery', ['Rise & Shine Bakery', 'Fresh croissants every morning', 'Kolaches too'], 'restaurants'],
  ['restaurant', ['Pho Real', 'Pho and banh mi', 'Show this for 10% off'], 'restaurants'],
  ['Other', ['Big Dog Hot Dogs', 'Two hot dogs for $6'], 'restaurants'],
  ['grocery', ['Green Leaf Market', 'Fresh produce, local farms'], 'groceries'],
  ['drink', ['Juicy Lucy', 'Cold-pressed juice and smoothies'], 'drinks'],
  ['other', ['Hop Yard', 'Craft beer and a beer garden', 'Live music Fridays'], 'alcohol'],
  ['Brewery', ['Hill Country Brewing', 'Flights all weekend', 'Taproom open till midnight'], 'alcohol'],
  // Health, care, fitness.
  ['health', ['Bright Smile Dental', 'New patients welcome', 'Free whitening with your first cleaning'], 'health'],
  ['other', ['Eastside Urgent Care', 'Walk-ins welcome, open late'], 'health'],
  ['wellness', ['Sol Yoga Studio', 'Your first class is free', 'Yoga and pilates'], 'fitness'],
  ['wellness', ['Calm Spa', 'Massage and facials', 'Book this week for 20% off'], 'personal-care'],
  ['beauty', ['Fade Factory', 'Haircut and beard trim $25', 'Walk-ins welcome'], 'personal-care'],
  ['fitness', ['Iron Works Gym', 'First month free', 'Show this at the front desk'], 'fitness'],
  ['bikes', ['Barton Creek Bikes', 'Tune-up special', 'Ride the greenbelt'], 'fitness'],
  ['outdoors', ['Zilker Paddle Co.', 'Rent a kayak or paddleboard', 'Two hours for $20'], 'fitness'],
  // Home, property, cars, getting around.
  ['real-estate', ['Lone Star Realty', 'Open house Sunday', 'Homes for sale in Mueller'], 'real-estate'],
  ['services', ['Blue Pipe Plumbing', '$50 off any plumbing repair', 'Call today'], 'home'],
  ['home', ['Lawn Rangers', 'Lawn mowing and landscaping', 'First cut free'], 'home'],
  ['auto', ['Speedy Lube', '$10 off any oil change'], 'automotive'],
  ['other', ['Sparkle Car Wash', 'Free car wash with any fill-up'], 'automotive'],
  ['transport', ['Lake Shuttle', 'Airport shuttle every hour', 'Book a ride'], 'transport'],
  ['travel', ['The Driskill', 'Weekend getaway at our hotel', 'Book a stay'], 'travel'],
  // Going out, learning, money, tech, shops.
  ['events', ['Paramount Theatre', 'Comedy night, tickets from $15'], 'entertainment'],
  ['other', ['Alamo Cinema', 'Movie night: tickets two for one'], 'entertainment'],
  ['education', ['Southside Music Lessons', 'Guitar and piano lessons', 'First lesson free'], 'education'],
  ['other', ['Bright Minds Tutoring', 'Math tutoring for grades 3 to 12'], 'education'],
  ['finance', ['Hill Country Credit Union', 'Free checking, no fees'], 'finance'],
  ['other', ['Austin Phone Fix', 'Cracked screen? Phone repair while you wait'], 'tech'],
  ['books', ['Eastside Books', 'New and used books, open late'], 'retail'],
  ['retail', ['Blooms', 'Fresh flowers for Mother’s Day'], 'retail'],
  ['retail', ['Threadbare', 'Vintage clothing and jeans', '20% off this weekend'], 'apparel'],
  // Pets, family, services, causes, civic, news, games.
  ['pets', ['Lucky Paws Grooming', 'Happy dogs, clean dogs'], 'pets'],
  ['other', ['Little Sprouts Daycare', 'Now enrolling: childcare for ages 1 to 5'], 'family'],
  ['local-services', ['Fresh Press', 'Laundry and dry cleaning, same day'], 'services'],
  ['nonprofit', ['Central Texas Food Bank', 'Volunteer this Saturday'], 'causes'],
  ['other', ['Central Texas Food Bank', 'Donate a meal'], 'causes'],
  ['other', ['Austin Public Library', 'Free library card, free classes'], 'civic'],
  ['news', ['The Eastside Paper', 'Local news, every Thursday'], 'media'],
  ['other', ['Pixel Palace', 'Arcade and video games, $10 all night'], 'games'],
];

describe('the built-in categorizer on typical local businesses', () => {
  it(`files all ${LOCAL.length} in the right industry`, () => {
    const wrong = LOCAL.map(([own, words, want]) => ({ business: words[0], own, want, got: guessIndustry(own, words).primary })).filter((r) => r.got !== r.want);
    expect(wrong).toEqual([]);
    expect(LOCAL.every(([, , want]) => isIndustry(want))).toBe(true);
  });
  it('the advertiser’s own clear business type decides, whatever the ad’s words lean to', () => {
    expect(guessIndustry('food', ['Comedy night', 'Show this', 'Live music', 'Tickets at the door']).primary).toBe('restaurants');
  });
  it('words count once each, whole and in plural; a phrase uses up its words', () => {
    expect(guessIndustry('other', ['Tacos', 'tacos', 'TACOS']).primary).toBe('restaurants');
    expect(guessIndustry('other', ['Classes', 'news']).primary).not.toBe('restaurants');
    expect(guessIndustry('other', ['We are a food bank']).primary).toBe('causes');
    expect(guessIndustry('other', ['Hello there']).primary).toBe('other');
  });
  it('a second industry only when it’s clearly there too', () => {
    expect(guessIndustry('food', ['Two tacos for $5', 'Show this']).secondary).toBeNull();
    expect(guessIndustry('alcohol', ['Craft beer', 'Tacos and burgers from the kitchen']).secondary).toBe('restaurants');
  });
});
