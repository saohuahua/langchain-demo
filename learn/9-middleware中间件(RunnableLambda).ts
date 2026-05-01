/**
 * 原理
 *
 * 这一章学的不是正式 API，而是 middleware 背后的思想本身。
 * 官方文档里 middleware 的核心是：在 agent / model 执行的关键节点前后插入自定义逻辑。
 * 但在真正接触 `createMiddleware(...)` 之前，先看懂“为什么需要中间件”会更重要。
 *
 * 这份代码用 `RunnableLambda + RunnableSequence` 手动拼出了一条处理链，
 * 本质上是在模拟一个典型的 middleware 流程：
 * 1. before：模型调用前先整理输入
 * 2. model：真正执行模型
 * 3. after：模型返回后统一加工结果
 *
 * 也就是说，这章的重点不是某个官方专有 API，
 * 而是让你先理解“为什么很多逻辑适合放在主流程两侧，而不是塞进主流程内部”。
 *
 * 作用
 *
 * 这种拆法特别适合处理横切逻辑，例如：
 * - 调用前统一组装 messages
 * - 记录日志
 * - 统计耗时
 * - 调用后统一转 viewModel
 *
 * 如果把这些都直接写进主函数里，代码很快会变得又长又杂；
 * 而拆成 before / model / after 三段后，职责会清晰很多。
 *
 * 通俗理解
 *
 * 可以把它理解成一条流水线。
 * 原始输入先经过预处理站，接着进入模型站，最后再进入结果加工站。
 * 中间件思想，本质上就是把这些站点从主流程里拆出来。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的结构是：
 * `const chain = RunnableSequence.from([beforeMiddleware, modelMiddleware, afterMiddleware])`
 *
 * 这句几乎就是“中间件流水线”的直观表达：
 * - `beforeMiddleware` 负责准备 messages 和记录开始时间
 * - `modelMiddleware` 负责真正调用 structuredModel
 * - `afterMiddleware` 负责计算耗时并把结果转成更适合前端消费的 viewModel
 *
 * 所以这章真正该学到的是：
 * 中间件不只是一个 API 名词，
 * 它首先是一种“把前后置公共逻辑拆出来”的组织代码方式。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/middleware
 * https://docs.langchain.com/oss/javascript/langchain/structured-output
 */
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
