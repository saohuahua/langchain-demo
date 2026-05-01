/**
 * 原理
 *
 * 这一章学的是短期记忆，也就是“同一段对话里，前文如何持续影响后文”。
 * 官方文档里真正的 short-term memory 是围绕 agent state 和 checkpointer 展开的，
 * 它的目标是让某个会话线程里的状态可以持续存在。
 *
 * 但在入门阶段，最先要看懂的不是框架层的持久化接口，
 * 而是记忆的最底层原理：
 * 只要上一轮的消息还会继续出现在下一轮的输入里，
 * 模型就会表现得像“记住了前面说过的话”。
 *
 * 所以这份代码故意用最朴素的方式演示：
 * 1. 用一个 `memory: BaseMessage[] = []` 保存消息历史
 * 2. 用户每说一轮，就先把 `HumanMessage` 放进去
 * 3. 调模型时，把 `[systemMessage, ...memory]` 一起发过去
 * 4. 模型返回后，再把 AI 回复也放回 `memory`
 *
 * 作用
 *
 * 这样做解决的是“同一个会话里怎么延续上下文”。
 * 比如第一轮用户说“我叫小王”，第二轮再问“我刚才说我叫什么”，
 * 模型之所以答得出来，就是因为第一轮消息还保留在 memory 里。
 *
 * 通俗理解
 *
 * 可以把 short-term memory 理解成“当前会话的聊天记录缓存”。
 * 只要这份缓存还跟着下一轮请求一起传给模型，
 * 模型就会像真的记住了一样继续往下聊。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的两处是：
 * `const memory: BaseMessage[] = [];`
 * `const response = await model.invoke([systemMessage, ...memory]);`
 *
 * 第一行表示：我要手动维护一份当前会话消息历史。
 * 第二行表示：每次推理时，都把这份历史重新交给模型。
 *
 * 这也是为什么我说这份代码是在演示“记忆原理”而不是“正式记忆架构”：
 * 它没有引入 checkpointer，也没有线程状态管理，
 * 但它非常适合先帮你把 short-term memory 的底层机制看明白。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/messages
 * https://docs.langchain.com/oss/javascript/langchain/short-term-memory
 */
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
