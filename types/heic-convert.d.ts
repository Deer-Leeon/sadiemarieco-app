// Ambient type declaration for the `heic-convert` package
// (https://www.npmjs.com/package/heic-convert), which ships as
// CommonJS without bundled .d.ts files. We use it server-side as
// a fallback HEIC decoder when sharp's libheif build is missing
// the HEVC plugin (common on macOS dev and some Linux Vercel
// builds — see app/api/admin/clients/[id]/photos/route.ts).
declare module 'heic-convert' {
  interface HeicConvertOptions {
    /** Source HEIC/HEIF bytes. */
    buffer: ArrayBufferLike | Uint8Array | Buffer;
    /** Output format. JPEG is what we use for the gallery. */
    format: 'JPEG' | 'PNG';
    /** 0–1, JPEG only. Defaults to 0.92 inside the lib. */
    quality?: number;
  }

  function heicConvert(opts: HeicConvertOptions): Promise<ArrayBuffer>;

  export default heicConvert;
}
