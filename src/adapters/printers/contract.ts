// Contract every printer adapter follows: a machine's built-in printer, a micro-factory line, or the virtual one.

export interface PrintJob {
  jobId: string;
  /** Same key = same physical print. Sending it twice never prints twice. */
  idempotencyKey: string;
  unitId: string;
  locationId: string;
  svg: string;
  widthIn: number;
  heightIn: number;
}

export type PrintResult =
  | { status: 'printed'; jobId: string; at: Date }
  | { status: 'failed'; jobId: string; reason: string; /** True when trying again can't help (the machine is offline or sold out). */ final?: boolean };

export interface PrinterAdapter {
  readonly name: string;
  print(job: PrintJob): Promise<PrintResult>;
}
