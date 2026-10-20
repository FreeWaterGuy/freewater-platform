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

/**
 * How much each person shares, chosen once and changeable any time. Everything works the same at every level: the
 * free bottle, AR, the games and every feature. Every choice in the games earns the same. Only full earns points, once,
 * and only where the law allows paying for data. Each level is just the person's own yes or no for each kind of data:
 * their law and the company's rules still apply on top, so a level can never collect more than the law allows.
 */
export const dataLevels = ['full', 'medium', 'lite'] as const;
export type DataLevel = (typeof dataLevels)[number];
export const levelChoices: Record<DataLevel, Partial<Record<DataCategory, boolean>>> = {
  full: { interactions: true, choices: true, preciseLocation: true, device: true, identityLinking: true },
  medium: { interactions: true, choices: true, preciseLocation: true, device: true, identityLinking: false },
  lite: { interactions: false, choices: false, preciseLocation: false, device: false, identityLinking: false },
};
export const dataLevelInfo: Record<DataLevel, { label: string; what: string }> = {
  full: { label: 'Full', what: 'Everything the law allows where you are: your choices, how you use pages, your exact location when you scan, your device, and one profile across your phones and accounts.' },
  medium: { label: 'Medium', what: 'Your choices, how you use pages, your exact location when you scan, and your device. Your phones and accounts are not joined into one profile.' },
  lite: { label: 'Lite', what: 'Only what’s needed to run things and keep them fair. You’re counted, not profiled, and no exact location.' },
};
/** The notice shown before choosing (the kind California asks for when anything is given for data). */
export function dataLevelNotice(pays: boolean) {
  return pays
    ? 'Choosing Full earns a one-time points bonus. We give it because your data helps us train our AI and plan free and negatively priced products; we never sell it. You can change your level, or erase your data, at any time and keep the points. Nothing works differently at any level.'
    : 'Full doesn’t earn points where you are. You can change your level, or erase your data, at any time. Nothing works differently at any level.';
}

/**
 * The notice of financial incentive California requires before anyone is given something for their data (Cal. Code
 * Regs. tit. 11, § 7016): a summary of the offer, the kinds of data it covers, how to join and how to leave at any
 * time, and why the reward is reasonably related to what the data is worth to us, with how we worked that out. The
 * value estimate is the business's own figure: until it is set, the notice says the points are the estimate (a lawyer
 * should confirm the method before launch; see docs/COMPLIANCE.md).
 */
export function financialIncentiveNotice(points: number | null) {
  const pts = points ?? 0;
  return {
    title: 'Notice of financial incentive',
    summary: `Choosing Full earns a one-time bonus of ${pts} points. Points can be used for offers and rewards in the app; they are not cash.`,
    categories: (['interactions', 'choices', 'preciseLocation', 'device', 'identityLinking'] as const).map((k) => categoryInfo[k].label),
    howToJoin: 'Choose Full. Nothing is pre-selected and nothing works differently at any level.',
    howToLeave: 'Change your level or erase your data at any time, in the app or at /v1/me/data. You keep the points.',
    valueOfData: `We estimate the extra data Full shares is worth about the value of the points to us: ${pts} points. We worked this out from what the platform expects to spend per person on research and rewards for the same kinds of data; we never sell it.`,
    use: dataUse,
  };
}

/** What data is for, said the same way everywhere it's asked for. */
export const dataUse = 'We use this to train our AI and to plan future free and negatively priced products. We never sell your personal data. We may share findings that can’t be traced to anyone.';

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
