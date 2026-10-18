// What a scan page can show. Plug-ins return these blocks as plain data; the scan page draws them.
// Because blocks are data and never code, no plug-in (ours or a partner's) can run anything on a viewer's phone.

export interface ModelRef {
  glbUrl: string; // a FreeWater asset or built-in model
  alt: string;
}

export type Action =
  | { kind: 'link'; url: string } // opens the advertiser's site; FreeWater adds fw_unit and fw_slot so sales can be credited
  | { kind: 'save' } // saves this to the viewer's Saved list
  | { kind: 'ar' } // opens the 3D model in the viewer's space
  | { kind: 'call'; phone: string };

export type Block =
  | { type: 'hero'; title: string; subtitle?: string; imageUrl?: string; model?: ModelRef }
  | { type: 'text'; text: string }
  | { type: 'offer'; headline: string; details?: string; code?: string; expires?: string }
  | { type: 'button'; label: string; action: Action; style?: 'primary' | 'secondary' }
  | { type: 'model'; model: ModelRef; arLabel?: string; addOns?: { id: string; label: string; model: ModelRef }[]; buy?: { label: string; url: string; title: string } }
  /** A one-time coupon made for this viewer (added by the platform, never by a plug-in). */
  | { type: 'coupon'; headline: string; details?: string; expires?: string; code: string; qrSvg: string; redeemed: boolean }
  | { type: 'tour'; title: string; rooms: { name: string; imageUrl?: string; color?: string; note?: string }[]; model?: ModelRef }
  | { type: 'video'; url: string; posterUrl?: string; caption?: string }
  | { type: 'article'; headline: string; byline?: string; paragraphs: string[] }
  | { type: 'booking'; title: string; slots: string[]; action: Action }
  | { type: 'gallery'; imageUrls: string[] }
  | { type: 'message'; from: string; text: string }
  | { type: 'confetti' }
  /**
   * AR in one of three kinds:
   * - world: put the 3D model in the room (on a table, the floor).
   * - bottle: the 3D model stays attached to the bottle in the camera (sitting on top, floating in front, circling it).
   * - label: a new label is laid over the real one, all the way round; turn the bottle and it turns with it.
   */
  | { type: 'ar'; mode: ArMode; title: string; model?: ModelRef; placement?: ArPlacement; motion?: ArMotion; sizeIn?: number; wrap?: ArWrap; caption?: string; cta?: { label: string; url: string } }
  /** A short line written for this person (by the AI or the built-in rules); added by the platform, never by a plug-in. */
  | { type: 'greeting'; text: string; by: string };

export type ArMode = 'world' | 'bottle' | 'label';
export type ArPlacement = 'top' | 'front' | 'orbit' | 'beside';
export type ArMotion = 'none' | 'spin' | 'float';
/** What the living label shows over the advertiser's part of the label. */
export interface ArWrap { imageUrl?: string; videoUrl?: string; effect?: 'none' | 'shimmer' | 'ripple' | 'sparkle'; color?: string }

export interface Theme {
  background: string;
  text: string;
  accent: string;
  button: string;
  buttonText: string;
}

export interface ExperienceDoc {
  pluginId: string;
  owner: { name: string; theme: Theme };
  blocks: Block[];
  fallback: boolean; // true when the plug-in failed or was too slow and the owner's simple card is shown
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** Links may point to the web (https), to FreeWater assets, or to built-in models. Nothing else. */
export const safeUrl = (v: unknown) => typeof v === 'string' && v.length <= 2000 && (/^https:\/\/[^\s"'<>]+$/.test(v) || /^\/(assets|models)\/[A-Za-z0-9_.\-/]+$/.test(v));

function checkModel(m: any, path: string): string | null {
  if (!m || typeof m !== 'object') return `${path} must be a model`;
  if (!safeUrl(m.glbUrl)) return `${path}.glbUrl must be https or a FreeWater asset`;
  if (!str(m.alt, 200)) return `${path}.alt is required (it describes the model for people who can't see it)`;
  return null;
}
function checkAction(a: any, path: string): string | null {
  if (!a || typeof a !== 'object') return `${path} must be an action`;
  if (a.kind === 'link') return safeUrl(a.url) ? null : `${path}.url must be https`;
  if (a.kind === 'call') return /^\+?[\d\s()-]{7,20}$/.test(a.phone ?? '') ? null : `${path}.phone is not a phone number`;
  if (a.kind === 'save' || a.kind === 'ar') return null;
  return `${path}.kind is not a known action`;
}

/** Returns the first problem, or null if every block is safe to show. Used on our plug-ins and partners' alike. */
export function checkBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return 'blocks must be a non-empty list';
  if (blocks.length > 40) return 'at most 40 blocks';
  for (let i = 0; i < blocks.length; i++) {
    const b: any = blocks[i];
    const p = `blocks[${i}]`;
    if (!b || typeof b !== 'object') return `${p} is not a block`;
    switch (b.type) {
      case 'hero':
        if (!str(b.title, 120)) return `${p}.title is required`;
        if (b.subtitle !== undefined && !str(b.subtitle, 300)) return `${p}.subtitle is too long`;
        if (b.imageUrl !== undefined && !safeUrl(b.imageUrl)) return `${p}.imageUrl must be https or a FreeWater asset`;
        if (b.model !== undefined) { const e = checkModel(b.model, `${p}.model`); if (e) return e; }
        break;
      case 'text': if (!str(b.text, 2000)) return `${p}.text is required`; break;
      case 'offer': if (!str(b.headline, 120)) return `${p}.headline is required`; if (b.code !== undefined && !str(b.code, 40)) return `${p}.code is too long`; break;
      case 'button': { if (!str(b.label, 60)) return `${p}.label is required`; const e = checkAction(b.action, `${p}.action`); if (e) return e; break; }
      case 'model': {
        const e = checkModel(b.model, `${p}.model`); if (e) return e;
        if (b.addOns !== undefined) {
          if (!Array.isArray(b.addOns) || b.addOns.length > 8) return `${p}.addOns must be a list of up to 8`;
          for (let j = 0; j < b.addOns.length; j++) { const a = b.addOns[j]; if (!str(a?.id, 40) || !str(a?.label, 40)) return `${p}.addOns[${j}] needs id and label`; const e2 = checkModel(a.model, `${p}.addOns[${j}].model`); if (e2) return e2; }
        }
        break;
      }
      case 'tour':
        if (!str(b.title, 120)) return `${p}.title is required`;
        if (!Array.isArray(b.rooms) || b.rooms.length === 0 || b.rooms.length > 20) return `${p}.rooms must list 1 to 20 rooms`;
        for (const r of b.rooms) { if (!str(r?.name, 60)) return `${p}.rooms need names`; if (r.imageUrl !== undefined && !safeUrl(r.imageUrl)) return `${p}.rooms imageUrl must be https`; if (r.color !== undefined && !HEX.test(r.color)) return `${p}.rooms color must be #rrggbb`; }
        if (b.model !== undefined) { const e = checkModel(b.model, `${p}.model`); if (e) return e; }
        break;
      case 'video': if (!safeUrl(b.url)) return `${p}.url must be https or a FreeWater asset`; break;
      case 'article': if (!str(b.headline, 200) || !Array.isArray(b.paragraphs) || !b.paragraphs.every((x: unknown) => str(x, 4000))) return `${p} needs a headline and paragraphs`; break;
      case 'booking': { if (!str(b.title, 120) || !Array.isArray(b.slots) || !b.slots.every((x: unknown) => str(x, 40))) return `${p} needs a title and time slots`; const e = checkAction(b.action, `${p}.action`); if (e) return e; break; }
      case 'gallery': if (!Array.isArray(b.imageUrls) || b.imageUrls.length > 20 || !b.imageUrls.every(safeUrl)) return `${p}.imageUrls must be up to 20 https images`; break;
      case 'message': if (!str(b.from, 80) || !str(b.text, 1000)) return `${p} needs from and text`; break;
      case 'confetti': break;
      case 'ar': {
        if (!['world', 'bottle', 'label'].includes(b.mode)) return `${p}.mode must be world, bottle or label`;
        if (!str(b.title, 120)) return `${p}.title is required`;
        if (b.model !== undefined) { const e = checkModel(b.model, `${p}.model`); if (e) return e; }
        if ((b.mode === 'world' || b.mode === 'bottle') && !b.model) return `${p} needs a 3D model`;
        if (b.placement !== undefined && !['top', 'front', 'orbit', 'beside'].includes(b.placement)) return `${p}.placement must be top, front, orbit or beside`;
        if (b.motion !== undefined && !['none', 'spin', 'float'].includes(b.motion)) return `${p}.motion must be none, spin or float`;
        if (b.sizeIn !== undefined && !(typeof b.sizeIn === 'number' && b.sizeIn >= 0.5 && b.sizeIn <= 24)) return `${p}.sizeIn must be between 0.5 and 24 inches`;
        if (b.wrap !== undefined) {
          const w = b.wrap;
          if (!w || typeof w !== 'object') return `${p}.wrap must be an object`;
          if (w.imageUrl !== undefined && !safeUrl(w.imageUrl)) return `${p}.wrap.imageUrl must be https or a FreeWater asset`;
          if (w.videoUrl !== undefined && !safeUrl(w.videoUrl)) return `${p}.wrap.videoUrl must be https or a FreeWater asset`;
          if (w.effect !== undefined && !['none', 'shimmer', 'ripple', 'sparkle'].includes(w.effect)) return `${p}.wrap.effect must be none, shimmer, ripple or sparkle`;
          if (w.color !== undefined && !HEX.test(w.color)) return `${p}.wrap.color must be #rrggbb`;
        }
        if (b.caption !== undefined && !str(b.caption, 120)) return `${p}.caption is too long`;
        if (b.cta !== undefined && (!str(b.cta?.label, 40) || !safeUrl(b.cta?.url))) return `${p}.cta needs a label and an https url`;
        break;
      }
      default: return `${p}.type "${String(b.type)}" is not a known block`;
    }
  }
  return null;
}

export function checkTheme(t: any): string | null {
  if (!t) return null;
  for (const k of ['background', 'text', 'accent', 'button', 'buttonText']) if (t[k] !== undefined && !HEX.test(t[k])) return `theme.${k} must be a color like #D7262E`;
  return null;
}
