import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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

  console.log("开始调用 Google Gemini...");
  console.log(`模型: ${modelName}`);
  console.log(`代理: ${proxyURL ?? "未配置"}`);

  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  const response = await model.invoke([
    new HumanMessage("请用一句话解释 LangChain 是什么？"),
  ]);

  console.log("调用成功：");
  console.log(response.content);
}

main().catch((error) => {
  console.error("调用失败：", error);

  if (
    error?.cause?.code === "ETIMEDOUT" ||
    error?.cause?.cause?.code === "ETIMEDOUT"
  ) {
    console.error(
      "网络连接超时：当前环境连不上 Google Generative AI。请检查代理/VPN，或确认 .env 中的 HTTPS_PROXY/HTTP_PROXY 可用。"
    );
  }
});
