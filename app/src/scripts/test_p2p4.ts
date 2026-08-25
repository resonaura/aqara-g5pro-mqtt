import { login, api } from "../aqara.js";
import crypto from "crypto";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);

// генерим клиентские ключи разными алгоритмами
const x25519 = crypto.generateKeyPairSync("x25519");
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const pubX = x25519.publicKey.export({ type: "spki", format: "der" }).toString("hex");
const pubEc = ec.publicKey.export({ type: "spki", format: "der" }).toString("hex");
const raw32 = crypto.randomBytes(32).toString("hex");

const variants: Array<[any, string]> = [
  [{ data: { did, publicKey: raw32 } }, "raw32"],
  [{ data: { did, publicKey: pubEc } }, "ec-spki"],
  [{ data: { did, publicKey: pubX } }, "x25519-spki"],
  [{ data: { did, clientPublicKey: raw32 } }, "clientPublicKey"],
  [{ data: { did, key: raw32, nonce: crypto.randomBytes(16).toString("hex") } }, "key+nonce"],
];
for (const [body, label] of variants) {
  try {
    const r = await api.post("/app/v1.0/lumi/devex/camera/p2p/sign", body);
    console.log(`[${label}] code=${r.data?.code}`, JSON.stringify(r.data?.result ?? "").slice(0, 300));
    if (r.data?.code === 0) break;
  } catch (e: any) { console.log(`[${label}] ERR ${e.message}`); }
}
