import "dotenv/config";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage,
  type ToolCall,
} from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import * as z from "zod";

type TavilySearchResult = {
  title: string;
  url: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
};

type TavilySearchResponse = {
  query: string;
  answer?: string;
  results?: TavilySearchResult[];
  response_time?: string;
};

const DEFAULT_QUESTION =
  "帮我搜索一下最近 LangChain agent tool calling 的实践建议，并顺手算一下如果我连续学 14 天每天 2.5 小时，总共学多久。";
const MAX_AGENT_STEPS = 5;

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

function normalizeAIMessage(message: AIMessageChunk): AIMessage {
  return new AIMessage({
    id: message.id,
    name: message.name,
    content: message.content,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    usage_metadata: message.usage_metadata,
  });
}

function normalizeToolMessage(
  toolCall: ToolCall,
  toolName: string,
  result: unknown,
): ToolMessage {
  if (ToolMessage.isInstance(result)) {
    return result;
  }

  return new ToolMessage({
    content: stringifyContent(result),
    tool_call_id: toolCall.id ?? `${toolName}-call`,
    name: toolName,
    status: "success",
  });
}

function formatToolArgs(toolCall: ToolCall) {
  try {
    return JSON.stringify(toolCall.args ?? {}, null, 2);
  } catch {
    return String(toolCall.args ?? "{}");
  }
}

function logModelStep(step: number, aiMessage: AIMessage) {
  console.log(`\n[Agent] 第 ${step + 1} 轮模型输出`);
  const content = stringifyContent(aiMessage.content).trim();

  if (content) {
    console.log("[Agent] content:");
    console.log(content);
  } else {
    console.log("[Agent] content: <empty>");
  }

  if (aiMessage.tool_calls?.length) {
    console.log("[Agent] tool_calls:");
    console.log(JSON.stringify(aiMessage.tool_calls, null, 2));
  } else {
    console.log("[Agent] tool_calls: []");
  }
}

function logWebPages(results: TavilySearchResult[]) {
  if (!results.length) {
    console.log("[Tool:tavily_web_search] 未命中网页结果");
    return;
  }

  console.log("[Tool:tavily_web_search] 查看的网页:");
  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${result.title}`);
    console.log(`   ${result.url}`);
  }
}

async function tavilySearch(params: {
  query: string;
  maxResults: number;
  topic: "general" | "news";
}) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error("缺少 TAVILY_API_KEY，请先在 .env 中配置。");
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
      search_depth: "basic",
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
      `Tavily 请求失败: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return (await response.json()) as TavilySearchResponse;
}

const tavilyWebSearch = tool(
  async ({ query, maxResults, topic }) => {
    const searchResponse = await tavilySearch({ query, maxResults, topic });
    const results = searchResponse.results ?? [];

    console.log(`\n[Tool:tavily_web_search] 搜索关键词: ${query}`);
    logWebPages(results);

    if (!results.length) {
      return JSON.stringify(
        {
          query,
          summary: "未找到可用网页结果。",
          pages: [],
        },
        null,
        2,
      );
    }

    const payload = {
      query: searchResponse.query,
      responseTime: searchResponse.response_time ?? null,
      pages: results.map((result, index) => ({
        index: index + 1,
        title: result.title,
        url: result.url,
        score: result.score ?? null,
        snippet: result.content ?? "",
      })),
    };

    return JSON.stringify(payload, null, 2);
  },
  {
    name: "tavily_web_search",
    description:
      "Search the web for current or external information. Use this for latest updates, news, library docs, product details, or anything not guaranteed to be in the model's memory. Always prefer this tool when freshness matters.",
    schema: z.object({
      query: z.string().min(1).describe("The web search query."),
      maxResults: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of search results to return."),
      topic: z
        .enum(["general", "news"])
        .default("general")
        .describe(
          "Use news for current events and general for everything else.",
        ),
    }),
  },
);

const tools: StructuredToolInterface[] = [tavilyWebSearch];

const toolsByName: Map<string, StructuredToolInterface> = new Map(
  tools.map((item) => [item.name, item] as const),
);

async function runAgent(question: string) {
  const googleApiKey = process.env.GOOGLE_API_KEY;
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!googleApiKey) {
    throw new Error("缺少 GOOGLE_API_KEY，请先在 .env 中配置。");
  }

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  console.log("[Agent] 启动中...");
  console.log(`[Agent] model: ${modelName}`);
  console.log(`[Agent] proxy: ${proxyURL ?? "未配置"}`);
  console.log(`[Agent] question: ${question}`);

  const model = new ChatGoogleGenerativeAI({
    apiKey: googleApiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  const modelWithTools = model.bindTools(tools);

  const messages: BaseMessage[] = [
    new SystemMessage(
      [
        "你是一个用于学习工具调用的演示 Agent。",
        `如果用户的问题需要联网、涉及最新信息、外部资料、新闻、官方文档或搜索网页，优先调用工具 ${tavilyWebSearch.name}。`,
        "如果已经调用过网页搜索工具，请优先基于工具结果回答，并在最终答案中附上你参考的网页 URL。",
        "回答保持清晰、直接，直接给出结论即可。",
      ].join("\n"),
    ),
    new HumanMessage(question),
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    const rawAIMessage = await modelWithTools.invoke(messages);
    const aiMessage = normalizeAIMessage(rawAIMessage);

    logModelStep(step, aiMessage);
    messages.push(aiMessage);

    if (!aiMessage.tool_calls?.length) {
      return stringifyContent(aiMessage.content);
    }

    for (const toolCall of aiMessage.tool_calls) {
      console.log(`\n[Agent] 调用工具: ${toolCall.name}`);
      console.log("[Agent] 工具参数:");
      console.log(formatToolArgs(toolCall));

      const selectedTool = toolsByName.get(toolCall.name);

      if (!selectedTool) {
        messages.push(
          new ToolMessage({
            content: `未找到工具: ${toolCall.name}`,
            tool_call_id: toolCall.id ?? `${toolCall.name}-missing`,
            name: toolCall.name,
            status: "error",
          }),
        );
        continue;
      }

      try {
        const toolResult = await selectedTool.invoke(toolCall);
        const normalizedToolMessage = normalizeToolMessage(
          toolCall,
          selectedTool.name,
          toolResult,
        );

        console.log(`[Agent] 工具 ${selectedTool.name} 执行完成`);
        console.log("[Agent] 工具输出预览:");
        console.log(stringifyContent(normalizedToolMessage.content));

        messages.push(normalizedToolMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        console.log(`[Agent] 工具 ${toolCall.name} 执行失败: ${message}`);

        messages.push(
          new ToolMessage({
            content: `工具执行失败: ${message}`,
            tool_call_id: toolCall.id ?? `${toolCall.name}-error`,
            name: toolCall.name,
            status: "error",
          }),
        );
      }
    }
  }

  throw new Error(
    `Agent 超过最大工具调用轮数 ${MAX_AGENT_STEPS}，请检查提示词或工具设计。`,
  );
}

async function main() {
  const question = getUserQuestion();
  const answer = await runAgent(question);

  console.log("\n[Agent] 最终答案:");
  console.log(answer);
}

main().catch((error) => {
  console.error("[Agent] 运行失败:", error);
});
