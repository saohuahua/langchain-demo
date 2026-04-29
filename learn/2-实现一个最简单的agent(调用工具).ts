import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage,
  type ToolCall,
} from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import * as z from "zod";

/**
 * 本地知识库文件路径。
 *
 * 这份示例里，我们没有接数据库、向量库、ES 之类的真正检索系统，
 * 而是直接把一个 Markdown 文件当成“最小知识库”。
 *
 * 好处是：非常适合学习 Agent 的第一步。
 * 你可以先专注理解：
 * 1. 模型怎么决定要不要调用工具
 * 2. 工具怎么执行
 * 3. 工具结果怎么回给模型
 */
const VUE_KNOWLEDGE_PATH = path.resolve(process.cwd(), "md", "Vue3.md");

/**
 * 定义一个“给模型调用”的工具。
 *
 * 这个工具的职责很简单：
 * - 接收用户问题 query
 * - 读取本地知识库 md/Vue3.md
 * - 把知识库内容拼成字符串返回给模型
 *
 * 注意：
 * 这里的 tool(...) 不是普通函数调用，它是把一个 JS/TS 函数包装成
 * “LangChain 可识别的工具对象”。
 *
 * 包装之后，模型就能知道：
 * - 工具名字是什么
 * - 工具是干什么的
 * - 调用工具时应该传什么参数
 */
const searchVueInterviewKnowledge = tool(
  async ({ query }) => {
    try {
      // 读取本地 Markdown 文件内容。
      const knowledge = await readFile(VUE_KNOWLEDGE_PATH, "utf8");

      // 把“用户问题 + 本地知识库内容”一起返回给模型。
      // 这样模型下一轮作答时，既知道用户问了什么，也知道工具查到了什么。
      return [
        `用户问题：${query}`,
        `以下是本地知识库 ${VUE_KNOWLEDGE_PATH} 的内容，请优先基于它回答：`,
        knowledge,
      ].join("\n\n");
    } catch (error) {
      // 如果知识库读取失败，不直接抛异常给外层，
      // 而是把失败信息作为工具结果返回给模型。
      // 这样模型仍然有机会给用户一个更友好的说明。
      return `读取知识库失败：${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    // 工具名：模型如果要调用这个工具，会在 tool_call 里使用这个名字。
    name: "read_vue3_md_knowledge",

    // 工具描述：这段说明很重要，模型会根据它判断
    // “什么时候该调用这个工具”。
    description:
      "当用户询问 Vue3 或前端面试知识时，读取本地知识库 md/Vue3.md 并返回资料。",

    // schema：约束工具参数结构。
    // 这里表示模型调用这个工具时，必须传入：
    // { query: string }
    schema: z.object({
      query: z.string().min(1).describe("用户想查询的 Vue3 面试问题"),
    }),
  },
);

const calculateStudyHours = tool(
  async ({ days, hoursPerDay }) => {
    const totalHours = days * hoursPerDay;
    return `总学习时间是 ${totalHours} 小时。`;
  },
  {
    name: "calculate_study_hours",
    description:
      "Calculate total study hours from number of days and hours per day. Use this when the user asks about study time calculation.",
    schema: z.object({
      days: z.number().describe("Number of study days."),
      hoursPerDay: z.number().describe("Study hours per day."),
    }),
  }
);

/**
 * 当前所有可用工具列表。
 *
 * 后面会把这个列表绑定到模型：
 *   const modelWithTools = model.bindTools(tools)
 *
 * 绑定之后，模型才具备“可以主动调用工具”的能力。
 */
const tools: StructuredToolInterface[] = [
  searchVueInterviewKnowledge,
  calculateStudyHours,
];

/**
 * 建一个 name -> tool 的映射表。
 *
 * 原因：
 * 模型发起工具调用时，只会告诉我们：
 * - 要调用哪个工具名
 * - 参数是什么
 *
 * 所以代码侧需要根据工具名，把真正的工具实例找出来再执行。
 */
const toolsByName: Map<string, StructuredToolInterface> = new Map(
  tools.map((item) => [item.name, item] as const),
);

/**
 * 从命令行参数中读取用户问题。
 *
 * 这样就可以直接这样运行：
 * npm run dev:google -- "请解释 Vue3 的 ref 和 reactive"
 *
 * 如果没有传问题，就给一个默认问题，方便演示。
 */
function getUserQuestion() {
  const question = process.argv.slice(2).join(" ").trim();

  return (
    question ||
    "请解释 Vue3 为什么使用 Proxy 实现响应式，并整理成一段面试回答。"
  );
}

/**
 * 把模型输出 / 工具输出统一格式化成字符串。
 *
 * 因为 LangChain 返回的 content 不一定永远是 string：
 * - 有时是字符串
 * - 有时是数组
 * - 有时是带 text 字段的内容块
 *
 * 为了方便打印日志、构造成 ToolMessage，这里统一做一次兜底转换。
 */
function stringifyContent(content: unknown): string {
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

        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }

  return JSON.stringify(content, null, 2);
}

/**
 * 把模型返回的 AIMessageChunk 整理成标准 AIMessage。
 *
 * 为什么要多做这一步？
 * 因为 bindTools(...) 之后，模型返回的对象类型可能偏向 chunk 结构。
 * 为了后面统一读取：
 * - content
 * - tool_calls
 * - metadata
 *
 * 这里主动包成 AIMessage，后续逻辑会更直观。
 */
function normalizeAIMessage(message: AIMessageChunk): AIMessage {
  return new AIMessage({
    id: message.id,
    name: message.name,
    content: message.content,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    usage_metadata: message.usage_metadata,
  });
}

/**
 * 把工具执行结果整理成 ToolMessage。
 *
 * 这一步很关键，因为在 Agent 流程里：
 * 工具执行后的结果，不是“偷偷传给模型”，
 * 而是作为一条正式的 ToolMessage 放回 messages 上下文里。
 *
 * 下一轮模型就能看到：
 * “刚才我调用的工具已经执行完了，返回内容如下……”
 */
function normalizeToolMessage(
  toolCall: ToolCall,
  toolName: string,
  result: unknown,
): ToolMessage {
  if (ToolMessage.isInstance(result)) {
    return result;
  }

  return new ToolMessage({
    content: stringifyContent(result),
    tool_call_id: toolCall.id ?? `${toolName}-call`,
    name: toolName,
    status: "success",
  });
}

/**
 * 打印模型本轮返回的关键信息，方便学习 Agent 的执行过程。
 *
 * 重点观察四部分：
 * 1. content：模型当前输出的内容
 * 2. tool_calls：模型计划调用哪些工具
 * 3. usage_metadata：token 使用情况
 * 4. response_metadata：模型返回的其他元信息
 */
function logAIMessage(aiMessage: AIMessage, step: number) {
  console.log(`\n===== 第 ${step + 1} 轮 AIMessage =====`);
  console.log("content:");
  console.log(stringifyContent(aiMessage.content));

  console.log("\ntool_calls:");
  console.log(
    aiMessage.tool_calls?.length
      ? JSON.stringify(aiMessage.tool_calls, null, 2)
      : "无",
  );

  console.log("\nusage_metadata:");
  console.log(
    aiMessage.usage_metadata
      ? JSON.stringify(aiMessage.usage_metadata, null, 2)
      : "无",
  );

  console.log("\nresponse_metadata:");
  console.log(
    aiMessage.response_metadata
      ? JSON.stringify(aiMessage.response_metadata, null, 2)
      : "无",
  );

  console.log("===== AIMessage 结束 =====\n");
}

/**
 * 运行最小 Agent 的核心函数。
 *
 * 这段逻辑体现了 Agent 和普通模型调用的根本差别：
 *
 * 普通聊天模型：
 *   用户问题 -> 模型直接回答
 *
 * Agent：
 *   用户问题 -> 模型先判断要不要调用工具
 *           -> 如果需要，就执行工具
 *           -> 把工具结果再喂回模型
 *           -> 模型基于工具结果输出最终答案
 */
async function runAgent(question: string) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const modelName = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
  const proxyURL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;

  if (!apiKey) {
    throw new Error("缺少 GOOGLE_API_KEY，请先在 .env 中配置。");
  }

  if (proxyURL) {
    setGlobalDispatcher(new ProxyAgent(proxyURL));
  }

  console.log("开始运行最小 Agent...");
  console.log(`模型: ${modelName}`);
  console.log(`代理: ${proxyURL ?? "未配置"}`);
  console.log(`知识库: ${VUE_KNOWLEDGE_PATH}`);
  console.log(`问题: ${question}`);

  /**
   * 创建 Gemini 聊天模型。
   *
   * 到这里为止，它还只是一个“普通模型实例”，
   * 还没有被赋予工具调用能力。
   */
  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 1,
  });

  /**
   * 给模型绑定工具。
   *
   * 一旦绑定完成，模型的输出里就可能出现 tool_calls。
   * 这表示模型不是想立刻回答，而是想先借助某个工具拿资料。
   */
  const modelWithTools = model.bindTools(tools);

  /**
   * messages 是整个 Agent 的“上下文记忆”。
   *
   * 初始时放两类消息：
   * 1. SystemMessage：规则、角色、回答要求
   * 2. HumanMessage：用户问题
   *
   * 后面随着执行过程推进，还会继续往里追加：
   * 3. AIMessage：模型本轮输出
   * 4. ToolMessage：工具返回结果
   */
  const messages: BaseMessage[] = [
    new SystemMessage(
      [
        "你是一个 Vue3 前端面试助手。",
        `当问题和 Vue3 面试相关时，优先调用工具 ${searchVueInterviewKnowledge.name} 读取本地知识库。`,
        `当用户让你计算学习计划、学习天数、每天学习时长或总学习时长时，优先调用工具 ${calculateStudyHours.name} 进行计算。`,
        "回答时直接给出一段适合面试复述的答案。一句话即可,回答的时候要事先说明回答基于本地的xxx知识库还是基于你自己的",
        "如果知识库没有明确内容，就直接说明“知识库未覆盖”，不要编造。",
        "请明确告诉用户：本地知识库没有覆盖这个问题。",
        "然后你可以基于你自己的通用知识继续回答，但要标注“以下内容来自模型通用知识”,并且回答只需要一句话即可，简单一些",
      ].join("\n"),
    ),
    new HumanMessage(question),
  ];

  /**
   * 最小版 Agent 主循环。
   *
   * 每一轮都做这几件事：
   * 1. 把当前所有消息发给模型
   * 2. 看模型是否要求调用工具
   * 3. 如果要调工具，就执行工具
   * 4. 把工具结果再追加回消息列表
   * 5. 再让模型继续下一轮推理
   *
   * 为什么最多只循环 3 次？
   * 因为如果提示词写得不严谨，模型可能会反复调工具，
   * 所以这里做一个安全上限，避免死循环。
   */
  for (let step = 0; step < 3; step += 1) {
    // 把完整上下文交给模型。
    const rawAIMessage = await modelWithTools.invoke(messages);

    // 归一化成标准 AIMessage，方便统一处理。
    const aiMessage = normalizeAIMessage(rawAIMessage);

    // 打印模型本轮的完整关键信息，便于观察 Agent 的内部执行过程。
    // logAIMessage(aiMessage, step);

    // 把模型本轮输出追加回上下文。
    // 这样如果后面还要继续调用工具，模型就能“记住自己刚刚说了什么”。
    messages.push(aiMessage);

    // 如果本轮没有 tool_calls，说明模型已经准备直接作答了。
    // 这时就把回答内容返回，结束整个 Agent 流程。
    if (!aiMessage.tool_calls?.length) {
      return stringifyContent(aiMessage.content);
    }

    // 如果出现 tool_calls，说明模型希望我们代为执行工具。
    for (const toolCall of aiMessage.tool_calls) {
      console.log(`第 ${step + 1} 轮调用工具: ${toolCall.name}`);

      // 根据模型给出的工具名，找到真正的工具实例。
      const selectedTool = toolsByName.get(toolCall.name);

      if (!selectedTool) {
        // 理论上不太应该发生，但为了健壮性保留。
        // 如果模型调用了一个不存在的工具，就给它回一条错误 ToolMessage。
        messages.push(
          new ToolMessage({
            content: `未找到工具：${toolCall.name}`,
            tool_call_id: toolCall.id ?? `${toolCall.name}-missing`,
            name: toolCall.name,
            status: "error",
          }),
        );
        continue;
      }

      /**
       * 真正执行工具。
       *
       * 这里 selectedTool.invoke(toolCall) 很方便：
       * 它会自动读取 toolCall.args，
       * 然后把参数传给前面 tool(...) 里定义的函数。
       *
       * 例如模型发出：
       * {
       *   name: "read_vue3_md_knowledge",
       *   args: { query: "什么是 ref" }
       * }
       *
       * 这里就会自动执行对应的工具函数。
       */
      const toolResult = await selectedTool.invoke(toolCall);

      // 把工具结果变成 ToolMessage，再放回上下文，
      // 供模型下一轮基于“已检索到的资料”继续回答。
      messages.push(
        normalizeToolMessage(toolCall, selectedTool.name, toolResult),
      );
      // console.log("toolResult", toolResult.content);
    }
  }

  // 超过最大轮数还没有结束，通常意味着提示词或工具设计有问题。
  throw new Error("Agent 超过最大工具调用轮数，请检查提示词或工具设计。");
}

/**
 * 程序入口。
 *
 * 做三件事：
 * 1. 读取用户问题
 * 2. 运行 Agent
 * 3. 打印最终答案
 */
async function main() {
  const question = getUserQuestion();
  const answer = await runAgent(question);

  console.log("\n最终答案：");
  console.log(answer);
}

// 统一兜底错误处理，避免程序直接异常退出但没有可读提示。
main().catch((error) => {
  console.error("运行失败：", error);
});
