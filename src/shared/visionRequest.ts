/**
 * Pure vision request builders shared by Provider vision calls and the
 * llm-vision OCR engine. Lives in shared so providers/ does not import ocr/
 * (M-57).
 */

export function buildVisionUserPrompt(ctx: {
  sourceLanguage: string;
  targetLanguage: string;
  glossary?: string;
}): string {
  const glossary = ctx.glossary && ctx.glossary.trim() !== '' ? `\n${ctx.glossary}` : '';
  return `You are an OCR + translation engine.
Extract ALL visible text fragments from this image, in reading order.
Translate every fragment from ${ctx.sourceLanguage} to ${ctx.targetLanguage}.
Respond with ONLY a JSON array, no explanations, in this exact shape:
[{"text": "original fragment", "translation": "translated fragment"}]${glossary}`;
}

/** Pure chat/completions body builder (unit-tested). */
export function buildVisionRequest(
  model: string,
  temperature: number,
  maxTokens: number,
  prompt: string,
  dataUrl: string,
): Record<string, unknown> {
  return {
    model,
    stream: false,
    temperature,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
}
