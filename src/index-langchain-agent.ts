import "dotenv/config";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
  addMessages,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import * as z from "zod";

/**
 * ============================
 * 新手阅读顺序（先看这里）
 * ============================
 *
 * 如果你是第一次看 LangChain / LangGraph 代码，建议按下面顺序读：
 *
 * 1. 先看 `ResearchAgentState`
 *    这是整张图共享的“状态对象”。
 *    你可以把它理解成：Agent 工作台上一直在更新的便签纸。
 *
 * 2. 再看 `tools`
 *    Agent 不会直接联网，它是通过工具（tool）联网和读网页的。
 *    LangChain 里 tool 本质上就是“带输入 schema 的函数”。
 *
 * 3. 再看 `buildResearchPlan`
 *    这里演示了：先让模型产出一个研究计划，而不是直接瞎搜。
 *
 * 4. 再看 `runResearchStep`
 *    这是 Agent 的核心节点：模型读取当前上下文，决定要不要调用工具。
 *
 * 5. 再看 `routeAfterResearch`
 *    这是 LangGraph 的关键点：它决定下一步走哪条边。
 *    有工具调用就走到 `tools`，没有工具调用就走到 `reporter`。
 *
 * 6. 最后看 `buildGraph` 和 `main`
 *    这两处把前面的节点真正连成一张图并运行起来。
 *
 * ============================
 * LangChain / Agent 核心原理
 * ============================
 *
 * 你不需要一上来就死磕 LangChain 内部源码。
 * 先把下面这个最小闭环吃透就够了：
 *
 * 1. 模型读到用户问题
 * 2. 模型判断：自己直接回答，还是先调工具
 * 3. 如果调工具，运行时执行工具
 * 4. 工具结果再喂回模型
 * 5. 模型继续思考，直到输出最终答案
 *
 * 这个闭环就是 Agent 的核心实现。
 *
 * LangChain 负责：
 * - 把模型、消息、工具这些积木拼起来
 * - 让“模型调用工具”变得规范
 *
 * LangGraph 负责：
 * - 把“上一步 -> 下一步”的流程显式建成图
 * - 让多步骤、可循环、可持久化的 Agent 更容易维护
 *
 * 你可以把 LangGraph 理解成：
 * “把原本藏在 while 循环里的 Agent 流程，画成了一张可控的流程图”
 *
 * ============================
 * 关于 Gemini 和 LangGraph
 * ============================
 *
 * 很多新手会担心：
 * “用了 LangGraph，是不是就不能继续用 Gemini API 了？”
 *
 * 答案是：完全可以继续用。
 *
 * 因为：
 * - LangGraph 管的是工作流 / 状态流转
 * - Gemini / OpenAI / Claude 管的是底层模型能力
 *
 * 只要这个模型支持聊天调用、最好支持 tool calling，
 * 就可以接到 LangGraph 里。
 *
 * 所以：
 * LangGraph 不是替代 Gemini，
 * 而是“在 Gemini 外面包一层更清晰的调度框架”。
 */

type TavilySearchResult = {
  title: string;
  url: string;
  content?: string;
  score?: number;
};

type TavilySearchResponse = {
  query: string;
  results?: TavilySearchResult[];
  response_time?: string;
};

const DEFAULT_QUESTION =
  "请研究一下 LangChain Agent 和 LangGraph 的关系，并给出适合前端工程师的学习建议。";

const MAX_WEBPAGE_CHARS = 6_000;

const ResearchPlanSchema = z.object({
  goal: z.string(),
  subQuestions: z.array(z.string()).min(2).max(5),
  suggestedQueries: z.array(z.string()).min(2).max(6),
  stopWhen: z.array(z.string()).min(2).max(4),
});

const ResearchReportSchema = z.object({
  title: z.string(),
  executiveSummary: z.string(),
  keyFindings: z
    .array(
      z.object({
        finding: z.string(),
        detail: z.string(),
        citations: z.array(z.string().url()).min(1).max(4),
      }),
    )
    .min(2)
    .max(6),
  risksAndUnknowns: z.array(z.string()).max(5),
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().url(),
        whyUseful: z.string(),
      }),
    )
    .min(1)
    .max(12),
});

type ResearchPlan = z.infer<typeof ResearchPlanSchema>;
type ResearchReport = z.infer<typeof ResearchReportSchema>;

/**
 * 这里是 LangGraph 里的“共享状态”。
 *
 * 最重要的是 `messages`：
 * - 用户消息、模型消息、工具消息，都会累积在这里
 * - Agent 的每一步，都是基于这份 messages 历史继续往前推
 *
 * 这就是为什么大家常说：
 * “Agent 不是一次调用，而是一串带状态的调用”
 */
const ResearchAgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: addMessages,
    default: () => [],
  }),
  question: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  researchPlan: Annotation<ResearchPlan | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  finalReport: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

function getUserQuestion() {
  const question = process.argv.slice(2).join(" ").trim();
  return question || DEFAULT_QUESTION;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }

        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }

  return JSON.stringify(content, null, 2);
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitleFromHtml(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() || "Untitled Page";
}

function getLastHumanMessageText(messages: BaseMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message._getType() === "human") {
      return stringifyContent(message.content);
    }
  }

  return "";
}

function formatPlan(plan: ResearchPlan) {
  return [
    `研究目标: ${plan.goal}`,
    "子问题:",
    ...plan.subQuestions.map((item, index) => `${index + 1}. ${item}`),
    "建议搜索词:",
    ...plan.suggestedQueries.map((item, index) => `${index + 1}. ${item}`),
    "停止条件:",
    ...plan.stopWhen.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function summarizeMessages(messages: BaseMessage[]) {
  return messages
    .map((message, index) => {
      const role = message._getType();
      const content = stringifyContent(message.content).slice(0, 2_000);

      if (role === "tool") {
        return `[${index}] tool:${message.name ?? "unknown"}\n${content}`;
      }

      if (role === "ai") {
        const maybeAIMessage = message as AIMessage;
        const toolCalls =
          maybeAIMessage.tool_calls?.length
            ? `\nTool calls:\n${JSON.stringify(
                maybeAIMessage.tool_calls,
                null,
                2,
              )}`
            : "";

        return `[${index}] ai\n${content}${toolCalls}`;
      }

      return `[${index}] ${role}\n${content}`;
    })
    .join("\n\n");
}

function extractSeenUrls(messages: BaseMessage[]) {
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/g;
  const urls = new Set<string>();

  for (const message of messages) {
    for (const match of stringifyContent(message.content).matchAll(urlPattern)) {
      urls.add(match[0]);
    }
  }

  return Array.from(urls);
}

function formatReport(report: ResearchReport) {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(report.executiveSummary);
  lines.push("");
  lines.push("## Key Findings");

  for (const finding of report.keyFindings) {
    lines.push(`### ${finding.finding}`);
    lines.push(finding.detail);
    lines.push(`Citations: ${finding.citations.join(", ")}`);
    lines.push("");
  }

  if (report.risksAndUnknowns.length) {
    lines.push("## Risks And Unknowns");
    for (const item of report.risksAndUnknowns) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("## Sources");
  for (const source of report.sources) {
    lines.push(`- ${source.title} | ${source.url}`);
    lines.push(`  Why useful: ${source.whyUseful}`);
  }

  return lines.join("\n");
}

async function tavilySearch(params: {
  query: string;
  maxResults: number;
  topic: "general" | "news";
}) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error("Missing TAVILY_API_KEY. Please configure it in .env first.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: params.query,
      topic: params.topic,
      search_depth: "advanced",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      max_results: params.maxResults,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Tavily request failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return (await response.json()) as TavilySearchResponse;
}

/**
 * Tool 1: 搜索网页
 *
 * 这就是 LangChain tool 的典型样子：
 * - 有明确输入 schema（zod）
 * - 本质上仍然只是一个函数
 * - 但模型会“看到”它的名字、描述、参数格式
 *
 * 于是模型就能自己决定：什么时候调用、传什么参数。
 */
const tavilyWebSearch = tool(
  async ({ query, maxResults, topic }) => {
    const searchResponse = await tavilySearch({ query, maxResults, topic });
    const results = searchResponse.results ?? [];

    console.log(`\n[Tool:tavily_web_search] query: ${query}`);
    console.log(`[Tool:tavily_web_search] results: ${results.length}`);

    return JSON.stringify(
      {
        query: searchResponse.query,
        responseTime: searchResponse.response_time ?? null,
        pages: results.map((result, index) => ({
          index: index + 1,
          title: result.title,
          url: result.url,
          score: result.score ?? null,
          snippet: result.content ?? "",
        })),
      },
      null,
      2,
    );
  },
  {
    name: "tavily_web_search",
    description:
      "Search the web for current or external information. Use this before answering when freshness or citations matter.",
    schema: z.object({
      query: z.string().min(1).describe("The web search query."),
      maxResults: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of search results."),
      topic: z
        .enum(["general", "news"])
        .default("general")
        .describe("Use news for current events and general for everything else."),
    }),
  },
);

/**
 * Tool 2: 读取网页正文
 *
 * 这一步很重要，因为“只看搜索结果 snippet”通常不够做研究。
 * 真正能写出带引用报告的 Agent，往往至少要做到：
 * 搜索 -> 选网页 -> 读网页 -> 提炼证据
 *
 * 这里为了让新手能读懂，我们用了非常朴素的 HTML 文本提取。
 * 生产环境里通常会换成更稳的正文抽取方案。
 */
const fetchWebpage = tool(
  async ({ url, maxChars }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "langchain-demo-research-agent/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Page request failed: ${response.status} ${response.statusText}`,
        );
      }

      const html = await response.text();
      const title = extractTitleFromHtml(html);
      const text = stripHtml(html).slice(0, maxChars);

      console.log(`\n[Tool:fetch_webpage] url: ${url}`);
      console.log(`[Tool:fetch_webpage] title: ${title}`);

      return JSON.stringify(
        {
          url,
          title,
          text,
          truncated: stripHtml(html).length > maxChars,
        },
        null,
        2,
      );
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    name: "fetch_webpage",
    description:
      "Fetch a web page and return a readable text excerpt. Use this after search when you need stronger evidence from the original page.",
    schema: z.object({
      url: z.string().url().describe("The page URL to read."),
      maxChars: z.coerce
        .number()
        .int()
        .min(500)
        .max(12_000)
        .default(MAX_WEBPAGE_CHARS)
        .describe("Maximum number of cleaned text characters to return."),
    }),
  },
);

const tools: StructuredToolInterface[] = [tavilyWebSearch, fetchWebpage];

function createBaseModel() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY. Please configure it in .env first.");
  }

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  return new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 2,
  });
}

async function buildResearchPlan(state: typeof ResearchAgentState.State) {
  console.log("\n[Graph] node: planner");

  const question = state.question || getLastHumanMessageText(state.messages);
  const planner = createBaseModel().withStructuredOutput(ResearchPlanSchema, {
    name: "ResearchPlan",
  });

  const plan = await planner.invoke([
    new SystemMessage(
      [
        "You are a research planning assistant.",
        "Break the user request into a small, practical web research plan.",
        "Prefer 2-5 sub questions and 2-6 suggested queries.",
        "Keep the plan concrete and easy for a beginner to inspect.",
      ].join("\n"),
    ),
    new HumanMessage(question),
  ]);

  console.log("[Graph] planner output:");
  console.log(formatPlan(plan));

  return {
    researchPlan: plan,
  };
}

/**
 * 这是 Agent 的核心节点。
 *
 * 注意这里没有手写 while 循环。
 * “要不要继续调用工具”这件事，不放在这里写死，
 * 而是交给下面的 `routeAfterResearch` 走图来决定。
 *
 * 这就是 LangGraph 的味道：
 * - 节点只关注“这一步做什么”
 * - 边负责“下一步去哪里”
 */
async function runResearchStep(state: typeof ResearchAgentState.State) {
  console.log("\n[Graph] node: researcher");

  const question = state.question || getLastHumanMessageText(state.messages);
  const planText = state.researchPlan
    ? formatPlan(state.researchPlan)
    : "No plan available.";

  const modelWithTools = createBaseModel().bindTools(tools);

  const response = await modelWithTools.invoke([
    new SystemMessage(
      [
        "You are a research agent.",
        "Your job is to gather evidence before giving a polished answer.",
        "Use tavily_web_search when web knowledge or freshness matters.",
        "Use fetch_webpage for the most relevant URLs before making key claims.",
        "Never invent citations. Only use URLs returned by tools you actually called.",
        "When you believe the research is sufficient, stop calling tools and write a short research handoff for the reporter node.",
        "",
        "Current user question:",
        question,
        "",
        "Current research plan:",
        planText,
      ].join("\n"),
    ),
    ...state.messages,
  ]);

  console.log("[Graph] researcher content:");
  console.log(stringifyContent(response.content) || "<empty>");
  console.log(
    `[Graph] researcher tool calls: ${response.tool_calls?.length ?? 0}`,
  );

  return {
    messages: [response],
  };
}

/**
 * 这是 LangGraph 最值得你体会的点之一：
 * “流程控制”被单独拿出来了。
 *
 * 传统写法通常会把这段逻辑塞进 while 循环里。
 * LangGraph 写法则是：
 * - 节点产出状态
 * - Router 根据状态决定下一条边
 */
function routeAfterResearch(state: typeof ResearchAgentState.State) {
  const lastMessage = state.messages[state.messages.length - 1] as
    | AIMessage
    | undefined;

  if (lastMessage?.tool_calls?.length) {
    return "tools";
  }

  return "reporter";
}

async function writeFinalReport(state: typeof ResearchAgentState.State) {
  console.log("\n[Graph] node: reporter");

  const question = state.question || getLastHumanMessageText(state.messages);
  const planText = state.researchPlan
    ? formatPlan(state.researchPlan)
    : "No plan available.";
  const transcript = summarizeMessages(state.messages);
  const allowedUrls = extractSeenUrls(state.messages);

  const reporter = createBaseModel().withStructuredOutput(ResearchReportSchema, {
    name: "ResearchReport",
  });

  const report = await reporter.invoke([
    new SystemMessage(
      [
        "You are a careful research report writer.",
        "Use only the evidence that appears in the provided transcript.",
        "Every key finding must cite at least one URL.",
        "Do not invent sources outside the allowed URL list.",
        "Keep the report readable for a beginner engineer.",
      ].join("\n"),
    ),
    new HumanMessage(
      [
        `User question:\n${question}`,
        `\nResearch plan:\n${planText}`,
        `\nAllowed URLs:\n${allowedUrls.join("\n") || "(none)"}`,
        `\nResearch transcript:\n${transcript}`,
      ].join("\n"),
    ),
  ]);

  const markdown = formatReport(report);

  console.log("[Graph] reporter done");

  return {
    finalReport: markdown,
    messages: [new AIMessage({ content: markdown })],
  };
}

function buildGraph() {
  /**
   * `ToolNode` 是 LangGraph 里一个很适合学习的预构建节点：
   * - 输入是最后一条 AIMessage 里的 tool_calls
   * - 它会自动执行这些工具
   * - 输出是 ToolMessage，再塞回 `messages`
   *
   * 所以整个 Agent 闭环就变成了：
   * researcher -> tools -> researcher -> tools -> ... -> reporter
   */
  const toolsNode = new ToolNode(tools);
  const memory = new MemorySaver();

  return new StateGraph(ResearchAgentState)
    .addNode("planner", buildResearchPlan)
    .addNode("researcher", runResearchStep)
    .addNode("tools", toolsNode)
    .addNode("reporter", writeFinalReport)
    .addEdge(START, "planner")
    .addEdge("planner", "researcher")
    .addConditionalEdges("researcher", routeAfterResearch, [
      "tools",
      "reporter",
    ])
    .addEdge("tools", "researcher")
    .addEdge("reporter", END)
    .compile({
      /**
       * 这里加了最简单的内存型 checkpoint。
       * 它的价值不是“性能优化”，而是让你看到：
       * LangGraph 天生适合长流程和可恢复执行。
       *
       * 你现在不用深究它内部原理，知道“图可以记住执行状态”就够了。
       */
      checkpointer: memory,
      name: "beginner-friendly-langgraph-agent",
      description: "A beginner-friendly research agent built with LangGraph.",
    });
}

async function main() {
  const question = getUserQuestion();
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  console.log("[Agent] starting...");
  console.log(`[Agent] model: ${modelName}`);
  console.log(`[Agent] proxy: ${proxyURL ?? "not configured"}`);
  console.log(`[Agent] question: ${question}`);

  const graph = buildGraph();
  const finalState = await graph.invoke(
    {
      question,
      messages: [new HumanMessage(question)],
    },
    {
      configurable: {
        thread_id: "demo-research-thread",
      },
      recursionLimit: 20,
    },
  );

  console.log("\n[Agent] final report:");
  console.log(finalState.finalReport);
}

main().catch((error) => {
  console.error("[Agent] run failed:", error);
});
