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
