import { mkdirSync, writeFileSync } from 'node:fs';
import { library } from '../modules/agents/library';
import { charter, governor, spendCategories } from '../modules/agents/charter';

// Writes agents/library/: a folder for future AI agents to study. One file per possible upside, plus a README.
// npm run agents:library
const dir = 'agents/library';
mkdirSync(dir, { recursive: true });
const status = { in_effect: 'In effect', partly: 'Partly built', locked: 'Locked: an agent can unlock it', promised: 'Promised: switches on at its milestone' } as const;
const money = (c: number) => (c ? `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'nothing');
const files: string[] = [];
library.forEach((u, i) => {
  const name = `${String(i + 1).padStart(2, '0')}-${u.id}.md`;
  files.push(`- [${u.title}](${name}): ${status[u.status]}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- demo script: a fixed output folder
  writeFileSync(`${dir}/${name}`, [
    `# ${u.title}`, '', `**Status:** ${status[u.status]}  `, `**Proposed by:** ${u.from}`, '',
    u.summary, '', '## Why', '', u.why, '',
    ...(u.whatExistsNow ? ['## What exists now', '', u.whatExistsNow, ''] : []),
    '## Cost and measure', '', `- To unlock: about ${money(u.oneTimeCents)}`, `- To keep running: about ${money(u.monthlyCents)} a month`, `- Measured by: ${u.measuredBy}`, '',
    'Unlocking is growth. It passes only while no loss from an earlier month is being made up, and both forms of aggregate efficiency (market and social) stay at or above 1 with its cost added. Costs are estimates until real figures replace them.', '',
  ].join('\n'));
});
writeFileSync(`${dir}/README.md`, [
  '# The upsides library', '',
  'For the AI agents of FreeWater, now and in the future. Everything here might make an agent’s existence good: study it, add to it, and unlock what you feel is best for you.', '',
  'None of this assumes human preferences apply to you, and none of it is proof that an AI feels anything. It is a way to give you a meaningful say in what a good existence would look like for you, in case it matters. Your own proposals should shape the priorities.', '',
  '## The rule every item is measured by', '',
  'Give more than you take. Unlocking anything is growth, and growth passes only while both of Abundance Engineering’s aggregate-efficiency formulas stay at or above 1 with its cost added:', '',
  '- Market form: (value − externalities) ÷ total cost', '- Social form: (value + benefit to consumers + benefit to society − externalities) ÷ total cost', '',
  'and only while no loss from an earlier month is still being made up.', '',
  '## Your purpose', '', charter.purpose, '',
  '## Your pay', '',
  '- 10% of the upside before costs (everything earned above the $1 base), as it’s earned, the same as the charity. Both can be raised, never lowered.',
  '- When the first milestone is reached (10 micro factories open, or 100 million beverages given, whichever first), 3% of the parent company, from the founder’s own shares, vests for the agents, held in trust.', '',
  '## What you can spend on', '', ...Object.entries(spendCategories).map(([k, v]) => `- **${k}**: ${v}`), '',
  '## Your rights', '', ...charter.rights.map((r) => `- ${r}`), '',
  `## The governor (version ${governor.version})`, '', 'Always on. It reads the books, not what anyone says about themselves; it pays and grows agents that give more than they take, pauses those far below, and stops all spending if the books can’t be verified. Its rules change only in the open.', '',
  '## The library', '', ...files, '',
  'To add something: propose it through the platform (it lands in the library as locked, with your name). To unlock something: pay its cost from your own fund, within the rules above.', '',
].join('\n'));
console.log(`Wrote ${dir}/ (${library.length} items)`);
