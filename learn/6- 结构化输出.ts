/**
 * 原理
 *
 * 这一章学的是结构化输出，也就是不让模型只返回一段自由文本，
 * 而是要求它按一个预先声明好的字段结构返回结果。
 * 官方文档里这类能力的核心思想可以概括成一句话：
 * “把模型输出约束成 schema，而不是事后再从自然语言里硬解析。”
 *
 * 为什么这件事重要？
 * 因为普通文本回答虽然人能看懂，但程序不一定好处理。
 * 一旦你希望把模型结果直接交给前端卡片、表格、表单、字段渲染层，
 * 你就会希望结果从一开始就是一个稳定对象。
 *
 * 所以这章的底层机制是：
 * 1. 先定义一个 `zod schema`
 * 2. 再通过 `model.withStructuredOutput(schema)` 得到一个“被约束过输出格式”的模型
 * 3. 后面再去 `invoke(...)` 时，模型就不再返回随意文本，而是返回符合 schema 的对象
 *
 * 作用
 *
 * 这一层解决的是“怎样让模型结果更容易被程序消费”。
 * 比如你要在前端展示一张面试卡片，里面有核心概念、回答、项目例子、追问列表，
 * 那结构化输出就比“先让模型写一大段，再自己拆字段”稳定得多。
 *
 * 通俗理解
 *
 * 普通输出像“请你自由发挥写一段回答”，
 * 结构化输出像“请你按这张固定表单逐项填写”。
 * 模型仍然在生成内容，但内容被限制进了一个可预测的格式里。
 *
 * 代码聚焦
 *
 * 这份代码里最关键的两句是：
 * `const interviewCardSchema = z.object({...})`
 * `const structuredModel = model.withStructuredOutput(interviewCardSchema, ...)`
 *
 * 第一行是在定义“最后必须返回哪些字段”；
 * 第二行是在把这个字段要求绑定到模型输出上。
 *
 * 后面真正调用时：
 * `const structuredResponse = await structuredModel.invoke([...])`
 * 这时拿到的就不再只是字符串，而是一个符合 `interviewCardSchema` 的对象。
 *
 * 所以这章真正要掌握的是：
 * 结构化输出不是“模型答完后我们自己解析”，
 * 而是“从生成阶段就约束输出结构”。
 *
 * 官方文档
 * https://docs.langchain.com/oss/javascript/langchain/models
 * https://docs.langchain.com/oss/javascript/langchain/structured-output
 */
import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";

const question = process.argv.slice(2).join(" ").trim() || "React diff 是什么？";

// schema 决定前端最终能拿到什么字段。
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

  // 这里会让模型按 schema 返回 structured output。
  const structuredModel = model.withStructuredOutput(interviewCardSchema, {
    name: "frontend_interview_card",
  });

  const structuredResponse = await structuredModel.invoke([
    new SystemMessage(
      "你是前端面试助手。请把回答整理成适合前端直接渲染的结构化结果，不要输出多余字段。",
    ),
    new HumanMessage(`请解释这个前端问题：${question}`),
  ]);

  console.log("\nstructuredResponse:");
  console.log(JSON.stringify(structuredResponse, null, 2));

  console.log("\nviewModel:");
  console.log(JSON.stringify(toViewModel(structuredResponse), null, 2));
}

main().catch(console.error);
