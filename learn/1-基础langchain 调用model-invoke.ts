/**
 * 原理
 *
 * 这一章学的是 LangChain 最基础、也是最重要的一层：直接调用聊天模型。
 * 官方文档里强调，LangChain 的 chat model 以 messages 作为输入，以 message 作为输出。
 * 也就是说，模型并不是只吃一个字符串，而是吃“带角色的消息列表”。
 *
 * 这背后的机制可以先记一句最核心的话：
 * `model.invoke(messages)` = 把当前上下文一次性发给模型，等待它返回一个完整的 `AIMessage`。
 *
 * 所以这类代码的底层流程其实很简单：
 * 1. 先创建模型实例，例如 `new ChatGoogleGenerativeAI(...)`
 * 2. 再构造输入消息，例如 `new HumanMessage("...")`
 * 3. 最后执行 `await model.invoke([...])`
 * 4. 返回值是模型这一次完整推理后的结果
 *
 * 作用
 *
 * 这一层解决的是“怎样最直接地让模型工作”。
 * 后面你学到的 tool calling、structured output、memory、middleware，
 * 本质上都是在这层调用之上继续加能力，而不是替代这层调用。
 *
 * 通俗理解
 *
 * 可以把它理解成最普通的一次问答：
 * 你把问题整理成一条消息交给模型，模型完整想完，再一次性把答案回给你。
 * 这时还没有工具决策、没有中间件拦截、也没有记忆管理，就是最纯粹的一次“请求 -> 响应”。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的一句是：
 * `const response = await model.invoke([new HumanMessage("...")]);`
 *
 * 这句代码非常值得记住，因为它对应了 LangChain 模型调用的最小闭环：
 * - `HumanMessage` 负责把用户输入包装成标准消息
 * - `invoke(...)` 负责真正发起一次完整模型推理
 * - `response.content` 则是最终要展示给用户的内容
 *
 * 如果把整份文件压缩成一句话，那就是：
 * “先把用户问题包成消息，再用 `model.invoke(...)` 让模型生成一次完整回答。”
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/models
 * https://docs.langchain.com/oss/javascript/langchain/messages
 */
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
