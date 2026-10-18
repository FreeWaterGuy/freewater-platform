import type { DesignPatch } from '../custom/design';
import type { DesignAssistant, DesignAssistantInput, DesignAssistantOutput } from './designContract';

/**
 * The built-in stand-in for the design AI. It picks out the occasion, names, ages, colors, words in quotes,
 * how many bottles, and what to do with attached photos and videos, then makes a full design and asks what's missing.
 */
const OCCASIONS: [RegExp, string, { bg: string; fg: string; accent: string }, string, string][] = [
  // pattern, id, colors, decoration, sub line
  [/\b(birthday|bday|turns? \d+|\d+(st|nd|rd|th) (birthday|bday))\b/, 'birthday', { bg: '#F7C6D4', fg: '#2B1A22', accent: '#B8862E' }, 'confetti', ''],
  [/\b(wedding|married|bride|groom|mr\.? (and|&) mrs)\b/, 'wedding', { bg: '#FBF6EE', fg: '#2B2B2B', accent: '#B8862E' }, 'hearts', ''],
  [/\b(baby shower|it'?s a (boy|girl)|new baby|gender reveal)\b/, 'baby', { bg: '#DCEFF8', fg: '#1F3B57', accent: '#E58FB0' }, 'dots', ''],
  [/\b(grad(uation)?|class of \d{4})\b/, 'graduation', { bg: '#1F2A44', fg: '#FFFFFF', accent: '#F2C14E' }, 'stars', ''],
  [/\b(anniversary)\b/, 'anniversary', { bg: '#5B1A2B', fg: '#FFFFFF', accent: '#F2C14E' }, 'hearts', ''],
  [/\b(team|company|staff|office|conference|offsite|employees)\b/, 'team', { bg: '#0B0B0B', fg: '#FFFFFF', accent: '#7FC6EA' }, 'stripes', ''],
  [/\b(thank(s| you)|appreciation)\b/, 'thanks', { bg: '#EAF5EC', fg: '#1D3B2A', accent: '#2F8F4E' }, 'stars', ''],
  [/\b(christmas|holiday|hanukkah|new year)\b/, 'holiday', { bg: '#14532D', fg: '#FFFFFF', accent: '#F2C14E' }, 'stars', ''],
];
const COLORS: Record<string, string> = { red: '#D7262E', orange: '#F28C28', yellow: '#F2C14E', gold: '#C9A227', green: '#2F8F4E', teal: '#14857F', blue: '#1E7DB8', navy: '#1F2A44', purple: '#6B3FA0', lavender: '#C9B6E8', pink: '#F7C6D4', 'hot pink': '#E0457B', brown: '#5B3A26', black: '#0B0B0B', white: '#FFFFFF', cream: '#FBF3E3', silver: '#C0C6CC', mint: '#CDEBC5' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const COMMON = new Set(['I', 'We', 'The', 'A', 'An', 'Our', 'My', 'Her', 'His', 'Their', 'Happy', 'Make', 'Please', 'For', 'And', 'When', 'With', 'Pink', 'Gold', 'Blue', 'Love', 'Bottles', 'Free', 'It', 'This', 'Thanks', 'Thank', 'Hi', 'Hey']);

export class BuiltinDesigner implements DesignAssistant {
  readonly name = 'built-in helper';

  async respond(input: DesignAssistantInput): Promise<DesignAssistantOutput> {
    const { design: d, context: ctx } = input;
    const text = input.message.trim();
    const low = text.toLowerCase();
    const patch: DesignPatch = {};
    const did: string[] = [];
    const label: NonNullable<DesignPatch['label']> = {};
    const scan: NonNullable<DesignPatch['scan']> = {};

    // Who it's for, how old, and what for.
    const occ = OCCASIONS.find(([re]) => re.test(low));
    const name = /\b(?:for|to|celebrate|celebrating)\s+([A-Z][a-z]+)(?:'s)?\b/.exec(text)?.[1] ?? /\b([A-Z][a-z]+)'s\b/.exec(text)?.[1] ?? /\b([A-Z][a-z]+) turns\b/.exec(text)?.[1];
    const who = name && !COMMON.has(name) ? name : undefined;
    const age = /\b(\d{1,3})(?:st|nd|rd|th)\b/.exec(low)?.[1] ?? /\bturns? (\d{1,3})\b/.exec(low)?.[1];
    if (!d.label?.colors && occ) { label.colors = occ[2]; label.decoration = occ[3] as any; }
    else if (!d.label?.colors) label.colors = { bg: '#EEF6FB', fg: '#0B0B0B', accent: '#1E7DB8' };

    // The words: quotes win; otherwise built from the occasion.
    const quoted = [...text.matchAll(/["“]([^"”]{2,60})["”]/g)].map((m) => m[1]!);
    const frontCmd = /\b(?:front|big words|headline|on the (?:bottle|label))\b[^"“]*["“]([^"”]{2,60})["”]/i.exec(text)?.[1];
    const aboutScan = /\b(message|scan|scans|scanned)\b/.test(low);
    let headline = frontCmd ?? (quoted.length && !aboutScan ? quoted[0] : undefined);
    if (!headline && !d.label?.headline && occ) {
      const id = occ[1];
      headline = id === 'birthday' ? (who && age ? `${who} turns ${age}` : who ? `Happy birthday, ${who}` : age ? `Happy ${age}th!` : 'Happy birthday!')
        : id === 'wedding' ? (who ? `${who}'s wedding` : 'Just married') : id === 'baby' ? (who ? `Welcome, ${who}` : 'Oh baby!')
        : id === 'graduation' ? (who ? `Congrats, ${who}!` : 'Congrats, grad!') : id === 'anniversary' ? 'Happy anniversary'
        : id === 'team' ? (who ? `Team ${who}` : 'Thanks, team!') : id === 'thanks' ? 'Thank you!' : 'Happy holidays';
    }
    if (headline) { label.headline = headline; did.push(`“${headline}” on the front`); }
    const subQ = /\b(?:small (?:words|line)|underneath|below)\b[^"“]*["“]([^"”]{2,90})["”]/i.exec(text)?.[1];
    const love = /\b((?:[Ll]ove|[Cc]heers|[Ff]rom|[Xx]oxo),?\s+[A-Z][\w' &]+?)(?:[.!,]|$)/.exec(text)?.[1];
    if (subQ) label.sub = subQ;
    else if (love && !d.label?.sub) label.sub = cap(love.trim());

    // Colors and style.
    const named = [...low.matchAll(/\b(hot pink|red|orange|yellow|gold|green|teal|blue|navy|purple|lavender|pink|brown|black|white|cream|silver|mint)\b/g)].map((m) => COLORS[m[1]!]!);
    const hex = [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
    const colors = [...hex, ...named];
    if (colors.length) { label.colors = { bg: colors[0], ...(colors[1] ? { accent: colors[1] } : {}) }; did.push('your colors'); }
    if (/\b(script|cursive|fancy|elegant)\b/.test(low)) label.font = 'script';
    else if (/\b(classic|serif|formal)\b/.test(low)) label.font = 'classic';
    else if (/\b(clean|simple|modern)\b/.test(low)) label.font = 'clean';
    for (const deco of ['confetti', 'stars', 'hearts', 'dots', 'stripes', 'balloons']) if (low.includes(deco)) label.decoration = deco as any;
    if (/\b(no (decoration|confetti|pattern)|plain)\b/.test(low)) label.decoration = 'none';
    if (/\b(full|whole|big) (photo|picture)\b|\bphoto (fills|across)\b/.test(low)) label.layout = 'photo-full';
    if (Object.keys(label).length) patch.label = label;

    // Photos and videos they attached.
    const images = input.attachments.map((a, i) => ({ a, i })).filter((x) => x.a.kind === 'image');
    const videos = input.attachments.map((a, i) => ({ a, i })).filter((x) => x.a.kind === 'video');
    const photoForScanOnly = /\b(scan page|when (friends|people|they) scan|gallery)\b/.test(low) && !/\b(front|label|on the bottle)\b/.test(low);
    if (images.length && !photoForScanOnly) { patch.usePhotoOnLabel = images[0]!.i; did.push('the photo on the front'); }
    if (images.length > (photoForScanOnly ? 0 : 1) || (images.length && photoForScanOnly)) { scan.usePhotos = images.slice(photoForScanOnly ? 0 : 1).map((x) => x.i); if (scan.usePhotos.length) did.push(`${scan.usePhotos.length === 1 ? 'a photo' : `${scan.usePhotos.length} photos`} on the scan page`); }
    if (videos.length) { scan.useVideo = videos[0]!.i; did.push('your video on the scan page'); }
    if (/\b(no|remove|without) (the )?(photo|picture)\b/.test(low)) patch.removePhoto = true;
    if (/\b(no|remove|without) (the )?video\b/.test(low)) scan.removeVideo = true;

    // The message when someone scans it.
    const msgCmd = /\b(?:message|when (?:friends|people|they|someone) scans?(?: it)?)\b[^"“]*["“]([^"”]{2,500})["”]/i.exec(text)?.[1];
    if (msgCmd) { scan.message = msgCmd; did.push('the message'); }
    else if (!d.scan?.message && (headline || d.label?.headline) && occ) scan.message = occ[1] === 'birthday' ? `Happy birthday${who ? `, ${who}` : ''}! Here's to you.` : occ[1] === 'wedding' ? 'Thank you for celebrating with us!' : occ[1] === 'team' ? 'Thanks for everything you do.' : `${headline ?? d.label?.headline}`;
    const from = /\b(?:[Ff]rom|[Ll]ove,?|[Ss]igned,?|[Cc]heers,?)\s+([A-Z][\w' &]+?)(?:[.!,]|$)/.exec(text)?.[1];
    if (from) scan.from = from.trim();
    if (/\bconfetti\b/.test(low) && !/\bno confetti\b/.test(low)) scan.confetti = true;
    else if (occ && d.scan?.confetti === undefined && ['birthday', 'graduation', 'wedding'].includes(occ[1])) scan.confetti = true;
    if (/\bno confetti\b/.test(low)) scan.confetti = false;
    if (Object.keys(scan).length) patch.scan = scan;

    // How many, and names on each.
    const qty = /\b(\d{1,2})\s*(?:bottles|of them|-?pack)\b/.exec(low)?.[1] ?? (/\ba dozen\b/.test(low) ? '12' : undefined);
    if (qty) { patch.quantity = Number(qty); did.push(`${qty} bottles`); }
    const list = /\bnames?\s*(?:are|:)\s*([A-Za-z ,'&-]{3,400}?)(?:\.|$)/i.exec(text)?.[1];
    if (list) {
      const names = list.split(/,|\band\b|&/).map((s) => s.trim()).filter(Boolean);
      patch.names = names; did.push(`${names.length} names`);
      if (!/\{name\}/.test(`${d.label?.headline ?? ''}${label.headline ?? ''}${d.label?.sub ?? ''}`)) patch.label = { ...(patch.label ?? {}), sub: '{name}' };
    } else if (/\b(a |their |each )?name on (each|every)\b/.test(low)) {
      patch.label = { ...(patch.label ?? {}), sub: '{name}' };
      did.push('a name on each bottle');
    }

    const left = new Set(ctx.missing);
    if (label.headline || d.label?.headline) left.delete('words');
    if (scan.message || d.scan?.message) left.delete('message');
    if (patch.names?.length) left.delete('names');
    if (patch.label?.sub === '{name}' && !patch.names && !(d.names?.length)) left.add('names');
    const first = !d.label?.headline;
    const start = did.length ? `${first ? 'Here’s a first design' : 'Done'}: ${did.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : first ? 'Let’s make your bottle.' : 'Got it.';
    const ask: Record<string, string> = {
      words: 'What should the front say? Tell me the occasion and who it’s for, like “Maya’s 30th birthday”.',
      message: 'What should people see when they scan it? Write a message in quotes, and add a video if you like.',
      names: 'What names go on the bottles? Say “names: Ana, Ben, Cy”.',
    };
    const next = [...left][0];
    const reply = next ? `${start} ${ask[next]}` : `${start} ${ctx.hasPhoto || patch.usePhotoOnLabel !== undefined ? '' : 'Want to add a photo? Tap + to attach one. '}When you like it, tap “Review my proof”.`;
    const suggestions = next === 'message' ? ['“Thanks for coming!”', 'Add confetti'] : next === 'names' ? ['names: Ana, Ben, Cy'] : next === 'words' ? ['Maya’s 30th birthday, pink and gold', 'Thank-you bottles for my team'] : [ctx.hasPhoto || patch.usePhotoOnLabel !== undefined ? 'Make the photo fill the label' : 'Add confetti', 'Use fancy lettering', '12 bottles'];
    return { reply: reply.trim(), patch, suggestions };
  }
}
