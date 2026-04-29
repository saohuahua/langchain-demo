import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { ProxyAgent } from "undici";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!apiKey) {
    throw new Error("缺少 OPENAI_API_KEY，请先在 .env 中配置。");
  }

  console.log("开始调用 LangChain...");
  console.log(`模型: ${modelName}`);
  console.log(`接口地址: ${baseURL ?? "OpenAI 官方默认地址"}`);
  console.log(`代理: ${proxyURL ?? "未配置"}`);

  const model = new ChatOpenAI({
    model: modelName,
    temperature: 0,
    timeout: 20_000,
    configuration: {
      ...(baseURL ? { baseURL } : {}),
      ...(proxyURL
        ? { fetchOptions: { dispatcher: new ProxyAgent(proxyURL) } }
        : {}),
    },
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
      "网络连接超时：当前环境连不上 OpenAI API。请检查代理/VPN，或在 .env 中配置可访问的 OPENAI_BASE_URL。"
    );
  }
});
