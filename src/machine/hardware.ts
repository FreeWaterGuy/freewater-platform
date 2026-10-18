// The Model 6's parts, as contracts the machine software talks to. Each real part (the label printer once it's
// chosen, the dispenser, the door and temperature sensors) gets a driver that follows its contract; until then the
// simulated machine below stands in, with switches to rehearse every fault.

export type Outcome = { ok: true; ms: number } | { ok: false; reason: string };

export interface PrinterReport { state: 'ready' | 'printing' | 'jammed' | 'out_of_labels' | 'error'; labelsLeft: number; labelsCapacity: number; inkPercent: number; message?: string }
export interface DispenserReport { state: 'ready' | 'dropping' | 'stuck' | 'empty' | 'error'; bottlesLeft: number; capacity: number }

/** Prints one label onto a bottle. svg is the exact label at real size (inches). */
export interface LabelPrinterDriver {
  readonly name: string;
  status(): PrinterReport;
  print(label: { svg: string; widthIn: number; heightIn: number }): Promise<Outcome>;
  /** A test pattern, for ops' "Test print". */
  testPrint(): Promise<Outcome>;
}

/** Drops the printed bottle into the tray, and knows when it got there. */
export interface DispenserDriver {
  readonly name: string;
  status(): DispenserReport;
  drop(): Promise<Outcome>;
}

export interface CabinetSensors {
  door(): 'open' | 'closed';
  temperatureC(): number;
}

export interface Model6Hardware {
  printer: LabelPrinterDriver;
  dispenser: DispenserDriver;
  sensors: CabinetSensors;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A whole Model 6 in software: prints take time, stock runs down, and faults can be switched on. */
export class SimulatedModel6 implements Model6Hardware {
  labelsLeft: number;
  labelsCapacity: number;
  inkPercent = 100;
  bottlesLeft: number;
  bottleCapacity: number;
  doorOpen = false;
  temp = 6;
  printerState: PrinterReport['state'] = 'ready';
  dispenserState: DispenserReport['state'] = 'ready';
  private jamNext = false;
  private stickNext = false;
  readonly printed: string[] = [];

  constructor(private opts: { printMs?: number; dropMs?: number; labels?: number; bottles?: number } = {}) {
    this.labelsCapacity = this.labelsLeft = opts.labels ?? 500;
    this.bottleCapacity = this.bottlesLeft = opts.bottles ?? 120;
  }

  // ---------- switches for rehearsing faults ----------
  jamOnNextPrint() { this.jamNext = true; }
  stickOnNextDrop() { this.stickNext = true; }
  clearFaults() { this.jamNext = this.stickNext = false; if (this.printerState === 'jammed' || this.printerState === 'error') this.printerState = 'ready'; if (this.dispenserState === 'stuck' || this.dispenserState === 'error') this.dispenserState = 'ready'; }
  restock(bottles = this.bottleCapacity) { this.bottlesLeft = Math.min(this.bottleCapacity, bottles); if (this.dispenserState === 'empty') this.dispenserState = 'ready'; }
  refillLabels() { this.labelsLeft = this.labelsCapacity; this.inkPercent = 100; if (this.printerState === 'out_of_labels') this.printerState = 'ready'; }
  setDoor(open: boolean) { this.doorOpen = open; }
  setTemperature(c: number) { this.temp = c; }
  setSpeed(printMs: number, dropMs: number) { this.opts.printMs = printMs; this.opts.dropMs = dropMs; }

  printer: LabelPrinterDriver = {
    name: 'simulated-printer',
    status: () => ({ state: this.printerState, labelsLeft: this.labelsLeft, labelsCapacity: this.labelsCapacity, inkPercent: Math.round(this.inkPercent * 10) / 10, ...(this.printerState === 'jammed' ? { message: 'Label jammed in the print head' } : {}) }),
    print: async (label) => {
      if (this.printerState !== 'ready') return { ok: false, reason: this.printerState === 'jammed' ? 'The printer is jammed' : `The printer isn’t ready (${this.printerState})` };
      if (this.labelsLeft <= 0) { this.printerState = 'out_of_labels'; return { ok: false, reason: 'Out of label stock' }; }
      this.printerState = 'printing';
      const ms = this.opts.printMs ?? 15000;
      await sleep(this.jamNext ? ms / 3 : ms);
      if (this.jamNext) { this.jamNext = false; this.printerState = 'jammed'; this.labelsLeft--; return { ok: false, reason: 'Label jammed in the print head' }; }
      this.labelsLeft--;
      this.inkPercent = Math.max(0, this.inkPercent - 0.04);
      this.printed.push(label.svg);
      this.printerState = this.labelsLeft > 0 ? 'ready' : 'out_of_labels';
      return { ok: true, ms };
    },
    testPrint: async () => {
      if (this.printerState !== 'ready' || this.labelsLeft <= 0) return { ok: false, reason: `The printer isn’t ready (${this.printerState})` };
      const ms = Math.round((this.opts.printMs ?? 15000) / 2);
      await sleep(ms);
      this.labelsLeft--;
      return { ok: true, ms };
    },
  };

  dispenser: DispenserDriver = {
    name: 'simulated-dispenser',
    status: () => ({ state: this.bottlesLeft <= 0 && this.dispenserState === 'ready' ? 'empty' : this.dispenserState, bottlesLeft: this.bottlesLeft, capacity: this.bottleCapacity }),
    drop: async () => {
      if (this.dispenserState !== 'ready') return { ok: false, reason: this.dispenserState === 'stuck' ? 'A bottle is stuck' : 'The dispenser isn’t ready' };
      if (this.bottlesLeft <= 0) { this.dispenserState = 'empty'; return { ok: false, reason: 'No bottles left' }; }
      this.dispenserState = 'dropping';
      const ms = this.opts.dropMs ?? 2500;
      await sleep(ms);
      this.bottlesLeft--;
      if (this.stickNext) { this.stickNext = false; this.dispenserState = 'stuck'; return { ok: false, reason: 'The bottle got stuck on the way to the tray' }; }
      this.dispenserState = this.bottlesLeft > 0 ? 'ready' : 'empty';
      return { ok: true, ms };
    },
  };

  sensors: CabinetSensors = {
    door: () => (this.doorOpen ? 'open' : 'closed'),
    temperatureC: () => this.temp,
  };
}
