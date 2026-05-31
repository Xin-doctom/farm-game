/**
 * 企业微信机器人 Webhook
 *
 * GET  → URL 验证
 * POST → 接收消息 → DeepSeek → 回复
 */
import { NextRequest, NextResponse } from "next/server";
import { chat, ChatMessage } from "@/lib/deepseek";
import {
  decryptMsg,
  encryptMsg,
  verifySignature,
  decryptEchoStr,
} from "@/lib/wechat/crypto";

// === 配置从环境变量读取 ===
function getConfig() {
  const token = process.env.WECHAT_TOKEN;
  const encodingAESKey = process.env.WECHAT_ENCODING_AES_KEY;
  const corpId = process.env.WECHAT_CORP_ID;

  if (!token || !encodingAESKey || !corpId) {
    throw new Error("Missing WeChat config: WECHAT_TOKEN, WECHAT_ENCODING_AES_KEY, WECHAT_CORP_ID");
  }

  return { token, encodingAESKey, corpId };
}

// === 简单的对话历史（服务端内存，重启丢失）===
const conversations = new Map<string, ChatMessage[]>();
const MAX_HISTORY = 20; // 最多保留 20 条对话

// === 系统提示词 ===
const SYSTEM_PROMPT = `你是一个友好的 AI 助手，通过企业微信与用户聊天。回答要简洁、有帮助。用中文回复。`;

// ============================================================
// GET - URL 验证
// ============================================================
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");
  const echostr = url.searchParams.get("echostr");

  if (!msgSignature || !timestamp || !nonce || !echostr) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  try {
    const { token, encodingAESKey, corpId } = getConfig();

    // 验证签名
    if (!verifySignature(token, timestamp, nonce, echostr, msgSignature)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    // 解密 echostr
    const plain = decryptEchoStr(echostr, token, encodingAESKey, corpId);

    return new NextResponse(plain, {
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err: any) {
    console.error("URL verification failed:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ============================================================
// POST - 接收消息
// ============================================================
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");

  if (!msgSignature || !timestamp || !nonce) {
    return NextResponse.json({ error: "Missing signature params" }, { status: 400 });
  }

  try {
    const { token, encodingAESKey, corpId } = getConfig();
    const rawBody = await req.text();

    // 从 XML 中提取 Encrypt 字段用于签名验证
    const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
    const encrypted = encryptMatch?.[1] ?? "";

    // 验证签名
    if (!verifySignature(token, timestamp, nonce, encrypted, msgSignature)) {
      console.error("Signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    // 解密消息
    const plainXml = decryptMsg(rawBody, token, encodingAESKey, corpId);
    console.log("Decrypted message:", plainXml);

    // 解析明文 XML
    const parsed = parseXml(plainXml);

    // 只处理文本消息
    if (parsed.MsgType === "text" && parsed.Content) {
      const userId = parsed.FromUserName;
      const userMsg = parsed.Content;

      // 获取或创建对话历史
      let history = conversations.get(userId) || [
        { role: "system", content: SYSTEM_PROMPT },
      ];

      // 添加用户消息
      history.push({ role: "user", content: userMsg });

      // 调用 DeepSeek
      let reply: string;
      try {
        reply = await chat(history);

        // 保存对话历史
        history.push({ role: "assistant", content: reply });
        if (history.length > MAX_HISTORY + 1) {
          // 保留 system prompt + 最近的消息
          history = [history[0], ...history.slice(-MAX_HISTORY)];
        }
        conversations.set(userId, history);
      } catch (err: any) {
        console.error("DeepSeek API error:", err.message);
        reply = `抱歉，AI 服务暂时不可用：${err.message}`;
      }

      // 构建回复 XML
      const replyXml = buildReplyXml(parsed, reply);

      // 加密回复
      const encryptedReply = encryptMsg(replyXml, token, encodingAESKey, corpId);

      return new NextResponse(encryptedReply, {
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }

    // 非文本消息 → 回复帮助提示
    const replyXml = buildReplyXml(parsed, "我目前只能处理文字消息，请直接发送文字～");
    const encryptedReply = encryptMsg(replyXml, token, encodingAESKey, corpId);
    return new NextResponse(encryptedReply, {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  } catch (err: any) {
    console.error("Message handling error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ============================================================
// 工具函数
// ============================================================

/** 简单 XML 解析（提取常见字段） */
function parseXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tags = [
    "ToUserName",
    "FromUserName",
    "CreateTime",
    "MsgType",
    "Content",
    "MsgId",
    "AgentID",
    "Event",
    "EventKey",
  ];
  for (const tag of tags) {
    const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
    if (match) {
      result[tag] = match[1];
    } else {
      const simpleMatch = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
      if (simpleMatch) result[tag] = simpleMatch[1];
    }
  }
  return result;
}

/** 构建回复 XML */
function buildReplyXml(
  parsed: Record<string, string>,
  content: string
): string {
  const toUser = parsed.FromUserName ?? "";
  const fromUser = parsed.ToUserName ?? "";
  const createTime = Math.floor(Date.now() / 1000).toString();

  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}
