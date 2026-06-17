# opencode-fusion: configuration guide for LLM agents

## How it works

opencode-fusion sends one prompt to a panel of models in parallel, has a judge model compare their answers, and returns structured analysis (consensus, contradictions, unique insights, blind spots) that the calling model uses to write the final answer.

Based on OpenRouter Fusion. Their DRACO benchmark found panels beating single models: Fable 5 + GPT-5.5 (judged by Opus 4.8) scored 69.0%, higher than any single model; a budget panel of Gemini Flash + Kimi + DeepSeek scored 64.7%, beating solo GPT-5.5 (60.0%) and solo Opus 4.8 (58.8%) at about half the cost.

Flow:

    Your prompt
        |
        v
    Primary model (your active chat model)
        |  decides to call the fusion tool
        v
    Panel models in parallel: each answers independently with read and web tools
        |
        v
    Judge model: compares answers into consensus / contradictions / unique insights / blind spots
        |
        v
    Primary model writes the final answer

This file explains how to install and configure the opencode-fusion plugin. Read this when a user asks you to set up or configure fusion in their OpenCode instance.

## What this plugin does

Registers a `fusion` tool that the active model can call. The "active model" (or "primary model") is whatever the user has selected in OpenCode via `/models`. It is not part of the fusion config. When the active model calls fusion, the plugin sends the prompt to multiple models in parallel (the "panel"), collects their responses, sends all responses to a judge model for structured comparison, and returns the analysis. The active model then uses that analysis to write its final answer.

The fusion config only controls the panel models and the judge model. The primary model is always the user's current chat model.

Fusion is for research and analysis. By default panel models get read-only tools (`read`, `grep`, `glob`, `list`, `webfetch`) so they can ground their answers in the actual repo and the web. This is configurable via `panelTools` in the config. The judge gets `webfetch` only by default, matching OpenRouter Fusion where the judge can fetch the web to verify claims but does not get repo-reading tools. The full read toolset is reserved for the panel models. To add real web search (Exa), include `websearch` in `panelTools`/`judgeTools` AND launch OpenCode with `OPENCODE_ENABLE_EXA=1`; it is left out of defaults so the plugin works without extra setup. This is configurable via `judgeTools`. Both panel and judge runs are bounded by `panelMaxSteps` and `judgeMaxSteps` (default 16 panel, 12 judge); the plugin registers hidden `fusion-panel` and `fusion-judge` subagents at load time so the tool-calling loop always terminates. No end-user config edits are required. Tool names are OpenCode built-in tool names. For research-only use, keep panels on read-only tools and avoid `write`, `edit`, and `bash`.

## Install

Add to the user's `opencode.json` (project-level or global at `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-fusion"]
}
```

Or from a local clone:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-fusion"]
}
```

The user must restart OpenCode after adding the plugin.

## Default setup

The plugin works out of the box with these three providers. The user needs API keys for each, configured via `/connect` in OpenCode:

| Role | Provider | Model ID | What to run |
|------|----------|----------|-------------|
| Panel model 1 | `anthropic` | `claude-opus-4-8` | `/connect` > Anthropic |
| Panel model 2 | `openai` | `gpt-5.5` | `/connect` > OpenAI |
| Panel model 3 | `deepseek` | `deepseek-chat` | `/connect` > DeepSeek |
| Judge | `anthropic` | `claude-opus-4-8` | (same as panel 1) |

All three are built-in OpenCode providers. No custom provider config needed.

Full default configuration:

```json
{
  "judge": {
    "providerID": "anthropic",
    "modelID": "claude-opus-4-8"
  },
  "panel": [
    { "providerID": "anthropic", "modelID": "claude-opus-4-8", "label": "Claude Opus 4.8" },
    { "providerID": "openai", "modelID": "gpt-5.5", "label": "GPT-5.5" },
    { "providerID": "deepseek", "modelID": "deepseek-chat", "label": "DeepSeek" }
  ],
  "panelTools": ["read", "grep", "glob", "list", "webfetch"],
  "judgeTools": ["webfetch"],
  "panelMaxSteps": 16,
  "judgeMaxSteps": 12,
  "panelTimeoutMs": 600000,
  "judgeTimeoutMs": 600000,
  "maxTokensPerPanel": 4096,
  "judgeMaxTokens": 8192,
  "temperature": 0.7
}
```

## Custom configuration

To change which models are used, create `~/.config/opencode/fusion-config.json`:

```json
{
  "judge": {
    "providerID": "<provider>",
    "modelID": "<model>"
  },
  "panel": [
    {
      "providerID": "<provider>",
      "modelID": "<model>",
      "label": "<display name>"
    }
  ],
  "maxTokensPerPanel": 4096,
  "judgeMaxTokens": 8192,
  "temperature": 0.7
}
```

### How to find valid providerID and modelID values

The `providerID` is the key used in OpenCode's provider config. Built-in providers use their standard names:

- `anthropic` for Anthropic (Claude models)
- `openai` for OpenAI (GPT models)
- `deepseek` for DeepSeek
- `google` for Google (Gemini models)
- `groq` for Groq
- `openrouter` for OpenRouter

Custom providers defined in `opencode.json` under `"provider"` use whatever key the user chose (e.g. `"my-ollama"`, `"kimi-for-coding-oauth"`).

The `modelID` is the model identifier within that provider. Run `/models` in OpenCode to see available models and their IDs.

### Example configurations

Budget setup (all free/cheap models via OpenRouter):
```json
{
  "judge": { "providerID": "deepseek", "modelID": "deepseek-chat" },
  "panel": [
    { "providerID": "deepseek", "modelID": "deepseek-chat", "label": "DeepSeek" },
    { "providerID": "groq", "modelID": "llama-4-scout-17b-16e-instruct", "label": "Llama 4 Scout" },
    { "providerID": "google", "modelID": "gemini-2.5-flash", "label": "Gemini Flash" }
  ]
}
```

High-quality setup (frontier models):
```json
{
  "judge": { "providerID": "anthropic", "modelID": "claude-opus-4-20250918" },
  "panel": [
    { "providerID": "anthropic", "modelID": "claude-opus-4-20250918", "label": "Claude Opus" },
    { "providerID": "openai", "modelID": "gpt-5", "label": "GPT-5" },
    { "providerID": "deepseek", "modelID": "deepseek-reasoner", "label": "DeepSeek R1" }
  ]
}
```

Local models (Ollama):
```json
{
  "judge": { "providerID": "ollama", "modelID": "qwen3:32b", "label": "Qwen 32B" },
  "panel": [
    { "providerID": "ollama", "modelID": "llama3:70b", "label": "Llama 70B" },
    { "providerID": "ollama", "modelID": "qwen3:32b", "label": "Qwen 32B" },
    { "providerID": "ollama", "modelID": "deepseek-r1:32b", "label": "DeepSeek R1 32B" }
  ]
}
```

For Ollama, the user must first configure it as a custom provider in their `opencode.json`:
```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "llama3:70b": { "name": "Llama 3 70B" },
        "qwen3:32b": { "name": "Qwen 3 32B" },
        "deepseek-r1:32b": { "name": "DeepSeek R1 32B" }
      }
    }
  }
}
```

## Settings reference

| Field | Default | Description |
|-------|---------|-------------|
| `judge.providerID` | `anthropic` | Provider for the judge model |
| `judge.modelID` | `claude-opus-4-8` | Model that produces the structured analysis |
| `panel[].providerID` | varies | Provider for each panel model |
| `panel[].modelID` | varies | Model ID for each panel model |
| `panel[].label` | auto-generated | Display name shown in the analysis output |
| `panelTools` | `["read","grep","glob","list","webfetch"]` | Read-only tools each panel model may call to gather repo/web context |
| `judgeTools` | `["webfetch"]` | Tools the judge may call; defaults to webfetch only (matching OpenRouter Fusion) so it can fetch the web to verify claims but not read the repo |
| `panelMaxSteps` | `16` | Max agentic tool-calling iterations a panel model may take before returning; set high enough that panels finish research naturally rather than hitting the cap |
| `judgeMaxSteps` | `12` | Max agentic tool-calling iterations the judge may take before returning |
| `panelTimeoutMs` | `600000` | Milliseconds before a panel model is timed out, its session aborted, and it is marked failed (prevents one hung model from blocking the run) |
| `judgeTimeoutMs` | `600000` | Milliseconds before the judge is timed out and the run falls back to returning panel responses without analysis |
| `maxTokensPerPanel` | `4096` | Max output tokens per panel model response (applied via chat.params hook) |
| `judgeMaxTokens` | `8192` | Max output tokens for the judge analysis (applied via chat.params hook) |
| `temperature` | `0.7` | Sampling temperature for panel and judge calls (applied via chat.params hook) |

## Troubleshooting

If a panel model fails, check that:
1. The provider has an API key configured (run `/connect` in OpenCode)
2. The `providerID` matches a configured provider
3. The `modelID` is valid for that provider (run `/models` to check)

The plugin logs failures in the fusion result under `failed_models` with the error message from each provider.
