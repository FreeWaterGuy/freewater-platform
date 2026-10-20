import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { commandKinds, type CommandKind } from '../modules/fleet/service';
import { ApiError, obj, S, type RouteDef } from './http';

/**
 * Model 6 machines talk to the platform here, each with its own key that belongs to that one machine.
 * Ops sees and steers the fleet through /v1/ops/fleet.
 */
export function machineRoutes(app: App, route: (r: RouteDef) => void) {
  const { fleet } = app;
  const mine = (key: ApiKey | null) => {
    if (!key?.locationId) throw new ApiError(403, 'machine_key_required', 'Use the key made for this machine. It’s shown once when the machine is added in the console.');
    if (!fleet.isModel6(key.locationId)) throw new ApiError(409, 'not_model6', `${key.locationId} isn’t set up as a Model 6. Change it in the console under Machines.`);
    return key.locationId;
  };
  const n = (min: number, max: number) => ({ type: 'number', minimum: min, maximum: max });
  const statusSchema = obj({
    printer: obj({ state: { type: 'string', enum: ['ready', 'printing', 'jammed', 'out_of_labels', 'error'] }, labelsLeft: n(0, 100000), labelsCapacity: n(1, 100000), inkPercent: n(0, 100), message: { type: 'string', maxLength: 200 } }, ['state', 'labelsLeft', 'labelsCapacity', 'inkPercent']),
    dispenser: obj({ state: { type: 'string', enum: ['ready', 'dropping', 'stuck', 'empty', 'error'] }, bottlesLeft: n(0, 10000), capacity: n(1, 10000) }, ['state', 'bottlesLeft', 'capacity']),
    door: { type: 'string', enum: ['closed', 'open'] }, temperatureC: n(-40, 90), network: { type: 'string', maxLength: 20 }, uptimeSec: n(0, 1e9), screen: { type: 'string', maxLength: 30 }, online: S.bool,
  }, ['printer', 'dispenser', 'door', 'temperatureC', 'uptimeSec']);

  // ---------- the machine itself ----------
  route({ method: 'POST', url: '/v1/machine/heartbeat', scope: 'orders', summary: 'Model 6: say how the machine is (printer, bottles, door, temperature). The answer has its mode, commands to run, the code for its screen, and its screen settings when they change.', body: obj({ status: statusSchema, softwareVersion: { type: 'string', maxLength: 40 }, bufferHeld: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 60 } }, screenVersion: { type: 'string', maxLength: 40 } }, ['status', 'softwareVersion']), handler: async (req, key) => ({ body: await fleet.heartbeat(mine(key), req.body as any) }) });
  route({ method: 'GET', url: '/v1/machine/jobs/next', scope: 'orders', summary: 'Model 6: the next bottle to print, waiting up to ?wait= seconds (max 25) for one. Taking it starts the clock to finish it.', handler: async (req, key) => {
    const wait = Math.max(0, Math.min(25, Number((req.query as any).wait ?? 0))) * 1000;
    const locationId = mine(key);
    // If the machine's request goes away while it waits, stop waiting; a job taken for it goes back in the queue.
    const gone = new AbortController();
    const socket = req.raw.socket;
    const onClose = () => gone.abort();
    socket?.once('close', onClose);
    let job: Awaited<ReturnType<typeof fleet.nextJob>>;
    try { job = await fleet.nextJob(locationId, wait, gone.signal); } finally { socket?.off('close', onClose); }
    if (job && (gone.signal.aborted || socket?.destroyed)) { fleet.requeue(locationId, job.jobId); return { status: 204 }; }
    return job ? { body: job } : { status: 204 };
  } });
  route({ method: 'POST', url: '/v1/machine/jobs/:id/result', scope: 'orders', summary: 'Model 6: what happened. "dispensed" means the bottle reached the tray, and only then is it billed.', body: obj({ status: { type: 'string', enum: ['dispensed', 'failed'] }, stage: { type: 'string', enum: ['print', 'drop'] }, reason: { type: 'string', maxLength: 200 }, printMs: S.int, dropMs: S.int, hardware: obj({ printer: statusSchema.properties.printer, dispenser: statusSchema.properties.dispenser, door: statusSchema.properties.door, temperatureC: statusSchema.properties.temperatureC }) }, ['status']), handler: async (req, key) => ({ body: await fleet.report(mine(key), (req.params as any).id, req.body as any) }) });
  route({ method: 'GET', url: '/v1/machine/presence', scope: 'orders', summary: 'Model 6: the code for the screen right now. It changes every 30 seconds.', handler: async (_req, key) => ({ body: await fleet.presenceFor(mine(key)) }) });
  route({ method: 'POST', url: '/v1/machine/buffer', scope: 'orders', summary: 'Model 6: labels to keep for when the internet drops. Their ads are held; nothing is billed unless one is printed.', body: obj({ want: { type: 'integer', minimum: 1, maximum: 50 } }, ['want']), handler: async (req, key) => ({ body: await fleet.refillBuffer(mine(key), (req.body as any).want) }) });
  route({ method: 'POST', url: '/v1/machine/offline-report', scope: 'orders', summary: 'Model 6: after the internet comes back, which kept labels were printed (billed now) and which were spoiled (let go).', body: obj({ items: { type: 'array', maxItems: 500, items: obj({ unitId: S.str, status: { type: 'string', enum: ['dispensed', 'failed'] }, at: S.str, reason: { type: 'string', maxLength: 200 } }, ['unitId', 'status', 'at']) } }, ['items']), handler: async (req, key) => ({ body: await fleet.offlineReport(mine(key), (req.body as any).items) }) });
  route({ method: 'POST', url: '/v1/machine/commands/:id/result', scope: 'orders', summary: 'Model 6: the outcome of a command from ops.', body: obj({ ok: S.bool, message: { type: 'string', maxLength: 300 } }, ['ok']), handler: async (req, key) => ({ body: await fleet.commandResult(mine(key), (req.params as any).id, req.body as any) }) });

  // ---------- ops ----------
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can do this.'); return key; };
  route({ method: 'GET', url: '/v1/ops/fleet', scope: ['admin', 'orders', 'packs', 'events'], summary: 'Every machine: online or not, bottles and labels left, open problems, the last day’s prints.', handler: async (_req, key) => ({ body: await fleet.list(staff(key).companyId) }) });
  route({ method: 'GET', url: '/v1/ops/fleet/:id', scope: ['admin', 'orders', 'packs', 'events'], summary: 'One machine: its health, recent prints, commands and problems.', handler: async (req, key) => ({ body: await fleet.detail(staff(key).companyId, (req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/ops/fleet/:id/commands', scope: ['admin', 'orders'], summary: 'Ask a machine to do something: test_print, restart, out_of_service (with a reason), in_service, refresh_screen, sync_buffer or update_software.', body: obj({ kind: { type: 'string', enum: [...commandKinds] }, args: { type: 'object', maxProperties: 5 } }, ['kind']), handler: async (req, key) => {
    const b = req.body as { kind: CommandKind; args?: Record<string, unknown> };
    return { status: 201, body: await fleet.command(staff(key).companyId, (req.params as any).id, b.kind, b.args, key!.name) };
  } });
}
