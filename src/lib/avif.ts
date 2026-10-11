// Shrinking image attachments by re-encoding them as AVIF, in the browser (see ComposeDialog's "Convert to AVIF?" prompt).
// The encoder is the libavif WASM build from @jsquash/avif (Squoosh's codec), not Bun.Image on the server: Bun.Image can
// only encode AVIF through the OS (macOS on Apple M3+, Windows with the AV1 extension) — never on Linux, Intel Macs or M1/M2.
// The single-threaded build is loaded directly: the multithreaded one needs SharedArrayBuffer, i.e. a cross-origin-isolated
// page, which this app isn't.
import wasmUrl from "@jsquash/avif/codec/enc/avif_enc.wasm" with { type: "file" };

/** PNGs, and JPEGs above this size, are worth offering to convert (a small JPEG is already about as small as it gets). */
export const JPEG_THRESHOLD_BYTES = 100 * 1024;

export function canOfferAvif(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/png") return true;
  return type === "image/jpeg" && file.size > JPEG_THRESHOLD_BYTES;
}

/** "photo.final.PNG" → "photo.final.avif"; a name without an extension just gets one. */
export function avifFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.avif`;
}

type AvifEncoder = { encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };
let encoderPromise: Promise<AvifEncoder> | null = null;

/** Loads the encoder on first use only — the WASM is about 3.5 MB, and most messages never need it. */
function loadEncoder(): Promise<AvifEncoder> {
  encoderPromise ??= (async () => {
    const [{ default: factory }, wasm] = await Promise.all([
      import("@jsquash/avif/codec/enc/avif_enc.js"),
      fetch(wasmUrl).then(res => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`AVIF encoder: HTTP ${res.status}`)))).then(bytes => WebAssembly.compile(bytes)),
    ]);
    return (await factory({
      noInitialRun: true,
      instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => {
        const instance = new WebAssembly.Instance(wasm, imports);
        done(instance);
        return instance.exports;
      },
    })) as AvifEncoder;
  })();
  encoderPromise.catch(() => (encoderPromise = null)); // a failed load (e.g. offline) can be retried next time
  return encoderPromise;
}

// @jsquash/avif's defaults, except speed: 8 instead of 6 is ~8× faster (a 12 MP photo in ~1.6 s instead of ~12 s on an
// M1) for files only ~5–10% larger — the encode runs on the main thread, so that difference is a frozen window.
const ENCODE_OPTIONS = {
  quality: 60,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 8,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  tune: 0,
  enableSharpYUV: false,
  bitDepth: 8,
  lossless: false,
};

/** Re-encodes an image as AVIF (keeping transparency, applying the EXIF orientation, dropping the rest of the metadata).
 * Returns the original file when the AVIF wouldn't actually be smaller. */
export async function convertToAvif(file: File): Promise<File> {
  const encoder = await loadEncoder();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read the image");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const output = encoder.encode(new Uint8Array(pixels.data.buffer), pixels.width, pixels.height, ENCODE_OPTIONS);
  if (!output) throw new Error(`Could not convert ${file.name} to AVIF`);
  if (output.byteLength >= file.size) return file;
  return new File([new Uint8Array(output)], avifFileName(file.name), { type: "image/avif", lastModified: file.lastModified });
}
