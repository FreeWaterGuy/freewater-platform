import { contrast, readableOn } from '../creative/poster';
import { checkKeepsake, keepsakeDecorations, keepsakeFonts, type KeepsakeSpec } from '../creative/keepsake';
import { shortenWords } from '../../core/shorten';

// A bottle someone is designing for themselves. The assistant proposes changes; this checks them.

export interface CustomDesign {
  label?: Partial<KeepsakeSpec>;
  quantity?: number; // 1 to 24
  names?: string[]; // one per bottle when the words use {name}
  scan?: { from?: string; message?: string; videoUrl?: string; photoUrls?: string[]; confetti?: boolean };
}

/** An attached picture or video. Pictures carry their data (for printing) and their stored address (for the scan page). */
export interface DesignAttachment { kind: 'image' | 'video'; name?: string; url: string; dataUrl?: string }

export type DesignPatch = {
  label?: Partial<Omit<KeepsakeSpec, 'photo' | 'colors'>> & { colors?: Partial<KeepsakeSpec['colors']> };
  usePhotoOnLabel?: number; // index of an attached picture
  removePhoto?: boolean;
  quantity?: number;
  names?: string[];
  scan?: { from?: string; message?: string; confetti?: boolean; useVideo?: number; usePhotos?: number[]; removeVideo?: boolean };
};

export const designMissingLabels = { words: 'the words on the bottle', message: 'the message people see when they scan it', names: 'a name for each bottle' } as const;
export type DesignMissing = keyof typeof designMissingLabels;

export function designMissing(d: CustomDesign): DesignMissing[] {
  const out: DesignMissing[] = [];
  if (!d.label?.headline) out.push('words');
  if (!d.scan?.message) out.push('message');
  const usesName = /\{name\}/.test(`${d.label?.headline ?? ''} ${d.label?.sub ?? ''}`);
  if (usesName && (d.names?.length ?? 0) < (d.quantity ?? 1)) out.push('names');
  return out;
}

/** A complete spec for drawing, with sensible stand-ins for anything not chosen yet. */
export function labelSpec(d: CustomDesign): KeepsakeSpec {
  const l = d.label ?? {};
  const spec: KeepsakeSpec = {
    headline: l.headline || 'Your words here',
    ...(l.sub ? { sub: l.sub } : {}),
    colors: { bg: '#F7C6D4', fg: '#0B0B0B', accent: '#B8862E', ...(l.colors ?? {}) },
    font: l.font ?? 'rounded',
    layout: l.photo ? (l.layout === 'words' ? 'words' : l.layout ?? 'photo-left') : 'words',
    decoration: l.decoration ?? 'none',
    ...(l.photo ? { photo: l.photo } : {}),
  };
  return spec;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export function applyDesignPatch(d: CustomDesign, p: DesignPatch, attachments: DesignAttachment[]): { design: CustomDesign; problems: string[] } {
  const next: CustomDesign = structuredClone(d);
  const problems: string[] = [];
  if (p.label || p.usePhotoOnLabel !== undefined || p.removePhoto) {
    const l = { ...(next.label ?? {}) };
    const pl = p.label ?? {};
    if (pl.headline !== undefined) l.headline = shortenWords(String(pl.headline), 60);
    if (pl.sub !== undefined) l.sub = shortenWords(String(pl.sub), 90) || undefined;
    if (pl.font !== undefined) { if (pl.font in keepsakeFonts) l.font = pl.font; else problems.push(`There's no "${pl.font}" lettering.`); }
    if (pl.decoration !== undefined) { if ((keepsakeDecorations as readonly string[]).includes(pl.decoration)) l.decoration = pl.decoration; else problems.push(`There's no "${pl.decoration}" decoration.`); }
    if (pl.layout !== undefined) { if (['words', 'photo-left', 'photo-full'].includes(pl.layout)) l.layout = pl.layout; }
    if (pl.colors) {
      const c = { bg: '#F7C6D4', fg: '#0B0B0B', accent: '#B8862E', ...(l.colors ?? {}) };
      for (const k of ['bg', 'fg', 'accent'] as const) { const v = pl.colors[k]; if (v === undefined) continue; if (HEX.test(v)) c[k] = v.toUpperCase(); else problems.push(`"${v}" isn't a color I can print.`); }
      if (contrast(c.bg, c.fg) < 3) c.fg = readableOn(c.bg);
      if (contrast(c.bg, c.accent) < 2.2) c.accent = c.fg;
      l.colors = c;
    }
    if (p.removePhoto) { delete l.photo; l.layout = 'words'; }
    if (p.usePhotoOnLabel !== undefined) {
      const a = attachments[p.usePhotoOnLabel];
      if (!a || a.kind !== 'image' || !a.dataUrl) problems.push('I couldn’t find that photo.');
      else { l.photo = a.dataUrl; if (!l.layout || l.layout === 'words') l.layout = 'photo-left'; }
    }
    next.label = l;
  }
  if (p.quantity !== undefined) {
    const q = Math.round(Number(p.quantity));
    if (q >= 1 && q <= 24) next.quantity = q; else problems.push('You can make 1 to 24 bottles at a time.');
  }
  if (p.names !== undefined) {
    const names = (p.names ?? []).map((n) => String(n).trim().slice(0, 24)).filter(Boolean).slice(0, 24);
    next.names = names;
    if (names.length > (next.quantity ?? 1)) next.quantity = names.length;
  }
  if (p.scan) {
    const s = { ...(next.scan ?? {}) };
    if (p.scan.from !== undefined) s.from = String(p.scan.from).trim().slice(0, 80) || undefined;
    if (p.scan.message !== undefined) s.message = String(p.scan.message).trim().slice(0, 1000) || undefined;
    if (p.scan.confetti !== undefined) s.confetti = !!p.scan.confetti;
    if (p.scan.removeVideo) delete s.videoUrl;
    if (p.scan.useVideo !== undefined) {
      const a = attachments[p.scan.useVideo];
      if (!a || a.kind !== 'video') problems.push('I couldn’t find that video.'); else s.videoUrl = a.url;
    }
    if (p.scan.usePhotos) {
      const urls = p.scan.usePhotos.map((i) => attachments[i]).filter((a) => a?.kind === 'image').map((a) => a!.url);
      s.photoUrls = [...new Set([...(s.photoUrls ?? []), ...urls])].slice(0, 12);
    }
    next.scan = s;
  }
  const bad = next.label?.headline ? checkKeepsake(labelSpec(next)) : null;
  if (bad) problems.push(`The label isn't right yet: ${bad}.`);
  return { design: next, problems };
}

/** What scanning one of these bottles opens: the custom-experience plug-in's settings. */
export function experienceOf(d: CustomDesign) {
  const s = d.scan ?? {};
  return { from: s.from || 'Someone who thought of you', message: s.message || 'Made just for you.', ...(s.confetti ? { confetti: true } : {}), ...(s.videoUrl ? { videoUrl: s.videoUrl } : {}), ...(s.photoUrls?.length ? { photoUrls: s.photoUrls } : {}) };
}
