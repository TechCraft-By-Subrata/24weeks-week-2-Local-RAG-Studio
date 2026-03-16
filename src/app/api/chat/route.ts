import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  streamText,
  type UIMessage,
  type LanguageModel,
} from 'ai';

export const maxDuration = 30;

type ProviderName = 'google' | 'openai' | 'anthropic';

type PanelConfig = {
  provider: ProviderName;
  modelId: string;
  apiKey?: string;
};

type RequestOptions = {
  systemPrompt?: string;
  temperature?: number;
};

type ChatRequestBody = {
  messages: UIMessage[];
  panel: PanelConfig;
  options?: RequestOptions;
};

function getModel(panel: PanelConfig): LanguageModel {
  const modelId = panel.modelId.trim();
  const apiKey = panel.apiKey?.trim();

  if (!modelId) {
    throw new Error('Model ID is required.');
  }

  if (panel.provider === 'google') {
    const fallbackKey = process.env.GOOGLE_API_KEY?.trim();
    const googleApiKey = apiKey || fallbackKey;

    if (!googleApiKey) {
      throw new Error(
        'No Google API key found. Add GOOGLE_API_KEY to .env.local or provide one in the panel settings.',
      );
    }

    const google = createGoogleGenerativeAI({ apiKey: googleApiKey });
    return google(modelId);
  }

  if (!apiKey) {
    throw new Error(
      `API key is required for ${panel.provider}. Add a key in this panel before running.`,
    );
  }

  if (panel.provider === 'openai') {
    const openai = createOpenAI({ apiKey });
    return openai(modelId);
  }

  const anthropic = createAnthropic({ apiKey });
  return anthropic(modelId);
}

function asErrorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: Request) {
  let body: ChatRequestBody;

  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return asErrorResponse('Invalid JSON request body.');
  }

  const { messages, panel, options } = body;

  if (!Array.isArray(messages)) {
    return asErrorResponse('`messages` must be an array.');
  }

  if (!panel || !panel.provider || !panel.modelId) {
    return asErrorResponse(
      '`panel` is required with provider and modelId fields.',
    );
  }

  try {
    const model = getModel(panel);

    const result = streamText({
      model,
      system: options?.systemPrompt?.trim() || undefined,
      temperature: options?.temperature,
      messages: await convertToModelMessages(messages),
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
    });
  } catch (error) {
    const details =
      error instanceof Error ? error.message : 'Unknown model execution error.';
    return asErrorResponse(details, 500);
  }
}
