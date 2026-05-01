import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { createAgent, createMiddleware } from "langchain";
import { z } from "zod";

const question = process.argv.slice(2).join(" ").trim() || "React diff 是什么？";

const interviewCardSchema = z.object({
  question: z.string(),
  coreConcept: z.string(),
  interviewAnswer: z.string(),
  projectExample: z.string(),
  followUpQuestions: z.array(z.string()),
});

type InterviewCard = z.infer<typeof interviewCardSchema>;

function toViewModel(card: InterviewCard) {
  return {
    title: card.question,
    sections: [
      { label: "核心概念", content: card.coreConcept },
      { label: "面试回答", content: card.interviewAnswer },
      { label: "项目例子", content: card.projectExample },
    ],
    followUpQuestions: card.followUpQuestions,
  };
}

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

  const loggingMiddleware = createMiddleware({
    name: "LoggingMiddleware",
    beforeModel: (state) => {
      // beforeModel: 在每次模型调用前执行。
      // 这里最适合放“查看当前 messages、打印日志、做简单校验”这类逻辑。
      console.log("\n[middleware:beforeModel] 准备调用模型");
      console.log(
        `[middleware:beforeModel] messageCount = ${state.messages.length}`,
      );
      return;
    },
    afterModel: (state) => {
      // afterModel: 在模型返回后执行。
      // 这里最适合放“记录结果、统计耗时、更新状态”这类逻辑。
      const lastMessage = state.messages[state.messages.length - 1];

      console.log("\n[middleware:afterModel] 模型调用完成");
      console.log(
        `[middleware:afterModel] lastMessageType = ${lastMessage?.getType?.()}`,
      );
      return;
    },
  });

  const agent = createAgent({
    model,
    tools: [],
    systemPrompt:
      "你是前端面试助手。请把回答整理成适合前端直接渲染的结构化结果，不要输出多余字段。",
    responseFormat: interviewCardSchema,
    middleware: [loggingMiddleware],
  });

  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: `请解释这个前端问题：${question}`,
      },
    ],
  });

  console.log("\nstructuredResponse:");
  console.log(JSON.stringify(result.structuredResponse, null, 2));

  console.log("\nviewModel:");
  console.log(
    JSON.stringify(toViewModel(result.structuredResponse as InterviewCard), null, 2),
  );
}

main().catch((error) => {
  console.error("\n[error] 执行失败");
  console.error(error);
});
