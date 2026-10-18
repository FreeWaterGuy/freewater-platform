import type { CustomDesign, DesignMissing, DesignPatch } from '../custom/design';

// Contract for the assistant that helps people design their own bottles. Like the ad assistant,
// it only proposes changes; the platform checks them. Any AI, or none, can sit behind it.

export interface DesignAssistantInput {
  design: CustomDesign;
  history: { role: 'user' | 'assistant'; text: string }[];
  message: string;
  attachments: { kind: 'image' | 'video'; name?: string; dataUrl?: string }[]; // this message's files, by index
  context: { company: string; priceCents: number; maxBottles: number; fonts: string[]; decorations: readonly string[]; missing: DesignMissing[]; hasPhoto: boolean; hasVideo: boolean };
}
export interface DesignAssistantOutput { reply: string; patch: DesignPatch; suggestions: string[] }
export interface DesignAssistant { readonly name: string; respond(input: DesignAssistantInput): Promise<DesignAssistantOutput> }
