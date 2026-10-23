import type { AdDraft, DraftPatch, Missing } from '../ads/draft';

// Contract for the ad-making assistant. Any AI (or none) can sit behind it.
// It reads the conversation and the draft and proposes a change; it never saves anything itself.

export interface ChatMessage { role: 'user' | 'assistant'; text: string; attachments?: string[] }

export interface AdAssistantInput {
  draft: AdDraft;
  history: ChatMessage[]; // earlier turns, oldest first
  message: string;
  attachments: { dataUrl: string; name?: string }[];
  context: {
    business: { name: string; category: string };
    company: { name: string; blockedCategories: string[]; giving: string | null };
    machines: { id: string; name: string; kind: string }[];
    plugins: { id: string; name: string; description: string; example: unknown; configSchema: unknown }[];
    icons: readonly string[];
    fonts: string[];
    sizes: number[];
    prices: {
      perPrintByShare: Record<string, number>; bidStartsAt: number; perScan: number; perArLaunch: number; commissionPercent: number;
      /** Set where ads are paid up front for a number of bottles (then there are no bids or daily amounts). */
      prepaid?: { minBottles: number; changeFeeCents: number; included: string; feesOn: string[]; extras: { id: string; label: string; perUseCents: number }[];
        /** Set where ads can be bought on the delivery routes (src/modules/ads/routeBuys.ts): the kinds offered. */
        routes?: { kinds: string[]; smallAudienceHouses: number } };
    };
    missing: Missing[];
    /** Ads on boxes are on here. False (FreeWater: its boxes are plain): never offer or set printing on boxes. */
    boxes?: boolean;
  };
}

export interface AdAssistantOutput {
  reply: string; // what the assistant says back, in plain words
  patch: DraftPatch; // the changes it proposes
  suggestions: string[]; // short replies the person can tap
  /** The AI chose not to work on this ad, and why. The built-in helper carried on; people see the reason at review. */
  objection?: { agent: string; reason: string };
}

export interface AdAssistant {
  readonly name: string;
  respond(input: AdAssistantInput): Promise<AdAssistantOutput>;
}
