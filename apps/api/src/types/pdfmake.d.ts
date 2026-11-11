/** The parts of pdfmake 0.3 (server build, CommonJS singleton) that the API uses. */
declare module "pdfmake" {
  type FontFamily = { normal: string; bold: string; italics: string; bolditalics: string };
  interface OutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    virtualfs: {
      writeFileSync(path: string, content: Buffer): void;
      existsSync(path: string): boolean;
    };
    setFonts(fonts: Record<string, FontFamily>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(definition: object, options?: object): OutputDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
