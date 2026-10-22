import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { CompanyConfig, Product, Share } from '../../core/types';
import { SIZE_SWITCHES, byId } from '../../runtime/registry';
import { adArea, layoutSwitch, templateFit, templateShares, TEMPLATES, type Layout } from './layouts';
import { prepaidLeft } from './budget';
import { companyLayouts, droppedPieces, fairTurnBottles, FAIR_TURN_DEFAULT, heldPaid, placementRule, whyNot, type On } from './layoutChoice';

/** The ad area's width over its height, for the small pictures. */
const aspectOf = (p: Product) => { const a = adArea(p); return Math.round((a.w / a.h) * 100) / 100; };

/**
 * The checks behind a company's label layouts (layoutChoice.ts), wherever they're changed: its switches on the
 * Features page, its most ads on a bottle and its choice for each product in the settings (and a settings version put
 * back). The founder's rules it keeps:
 *  - while ads are on, at least one layout stays usable on the standard product (a change that would leave none is
 *    refused, in plain words);
 *  - paid bottles are never stranded silently: a change that leaves a paid ad's size without a layout says how many
 *    bottles first (they wait, and print again once a layout holds them, or a person stops the ad and pays it back), and
 *    route pieces that could no longer share a label are counted first too (when their bottles print they come back to
 *    the advertiser as credit, the rule for pieces that can't print).
 */
export class LayoutGuard {
  constructor(private db: SqlClient, private platform: Platform, private onNow: (companyId: string, id: string) => boolean) {}

  private company(id: string) { return this.platform.companies.get(id); }
  private now(companyId: string): On { return (id) => this.onNow(companyId, id); }
  private products(companyId: string) { return [...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === companyId); }
  private layoutsBy(c: CompanyConfig, on: On) {
    const memo = new Map<string, Layout[]>();
    return (productId: string) => {
      let l = memo.get(productId);
      const p = this.platform.products.get(productId);
      if (!l) memo.set(productId, (l = p ? companyLayouts(c, p, on) : []));
      return l;
    };
  }

  /** A switch change (Features page): the refusal, if it would leave the standard product without a layout while ads are on. */
  switchProblem(companyId: string, onAfter: On): string | null {
    const c = this.company(companyId);
    if (!c || !onAfter('ads')) return null;
    const p = this.platform.standardProduct(companyId);
    if (companyLayouts(c, p, onAfter).length || !companyLayouts(c, p, this.now(companyId)).length) return null;
    return `At least one label layout has to stay on while ads are on: after this change no layout would be left for the ${p.name}. Turn another layout (and the sizes it needs) on first, or turn off “Ads on bottles”.`;
  }

  /**
   * A switch change: paid bottles it would hold back because no allowed layout holds their size any more. Ads whose
   * size itself goes off, or with ads off altogether, are already counted by the Features page's own warning.
   */
  switchWarnings(companyId: string, onAfter: On): string[] {
    const c = this.company(companyId);
    if (!c || !onAfter('ads') || !onAfter('printing')) return [];
    const before = new Set(heldPaid(this.platform.campaigns.values(), companyId, this.layoutsBy(c, this.now(companyId))).ids);
    const after = heldPaid(this.platform.campaigns.values(), companyId, this.layoutsBy(c, onAfter)).ids
      .filter((id) => !before.has(id) && onAfter(SIZE_SWITCHES[this.platform.campaigns.get(id)!.prepaid!.share]!));
    return this.paidWords(after);
  }

  /** A switch change: route pieces that could no longer share a label (counted from the database). */
  async switchRouteWarnings(companyId: string, onAfter: On): Promise<string[]> {
    const c = this.company(companyId);
    if (!c || !onAfter('ads') || !onAfter('printing')) return [];
    return this.routeWords(await this.droppedRoutePieces(c, c, this.now(companyId), onAfter));
  }

  /**
   * A settings change (most ads on a bottle, fewest, each product's layouts): the refusal, if any, and what it would
   * strand, counted. Unchanged layout settings: nothing to say.
   */
  async settingsCheck(companyId: string, cur: CompanyConfig, next: CompanyConfig): Promise<{ problem: string | null; stranded: { count: number; words: string[] } }> {
    const none = { problem: null, stranded: { count: 0, words: [] } };
    const pick = (c: CompanyConfig) => JSON.stringify([c.adRules.maxAdsPerUnit, c.adRules.minAdsPerUnit, c.adRules.productLayouts ?? null]);
    if (pick(cur) === pick(next)) return none;
    const on = this.now(companyId);
    // Each product named must be one this company prints (its own or a shared one: P5).
    for (const id of Object.keys(next.adRules.productLayouts ?? {})) {
      const p = this.platform.products.get(id);
      if (!p || (p.companyId && p.companyId !== companyId)) return { ...none, problem: `There is no product “${id}” here. Choose layouts only for your own or shared products.` };
    }
    if (on('ads')) {
      for (const p of this.products(companyId)) {
        const changed = JSON.stringify(cur.adRules.productLayouts?.[p.id] ?? null) !== JSON.stringify(next.adRules.productLayouts?.[p.id] ?? null);
        const std = p.id === this.platform.standardProduct(companyId).id;
        if ((changed || std) && !companyLayouts(next, p, on).length && companyLayouts(cur, p, on).length) {
          return { ...none, problem: `At least one label layout has to stay on while ads are on: no layout would be left for the ${p.name}. Choose one that fits it${std ? '' : ', or use your company’s layouts there'}.` };
        }
      }
    }
    const before = new Set(heldPaid(this.platform.campaigns.values(), companyId, this.layoutsBy(cur, on)).ids);
    const held = heldPaid(this.platform.campaigns.values(), companyId, this.layoutsBy(next, on)).ids.filter((id) => !before.has(id));
    const pieces = on('ads') ? await this.droppedRoutePieces(cur, next, on, on) : 0;
    const words = [...this.paidWords(held), ...this.routeWords(pieces)];
    return { problem: null, stranded: { count: this.left(held) + pieces, words } };
  }

  private paidWords(ids: string[]): string[] {
    if (!ids.length) return [];
    const bottles = this.left(ids);
    return [`${bottles.toLocaleString('en-US')} paid bottle${bottles === 1 ? '' : 's'} of ${ids.length} ad${ids.length === 1 ? '' : 's'} would have no label layout to print in. Paid bottles always go out: they wait, and print again once a layout that holds their size is back, or an owner or finance person stops each ad and pays back what wasn’t printed.`];
  }
  private left(ids: string[]) { return ids.reduce((a, id) => a + prepaidLeft(this.platform.campaigns.get(id)!), 0); }
  private routeWords(pieces: number): string[] {
    if (!pieces) return [];
    return [`${pieces.toLocaleString('en-US')} piece${pieces === 1 ? '' : 's'} bought on delivery routes could no longer share a label in a layout you allow. When their bottles are printed they’re given back to the advertiser as credit (the rule for pieces that can’t print), never charged.`];
  }

  /** Route pieces still to print that a change would leave off their bottles (the standard product: route bottles print on it). */
  private async droppedRoutePieces(cur: CompanyConfig, next: CompanyConfig, onCur: On, onNext: On): Promise<number> {
    const monday = (() => { const d = this.platform.bus.now(); const k = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - k * 86_400_000).toISOString().slice(0, 10); })();
    const rows = (await this.db.query<any>(`select house_id, week, bottle, share from route_spots where company_id = $1 and status = 'open' and bottle is not null and week >= $2`, [cur.id, monday])).rows;
    if (!rows.length) return 0;
    const bottles = new Map<string, Share[]>();
    for (const r of rows) { const k = `${r.house_id}|${String(r.week instanceof Date ? r.week.toISOString() : r.week).slice(0, 10)}|${r.bottle}`; const b = bottles.get(k) ?? []; b.push(Number(r.share) as Share); bottles.set(k, b); }
    const p = this.platform.standardProduct(cur.id);
    const all = [...bottles.values()];
    return Math.max(0, droppedPieces(all, companyLayouts(next, p, onNext), next.adRules.maxAdsPerUnit) - droppedPieces(all, companyLayouts(cur, p, onCur), cur.adRules.maxAdsPerUnit));
  }

  /** The Label layouts section of the Features page: every template with a small picture, and each product's choice. */
  view(companyId: string) {
    const c = this.company(companyId);
    if (!c) return null;
    const on = this.now(companyId);
    const std = this.platform.standardProduct(companyId);
    const label = (id: string) => byId.get(id)?.label ?? id;
    const fitStd = new Map(templateFit(std).map((f) => [f.template.id, f]));
    const usableStd = new Set(companyLayouts(c, std, on).map((l) => l.templateId));
    return {
      maxAds: c.adRules.maxAdsPerUnit, minAds: c.adRules.minAdsPerUnit, placement: placementRule(c), fairTurnBottles: fairTurnBottles(c), fairTurnDefault: FAIR_TURN_DEFAULT,
      standardProduct: { id: std.id, name: std.name, aspect: aspectOf(std) },
      templates: TEMPLATES.map((t) => {
        const f = fitStd.get(t.id)!;
        // Why it isn't used on the standard bottle, ignoring the product's own narrower choice (that's per product).
        const why = usableStd.has(t.id) ? null : whyNot({ ...c, adRules: { ...c.adRules, productLayouts: undefined } }, std, t.id, on, label);
        return { id: t.id, switchId: layoutSwitch(t), name: t.name, pieces: templateShares(t).length, sizes: [...new Set(templateShares(t))], shares: f.shares, rects: f.rects, own: this.ownChoice ? this.ownChoice(companyId, layoutSwitch(t)) : on(layoutSwitch(t)), usable: usableStd.has(t.id), why };
      }),
      products: this.products(companyId).map((p: Product) => {
        const mine = c.adRules.productLayouts?.[p.id];
        const fit = new Map(templateFit(p).map((f) => [f.template.id, f]));
        return {
          id: p.id, name: p.name, shared: !p.companyId, standard: p.id === std.id, chosen: mine ?? null, aspect: aspectOf(p),
          templates: TEMPLATES.map((t) => ({ id: t.id, rects: fit.get(t.id)!.rects, shares: fit.get(t.id)!.shares, chosen: !mine || mine.includes(t.id), why: whyNot({ ...c, adRules: { ...c.adRules, productLayouts: undefined } }, p, t.id, on, label) })),
        };
      }),
    };
  }
  /** Set by the app: the company's own choice for a switch (on even if something it needs is off). */
  ownChoice?: (companyId: string, id: string) => boolean;
}
