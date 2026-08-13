/**
 * Minimal Gemini REST client used by the extraction worker.
 *
 * The PDF is sent inline (base64) via `inline_data`; for documents near the
 * 20 MB inline ceiling, switch to the Gemini Files API (`files.upload`) and
 * reference the file by URI instead.
 */

/**
 * Model used for structured extraction. Override with `GEMINI_MODEL`; defaults
 * to `gemini-3.6-flash`. A leading `models/` prefix is tolerated (env values
 * like `models/gemini-3.6-flash` are normalized before the REST call).
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/** Model name with any `models/` prefix stripped — the REST path wants the bare name. */
const GEMINI_MODEL_NAME = GEMINI_MODEL.replace(/^models\//, '');

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini inline `inline_data` ceiling (free tier). */
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** Tagged error so the queue can distinguish rate limits from other failures. */
export class GeminiApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
  }
}

/** HTTP 429 — the queue retries with a longer backoff delay. */
export class GeminiRateLimitError extends GeminiApiError {
  constructor(message: string, status = 429) {
    super(message, status);
    this.name = 'GeminiRateLimitError';
  }
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof GeminiRateLimitError;
}

export interface GeminiExtractInput {
  pdf: Buffer;
  mimeType?: string;
  fileName?: string;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

const EXTRACTION_PROMPT = `You are a document extraction engine. Extract all meaningful
information from the attached PDF and return it as a single JSON object with no
markdown formatting. Use snake_case keys and preserve numbers, dates (ISO 8601),
and monetary values as-is. If the document has no extractable content, return an
object with an empty body instead of failing.`;

/**
 * Send the PDF to Gemini (model from `GEMINI_MODEL`, default `gemini-3.6-flash`)
 * and return the parsed structured JSON object. Throws `GeminiRateLimitError`
 * on HTTP 429 and `GeminiApiError` for other API failures, so the worker's
 * retry/backoff policy can react.
 */
export async function extractStructuredJsonFromPdf(
  input: GeminiExtractInput,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — see .env.example');
  }

  const { pdf, mimeType = 'application/pdf' } = input;
  if (pdf.byteLength > MAX_INLINE_BYTES) {
    throw new Error(
      `PDF is ${(pdf.byteLength / 1024 / 1024).toFixed(1)} MB — over the ${MAX_INLINE_BYTES / 1024 / 1024} MB inline limit`,
    );
  }

  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${GEMINI_MODEL_NAME}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: EXTRACTION_PROMPT },
              { inline_data: { mime_type: mimeType, data: pdf.toString('base64') } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new GeminiRateLimitError(
        `Gemini rate limited (429): ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    throw new GeminiApiError(
      `Gemini API error ${res.status}: ${detail.slice(0, 200)}`,
      res.status,
    );
  }

  const data = (await res.json()) as GeminiGenerateResponse;

  if (data.promptFeedback?.blockReason) {
    throw new GeminiApiError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, 200);
  }

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim() ?? '';

  if (!text) {
    throw new GeminiApiError('Gemini returned an empty response', 200);
  }

  return parseJsonObject(text);
}

/** Parse the model's JSON, tolerating accidental markdown fences. */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new GeminiApiError(
      `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      200,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GeminiApiError('Gemini JSON response was not an object', 200);
  }
  return parsed as Record<string, unknown>;
}
