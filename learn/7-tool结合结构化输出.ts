/**
 * 原理
 *
 * 这一章学的是两种能力的组合：
 * 先用 tool 补充外部信息，再用 structured output 约束最终返回格式。
 * 这是非常典型的真实业务写法，因为很多场景既需要“信息正确”，也需要“格式稳定”。
 *
 * 单独看这两种能力：
 * - tool calling 解决“模型没有资料怎么办”
 * - structured output 解决“结果怎么稳定交给程序”
 *
 * 把它们合起来后，整体链路就会变成：
 * 1. 先把搜索工具绑定给模型
 * 2. 模型判断当前问题是否需要搜索
 * 3. 如果需要，就调用 tool 获取额外资料
 * 4. 工具结果回到消息上下文后，再让模型整理最终答案
 * 5. 最终答案不是随意文本，而是一个符合 schema 的对象
 *
 * 作用
 *
 * 这一层解决的是“既要外部资料，又要结构稳定”的问题。
 * 比如前端要展示一张回答卡片，还要标记是否使用过搜索、有哪些来源链接，
 * 这时组合使用 tool + schema 就很自然。
 *
 * 通俗理解
 *
 * 可以把这章理解成两步走：
 * 第一步先去外面找资料，第二步再按固定模板交答案。
 * 换句话说，一个能力负责“找内容”，另一个能力负责“整理格式”。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的结构不是某一行，而是两段串联：
 * 1. `const modelWithTools = model.bindTools([searchTool])`
 *    这一段负责让模型拥有“可以先搜索”的能力。
 * 2. `const structuredModel = model.withStructuredOutput(answerSchema, ...)`
 *    这一段负责让最终输出变成固定对象。
 *
 * 中间还有一个关键细节：
 * 当 tool 执行完后，代码会把结果变成 `ToolMessage` 加回 `messages`，
 * 然后再让结构化模型基于这份上下文产出最终对象。
 *
 * 所以这章真正要理解的是：
 * tool 和 structured output 并不是二选一，
 * 而是“一个扩展信息来源，一个约束结果形态”，可以自然地串在一起。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/tools
 * https://docs.langchain.com/oss/javascript/langchain/models
 * https://docs.langchain.com/oss/javascript/langchain/structured-output
 * https://docs.langchain.com/oss/javascript/langchain/messages
 */
import "dotenv/config";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";

const question =
  process.argv.slice(2).join(" ").trim() ||
  "React 19 和 React 18 相比，对前端面试有哪些值得关注的变化？";

const answerSchema = z.object({
  question: z.string(),
  coreConcept: z.string(),
  interviewAnswer: z.string(),
  projectExample: z.string(),
  followUpQuestions: z.array(z.string()),
  usedSearch: z.boolean(),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
    }),
  ),
});

async function tavilySearch(query: string, maxResults: number) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      max_results: maxResults,
    }),
  });

  return response.json() as Promise<{
    query: string;
    results?: Array<{ title: string; url: string; content?: string }>;
  }>;
}

const searchTool = tool(
  async ({ query, maxResults }) => {
    console.log("\n[tool call]");
    console.log("name: tavily_web_search");
    console.log("args:", { query, maxResults });

    const data = await tavilySearch(query, maxResults);
    const pages = (data.results ?? []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content ?? "",
    }));

    console.log("[tool result]");
    pages.forEach((page, index) => {
      console.log(`${index + 1}. ${page.title}`);
      console.log(`   ${page.url}`);
    });

    return { query: data.query, pages };
  },
  {
    name: "tavily_web_search",
    description:
      "Search the web when the question needs external or recent information.",
    schema: z.object({
      query: z.string(),
      maxResults: z.coerce.number().default(3),
    }),
  },
);

async function main() {
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  const model = new ChatGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_API_KEY,
    model: process.env.GOOGLE_MODEL ?? "gemini-2.5-flash",
    temperature: 0,
  });

  const modelWithTools = model.bindTools([searchTool]);
  const messages: BaseMessage[] = [
    new SystemMessage(
      "你是前端面试助手。可以先调用 tavily_web_search，如果没有符合的就使用模型自身。调用外部工具要说明一下，否则就基于模型自身，也需要说明",
    ),
    new HumanMessage(question),
  ];

  const aiMessage = await modelWithTools.invoke(messages);
  messages.push(aiMessage);

  for (const toolCall of aiMessage.tool_calls ?? []) {
    const toolResult = await searchTool.invoke(toolCall);
    messages.push(
      new ToolMessage({
        tool_call_id: toolCall.id ?? "search-call",
        name: searchTool.name,
        content: JSON.stringify(toolResult),
      }),
    );
  }

  const structuredModel = model.withStructuredOutput(answerSchema, {
    name: "frontend_answer",
  });

  const structuredResponse = await structuredModel.invoke([
    ...messages,
    new HumanMessage(
      "请基于上面的上下文，输出适合前端渲染的结构化结果。如果用了搜索工具，就把来源放到 sources。",
    ),
  ]);

  console.log("\nstructuredResponse:");
  console.log(JSON.stringify(structuredResponse, null, 2));
}

main().catch(console.error);
