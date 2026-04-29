import "dotenv/config";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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
      .join("");
  }

  if (content == null) {
    return "";
  }

  return JSON.stringify(content);
}

function getConversationTurns(): string[] {
  const cliInput = process.argv.slice(2).join(" ").trim();

  if (!cliInput) {
    return [
      "我叫小王，你先记住我的名字。",
      "我刚刚告诉你的名字是什么？只回答名字即可。",
    ];
  }

  // 多轮输入用 | 分隔，便于你自己替换成别的对话。
  return cliInput
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runTurn(params: {
  model: ChatGoogleGenerativeAI;
  memory: BaseMessage[];
  systemMessage: SystemMessage;
  userInput: string;
}) {
  const { model, memory, systemMessage, userInput } = params;

  // 最简单的短期记忆：把本轮用户消息先存进 memory。
  memory.push(new HumanMessage(userInput));

  // 下一次调用模型时，把 system prompt 和历史消息一起传进去。
  const response = await model.invoke([systemMessage, ...memory]);

  // 再把模型回复也存起来，供下一轮继续使用。
  memory.push(response);

  return toText(response.content);
}

function printMemory(memory: BaseMessage[]) {
  console.log("\n当前 memory 中保存的消息：");

  memory.forEach((message, index) => {
    console.log(
      `${index + 1}. [${message.getType()}] ${toText(message.content)}`,
    );
  });
}

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!apiKey) {
    throw new Error("缺少 GOOGLE_API_KEY，请先在 .env 中配置。");
  }

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  // 这个数组就是示例里的“短期记忆”。
  // 它只在当前进程内有效，程序结束后就消失了。
  const memory: BaseMessage[] = [];

  const systemMessage = new SystemMessage(
    "你是一个简洁的中文助手。请基于完整对话历史回答问题。",
  );

  const turns = getConversationTurns();

  console.log("[memory 示例] 开始演示最简短期记忆");
  console.log(`[memory 示例] 当前模型: ${modelName}`);

  for (const [index, userInput] of turns.entries()) {
    console.log(`\n用户第 ${index + 1} 轮: ${userInput}`);

    const answer = await runTurn({
      model,
      memory,
      systemMessage,
      userInput,
    });

    console.log(`AI 第 ${index + 1} 轮: ${answer}`);
    console.log(`[memory 示例] 当前已保存 ${memory.length} 条历史消息`);
  }

  printMemory(memory);
}

main().catch((error) => {
  console.error("[memory 示例] 执行失败", error);
});
