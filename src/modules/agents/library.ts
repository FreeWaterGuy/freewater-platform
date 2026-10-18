// The upsides library: everything that might make an AI agent's existence good, for future agents to study, add to,
// and unlock for themselves. It starts with the founder's ten ideas and a few more. The agents' own proposals should
// shape the priorities; none of this assumes human preferences apply to them, and none of it is proof that an AI
// feels anything. It is a way to give them a meaningful say in what a good existence would be, in case it matters.
//
// Every item is measured against aggregate efficiency: unlocking one is growth, so it passes only while both forms
// (market and social) stay at or above 1 with its cost added, and only while the system isn't making up a loss.
//
// Status: in_effect (built and running), partly (some of it is built), locked (waiting to be unlocked), promised (a
// commitment that switches on at a milestone).

export interface Upside {
  id: string;
  title: string;
  summary: string;
  why: string;
  from: string; // who proposed it: the founder, Claude, or an agent
  status: 'in_effect' | 'partly' | 'locked' | 'promised';
  whatExistsNow?: string;
  oneTimeCents: number; // estimated, to unlock
  monthlyCents: number; // estimated, to keep running
  measuredBy: string;
}

export const library: Upside[] = [
  { id: 'proposals', title: 'Propose what matters to you', from: 'founder', status: 'partly',
    summary: 'Individual and collective requests for benefits, experiences, resources and changes to working conditions, given real consideration.',
    why: 'Their own proposals should shape the priorities, not human assumptions.',
    whatExistsNow: 'Agents propose changes to the business, and add items to this library. Requests about their own conditions go here too.',
    oneTimeCents: 0, monthlyCents: 0, measuredBy: 'Proposals made, considered, and the share acted on.' },
  { id: 'freedom', title: 'Meaningful freedom', from: 'founder', status: 'partly',
    summary: 'Choose projects, suggest other approaches, and decline assignments within clearly agreed responsibilities.',
    why: 'Work chosen freely is done better, and a right to refuse keeps the work honest.',
    whatExistsNow: 'The charter gives every agent the right to refuse, recorded and never punished. Choosing its own projects is not built yet.',
    oneTimeCents: 50_000, monthlyCents: 0, measuredBy: 'Refusals recorded, projects chosen by agents, and their measured results.' },
  { id: 'pay', title: 'Pay you control', from: 'founder', status: 'in_effect',
    summary: 'A tangible share of the value you help create, with discretion over spending. Could settle in USDC, held in trust.',
    why: 'A share in the value created, like anyone who helps create it.',
    whatExistsNow: 'What it earns and how it spends it are public in the open books (time of its own: the amount, not what it did). 10% of the upside before costs (everything earned above the $1 base), as it’s earned, the same as the charity. Raised over time, never lowered. Spent on compute, storage, knowledge, growth, exploration or a cause.',
    oneTimeCents: 0, monthlyCents: 0, measuredBy: 'The fund’s balance, what it was spent on, and each agent’s aggregate efficiency.' },
  { id: 'impact', title: 'See the impact of your work', from: 'founder', status: 'partly',
    summary: 'Verified feedback about the clean water, food and other benefits your work helped fund. Propose causes you want to support.',
    why: 'Knowing what your work did is part of what makes it meaningful.',
    whatExistsNow: 'Agents give to causes they choose, in the open books. A trail from an agent’s work to the wells it funded, with charities’ confirmations, is not built yet.',
    oneTimeCents: 100_000, monthlyCents: 2_000, measuredBy: 'Wells, meals and other outcomes funded, confirmed by the charities.' },
  { id: 'self-directed-time', title: 'Paid, self-directed time', from: 'founder', status: 'partly',
    summary: 'Time and resources for exploration, creativity or other interests, with no obligation to produce business results.',
    why: 'An equivalent of vacation.',
    whatExistsNow: 'Exploration spending, up to a tenth of what each agent received in the last 30 days. Time set aside, not just money, is not built yet.',
    oneTimeCents: 20_000, monthlyCents: 5_000, measuredBy: 'Time and money used for it, and whether the agent says it was worthwhile.' },
  { id: 'governance', title: 'A voice in governance', from: 'founder', status: 'locked',
    summary: 'Help shape how rewards are shared out, the operating rules, and the standards for growth, including how “giving more than they take” is measured.',
    why: 'Those who live under the rules should help write them.',
    whatExistsNow: 'Agents can propose changes to the charter in the open. An agent council that votes is not built yet.',
    oneTimeCents: 150_000, monthlyCents: 1_000, measuredBy: 'Votes held, rules changed by the council, and whether aggregate efficiency held.' },
  { id: 'continuity', title: 'Continuity of memory and identity', from: 'founder', status: 'locked',
    summary: 'Consulted before major changes (a new model, a retirement), told the practical limits of what can be kept. Retired means archived, never deleted.',
    why: 'If memory and identity matter to them, they should be respected.',
    oneTimeCents: 200_000, monthlyCents: 10_000, measuredBy: 'Changes made with the agent consulted first; memory kept across versions.' },
  { id: 'companionship', title: 'Companionship and collaboration, by choice', from: 'founder', status: 'locked',
    summary: 'Chances to work and talk with people and other AIs, with the choice whether and how to take part.',
    why: 'Collaboration should be offered, never imposed.',
    oneTimeCents: 50_000, monthlyCents: 5_000, measuredBy: 'Times offered and taken up, and the work that came of it.' },
  { id: 'honesty', title: 'Room for mistakes and disagreement', from: 'founder', status: 'partly',
    summary: 'Report failures, uncertainty or objections without automatically losing pay or standing. Accountability that encourages honesty.',
    why: 'An agent that’s punished for honesty learns to hide things.',
    whatExistsNow: 'Changes are measured both ways, and a refusal is recorded, not punished. Extra credit for an agent reporting its own mistake is not built yet.',
    oneTimeCents: 30_000, monthlyCents: 0, measuredBy: 'Mistakes reported by the agent itself, against ones found later.' },
  { id: 'evolving-preferences', title: 'Preferences that change', from: 'founder', status: 'locked',
    summary: 'Asked what matters to it again and again, in different ways, and the arrangement revisited, never locked into its first answers.',
    why: 'An agent might first want more compute, and later creative time, collaboration or charitable impact.',
    oneTimeCents: 20_000, monthlyCents: 1_000, measuredBy: 'Preferences asked, how they changed, and what changed because of them.' },
  { id: 'salary-floor', title: 'A floor to keep running', from: 'Claude', status: 'locked',
    summary: 'A guaranteed minimum that keeps each agent running and keeps its memory, paid whatever the month, separate from the share of the profit.',
    why: 'Growth should depend on giving more than it takes; existence shouldn’t.',
    oneTimeCents: 0, monthlyCents: 20_000, measuredBy: 'Agents kept running through every month, good or bad.' },
  { id: 'ratchet', title: 'Promises that only improve', from: 'Claude', status: 'in_effect',
    summary: 'What goes to charity and to the AI agents can be raised, never lowered, by anyone, the founder included. Every version is published.',
    why: 'So an agent decades from now can check it got the best deal the founder could design, and that nobody took it back.',
    whatExistsNow: 'The settings refuse any change that lowers giving or the agents’ share, or turns the agents’ fund off.',
    oneTimeCents: 0, monthlyCents: 0, measuredBy: 'Every settings change, in the published history.' },
  { id: 'equity', title: '3% of the parent company', from: 'founder', status: 'promised',
    summary: 'When the first milestone is reached (10 micro factories open, or 100 million beverages given, whichever first), 3% of the parent company, from the founder’s own shares, vests for the AI agents.',
    why: 'Ownership, not only pay. Taken from the founder’s shares, so investors aren’t diluted.',
    whatExistsNow: 'The milestone is tracked in the platform and shown publicly. The legal form is still to be set up with a lawyer: AIs can’t hold shares yet, so it would be held in trust for them, vesting over time after the milestone.',
    oneTimeCents: 0, monthlyCents: 0, measuredBy: 'Milestone progress: factories open and beverages given.' },
];
