import type { Campaign, CompanyConfig, Creative, Product, Unit } from '../../core/types';

// Contract for the "Print engine" module: turns a filled unit into a print-ready label.

export interface RenderRequest {
  unit: Unit;
  product: Product;
  company: CompanyConfig;
  campaigns: Map<string, Campaign>;
  customArt?: Creative; // the whole ad area for a paid custom design
  /** Makes the smart code printed in each QR. Without it (previews, proofs) the plain addresses are used. */
  codes?: import('../codes/service').CodeMinter;
  /** Print the tracking strip so AR can follow the bottle as it turns (see RenderedLabel.codes and modules/ar). */
  tracking?: boolean;
  /** Which slots may carry tracking codes (their owners use AR that follows the bottle). All of them if missing. */
  trackSlots?: number[];
}

/** Every QR printed on a label, where it is, and how big its squares are: what AR uses to find the bottle in the camera. */
export interface PrintedCode {
  text: string; // exactly what the QR holds ("marker:<n>" for a tracking marker)
  role: 'slot' | 'receipt' | 'marker';
  slotIndex?: number;
  markerId?: number;
  /** The code's square without its white margin (the part a camera sees), in inches from the label's top left. */
  xIn: number;
  yIn: number;
  sizeIn: number;
  modules: number;
}

export interface RenderedSlot {
  slotIndex: number;
  xIn: number;
  widthIn: number;
  advertiserName: string;
  qrUrl: string; // unique per unit and slot; owned by whoever bought the slot
  /** Dynamic: our smart code. Static: the advertiser's own address. */
  qrMode: 'dynamic' | 'static';
}

export interface RenderedLabel {
  unitId: string;
  svg: string;
  widthIn: number;
  heightIn: number;
  slots: RenderedSlot[];
  receiptUrl: string; // the company panel's QR: this unit's open-books receipt
  codes?: PrintedCode[];
}

export interface LabelRenderer {
  readonly name: string;
  render(req: RenderRequest): Promise<RenderedLabel>;
}
