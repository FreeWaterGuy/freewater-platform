import type { VideoStyle } from '../../core/types';

// Personalized videos, shown only when the person taps "Show me more" after the advertiser's own ad.
//
// Two kinds:
// - Motion: a short, professional motion-graphics piece made from the advertiser's own words, colors, pictures and
//   offer, cut for the moment (morning or night, a bottle passed on by a friend, a first-time or returning customer,
//   what the person likes). Made in milliseconds, so it's always ready. It's a storyboard the phone plays.
// - Footage: live action or animated (cartoon) video made by a video model. These take from a few seconds to a few
//   minutes, so they're made ahead of time for each kind of moment and kept; the first person in a new kind of moment
//   gets the motion piece while the footage is being made for the next one.

/** The kind of moment a video is made for. Never who the person is. */
export interface Segment {
  daypart: 'morning' | 'afternoon' | 'evening' | 'night';
  passedOn: boolean;
  newCustomer: boolean;
  interest?: string;
}
export const segmentKey = (s: Segment) => [s.daypart, s.passedOn ? 'passed' : 'first', s.newCustomer ? 'new' : 'returning', s.interest ?? '-'].join('|');

/** Everything a video may be made from: only what the advertiser wrote and uploaded, and the moment. */
export interface VideoBrief {
  campaignId: string;
  advertiser: string;
  category: string;
  /** The advertiser's own words, from their ad. */
  facts: { headline?: string; details?: string; offer?: string; price?: string; place?: string; extra?: string[] };
  cta: { label: string; url?: string };
  colors: { background: string; text: string; accent: string };
  /** The advertiser's pictures (their uploaded ad's still or picture, their logo). */
  images: string[];
  segment: Segment;
  /** A number that makes a different cut of the same video, so the best one can be learned. */
  take: number;
}

export interface MotionScene {
  ms: number;
  layout: 'hook' | 'picture' | 'point' | 'offer' | 'end';
  title: string;
  sub?: string;
  imageUrl?: string;
  motion: 'rise' | 'zoom' | 'slide' | 'pop';
}
export interface MotionSpec {
  aspect: '9:16';
  colors: { background: string; text: string; accent: string };
  scenes: MotionScene[];
  cta: { label: string; url?: string };
  brand: string;
}

export type MadeVideo =
  | { kind: 'motion'; spec: MotionSpec; by: string }
  | { kind: 'file'; url: string; posterUrl?: string; by: string };

/** Writes motion storyboards. Built-in rules, or Claude. */
export interface StoryWriter {
  readonly name: string;
  write(brief: VideoBrief): Promise<MotionSpec>;
}

/** Makes footage (live action or animated) with a video model. Slow: started, then checked. */
export interface FootageProvider {
  readonly name: string;
  readonly styles: readonly VideoStyle[];
  start(brief: VideoBrief, style: Exclude<VideoStyle, 'motion'>): Promise<{ jobId: string; prompt: string }>;
  /** Not done yet: null. Done: the video's bytes (MP4). Failed: throws. */
  check(jobId: string): Promise<Uint8Array | null>;
}
