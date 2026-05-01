/**
 * 原理
 *
 * 这一章学的是模型的流式输出。
 * 官方文档里把 streaming 定义为“在运行过程中实时把更新暴露出来”，
 * 对最基础的模型调用来说，就是模型一边生成内容，一边把 chunk 持续发出来，
 * 而不是等整段文本全部生成完再一次性返回。
 *
 * 所以它和 `invoke(...)` 的真正区别是：
 * - `invoke(...)`：拿到的是完整结果
 * - `stream(...)`：拿到的是一个可迭代的输出流
 *
 * 这意味着底层使用方式也会变化：
 * 你不再是 `const response = await model.invoke(...)`
 * 而是 `const stream = await model.stream(...)`，然后用 `for await (...)` 一块一块消费。
 *
 * 作用
 *
 * 流式输出最直接的价值是改善交互体验。
 * 用户不用干等整段结果完成，而是可以立刻看到模型正在生成什么。
 * 在真实产品里，这通常会让等待感明显下降。
 *
 * 通俗理解
 *
 * 如果说 `invoke` 像收到一封完整写好的信，
 * 那 `stream` 就像你正看着对方一边打字一边把内容发过来。
 * 内容没写完，但你已经能提前看到一部分了。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的两句是：
 * `const stream = await model.stream(messages);`
 * `for await (const chunk of stream) { ... }`
 *
 * 第一行表示：这次不要整段答案，而是要一个“持续产出内容的流”。
 * 第二行表示：后面每来一小段内容，我就立刻处理一次。
 *
 * 也正因为如此，代码里才会一边累积 `fullText`，
 * 一边用 `process.stdout.write(text)` 即时把内容打印出来。
 * 这正是 streaming 和普通调用在代码结构上的根本差别。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/streaming
 * https://docs.langchain.com/oss/javascript/langchain/models
 */
import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
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

  console.log("[流式示例] 开始执行");
  console.log(`[流式示例] 当前模型: ${modelName}`);
  console.log(`[流式示例] 当前代理: ${proxyURL ?? "未配置"}`);

  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  const messages = [
    new HumanMessage(
      "Please explain LangChain in 3 short Chinese sentences so the output is long enough to observe streaming.",
    ),
  ];

  console.log("[流式示例] 正在发送请求...");

  const startedAt = Date.now();
  const stream = await model.stream(messages);

  console.log("[流式示例] 已建立流式连接");
  console.log("[流式示例] 下面开始逐块输出 chunk：");
  console.log("");

  let fullText = "";
  let chunkCount = 0;

  for await (const chunk of stream) {
    chunkCount += 1;

    const text = toText(chunk.content);
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[第 ${chunkCount} 块] 已耗时 ${elapsedMs}ms，文本长度 ${text.length}，内容: ${JSON.stringify(text)}`,
    );

    if (text) {
      fullText += text;
      process.stdout.write(text);
    }
  }

  console.log("");
  console.log("");
  console.log("[流式示例] 流式输出结束");
  console.log(`[流式示例] 总共收到 ${chunkCount} 个 chunk`);
  console.log(`[流式示例] 最终文本总长度: ${fullText.length}`);
  console.log("[流式示例] 合并后的完整内容:");
  console.log(fullText);
}

main().catch((error) => {
  console.error("[流式示例] 执行失败", error);

  if (
    error?.cause?.code === "ETIMEDOUT" ||
    error?.cause?.cause?.code === "ETIMEDOUT"
  ) {
    console.error(
      "[流式示例] 网络连接超时：请检查代理、VPN 或 GOOGLE_API_KEY 配置是否可用。",
    );
  }
});
