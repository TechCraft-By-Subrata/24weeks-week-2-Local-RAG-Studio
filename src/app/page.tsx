'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useMemo, useState, type FormEvent } from 'react';

type ProviderName = 'google' | 'openai' | 'anthropic';

type PanelConfig = {
  provider: ProviderName;
  modelId: string;
  apiKey: string;
};

type EvaluatorOptions = {
  systemPrompt: string;
  temperature: number;
};

const PROVIDER_MODEL_SUGGESTIONS: Record<ProviderName, string[]> = {
  google: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
  ],
  openai: ['gpt-4.1-mini', 'gpt-4o-mini'],
  anthropic: ['claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'],
};

const LEFT_PANEL_DEFAULT: PanelConfig = {
  provider: 'google',
  modelId: 'gemini-2.5-flash-lite',
  apiKey: '',
};

const RIGHT_PANEL_DEFAULT: PanelConfig = {
  provider: 'google',
  modelId: 'gemini-2.5-flash',
  apiKey: '',
};

const DEFAULT_OPTIONS: EvaluatorOptions = {
  systemPrompt: '',
  temperature: 0.7,
};

function getAssistantText(messages: UIMessage[]): string {
  const lastAssistantMessage = [...messages]
    .reverse()
    .find(message => message.role === 'assistant');

  if (!lastAssistantMessage) {
    return '';
  }

  return lastAssistantMessage.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

function getStatusText(status: string): string {
  if (status === 'submitted') {
    return 'Queued';
  }

  if (status === 'streaming') {
    return 'Streaming';
  }

  if (status === 'error') {
    return 'Error';
  }

  return 'Ready';
}

function isBusyStatus(status: string): boolean {
  return status === 'submitted' || status === 'streaming';
}

type ComparisonReport = {
  summary: string;
  winner: string;
  reliability: string;
  quality: string;
  action: string;
};

function getComparisonReport({
  leftText,
  rightText,
  leftError,
  rightError,
}: {
  leftText: string;
  rightText: string;
  leftError?: string;
  rightError?: string;
}): ComparisonReport {
  const leftOk = Boolean(leftText) && !leftError;
  const rightOk = Boolean(rightText) && !rightError;

  if (leftOk && rightOk) {
    const leftLen = leftText.length;
    const rightLen = rightText.length;
    const winner =
      leftLen === rightLen
        ? 'Tie'
        : leftLen > rightLen
          ? 'Left model (more detailed response)'
          : 'Right model (more detailed response)';

    return {
      summary: 'Both models returned successfully.',
      winner,
      reliability: 'Both runs completed without provider errors.',
      quality:
        'Compare factual accuracy and relevance manually, since automatic truth scoring is not enabled yet.',
      action:
        'If you want strict quality scoring, add a judge model pass in the next iteration.',
    };
  }

  if (leftOk && !rightOk) {
    return {
      summary: 'Partial success: left model succeeded, right model failed.',
      winner: 'Left model by availability',
      reliability: `Right model failed with provider error: ${rightError ?? 'Unknown error'}`,
      quality:
        'Only one valid answer is available, so quality comparison is incomplete.',
      action:
        'Retry right model with a different model ID or project key/quota configuration.',
    };
  }

  if (!leftOk && rightOk) {
    return {
      summary: 'Partial success: right model succeeded, left model failed.',
      winner: 'Right model by availability',
      reliability: `Left model failed with provider error: ${leftError ?? 'Unknown error'}`,
      quality:
        'Only one valid answer is available, so quality comparison is incomplete.',
      action:
        'Retry left model with a different model ID or project key/quota configuration.',
    };
  }

  return {
    summary: 'Both model runs failed.',
    winner: 'No winner',
    reliability:
      'Provider-side errors blocked both outputs. Check API keys, quota, and selected model availability.',
    quality:
      'No response content available to compare on quality or completeness.',
    action: 'Fix provider errors, then rerun the same prompt.',
  };
}

type PanelProps = {
  title: string;
  config: PanelConfig;
  setConfig: (next: PanelConfig) => void;
  status: string;
  assistantText: string;
  errorText?: string;
};

function ComparisonPanel({
  title,
  config,
  setConfig,
  status,
  assistantText,
  errorText,
}: PanelProps) {
  const modelDatalistId = useMemo(
    () => `${title.toLowerCase().replace(/\s+/g, '-')}-models`,
    [title],
  );

  return (
    <article className="panel-card">
      <header className="panel-head">
        <h2>{title}</h2>
        <span className={`status-pill status-${status}`}>{getStatusText(status)}</span>
      </header>

      <div className="panel-config">
        <label>
          Provider
          <select
            value={config.provider}
            onChange={event =>
              setConfig({
                ...config,
                provider: event.currentTarget.value as ProviderName,
              })
            }
          >
            <option value="google">Google (Gemini)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>

        <label>
          Model ID
          <input
            value={config.modelId}
            list={modelDatalistId}
            onChange={event =>
              setConfig({ ...config, modelId: event.currentTarget.value })
            }
            placeholder="Enter model ID"
          />
          <datalist id={modelDatalistId}>
            {PROVIDER_MODEL_SUGGESTIONS[config.provider].map(modelId => (
              <option key={modelId} value={modelId} />
            ))}
          </datalist>
        </label>

        <label>
          API key {config.provider === 'google' ? '(optional override)' : '(required)'}
          <input
            value={config.apiKey}
            onChange={event =>
              setConfig({ ...config, apiKey: event.currentTarget.value })
            }
            placeholder={
              config.provider === 'google'
                ? 'Uses GOOGLE_API_KEY by default'
                : `Enter ${config.provider} key`
            }
            type="password"
            autoComplete="off"
          />
        </label>
      </div>

      <section className="panel-output">
        {errorText ? <p className="panel-error">{errorText}</p> : null}
        {!assistantText && !errorText ? (
          <p className="panel-empty">
            Response will appear here after you run an evaluation.
          </p>
        ) : null}
        {assistantText ? <p>{assistantText}</p> : null}
      </section>
    </article>
  );
}

export default function MultiModelEvaluator() {
  const [prompt, setPrompt] = useState('');
  const [leftPanel, setLeftPanel] = useState<PanelConfig>(LEFT_PANEL_DEFAULT);
  const [rightPanel, setRightPanel] = useState<PanelConfig>(RIGHT_PANEL_DEFAULT);
  const [options, setOptions] = useState<EvaluatorOptions>(DEFAULT_OPTIONS);

  const {
    messages: leftMessages,
    sendMessage: sendLeft,
    status: leftStatus,
    stop: stopLeft,
    error: leftError,
    clearError: clearLeftError,
  } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  const {
    messages: rightMessages,
    sendMessage: sendRight,
    status: rightStatus,
    stop: stopRight,
    error: rightError,
    clearError: clearRightError,
  } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  const isRunning = isBusyStatus(leftStatus) || isBusyStatus(rightStatus);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const promptText = prompt.trim();
    if (!promptText) {
      return;
    }

    clearLeftError();
    clearRightError();

    const requestOptions = {
      options: {
        systemPrompt: options.systemPrompt.trim() || undefined,
        temperature: options.temperature,
      },
    };

    sendLeft(
      { text: promptText },
      {
        body: {
          panel: {
            provider: leftPanel.provider,
            modelId: leftPanel.modelId.trim(),
            apiKey: leftPanel.apiKey.trim() || undefined,
          },
          ...requestOptions,
        },
      },
    );

    sendRight(
      { text: promptText },
      {
        body: {
          panel: {
            provider: rightPanel.provider,
            modelId: rightPanel.modelId.trim(),
            apiKey: rightPanel.apiKey.trim() || undefined,
          },
          ...requestOptions,
        },
      },
    );

    setPrompt('');
  };

  const handleStop = () => {
    stopLeft();
    stopRight();
  };

  const leftAssistantText = getAssistantText(leftMessages);
  const rightAssistantText = getAssistantText(rightMessages);
  const report = getComparisonReport({
    leftText: leftAssistantText,
    rightText: rightAssistantText,
    leftError: leftError?.message,
    rightError: rightError?.message,
  });
  const shouldShowReport =
    !isRunning &&
    Boolean(
      leftAssistantText ||
        rightAssistantText ||
        leftError?.message ||
        rightError?.message,
    );

  return (
    <main className="app-shell">
      <div className="ambient-glow" />
      <div className="content-wrap">
        <header className="hero">
          <p className="eyebrow">The Multi-Model Evaluator</p>
          <h1>Compare model outputs side-by-side with streaming results.</h1>
          <p className="hero-copy">
            Starts with Google Gemini free-tier defaults and lets you bring your
            own OpenAI or Anthropic key for broader benchmarking.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="composer-card"
        >
          <div className="composer-grid">
            <textarea
              value={prompt}
              onChange={event => setPrompt(event.currentTarget.value)}
              placeholder="Enter a prompt to evaluate both models..."
              className="prompt-box"
              rows={4}
            />

            <div className="options-column">
              <label>
                System prompt (optional)
                <input
                  value={options.systemPrompt}
                  onChange={event =>
                    setOptions({
                      ...options,
                      systemPrompt: event.currentTarget.value,
                    })
                  }
                  placeholder="You are a concise expert..."
                />
              </label>

              <label>
                Temperature: {options.temperature.toFixed(1)}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={options.temperature}
                  onChange={event =>
                    setOptions({
                      ...options,
                      temperature: Number(event.currentTarget.value),
                    })
                  }
                />
              </label>

              <div className="action-row">
                <button type="submit" className="btn-primary" disabled={isRunning}>
                  {isRunning ? 'Running...' : 'Run Evaluation'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleStop}
                  disabled={!isRunning}
                >
                  Stop
                </button>
              </div>
            </div>
          </div>
        </form>

        <section className="panel-grid">
          <ComparisonPanel
            title="Left Model"
            config={leftPanel}
            setConfig={setLeftPanel}
            status={leftStatus}
            assistantText={leftAssistantText}
            errorText={leftError?.message}
          />
          <ComparisonPanel
            title="Right Model"
            config={rightPanel}
            setConfig={setRightPanel}
            status={rightStatus}
            assistantText={rightAssistantText}
            errorText={rightError?.message}
          />
        </section>

        {shouldShowReport ? (
          <section className="comparison-card">
            <h3>Comparison Report</h3>
            <p><strong>Summary:</strong> {report.summary}</p>
            <p><strong>Winner:</strong> {report.winner}</p>
            <p><strong>Reliability:</strong> {report.reliability}</p>
            <p><strong>Quality:</strong> {report.quality}</p>
            <p><strong>Next action:</strong> {report.action}</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
