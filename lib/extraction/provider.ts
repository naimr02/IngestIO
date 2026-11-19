/** Extraction provider interface — swap implementations without changing callers. */
export interface ExtractionProvider {
  extract(input: {
    pdf: Buffer;
    mimeType?: string;
    fileName?: string;
  }): Promise<Record<string, unknown>>;
}
