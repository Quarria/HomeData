declare module "sharp" {
  type InputOptions = {
    limitInputPixels?: number;
    failOn?: "none" | "truncated" | "error";
    animated?: boolean;
  };
  type ResizeOptions = {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  };
  type Metadata = { format?: string; width?: number; height?: number };
  type OutputInfo = { width: number; height: number };
  type SharpPipeline = {
    metadata(): Promise<Metadata>;
    rotate(): SharpPipeline;
    resize(options: ResizeOptions): SharpPipeline;
    webp(options: { quality: number; effort: number }): SharpPipeline;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: OutputInfo;
    }>;
  };
  type SharpFactory = ((
    input: Buffer,
    options?: InputOptions,
  ) => SharpPipeline) & {
    cache(options: { memory: number; files: number; items: number }): void;
    concurrency(value: number): void;
  };
  const sharp: SharpFactory;
  export default sharp;
}
