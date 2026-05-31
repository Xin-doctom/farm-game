/**
 * 企业微信消息加解密工具
 *
 * 参考: https://developer.work.weixin.qq.com/document/path/90968
 */
import crypto from "crypto";

/**
 * 解密企业微信发来的消息
 *
 * @param encrypted 加密的 XML 字符串
 * @param token 应用 Token
 * @param encodingAESKey 43位 EncodingAESKey
 * @param corpId 企业 CorpID
 * @returns 解密后的明文 XML
 */
export function decryptMsg(
  encryptedXml: string,
  token: string,
  encodingAESKey: string,
  corpId: string
): string {
  // 1. 从 XML 中提取 Encrypt 字段
  const encryptMatch = encryptedXml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
  if (!encryptMatch) throw new Error("Invalid encrypted XML: missing Encrypt");
  const encrypted = encryptMatch[1];

  // 2. AES Key: Base64 decode 43-char key → 32 bytes
  const aesKey = Buffer.from(encodingAESKey + "=", "base64"); // 补 = 号

  // 3. AES-256-CBC 解密 (iv = aesKey 前 16 字节)
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([
    decipher.update(encrypted, "base64"),
    decipher.final(),
  ]);

  // 4. 去除 PKCS7 padding
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - pad);

  // 5. 解析: random(16) + msg_len(4) + msg + corpId
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
  const corpIdFromMsg = decrypted.subarray(20 + msgLen).toString("utf8");

  if (corpIdFromMsg !== corpId) {
    throw new Error(`CorpId mismatch: expected ${corpId}, got ${corpIdFromMsg}`);
  }

  return msg;
}

/**
 * 加密回复消息
 *
 * @param replyXml 明文回复 XML
 * @param token 应用 Token
 * @param encodingAESKey 43位 EncodingAESKey
 * @param corpId 企业 CorpID
 * @returns 加密后的 XML（可直接返回给企业微信）
 */
export function encryptMsg(
  replyXml: string,
  token: string,
  encodingAESKey: string,
  corpId: string
): string {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");

  // 1. 生成 16 字节随机数
  const random = crypto.randomBytes(16);

  // 2. 拼装: random(16) + msg_len(4) + msg + corpId
  const msgBuf = Buffer.from(replyXml, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  let plain = Buffer.concat([random, lenBuf, msgBuf, Buffer.from(corpId, "utf8")]);

  // 3. PKCS7 padding
  const blockSize = 32;
  const padLen = blockSize - (plain.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  plain = Buffer.concat([plain, pad]);

  // 4. AES-256-CBC 加密
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");

  // 5. 生成签名
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();
  const signature = sha1Sign(token, timestamp, nonce, encrypted);

  // 6. 包装成加密 XML
  return `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}

/**
 * 验证消息签名
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  signature: string
): boolean {
  const expected = sha1Sign(token, timestamp, nonce, encrypted);
  return expected === signature;
}

/**
 * SHA1 签名: sort(token, timestamp, nonce, encrypt) → sha1 → hex
 */
function sha1Sign(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string
): string {
  const sorted = [token, timestamp, nonce, encrypt].sort().join("");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

function generateNonce(): string {
  return Math.random().toString(36).substring(2, 18);
}

/**
 * URL 验证时解密 echostr
 */
export function decryptEchoStr(
  echostr: string,
  token: string,
  encodingAESKey: string,
  corpId: string
): string {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([
    decipher.update(echostr, "base64"),
    decipher.final(),
  ]);
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - pad);
  // random(16) + msg_len(4) + msg + corpId
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
  return msg;
}
