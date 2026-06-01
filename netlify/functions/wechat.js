/**
 * 企业微信机器人 - Netlify Function
 * URL: https://xxx.netlify.app/.netlify/functions/wechat
 */
const crypto = require("crypto");

// ========== 配置 ==========
const CONFIG = {
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  token: process.env.WECHAT_TOKEN,
  encodingAESKey: process.env.WECHAT_ENCODING_AES_KEY,
  corpId: process.env.WECHAT_CORP_ID,
};

// ========== 系统提示词 ==========
const SYSTEM_PROMPT = `你是一个友好的 AI 助手，通过企业微信与用户聊天。回答要简洁、有帮助。用中文回复。`;

// ========== 简单对话记忆（函数实例存活期间有效）==========
const conversations = new Map();
const MAX_HISTORY = 20;

// ========== DeepSeek API ==========
async function deepseekChat(messages) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.7,
      max_tokens: 2000,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  const json = await res.json();
  return json.choices[0].message.content;
}

// ========== 企业微信加解密 ==========
function sha1Sign(token, timestamp, nonce, encrypt) {
  const sorted = [token, timestamp, nonce, encrypt].sort().join("");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

function decryptMsg(encryptedXml, token, encodingAESKey, corpId) {
  const encryptMatch = encryptedXml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
  if (!encryptMatch) throw new Error("Missing Encrypt field");
  const encrypted = encryptMatch[1];

  const aesKey = Buffer.from(encodingAESKey + "=", "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);

  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - pad);

  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
  const corpIdFromMsg = decrypted.subarray(20 + msgLen).toString("utf8");

  if (corpIdFromMsg !== corpId) throw new Error("CorpId mismatch");
  return msg;
}

function encryptMsg(replyXml, token, encodingAESKey, corpId) {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(replyXml, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  let plain = Buffer.concat([random, lenBuf, msgBuf, Buffer.from(corpId, "utf8")]);

  const blockSize = 32;
  const padLen = blockSize - (plain.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  plain = Buffer.concat([plain, pad]);

  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).substring(2, 18);
  const signature = sha1Sign(token, timestamp, nonce, encrypted);

  return `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}

function verifySignature(token, timestamp, nonce, encrypted, signature) {
  return sha1Sign(token, timestamp, nonce, encrypted) === signature;
}

function decryptEchoStr(echostr, encodingAESKey, corpId) {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(echostr, "base64"), decipher.final()]);
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - pad);
  const msgLen = decrypted.readUInt32BE(16);
  return decrypted.subarray(20, 20 + msgLen).toString("utf8");
}

function parseXml(xml) {
  const result = {};
  const tags = ["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "AgentID", "Event", "EventKey"];
  for (const tag of tags) {
    const m1 = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
    if (m1) { result[tag] = m1[1]; continue; }
    const m2 = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    if (m2) result[tag] = m2[1];
  }
  return result;
}

function buildReplyXml(parsed, content) {
  const toUser = parsed.FromUserName || "";
  const fromUser = parsed.ToUserName || "";
  const createTime = Math.floor(Date.now() / 1000).toString();
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

// ========== Netlify Function Handler ==========
exports.handler = async (event) => {
  const { httpMethod, queryStringParameters, body: rawBody } = event;

  // 检查配置
  if (!CONFIG.token || !CONFIG.encodingAESKey || !CONFIG.corpId) {
    return { statusCode: 500, body: "Missing WeChat config" };
  }

  // ===== GET: URL 验证 =====
  if (httpMethod === "GET") {
    const { msg_signature, timestamp, nonce, echostr } = queryStringParameters || {};
    if (!msg_signature || !timestamp || !nonce || !echostr) {
      return { statusCode: 400, body: "Missing parameters" };
    }
    try {
      if (!verifySignature(CONFIG.token, timestamp, nonce, echostr, msg_signature)) {
        return { statusCode: 403, body: "Invalid signature" };
      }
      const plain = decryptEchoStr(echostr, CONFIG.encodingAESKey, CONFIG.corpId);
      return { statusCode: 200, body: plain };
    } catch (err) {
      console.error("URL verify error:", err.message);
      return { statusCode: 500, body: err.message };
    }
  }

  // ===== POST: 接收消息 =====
  if (httpMethod === "POST") {
    const { msg_signature, timestamp, nonce } = queryStringParameters || {};
    if (!msg_signature || !timestamp || !nonce) {
      return { statusCode: 400, body: "Missing signature" };
    }

    try {
      const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
      const encrypted = encryptMatch?.[1] || "";

      if (!verifySignature(CONFIG.token, timestamp, nonce, encrypted, msg_signature)) {
        return { statusCode: 403, body: "Invalid signature" };
      }

      const plainXml = decryptMsg(rawBody, CONFIG.token, CONFIG.encodingAESKey, CONFIG.corpId);
      console.log("Message:", plainXml);

      const parsed = parseXml(plainXml);
      let replyContent = "我目前只能处理文字消息～";

      if (parsed.MsgType === "text" && parsed.Content) {
        const userId = parsed.FromUserName;
        let history = conversations.get(userId) || [{ role: "system", content: SYSTEM_PROMPT }];
        history.push({ role: "user", content: parsed.Content });

        try {
          replyContent = await deepseekChat(history);
          history.push({ role: "assistant", content: replyContent });
          if (history.length > MAX_HISTORY + 1) {
            history = [history[0], ...history.slice(-MAX_HISTORY)];
          }
          conversations.set(userId, history);
        } catch (err) {
          console.error("DeepSeek error:", err.message);
          replyContent = `抱歉，AI 服务暂时不可用：${err.message}`;
        }
      }

      const replyXml = buildReplyXml(parsed, replyContent);
      const encryptedReply = encryptMsg(replyXml, CONFIG.token, CONFIG.encodingAESKey, CONFIG.corpId);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
        body: encryptedReply,
      };
    } catch (err) {
      console.error("Message error:", err.message);
      return { statusCode: 500, body: err.message };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
