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
