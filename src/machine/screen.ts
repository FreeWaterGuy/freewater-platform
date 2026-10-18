import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineAgent } from './agent';

// The machine's screen is a web page shown full-screen by the machine's browser (kiosk mode). This serves it,
// on this machine only, along with what it should show right now and the screen's one button (offline taps).

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const files: Record<string, [string, string]> = {
  '/': ['machine.html', 'text/html; charset=utf-8'],
  '/machine.js': ['machine.js', 'text/javascript'],
  '/machine.css': ['machine.css', 'text/css'],
};
const csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'self'";

export function startScreen(agent: MachineAgent, opts: { port: number; host?: string; extra?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }): Promise<Server> {
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' }); res.end(body); };
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    try {
      if (opts.extra && (await opts.extra(req, res))) return;
      if (req.method === 'GET' && path === '/local/state') return send(res, 200, 'application/json', JSON.stringify({ ...agent.screen(), now: Date.now() }));
      if (req.method === 'POST' && path === '/local/tap') return send(res, 200, 'application/json', JSON.stringify(await agent.walkUp()));
      const f = files[path];
      if (req.method === 'GET' && f) return send(res, 200, f[1], readFileSync(join(webDir, f[0])));
      send(res, 404, 'text/plain', 'Not found');
    } catch (e: any) {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server)));
}
