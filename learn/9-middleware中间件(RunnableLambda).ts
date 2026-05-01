import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
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

type ChainInput = {
  question: string;
};

type PreparedInput = {
  question: string;
  startedAt: number;
  messages: [SystemMessage, HumanMessage];
};

type ModelOutput = {
  startedAt: number;
  structuredResponse: InterviewCard;
};

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

  const structuredModel = model.withStructuredOutput(interviewCardSchema, {
    name: "frontend_interview_card",
  });

  const beforeMiddleware = RunnableLambda.from(
    async (input: ChainInput): Promise<PreparedInput> => {
      console.log("\n[middleware:before] 开始处理输入");
      console.log(`[middleware:before] question = ${input.question}`);

      // 前置中间件：在调用模型前统一处理输入
      // 这里做的事情很简单，就是组装 messages，并记录开始时间
      return {
        question: input.question,
        startedAt: Date.now(),
        messages: [
          new SystemMessage(
            "你是前端面试助手。请把回答整理成适合前端直接渲染的结构化结果，不要输出多余字段。",
          ),
          new HumanMessage(`请解释这个前端问题：${input.question}`),
        ],
      };
    },
  );

  const modelMiddleware = RunnableLambda.from(
    async (input: PreparedInput): Promise<ModelOutput> => {
      console.log("\n[middleware:model] 即将调用模型");
      console.log(`[middleware:model] messageCount = ${input.messages.length}`);

      // 中间这一步负责真正调用模型。
      // 这里仍然放在链路里，是为了让你看到“模型调用”也可以被包在中间件流程中。
      const structuredResponse = await structuredModel.invoke(input.messages);

      return {
        startedAt: input.startedAt,
        structuredResponse,
      };
    },
  );

  const afterMiddleware = RunnableLambda.from(
    async (input: ModelOutput) => {
      const elapsedMs = Date.now() - input.startedAt;

      console.log("\n[middleware:after] 模型调用完成");
      console.log(`[middleware:after] elapsedMs = ${elapsedMs}`);

      // 后置中间件：在模型返回后统一处理结果。
      // 这里把结构化输出再转换成更适合前端展示的 viewModel。
      return {
        structuredResponse: input.structuredResponse,
        viewModel: toViewModel(input.structuredResponse),
        elapsedMs,
      };
    },
  );

  // 用 RunnableSequence 把 3 段串起来：
  // 前置中间件 -> 模型调用 -> 后置中间件
  const chain = RunnableSequence.from([
    beforeMiddleware,
    modelMiddleware,
    afterMiddleware,
  ]);

  const result = await chain.invoke({ question });

  console.log("\nstructuredResponse:");
  console.log(JSON.stringify(result.structuredResponse, null, 2));

  console.log("\nviewModel:");
  console.log(JSON.stringify(result.viewModel, null, 2));
}

main().catch((error) => {
  console.error("\n[error] 执行失败");
  console.error(error);
});
