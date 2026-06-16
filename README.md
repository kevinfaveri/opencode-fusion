# opencode-fusion

Multi-model ensemble tool for [OpenCode](https://opencode.ai). Sends the same prompt to a configurable panel of LLMs in parallel, collects their responses, and runs a judge model that outputs structured analysis: consensus, contradictions, unique insights, and blind spots.

Based on [OpenRouter Fusion](https://openrouter.ai/fusion). Their [DRACO benchmark results](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) showed that panels of models consistently beat individual models:

- Fable 5 + GPT-5.5 (judged by Opus 4.8): 69.0% on DRACO deep research, higher than any single model
- Gemini Flash + Kimi + DeepSeek (budget panel): 64.7%, beating solo GPT-5.5 (60.0%) and solo Opus 4.8 (58.8%) at roughly half the cost
- Same model run twice (self-fusion): +6.7 points over a single run

This plugin runs the same pipeline locally inside OpenCode, hitting your own provider APIs directly.

## How it works

```
Your prompt
    |
    v
Primary model (your active chat model)
    |
    | decides to call fusion tool
    v
Panel models (parallel):
    Claude Sonnet 4.6 ──┐
    GPT-5.5            ──┼── all answer independently
    DeepSeek            ┘
    |
    v
Judge model (Claude Sonnet 4.6):
    Produces structured JSON analysis:
    - consensus (high-confidence agreements)
    - contradictions (where models disagree)
    - unique_insights (only one model raised)
    - blind_spots (nobody addressed)
    |
    v
Primary model writes final answer using the analysis
```

The primary model is whatever model you have selected in OpenCode (via `/models`). It is not configured in the fusion plugin. It decides when to invoke fusion based on the tool description, using it for research, architecture decisions, and complex trade-off questions, and skipping it for simple edits.

## Install

### From a local path

Clone or copy the project, then add to your `opencode.json`:

```json
{
  "plugin": [
    "file:///path/to/opencode-fusion"
  ]
}
```

### From npm

```bash
npm install opencode-fusion
```

Then add to your `opencode.json`:

```json
{
  "plugin": ["opencode-fusion"]
}
```

Restart OpenCode after adding the plugin.

## Configure

The plugin works out of the box if you have Anthropic, OpenAI, and DeepSeek connected via `/connect`. The default panel uses Claude Sonnet 4.6, GPT-5.5, and DeepSeek, with Sonnet 4.6 as judge. No config file needed.

To override the defaults, create `~/.config/opencode/fusion-config.json`:

```json
{
  "judge": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-6"
  },
  "panel": [
    {
      "providerID": "anthropic",
      "modelID": "claude-sonnet-4-6",
      "label": "Claude Sonnet 4.6"
    },
    {
      "providerID": "openai",
      "modelID": "gpt-5.5",
      "label": "GPT-5.5"
    },
    {
      "providerID": "deepseek",
      "modelID": "deepseek-chat",
      "label": "DeepSeek"
    }
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

`providerID` and `modelID` must match your OpenCode `/models` list. All three default providers (Anthropic, OpenAI, DeepSeek) are built-in to OpenCode and only require an API key via `/connect`.

`panelTools` controls which read-only tools each panel model can call while forming its answer (default: `read`, `grep`, `glob`, `list`, `webfetch`). This lets panel models pull real context from your repo and the web instead of answering from training knowledge alone. `judgeTools` is the judge's tool set; it defaults to `webfetch` only, matching OpenRouter Fusion where the judge can fetch the web to verify claims but does not get repo-reading tools. Set either to `[]` to disable all tools for that role. Use OpenCode built-in tool names: `read`, `grep`, `glob`, `list`, `webfetch`, `bash`, `write`, `edit`. For research-only safety, prefer read-only tools.

### Tool-call limits

`panelMaxSteps` (default `16`) and `judgeMaxSteps` (default `12`) cap how many agentic tool-calling iterations each panel model and the judge may take before they must return a final answer. The plugin registers two hidden bounded subagents (`fusion-panel`, `fusion-judge`) at load time so runs always terminate instead of looping forever. The caps are set high enough that panels doing genuine multi-file research finish naturally; set them higher if your models need more rounds. Note: if a panel actually reaches the cap, OpenCode forces a final text response, and on Anthropic models that run with forced thinking (e.g. claude-opus-4-8) that forced stop can hit a provider prefill restriction and return an empty panel (the run still completes via graceful degradation). Keeping the cap above the rounds your panels really need avoids this; alternatively use a thinking-disabled model alias for the panel slot.

### Timeouts

`panelTimeoutMs` and `judgeTimeoutMs` (both default `600000` = 10 minutes) cap how long a single panel model or the judge may run before it is timed out, its session aborted, and the model marked as failed. Because panels run in parallel and the run waits for all of them, this prevents one hung model (e.g. a provider network stall or retry loop) from blocking the entire fusion run: the timed-out model is dropped and the judge proceeds with whichever panels succeeded (the run still returns `status: ok` with a `failed_models` entry). Raise these if your models legitimately need longer for deep research.

### Optional: web search (Exa)

OpenRouter Fusion gives its panel and judge a real web search tool. To match that, add `websearch` to `panelTools` and `judgeTools` in your config, then enable OpenCode's Exa-backed `websearch` tool:

1. Launch OpenCode with the env var: `OPENCODE_ENABLE_EXA=1 opencode`, or add `export OPENCODE_ENABLE_EXA=1` to your shell profile and restart your shell.
2. Add `"websearch"` to `panelTools` (and `judgeTools` if you want the judge to search too).

Exa requires no API key. Without `OPENCODE_ENABLE_EXA`, the `websearch` tool is not registered and referencing it has no effect. It is left out of the defaults so the plugin works out of the box without extra setup.

If no config file exists, the embedded defaults are used. If the config file is malformed, it falls back to defaults.

## Requirements

- OpenCode 1.14+
- API keys for each panel model and the judge model (run `/connect` for each provider)

## Graceful degradation

- If 1 or 2 panel models fail (wrong API key, rate limit, etc.), the judge runs on whatever succeeded
- If the judge fails, raw panel responses are returned and the primary model synthesizes them itself
- Hard failure only happens if every panel model errors

## Usage

Ask your model a complex question. It decides whether to invoke fusion on its own. You can also force it:

```
Use fusion to research the trade-offs between server components and client-side
rendering for data-heavy dashboards
```

## References

- [OpenRouter Fusion announcement](https://openrouter.ai/blog/announcements/fusion-beats-frontier/)
- [OpenRouter Fusion docs (server tool)](https://openrouter.ai/docs/guides/features/server-tools/fusion)
- [OpenRouter Fusion docs (plugin)](https://openrouter.ai/docs/guides/features/plugins/fusion)
- [DRACO benchmark paper](https://arxiv.org/abs/2602.11685)
- [OpenCode plugin docs](https://opencode.ai/docs/plugins/)
