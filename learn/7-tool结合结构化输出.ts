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
