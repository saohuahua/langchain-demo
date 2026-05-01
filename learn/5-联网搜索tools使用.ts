/**
 * 原理
 *
 * 这一章学的是“为什么要把联网搜索做成 tool，而不是让模型自己硬答”。
 * 官方文档里提到，tools 的价值就在于扩展模型能力，
 * 让模型可以获取实时数据、访问外部系统、执行宿主程序里的动作。
 *
 * 联网搜索正是最典型的一类工具：
 * 模型自己并不直接访问互联网，
 * 它只能先发出一个 tool call，请宿主代码去真正执行搜索。
 *
 * 所以这章的底层链路和上一章的 tool calling 是一致的，只是工具换成了搜索：
 * 1. 用 `tool(...)` 把 Tavily 搜索能力包装成 LangChain 工具
 * 2. 用 `model.bindTools(...)` 让模型知道“你现在可以搜索网页”
 * 3. 当模型判断问题需要最新资料时，就会返回 `tool_calls`
 * 4. 代码调用 Tavily API 拿到搜索结果
 * 5. 再把这些结果作为 `ToolMessage` 回传给模型，让模型基于结果给出最终回答
 *
 * 作用
 *
 * 这一层解决的是“模型如何回答新鲜信息”。
 * 比如最新文档、近期新闻、外部页面、API 信息、版本差异，
 * 这些都不适合只靠模型参数记忆来答。
 *
 * 通俗理解
 *
 * 可以把它理解成模型在说：
 * “这个问题我不该闭眼猜，我先上网查一下，再回来告诉你。”
 * 注意，真正执行“上网查”的不是模型本身，而是你代码里的搜索工具。
 *
 * 代码聚焦
 *
 * 这份代码有三层特别值得看：
 * 1. `const tavilyWebSearch = tool(...)`
 *    这一层是把搜索能力包装成模型可理解的工具。
 * 2. `const searchResponse = await tavilySearch(...)`
 *    这一层是真正去调用外部搜索接口。
 * 3. `messages.push(normalizedToolMessage)`
 *    这一层是把搜索结果送回模型，让模型继续组织最终答案。
 *
 * 也就是说，这章不只是“会用 Tavily”而已，
 * 更重要的是看懂：
 * 外部工具如何进入 agent 推理链路，并成为模型回答的一部分。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/tools
 * https://docs.langchain.com/oss/javascript/langchain/models
 * https://docs.langchain.com/oss/javascript/langchain/messages
 */
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
// z 来自 zod，用来定义和校验工具参数的结构。
// 在 agent tool calling 里，它既是“参数说明书”，也是“运行时校验器”。
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

// tool(...) 会把一个普通函数包装成“可供模型选择和调用的工具”。
// 这里可以把它拆成两部分理解：
// 1. async ({ ... }) => {...} 是工具真正执行时跑的业务逻辑
// 2. 后面的 { name, description, schema } 是暴露给模型看的工具声明
//
// 整个流程通常是：
// 1. 先定义工具
// 2. 再通过 bindTools(tools) 把工具能力告诉模型
// 3. 模型返回 tool_calls，说明它想调用哪个工具、传什么参数
// 4. 我们在宿主代码里真正执行该工具，再把结果回传给模型
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
    // name 是工具的唯一名字。
    // 后面模型返回 tool_call.name 时，会用这个值来匹配具体要执行哪个工具。
    // 所以 name 最好稳定、清晰、不要和别的工具重名。
    name: "tavily_web_search",
    // description 是给模型看的“使用场景说明”。
    // 模型不会读你的函数名猜全部语义，它主要依赖 description 来判断：
    // “什么时候该调用这个工具，而不是直接口头回答？”
    description:
      "Search the web for current or external information. Use this for latest updates, news, library docs, product details, or anything not guaranteed to be in the model's memory. Always prefer this tool when freshness matters.",
    // schema 定义工具入参的结构。
    // 它的作用有三层：
    // 1. 告诉模型参数名、参数类型、默认值和每个字段的含义
    // 2. 在调用前做参数校验，避免把无效参数传进工具
    // 3. 让 TypeScript 能更好地推导工具参数类型
    //
    // z.object(...) 表示：这个工具接收的是一个对象参数。
    schema: z.object({
      // query: 搜索词
      // z.string() 表示必须是字符串
      // .min(1) 表示不能为空字符串
      // .describe(...) 会补充给模型看的字段说明
      query: z.string().min(1).describe("The web search query."),
      // maxResults: 想返回几条搜索结果
      // z.coerce.number() 会先“尽量转成 number”，
      // 例如模型传了字符串 "5"，这里也能被转成数字 5。
      // 这对 tool calling 很常见，因为模型有时会把数字写成字符串。
      maxResults: z.coerce
        .number()
        // 必须是整数，不能是 2.5 这种小数
        .int()
        // 最少 1 条
        .min(1)
        // 最多 10 条，避免一次取太多
        .max(10)
        // 如果模型没填这个参数，就默认按 5 条处理
        .default(5)
        .describe("Maximum number of search results to return."),
      // topic: 搜索主题类型
      // z.enum(...) 表示它只能是固定枚举值之一，
      // 这样模型可选范围更明确，也更不容易传错。
      topic: z
        .enum(["general", "news"])
        // 默认普通搜索
        .default("general")
        .describe(
          "Use news for current events and general for everything else.",
        ),
    }),
  },
);

const tools: StructuredToolInterface[] = [tavilyWebSearch];

// 把工具数组转成 Map，方便后面根据 tool_call.name 快速找到对应工具。
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

  // bindTools(tools) 的作用是“向模型声明有哪些工具可用”。
  // 注意：这一步并不会真的执行工具，它只是把工具的
  // name / description / schema 一并交给模型，供模型决策。
  // 真正的执行发生在后面我们读取 aiMessage.tool_calls 之后。
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
    // 每一轮都把当前消息历史发给模型。
    // 如果模型判断不需要工具，就直接返回文本答案；
    // 如果需要工具，它会在返回结果里带上 tool_calls。
    const rawAIMessage = await modelWithTools.invoke(messages);
    const aiMessage = normalizeAIMessage(rawAIMessage);

    logModelStep(step, aiMessage);
    messages.push(aiMessage);

    if (!aiMessage.tool_calls?.length) {
      return stringifyContent(aiMessage.content);
    }

    // 从这里开始，进入“宿主应用执行工具”的阶段。
    // 大模型本身不会真的执行 JS 函数，它只会生成一个调用意图：
    // 也就是 tool name + args。真正执行工具的是当前这段 TypeScript 代码。
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
        // invoke(toolCall) 会把模型生成的参数交给工具。
        // LangChain 会结合前面定义的 schema 做解析和校验，
        // 然后才进入 tool(...) 里的 async 函数主体。
        const toolResult = await selectedTool.invoke(toolCall);
        const normalizedToolMessage = normalizeToolMessage(
          toolCall,
          selectedTool.name,
          toolResult,
        );

        console.log(`[Agent] 工具 ${selectedTool.name} 执行完成`);
        console.log("[Agent] 工具输出预览:");
        console.log(stringifyContent(normalizedToolMessage.content));

        // 工具结果必须作为 ToolMessage 放回消息历史，
        // 这样模型下一轮推理时才能“看到工具返回了什么”。
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
