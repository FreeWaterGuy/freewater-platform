/**
 * The box-code sticker's words (docs/REVIEW-LOG.md, 2026-10-25, "Wording round 2", item 9). The sticker showed "R3 · 1"
 * and "#4886F" beside the box code, unexplained. Both are for the driver, so both stay, said in words: "Stop R3 · 1"
 * (route 3, stop 1) and "Box #4886F" (the box's short number, the one the driver app names). The words are checked
 * before they're outlined (outlining turns them into shapes).
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/modules/print/outline', () => ({ outlineText: (svg: string) => svg }));
import { renderSticker } from '../src/modules/packs/sticker';
import { stickerSetting } from '../src/modules/packs/boxSettings';
import { boxNumber } from '../src/modules/packs/boxRenderer';
import { freewater } from '../src/demo/seed';

const words = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('9. the sticker labels what the driver reads', () => {
  it('"Stop R3 · 1" and "Box #…", beside "Box code: …"; nothing unexplained', () => {
    const r = renderSticker({ company: freewater, packId: 'pk_91c2a0e4886f', packUrl: 'https://freewater.io/Q/7K2QF8MN3XPART', routeId: 'route-3', stop: 1, setting: stickerSetting(freewater, 12) });
    expect(words(r.svg)).toEqual(['Stop R3 · 1', `Box #${boxNumber('pk_91c2a0e4886f')}`, 'Box code: 7K2Q F8MN 3XPA RT']);
  });
  it('a long route and stop still fit across the top', () => {
    const st = stickerSetting(freewater, 12);
    const r = renderSticker({ company: freewater, packId: 'pk_91c2a0e4886f', packUrl: 'https://freewater.io/Q/7K2QF8MN3XPART', routeId: 'route-12', stop: 148, setting: st });
    const size = Number(/font-size="([\d.]+)"/.exec(r.svg)![1]);
    const [a, b] = words(r.svg);
    expect((a!.length + b!.length) * 0.6 * size).toBeLessThanOrEqual(st.widthIn * 100);
  });
});
