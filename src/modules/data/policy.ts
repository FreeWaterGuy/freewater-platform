// What a company collects, by kind of data, and how each country's law shapes it. Each company (FreeWater and every
// white-label company) picks a preset for where it operates and can change any line. These presets are starting
// points written from the general shape of each law; a lawyer should confirm them before launch.

export const dataCategories = ['interactions', 'activity', 'designContent', 'adContent', 'choices', 'preciseLocation', 'device', 'ipAddress', 'identityLinking'] as const;
export type DataCategory = (typeof dataCategories)[number];
export const categoryInfo: Record<DataCategory, { label: string; what: string }> = {
  interactions: { label: 'Page interactions', what: 'How long people watch the ad, time in AR, scrolling, “Show me more”, sharing, which video they watched.' },
  activity: { label: 'Everything people do', what: 'Every action anyone takes through the platform: consumers, advertisers, your team, machines and drivers.' },
  designContent: { label: 'What people design', what: 'Custom bottle chats, prompts and the photos and videos people upload for them.' },
  adContent: { label: 'What advertisers make', what: 'Ad assistant chats, drafts, uploads and every change to an ad.' },
  choices: { label: 'Choices and honest data', what: 'Each choice people make (taking a bottle, engaging, buying), placed on the number line and sorted into the honest-data tiers.' },
  preciseLocation: { label: 'Exact location', what: 'A phone’s exact position when it scans (otherwise only the machine or route is known).' },
  device: { label: 'Device details', what: 'Phone type, browser and screen size.' },
  ipAddress: { label: 'IP address', what: 'The internet address a request came from (for security and fraud checks, and rough location).' },
  identityLinking: { label: 'Linking one person', what: 'Joining one person’s phones, accounts and roles (a consumer who is also an advertiser) into one profile.' },
};

/** none: collected without asking (needed to run the service). opt_out: collected unless the person says no. opt_in: only if the person says yes. */
export type ConsentMode = 'none' | 'opt_out' | 'opt_in';
export interface CategoryRule { collect: boolean; consent: ConsentMode; keepDays: number }
export type Region = 'us' | 'us_ca' | 'eu' | 'uk' | 'ca' | 'br' | 'custom';
export interface DataPolicy {
  region: Region;
  rules: Record<DataCategory, CategoryRule>;
  /** IP addresses are cut to their network (the last part removed) before they're kept. */
  truncateIp: boolean;
  /** A white-label company's data may be seen by the platform company (FreeWater), as its license allows. */
  shareWithPlatform: boolean;
}

const r = (collect: boolean, consent: ConsentMode, keepDays: number): CategoryRule => ({ collect, consent, keepDays });

export const regionInfo: Record<Exclude<Region, 'custom'>, string> = {
  us: 'United States (general): collect, let people opt out; exact location only with permission.',
  us_ca: 'California and states with similar laws (CCPA/CPRA and others): opt-out, honor “don’t sell or share” and Global Privacy Control; sensitive data with permission.',
  eu: 'European Union (GDPR): only what’s needed without asking; tracking, device details, exact location and linking people only with permission; IPs shortened.',
  uk: 'United Kingdom (UK GDPR and PECR): like the EU.',
  ca: 'Canada (PIPEDA and Quebec’s Law 25): meaningful consent; opt-out for most, permission for sensitive data.',
  br: 'Brazil (LGPD): like the EU.',
};

export function preset(region: Region): DataPolicy {
  const strict = region === 'eu' || region === 'uk' || region === 'br';
  const rules: Record<DataCategory, CategoryRule> = strict ? {
    interactions: r(true, 'opt_in', 365), activity: r(true, 'none', 365), designContent: r(true, 'none', 730), adContent: r(true, 'none', 1825),
    choices: r(true, 'opt_in', 730), preciseLocation: r(false, 'opt_in', 30), device: r(true, 'opt_in', 365), ipAddress: r(true, 'none', 30), identityLinking: r(true, 'opt_in', 730),
  } : region === 'ca' ? {
    interactions: r(true, 'opt_out', 730), activity: r(true, 'none', 730), designContent: r(true, 'none', 1095), adContent: r(true, 'none', 1825),
    choices: r(true, 'opt_out', 1825), preciseLocation: r(true, 'opt_in', 90), device: r(true, 'opt_out', 730), ipAddress: r(true, 'none', 90), identityLinking: r(true, 'opt_in', 1825),
  } : {
    interactions: r(true, 'opt_out', 1095), activity: r(true, 'none', 1095), designContent: r(true, 'none', 1825), adContent: r(true, 'none', 1825),
    choices: r(true, 'opt_out', 3650), preciseLocation: r(true, 'opt_in', 365), device: r(true, 'opt_out', 1095), ipAddress: r(true, 'none', region === 'us_ca' ? 90 : 365), identityLinking: r(true, region === 'us_ca' ? 'opt_out' : 'opt_out', 3650),
  };
  return { region, rules, truncateIp: strict, shareWithPlatform: false };
}

export function checkPolicy(p: DataPolicy | undefined): string | null {
  if (!p) return null;
  if (!['us', 'us_ca', 'eu', 'uk', 'ca', 'br', 'custom'].includes(p.region)) return 'Pick where you operate.';
  if (!p.rules) return 'Data rules are missing.';
  for (const k of dataCategories) {
    const x = p.rules[k];
    if (!x || typeof x.collect !== 'boolean' || !['none', 'opt_out', 'opt_in'].includes(x.consent) || !Number.isInteger(x.keepDays) || x.keepDays < 1 || x.keepDays > 3650) return `${categoryInfo[k].label}: choose on or off, how people agree, and 1 to 3650 days to keep it.`;
  }
  if (typeof p.truncateIp !== 'boolean' || typeof p.shareWithPlatform !== 'boolean') return 'Shortening IPs and sharing with the platform are each on or off.';
  return null;
}
