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
}

export interface RenderedSlot {
  slotIndex: number;
  xIn: number;
  widthIn: number;
  advertiserName: string;
  qrUrl: string; // unique per unit and slot; owned by whoever bought the slot
}

export interface RenderedLabel {
  unitId: string;
  svg: string;
  widthIn: number;
  heightIn: number;
  slots: RenderedSlot[];
  receiptUrl: string; // the company panel's QR: this unit's open-books receipt
}

export interface LabelRenderer {
  readonly name: string;
  render(req: RenderRequest): Promise<RenderedLabel>;
}
