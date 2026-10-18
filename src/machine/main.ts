// Start the Model 6 machine software.
//   FW_MACHINE=ATX-014 FW_API=https://api.freewater.io FW_KEY=fwk_… npm run machine
// Optional: FW_DATA=/var/lib/freewater (where it remembers things across power cuts), FW_SCREEN_PORT=7000,
// FW_HARDWARE=simulated (the only driver until the printer is chosen).
import { MachineAgent } from './agent';
import { SimulatedModel6 } from './hardware';
import { Journal } from './journal';
import { startScreen } from './screen';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`Set ${k}. See src/machine/main.ts.`); process.exit(1); } return v; };
const locationId = need('FW_MACHINE');
const hardwareName = process.env.FW_HARDWARE ?? 'simulated';
if (hardwareName !== 'simulated') { console.error(`No driver called "${hardwareName}" yet. Printers aren’t chosen; use FW_HARDWARE=simulated.`); process.exit(1); }
const hardware = new SimulatedModel6();
const agent = new MachineAgent({ locationId, apiUrl: need('FW_API'), apiKey: need('FW_KEY'), hardware, journal: new Journal(process.env.FW_DATA ?? './machine-data'), log: (l) => console.log(`[${new Date().toISOString()}] ${locationId} ${l}`) });
agent.start();
const port = Number(process.env.FW_SCREEN_PORT ?? 7000);
await startScreen(agent, { port });
console.log(`${locationId} running software ${agent.softwareVersion}. Screen: http://127.0.0.1:${port}`);
const stop = () => { agent.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
