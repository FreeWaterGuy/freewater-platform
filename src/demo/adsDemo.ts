import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';

// Runs FreeWater Ads with sample data. npm run demo:ads, then open http://localhost:8787/ads
// Sign in as joe@joesburgers.example to see two weeks of results, or with any other email to start a new business.
// Sign-in codes are printed here. To review submitted ads, use the freewater-admin key printed below with the review API.

const port = Number(process.env.PORT ?? 8787);
let now = Date.now();
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: new TestOutbox(true), clock: () => new Date(now) });
await app.accounts.invite({ companyId: 'freewater', email: 'joe@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes', displayName: 'Joe' });
console.log('Printing two weeks of sample bottles…');
const end = now;
await simulateHistory(app, (ms) => (now = ms), { endMs: end });
setInterval(() => (now = Date.now()), 1000);
const server = await buildServer(app);
await server.listen({ port, host: '0.0.0.0' });
console.log(`\nFreeWater Ads is running at http://localhost:${port}/ads\n  Sample advertiser: joe@joesburgers.example\n  Company key for reviewing ads: ${app.demoKeys!['freewater-admin']}\n  Assistant: ${app.ads.assistant.name}\n\nSign-in codes appear below. Press Ctrl+C to stop.\n`);
