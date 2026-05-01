/**
 * 原理
 *
 * 这一章学的是 LangChain 正式的 middleware API，也就是 `createMiddleware(...)`。
 * 如果上一章是在学“中间件思想”，那这一章就是在看“LangChain 把这种思想正式落成了什么接口”。
 *
 * 官方文档里 middleware 的位置很明确：
 * 它是挂在 agent 执行生命周期上的钩子系统，
 * 让你可以在模型调用前后、工具调用前后、agent 开始和结束时插入自定义逻辑。
 *
 * 也就是说，middleware 的本质不是替代 agent，
 * 而是“围绕 agent 的执行过程做观察、修改和增强”。
 *
 * 在这份代码里，使用的是最容易理解的一组钩子：
 * - `beforeModel`：在模型真正调用前触发
 * - `afterModel`：在模型返回结果后触发
 *
 * 作用
 *
 * 这种机制特别适合放那些“你每次都可能要做，但又不属于主业务回答本身”的逻辑，
 * 比如日志、输入检查、耗时统计、提示词增强、输出审查、fallback、重试等。
 *
 * 通俗理解
 *
 * 如果说 `createAgent(...)` 建出来的是主流程，
 * 那 middleware 就像挂在主流程边上的拦截器。
 * 每次数据路过时，你都可以看一眼、记一笔、改一点，甚至决定后面怎么继续。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的结构有两层：
 * 1. `const loggingMiddleware = createMiddleware({...})`
 *    这一步是在正式定义一个可挂载到 agent 生命周期里的中间件。
 * 2. `middleware: [loggingMiddleware]`
 *    这一步是在把中间件真正接到 agent 上。
 *
 * 然后再看中间件内部：
 * `beforeModel: (state) => { ... }`
 * `afterModel: (state) => { ... }`
 *
 * 这两句的意义非常直接：
 * - 模型调用前，我可以先读取当前 state.messages 做日志或检查
 * - 模型调用后，我可以再读取最后一条消息做记录或后处理
 *
 * 所以这章真正要掌握的是：
 * LangChain 的 middleware 不是一个抽象概念，
 * 而是一套能正式挂进 agent 生命周期的钩子接口。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/middleware
 * https://docs.langchain.com/oss/javascript/langchain/structured-output
 */
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
