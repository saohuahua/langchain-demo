import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import * as z from "zod";

const VUE_KNOWLEDGE_PATH = path.resolve(process.cwd(), "md", "Vue3.md");

const readVue3Knowledge = tool(
  async ({ query }) => {
    const knowledge = await readFile(VUE_KNOWLEDGE_PATH, "utf8");
    return `问题：${query}\n\n参考资料：\n${knowledge}`;
  },
  {
    name: "read_vue3_md_knowledge",
    description: "当用户询问 Vue3 相关问题时，读取本地知识库 md/Vue3.md。",
    schema: z.object({
      query: z.string().min(1).describe("Vue3 相关问题"),
    }),
  },
);

const tools = [readVue3Knowledge];
const toolsByName: Record<string, (typeof tools)[number]> = {
  [readVue3Knowledge.name]: readVue3Knowledge,
};

function toText(content: unknown): string {
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

        return JSON.stringify(item);
      })
      .join("\n");
  }

  return JSON.stringify(content);
}

function normalizeAIMessage(message: AIMessageChunk): AIMessage {
  return new AIMessage({
    content: message.content,
    tool_calls: message.tool_calls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    usage_metadata: message.usage_metadata,
  });
}

function getRole(message: BaseMessage): string {
  if (message instanceof SystemMessage) {
    return "System";
  }

  if (message instanceof HumanMessage) {
    return "Human";
  }

  if (message instanceof AIMessage) {
    return "AI";
  }

  if (message instanceof ToolMessage) {
    return "Tool";
  }

  return "Message";
}

function getLastQuestion() {
  return (
    process.argv.slice(2).join(" ").trim() ||
    "那面试里如果让我选，什么时候优先用 ref，什么时候优先用 reactive？"
  );
}

function createMessages(lastQuestion: string): BaseMessage[] {
  return [
    new SystemMessage(
      [
        "你是一个 Vue3 前端面试助手，回答简洁、适合学习。",
        `遇到 Vue3 问题时，优先调用工具 ${readVue3Knowledge.name} 读取本地知识库。如果使用的本地知识库要说明，否则就说明根据通用知识库`,
        "如果知识库没有明确覆盖，再基于通用知识补充，但不要编造。一句话回答即可，简单一点",
      ].join("\n"),
    ),
    new HumanMessage("请解释 Vue3 里 ref 和 reactive 的区别。"),
    new AIMessage(
      "ref 适合基本类型，也能包裹对象；reactive 更适合对象和数组，返回的是 Proxy 代理对象。",
    ),
    new HumanMessage("那为什么 reactive 不能直接处理基本类型？"),
    new AIMessage(
      "因为 reactive 底层依赖 Proxy，而 Proxy 只能代理对象，不能直接代理 number、string 这类基本类型。",
    ),
    new HumanMessage(lastQuestion),
  ];
}

function printMessages(messages: BaseMessage[]) {
  console.log("\n=== 对话上下文 ===");

  messages.forEach((message, index) => {
    console.log(`\n[${index + 1}] ${getRole(message)}`);
    console.log(toText(message.content));
  });
}

async function runConversation(lastQuestion: string) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!apiKey) {
    throw new Error("缺少 GOOGLE_API_KEY，请先在 .env 中配置。");
  }

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  console.log("开始运行多轮对话...");
  console.log(`模型: ${modelName}`);
  console.log(`知识库: ${VUE_KNOWLEDGE_PATH}`);
  console.log(`最后一个问题: ${lastQuestion}`);

  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  const modelWithTools = model.bindTools(tools);
  const messages = createMessages(lastQuestion);

  printMessages(messages);

  for (let i = 0; i < 3; i += 1) {
    const aiMessage = normalizeAIMessage(await modelWithTools.invoke(messages));
    messages.push(aiMessage);

    if (!aiMessage.tool_calls?.length) {
      console.log("\n=== 最终回答 ===");
      return toText(aiMessage.content);
    }

    for (const toolCall of aiMessage.tool_calls) {
      const selectedTool = toolsByName[toolCall.name];

      console.log(`\n=== 第 ${i + 1} 轮工具调用 ===`);
      console.log(`工具: ${toolCall.name}`);
      console.log(`参数: ${JSON.stringify(toolCall.args, null, 2)}`);

      if (!selectedTool) {
        messages.push(
          new ToolMessage({
            content: `未找到工具：${toolCall.name}`,
            tool_call_id: toolCall.id ?? toolCall.name,
          }),
        );
        continue;
      }

      const result = await selectedTool.invoke(toolCall);

      messages.push(
        new ToolMessage({
          content: toText(result),
          tool_call_id: toolCall.id ?? selectedTool.name,
          name: selectedTool.name,
        }),
      );
    }
  }

  throw new Error("工具调用轮次超过上限。");
}

async function main() {
  const answer = await runConversation(getLastQuestion());
  console.log(answer);
}

main().catch((error) => {
  console.error("运行失败：", error);
});
