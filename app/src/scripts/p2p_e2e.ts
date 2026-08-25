// Проверяем варианты E2E-расшифровки видео-канала
import crypto from "crypto";

const appPriv = process.env.APP_PRIV!;
const devPub = process.env.DEV_PUB!;
const sample = Buffer.from(process.env.SAMPLE!, "hex");

// X25519 shared
const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e", "hex"), Buffer.from("032200", "hex"), Buffer.from(appPriv, "hex")]), format: "der", type: "pkcs8" });
const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(devPub, "hex")]), format: "der", type: "spki" });
const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
console.log("shared:", shared.toString("hex"));

const variants: Array<[string, () => Buffer]> = [
  ["ppcs(shared[:20])", () => { const m = require("child_process"); return Buffer.from(""); }],
];

// ppcs cipher in TS (same as python)
const TABLE = Buffer.from("7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a388ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af4237d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17", "hex");
function ppcsDecrypt(key: Buffer, data: Buffer): Buffer {
  if (!key.length || !data.length) return data;
  const k = key.subarray(0, 20);
  let total = 0, sx = 0, s3 = 0;
  for (const b of k) { total += b; sx ^= b; s3 += Math.floor((b * 0xab) / 512); }
  const s = [total & 0xff, (-total) & 0xff, s3 & 0xff, sx & 0xff];
  const out = Buffer.alloc(data.length);
  out[0] = TABLE[s[0]] ^ data[0];
  let fb = data[0];
  for (let i = 1; i < data.length; i++) { out[i] = TABLE[(s[fb & 3] + fb) & 0xff] ^ data[i]; fb = data[i]; }
  return out;
}

function tryName(name: string, buf: Buffer) {
  // H264 NAL starts 00 00 00 01 or contains 65/41 NAL types; check plausibility
  const starts = buf.subarray(0, 4).toString("hex");
  const hasNal = buf.includes(Buffer.from("00000001", "hex"));
  console.log(`[${name}] first=${starts} nal_marker=${hasNal} head=${buf.subarray(0, 16).toString("hex")}`);
}

tryName("raw", sample);
tryName("ppcs(shared)", ppcsDecrypt(shared, sample));
tryName("ppcs(shared[:20])", ppcsDecrypt(shared.subarray(0, 20), sample));
tryName("ppcs(sha256(shared))", ppcsDecrypt(crypto.createHash("sha256").update(shared).digest(), sample));
// AES-256-GCM with shared
try {
  const key = crypto.createHash("sha256").update(shared).digest();
  const iv = sample.subarray(0, 12);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(Buffer.alloc(16));
  tryName("aes-gcm(sha256(shared))", Buffer.concat([d.update(sample.subarray(12)), d.final()]));
} catch (e: any) { console.log("[aes-gcm] ERR", e.message); }
// AES-256-CBC zero iv
try {
  const key = crypto.createHash("sha256").update(shared).digest();
  const d = crypto.createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
  tryName("aes-cbc(sha256(shared))", Buffer.concat([d.update(sample), d.final()]));
} catch (e: any) { console.log("[aes-cbc] ERR", e.message.slice(0, 60)); }
