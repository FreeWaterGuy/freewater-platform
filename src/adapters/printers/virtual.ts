/* eslint-disable security/detect-non-literal-fs-filename -- the stand-in printer writes under the operator's outDir; names are server-made ids */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrintJob, PrintResult, PrinterAdapter } from './contract';

export interface VirtualPrinterOptions {
  outDir?: string; // write each printed label as an SVG file; omit to keep everything in memory
  failureRate?: number; // 0–1, to rehearse jams and misprints
  random?: () => number;
  failNext?: string[]; // reasons to fail the next N jobs with, in order (for tests and demos)
}

/** A printer that needs no hardware. Same contract as a real one, so the rest of the platform can't tell the difference. */
export class VirtualPrinter implements PrinterAdapter {
  readonly name = 'virtual-printer';
  readonly printed: PrintJob[] = [];
  private done = new Map<string, PrintResult>();
  private opts: VirtualPrinterOptions;

  constructor(opts: VirtualPrinterOptions = {}) {
    this.opts = { failureRate: 0, random: Math.random, ...opts, failNext: [...(opts.failNext ?? [])] };
  }

  failNext(reason: string) {
    this.opts.failNext!.push(reason);
  }

  async print(job: PrintJob): Promise<PrintResult> {
    const previous = this.done.get(job.idempotencyKey);
    if (previous) return previous;

    let result: PrintResult;
    const forced = this.opts.failNext!.shift();
    if (forced) result = { status: 'failed', jobId: job.jobId, reason: forced };
    else if (this.opts.random!() < (this.opts.failureRate ?? 0)) result = { status: 'failed', jobId: job.jobId, reason: 'Print head jam' };
    else {
      if (this.opts.outDir) {
        const dir = join(this.opts.outDir, job.locationId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${job.unitId}.svg`), job.svg, 'utf8');
      }
      this.printed.push(job);
      result = { status: 'printed', jobId: job.jobId, at: new Date() };
    }
    this.done.set(job.idempotencyKey, result);
    return result;
  }
}
