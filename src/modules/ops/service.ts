import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { ExperienceHost } from '../experiences/host';
import type { DeliveryService } from '../delivery/service';
import { signed } from '../books/service';

/** What the company's team sees: today at a glance, and how every machine is doing. */
export class OpsService {
  constructor(private db: SqlClient, private platform: Platform, private delivery: DeliveryService, private host: ExperienceHost) {}

  private dayOf(companyId: string, iso: string | Date) {
    return this.delivery.today(companyId, typeof iso === 'string' ? new Date(iso) : iso);
  }

  async overview(companyId: string) {
    const p = this.platform;
    const today = this.delivery.today(companyId);
    const since = new Date(p.bus.now().getTime() - 36 * 3600_000).toISOString(); // wide enough to cover "today" in any time zone
    const units = [...p.units.values()].filter((u) => u.companyId === companyId && this.dayOf(companyId, u.createdAt) === today);
    const events = (await this.db.query<any>(`select type, at, payload from events where company_id = $1 and at >= $2 and type in ('unit.scanned','ar.launched','box.scanned','print.failed','delivery.rejected')`, [companyId, since])).rows
      .filter((e) => this.dayOf(companyId, new Date(e.at)) === today);
    const lines = (await this.db.query<any>(`select at, kind, debit, credit, amount_cents from ledger_entries where company_id = $1 and at >= $2`, [companyId, since])).rows
      .filter((l) => this.dayOf(companyId, new Date(l.at)) === today);
    const count = (t: string) => events.filter((e) => e.type === t).length;
    const runs = await this.delivery.runs(companyId, today);
    const stops = runs.flatMap((r) => r.stops);
    const review = [...p.campaigns.values()].filter((c) => c.companyId === companyId && (c.review?.status === 'submitted' || c.review?.status === 'flagged')).length;
    return {
      date: today,
      bottles: { printed: units.filter((u) => u.status === 'dispensed' || u.status === 'printed').length, failed: units.filter((u) => u.status === 'failed').length, custom: units.filter((u) => u.kind === 'custom' && u.status !== 'failed').length, inPacks: units.filter((u) => u.packId && u.status !== 'failed').length },
      engagement: { scans: count('unit.scanned') + count('box.scanned'), arLaunches: count('ar.launched') },
      // By each line's side, as the open books count it: a reversal (a refund, a voided batch) takes back what it added.
      money: { revenueCents: lines.reduce((s, l) => s + signed(l, 'revenue:'), 0), donatedCents: lines.filter((l) => l.kind === 'donation').reduce((s, l) => s + signed(l, 'payable:charity:'), 0) },
      delivery: { routes: runs.length, stops: stops.length, delivered: stops.filter((s) => s.status === 'delivered').length, notDelivered: stops.filter((s) => s.status === 'not_delivered').length, wrongBoxScans: count('delivery.rejected') },
      attention: { adsToReview: review, printFailures: count('print.failed'), pluginFailures: this.host.failures.length },
    };
  }

  async machines(companyId: string) {
    const p = this.platform;
    const today = this.delivery.today(companyId);
    const since = new Date(p.bus.now().getTime() - 36 * 3600_000).toISOString();
    const failed = (await this.db.query<any>(`select at, payload from events where company_id = $1 and type = 'print.failed' and at >= $2`, [companyId, since])).rows;
    const company = p.companies.get(companyId)!;
    return [...p.locations.values()].filter((l) => l.kind === 'machine' && l.companyId === companyId).map((l) => {
      const units = [...p.units.values()].filter((u) => u.locationId === l.id);
      const todays = units.filter((u) => this.dayOf(companyId, u.createdAt) === today);
      const last = units.filter((u) => u.status !== 'failed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const fails = failed.filter((e) => {
        const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
        return p.units.get(payload.unitId)?.locationId === l.id && this.dayOf(companyId, new Date(e.at)) === today;
      }).length;
      const quietHours = last ? (p.bus.now().getTime() - Date.parse(last.createdAt)) / 3600_000 : null;
      const status = fails >= 3 ? 'attention' : quietHours === null || quietHours > 6 ? 'quiet' : 'ok';
      return { id: l.id, name: l.name, city: l.city, address: l.address ?? null, lat: l.lat ?? null, lng: l.lng ?? null, printer: company.modules.printer,
        printedToday: todays.filter((u) => u.status !== 'failed').length, customToday: todays.filter((u) => u.kind === 'custom' && u.status !== 'failed').length, failedPrintsToday: fails, lastPrintAt: last?.createdAt ?? null, status };
    });
  }
}
