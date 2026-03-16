# The Multi-Model Evaluator

A professional side-by-side model comparison tool built with Next.js and AI SDK.

## What it does

- Compares two model outputs for the same prompt in parallel.
- Starts with Google Gemini defaults (free-tier oriented model IDs).
- Supports bring-your-own-key (BYOK) for:
  - Google
  - OpenAI
  - Anthropic
- Keeps user-entered keys session-only in browser state (no local storage, no database persistence).

## Tech stack

- Next.js App Router
- AI SDK (`ai`, `@ai-sdk/react`)
- Providers:
  - `@ai-sdk/google`
  - `@ai-sdk/openai`
  - `@ai-sdk/anthropic`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` in the project root:

```env
GOOGLE_API_KEY=your_google_api_key
```

`GOOGLE_API_KEY` is used as the default key for Google panel requests.

3. Start the app:

```bash
npm run dev
```

4. Open:

`http://localhost:3000`

## How to use

1. Enter one prompt in the shared composer.
2. Configure each panel:
   - Provider
   - Model ID
   - API key (required for OpenAI/Anthropic, optional override for Google)
3. Click **Run Evaluation**.
4. Watch both responses stream side by side.
5. Use **Stop** to cancel active runs.

## API contract (`/api/chat`)

Request body:

```ts
{
  messages: UIMessage[],
  panel: {
    provider: 'google' | 'openai' | 'anthropic',
    modelId: string,
    apiKey?: string
  },
  options?: {
    systemPrompt?: string,
    temperature?: number
  }
}
```

Notes:
- Uses `convertToModelMessages(messages)` before model invocation.
- Uses `toUIMessageStreamResponse({ originalMessages })` for stable message streaming.

## Recommended defaults

- Left panel: `google` + `gemini-2.0-flash-lite`
- Right panel: `google` + `gemini-2.0-flash`

You can override with any valid model ID from your selected provider.

## Security note

If you accidentally exposed a real API key in commits or screenshots, rotate that key immediately.
