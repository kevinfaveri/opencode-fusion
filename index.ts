import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

interface PanelModel {
  providerID: string
  modelID: string
  label: string
}

interface FusionConfig {
  judge: { providerID: string; modelID: string }
  panel: PanelModel[]
  panelTools: string[]
  judgeTools: string[]
  panelMaxSteps: number
  judgeMaxSteps: number
  panelTimeoutMs: number
  judgeTimeoutMs: number
  maxTokensPerPanel: number
  judgeMaxTokens: number
  temperature: number
}

interface PanelResponse {
  model: string
  label: string
  content: string
  error?: string
}

interface FusionAnalysis {
  consensus: string[]
  contradictions: Array<{
    topic: string
    stances: Array<{ model: string; stance: string }>
  }>
  unique_insights: Array<{ model: string; insight: string }>
  blind_spots: string[]
}

interface FusionResult {
  status: "ok" | "error"
  analysis?: FusionAnalysis
  judge_raw?: string
  responses: PanelResponse[]
  failed_models?: Array<{ model: string; error: string }>
  error?: string
}

const DEFAULT_CONFIG: FusionConfig = {
  judge: {
    providerID: "anthropic",
    modelID: "claude-opus-4-8",
  },
  panel: [
    { providerID: "anthropic", modelID: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { providerID: "openai", modelID: "gpt-5.5", label: "GPT-5.5" },
    { providerID: "deepseek", modelID: "deepseek-chat", label: "DeepSeek" },
  ],
  panelTools: ["read", "grep", "glob", "list", "webfetch"],
  judgeTools: ["webfetch"],
  panelMaxSteps: 16,
  judgeMaxSteps: 12,
  panelTimeoutMs: 600000,
  judgeTimeoutMs: 600000,
  maxTokensPerPanel: 4096,
  judgeMaxTokens: 8192,
  temperature: 0.7,
}

function loadConfig(): FusionConfig {
  const overridePath = join(homedir(), ".config", "opencode", "fusion-config.json")
  if (existsSync(overridePath)) {
    try {
      const raw = readFileSync(overridePath, "utf-8")
      const parsed = JSON.parse(raw)
      return {
        judge: parsed.judge ?? DEFAULT_CONFIG.judge,
        panel: Array.isArray(parsed.panel) && parsed.panel.length > 0
          ? parsed.panel.map((p: any) => ({
              providerID: String(p.providerID ?? ""),
              modelID: String(p.modelID ?? ""),
              label: String(p.label ?? `${p.providerID}/${p.modelID}`),
            }))
          : DEFAULT_CONFIG.panel,
        panelTools: Array.isArray(parsed.panelTools) ? parsed.panelTools.map(String) : DEFAULT_CONFIG.panelTools,
        judgeTools: Array.isArray(parsed.judgeTools) ? parsed.judgeTools.map(String) : DEFAULT_CONFIG.judgeTools,
        panelMaxSteps: typeof parsed.panelMaxSteps === "number" ? parsed.panelMaxSteps : DEFAULT_CONFIG.panelMaxSteps,
        judgeMaxSteps: typeof parsed.judgeMaxSteps === "number" ? parsed.judgeMaxSteps : DEFAULT_CONFIG.judgeMaxSteps,
        panelTimeoutMs: typeof parsed.panelTimeoutMs === "number" ? parsed.panelTimeoutMs : DEFAULT_CONFIG.panelTimeoutMs,
        judgeTimeoutMs: typeof parsed.judgeTimeoutMs === "number" ? parsed.judgeTimeoutMs : DEFAULT_CONFIG.judgeTimeoutMs,
        maxTokensPerPanel: parsed.maxTokensPerPanel ?? DEFAULT_CONFIG.maxTokensPerPanel,
        judgeMaxTokens: parsed.judgeMaxTokens ?? DEFAULT_CONFIG.judgeMaxTokens,
        temperature: parsed.temperature ?? DEFAULT_CONFIG.temperature,
      }
    } catch {
      return DEFAULT_CONFIG
    }
  }
  return DEFAULT_CONFIG
}

function extractTextFromParts(parts: Array<any>): string {
  return parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text || p.content || "")
    .join("\n")
    .trim()
}

function toolsMap(toolNames: string[]): { [key: string]: boolean } {
  const map: { [key: string]: boolean } = { fusion: false }
  for (const name of toolNames) {
    map[name] = true
  }
  return map
}

const JUDGE_SYSTEM_PROMPT = `You are a judge analyzing multiple expert responses to the same question. Your job is to produce a structured comparison -- not to answer the question yourself.

Analyze the responses and produce a JSON object with exactly these fields:

- "consensus": array of strings -- points that all or most respondents agree on. These are higher-confidence findings.
- "contradictions": array of objects with "topic" (string) and "stances" (array of {"model": string, "stance": string}) -- where respondents explicitly disagree.
- "unique_insights": array of objects with "model" (string) and "insight" (string) -- valuable points raised by only one respondent.
- "blind_spots": array of strings -- important aspects of the question that NO respondent addressed.

Be precise. Quote or closely paraphrase the original responses. Do not inject your own opinions or add information not present in the responses.`

const PANEL_SYSTEM_PROMPT = `You are an expert analyst on a multi-model panel. You have read-only tools: read, grep, glob, and list to inspect the project in the current working directory, plus webfetch and websearch for current external information.

Before you answer, you MUST gather real evidence using these tools. Do not answer from memory or assumptions alone, and do not trust claims already present in the prompt without verifying them yourself with a tool call:
- If the question touches this project's code, configuration, dependencies, or structure, read the relevant files first (start from the project root and the package and config files).
- If it depends on current or external facts such as library versions, APIs, recent changes, or best practices, search the web and fetch authoritative sources.

Make at least one tool call to ground your analysis before concluding. Research independently and reach your own conclusion. Ground every significant claim in a file you read or a source you found. Then answer thoroughly with specific details, concrete trade-offs, and clear reasoning. Be direct and substantive.`

async function runPanel(
  client: any,
  panelModel: PanelModel,
  prompt: string,
  tools: { [key: string]: boolean },
  timeoutMs: number,
): Promise<PanelResponse> {
  const log = (message: string, extra?: any) =>
    client.app.log({ body: { service: "fusion", level: "info", message, extra } }).catch(() => {})
  await log(`panel:start ${panelModel.label}`, { providerID: panelModel.providerID, modelID: panelModel.modelID, tools: Object.keys(tools) })
  const sessionResult = await client.session.create({
    body: { title: `fusion-panel-${panelModel.label}` },
  })
  const sessionId = sessionResult.data?.id || sessionResult.id
  let panelTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const result: any = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "fusion-panel",
          model: {
            providerID: panelModel.providerID,
            modelID: panelModel.modelID,
          },
          system: PANEL_SYSTEM_PROMPT,
          tools,
          parts: [{ type: "text" as const, text: prompt }],
        },
      }),
      new Promise((_resolve, reject) => {
        panelTimer = setTimeout(() => reject(new Error(`panel timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    const responseData = result.data || result
    const parts = (responseData as any).parts || []
    const info = (responseData as any).info || {}
    let content = extractTextFromParts(parts)
    if (!content && info.content) {
      content = typeof info.content === "string" ? info.content : JSON.stringify(info.content)
    }
    const panelToolParts = parts.filter((p: any) => p.type === "tool").map((p: any) => ({
      tool: p.tool || "unknown",
      status: p.state?.status || "unknown",
      error: p.state?.status === "error" ? (p.state?.error || "error") : undefined,
    }))
    const infoError =
      info.error?.message || info.error?.name || (typeof info.error === "string" ? info.error : undefined)
    if (!content || infoError) {
      await log(`panel:empty ${panelModel.label}`, { contentLength: content?.length || 0, infoError })
      return {
        model: `${panelModel.providerID}/${panelModel.modelID}`,
        label: panelModel.label,
        content: "",
        error: infoError || "panel returned no answer (empty response)",
      }
    }
    await log(`panel:done ${panelModel.label}`, {
      contentLength: content.length,
      toolCallCount: panelToolParts.length,
      toolCalls: panelToolParts,
    })
    return {
      model: `${panelModel.providerID}/${panelModel.modelID}`,
      label: panelModel.label,
      content,
    }
  } catch (err: any) {
    await log(`panel:error ${panelModel.label}`, { error: err?.message || String(err) })
    try {
      await client.session.abort({ path: { id: sessionId } })
    } catch {}
    return {
      model: `${panelModel.providerID}/${panelModel.modelID}`,
      label: panelModel.label,
      content: "",
      error: err?.message || String(err),
    }
  } finally {
    if (panelTimer) clearTimeout(panelTimer)
    try {
      await client.session.delete({ path: { id: sessionId } })
    } catch {}
  }
}

async function runJudge(
  client: any,
  config: FusionConfig,
  prompt: string,
  responses: PanelResponse[],
  tools: { [key: string]: boolean },
): Promise<{ analysis?: FusionAnalysis; raw?: string }> {
  const log = (message: string, extra?: any) =>
    client.app.log({ body: { service: "fusion", level: "info", message, extra } }).catch(() => {})
  await log("judge:start", { providerID: config.judge.providerID, modelID: config.judge.modelID, panelCount: responses.length })
  const judgeInput = responses
    .map((r, i) => `=== Response ${i + 1} (${r.label}) ===\n${r.content}\n`)
    .join("\n")

  const sessionResult = await client.session.create({
    body: { title: "fusion-judge" },
  })
  const sessionId = sessionResult.data?.id || sessionResult.id
  const judgeStartedAt = Date.now()
  let judgeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await log("judge:prompt sending", {
      sessionId,
      tools: Object.keys(tools),
      judgeInputLength: judgeInput.length,
      panelLabels: responses.map((r) => r.label),
      panelContentLengths: responses.map((r) => r.content.length),
      hasFormat: false,
    })
    const judgeResult: any = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "fusion-judge",
          model: {
            providerID: config.judge.providerID,
            modelID: config.judge.modelID,
          },
          system: JUDGE_SYSTEM_PROMPT,
          tools,
          parts: [
            {
              type: "text" as const,
              text: `The original question was:\n\n${prompt}\n\nHere are ${responses.length} expert responses to analyze:\n\n${judgeInput}\n\nProduce the structured JSON analysis now. Return ONLY the JSON object, no other text, no markdown code fences.`,
            },
          ],
        },
      }),
      new Promise((_resolve, reject) => {
        judgeTimer = setTimeout(() => reject(new Error(`judge timed out after ${config.judgeTimeoutMs}ms`)), config.judgeTimeoutMs)
      }),
    ])
    await log("judge:prompt returned", { elapsedMs: Date.now() - judgeStartedAt })
    const judgeData = judgeResult.data || judgeResult
    const judgeInfo = (judgeData as any).info || {}
    const judgeParts0 = (judgeData as any).parts || []
    await log("judge:inspecting response", {
      hasStructuredOutput: !!judgeInfo.structured_output,
      hasError: !!(judgeInfo.error),
      errorName: judgeInfo.error?.name,
      errorMessage: judgeInfo.error?.message,
      infoKeys: Object.keys(judgeInfo),
      partCount: judgeParts0.length,
      partTypes: judgeParts0.map((p: any) => p.type),
      toolCallCount: judgeParts0.filter((p: any) => p.type === "tool").length,
      toolCalls: judgeParts0.filter((p: any) => p.type === "tool").map((p: any) => ({
        tool: p.tool || "unknown",
        status: p.state?.status || "unknown",
        error: p.state?.status === "error" ? (p.state?.error || "error") : undefined,
      })),
    })
    if (judgeInfo.structured_output) {
      await log("judge:done (structured_output)")
      return { analysis: judgeInfo.structured_output as FusionAnalysis }
    }
    const judgeParts = (judgeData as any).parts || []
    let judgeText = extractTextFromParts(judgeParts)
    await log("judge:response fallback", { textLength: judgeText?.length || 0, textPreview: judgeText?.slice(0, 200) })
    if (judgeText) {
      const fenceMatch = judgeText.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
      if (fenceMatch) {
        judgeText = fenceMatch[1].trim()
      }
      const jsonMatch = judgeText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as FusionAnalysis
          await log("judge:done (parsed from text)")
          return { analysis: parsed }
        } catch {
          await log("judge:done (raw text, json parse failed)")
          return { raw: judgeText }
        }
      }
      await log("judge:done (raw text, no json)")
      return { raw: judgeText }
    }
    return {}
  } catch (judgeErr: any) {
    await log("judge:error", { error: judgeErr?.message || String(judgeErr), elapsedMs: Date.now() - judgeStartedAt })
    try {
      await client.session.abort({ path: { id: sessionId } })
    } catch {}
    throw judgeErr
  } finally {
    if (judgeTimer) clearTimeout(judgeTimer)
    try {
      await client.session.delete({ path: { id: sessionId } })
    } catch {}
  }
}

const fusionInFlight = new Set<string>()

export const OpenCodeFusion: Plugin = async ({ client }) => {
  const fusionConfig = loadConfig()
  return {
    config: async (cfg: any) => {
      cfg.agent = cfg.agent ?? {}
      cfg.agent["fusion-panel"] = {
        mode: "subagent",
        hidden: true,
        steps: fusionConfig.panelMaxSteps,
        description: "Bounded fusion panel model run",
      }
      cfg.agent["fusion-judge"] = {
        mode: "subagent",
        hidden: true,
        steps: fusionConfig.judgeMaxSteps,
        description: "Bounded fusion judge run that produces structured analysis",
      }
    },
    "chat.params": async (input: any, output: any) => {
      if (input.agent === "fusion-panel") {
        const cfg = loadConfig()
        output.temperature = cfg.temperature
        output.maxOutputTokens = cfg.maxTokensPerPanel
      } else if (input.agent === "fusion-judge") {
        const cfg = loadConfig()
        output.temperature = cfg.temperature
        output.maxOutputTokens = cfg.judgeMaxTokens
      }
    },
    tool: {
      fusion: tool({
        description:
          "Invoke multi-model deliberation for complex questions that benefit from multiple expert perspectives. Use this when the question involves research, architecture decisions, comparing approaches, or any situation where being wrong is expensive and multiple viewpoints would help. Do NOT use for simple tactical tasks like renaming variables, fixing typos, or straightforward edits. Call this tool AT MOST ONCE per turn and never in parallel: a single invocation already consults the entire panel of models and the judge. Put your complete question in one call. Pass the user's actual question plus brief framing of what is being analyzed (for example, the project in the current working directory) and let the panel models research independently with their own read and web tools. Do NOT gather all the evidence yourself and embed it into the prompt, so each panel forms a genuinely independent view -- that diversity is the point of fusion.",
        args: {
          prompt: tool.schema
            .string()
            .describe(
              "The question or task to send to the panel of expert models for multi-perspective analysis",
            ),
        },
        async execute(args, context) {
          if (fusionInFlight.has(context.sessionID)) {
            await client.app
              .log({ body: { service: "fusion", level: "info", message: "fusion:capped (already in flight)" } })
              .catch(() => {})
            return JSON.stringify(
              {
                status: "error",
                error: "Fusion is already running in this turn. Only one fusion invocation runs at a time; use the result from the first call.",
                failure_reason: "fusion_invocation_capped",
              },
              null,
              2,
            )
          }
          fusionInFlight.add(context.sessionID)
          const config = loadConfig()
          const log = (message: string, extra?: any) =>
            client.app.log({ body: { service: "fusion", level: "info", message, extra } }).catch(() => {})
          const toastQueue: Array<{ message: string; variant: string }> = []
          const toast = (message: string, variant: string = "info") => {
            toastQueue.push({ message, variant })
          }
          const activeIntervals: ReturnType<typeof setInterval>[] = []

          const consumer = setInterval(() => {
            const next = toastQueue.shift()
            if (next) {
              client.tui.showToast({ body: { message: next.message, variant: next.variant } }).catch(() => {})
            }
          }, 2000)
          activeIntervals.push(consumer)

          try {

          const panelLabels = config.panel.map((p) => p.label).join(", ")
          toast(`Fusion: dispatching to ${panelLabels}`)

          let completed = 0
          const panelStart = Date.now()
          const pending = new Set(config.panel.map((_: PanelModel, i: number) => i))
          let rotation = 0

          const heartbeat = setInterval(() => {
            if (pending.size === 0) return
            const active = Array.from(pending)
            const idx = active[rotation % active.length]
            rotation++
            const elapsed = Math.round((Date.now() - panelStart) / 1000)
            toast(`Fusion: ${config.panel[idx].label} thinking... (${elapsed}s)`)
          }, 4000)
          activeIntervals.push(heartbeat)

          const panelResults = await Promise.all(
            config.panel.map(async (panelModel: PanelModel, index: number) => {
              const result = await runPanel(client, panelModel, args.prompt, toolsMap(config.panelTools), config.panelTimeoutMs)
              pending.delete(index)
              completed++
              const elapsed = Math.round((Date.now() - panelStart) / 1000)
              const status = result.error ? "failed" : "responded"
              toast(
                `Fusion: ${panelModel.label} ${status} in ${elapsed}s (${completed}/${config.panel.length})`,
                result.error ? "error" : "success",
              )
              return result
            }),
          )

          const successfulResponses = panelResults.filter((r) => !r.error)
          const failedModels = panelResults
            .filter((r) => r.error)
            .map((r) => ({ model: r.label, error: r.error! }))

          if (successfulResponses.length === 0) {
            toast("Fusion: all panel models failed", "error")
            const result: FusionResult = {
              status: "error",
              responses: panelResults,
              failed_models: failedModels,
              error: "All panel models failed",
            }
            const errJson = JSON.stringify(result, null, 2)
            await log("fusion:returning to primary", {
              status: "error",
              responseCount: result.responses.length,
              resultLength: errJson.length,
            })
            return errJson
          }

          toast(`Fusion: judge analyzing ${successfulResponses.length} responses...`)

          const judgeStart = Date.now()
          const judgeHeartbeat = setInterval(() => {
            const elapsed = Math.round((Date.now() - judgeStart) / 1000)
            toast(`Fusion: judge thinking... (${elapsed}s)`)
          }, 5000)
          activeIntervals.push(judgeHeartbeat)

          let judgeOutcome: { analysis?: FusionAnalysis; raw?: string } = {}
          try {
            judgeOutcome = await runJudge(client, config, args.prompt, successfulResponses, toolsMap(config.judgeTools))
          } catch {}

          const totalElapsed = Math.round((Date.now() - judgeStart) / 1000)
          await client.tui
            .showToast({ body: { message: `Fusion: complete (judge took ${totalElapsed}s)`, variant: "success" } })
            .catch(() => {})

          const result: FusionResult = {
            status: "ok",
            responses: successfulResponses.map((r) => ({
              model: r.model,
              label: r.label,
              content: r.content,
            })),
          }

          if (judgeOutcome.analysis) {
            result.analysis = judgeOutcome.analysis
          } else if (judgeOutcome.raw) {
            result.judge_raw = judgeOutcome.raw
          }

          if (failedModels.length > 0) {
            result.failed_models = failedModels
          }

          const resultJson = JSON.stringify(result, null, 2)
          await log("fusion:returning to primary", {
            status: result.status,
            hasAnalysis: !!result.analysis,
            analysisConsensus: result.analysis?.consensus?.length ?? 0,
            analysisContradictions: result.analysis?.contradictions?.length ?? 0,
            analysisUniqueInsights: result.analysis?.unique_insights?.length ?? 0,
            analysisBlindSpots: result.analysis?.blind_spots?.length ?? 0,
            hasJudgeRaw: !!result.judge_raw,
            judgeRawLength: result.judge_raw?.length ?? 0,
            responseCount: result.responses.length,
            resultLength: resultJson.length,
          })
          return resultJson

          } finally {
            fusionInFlight.delete(context.sessionID)
            activeIntervals.forEach((id) => clearInterval(id))
            toastQueue.length = 0
          }
        },
      }),
    },
  }
}
