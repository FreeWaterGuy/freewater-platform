import sharp from 'sharp';

/**
 * A small real photo of a box at a door, for tests that deliver (Photo proof of each drop: a drop is delivered only
 * with one). Made once; JPEG with hidden data in it (where it was taken, the camera), which must never be kept.
 */
let made: Buffer | null = null;
export async function doorPhoto(): Promise<Buffer> {
  made ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 160, b: 90 } } })
    .jpeg().withMetadata({ exif: { IFD0: { Make: 'TestPhone', Model: 'Doorstep 1', Artist: 'Someone' }, IFD2: { UserComment: 'GPS 30.2672 -97.7431' } } }).toBuffer();
  return made;
}
