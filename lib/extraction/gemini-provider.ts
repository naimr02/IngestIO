import { extractStructuredJsonFromPdf } from '@ingestio/lib/gemini/client';
import type { ExtractionProvider } from './provider';

export class GeminiExtractionProvider implements ExtractionProvider {
  async extract(input: { pdf: Buffer; mimeType?: string; fileName?: string }) {
    return extractStructuredJsonFromPdf(input);
  }
}
