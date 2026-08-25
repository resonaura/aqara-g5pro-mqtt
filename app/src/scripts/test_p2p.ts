import { login, api } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);

const variants: Array<[string, any]> = [
  ["/app/v1.0/lumi/devex/camera/p2p/info", { did }],
  ["/app/v1.0/lumi/devex/camera/p2p/info", { data: { did } }],
  ["/app/v1.0/lumi/devex/camera/p2p/info", { data: [{ did }] }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { did }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { did } }],
];
for (const [url, body] of variants) {
  try {
    const r = await api.post(url, body);
    console.log(`[${url.split("/").pop()} ${JSON.stringify(body)}] code=${r.data?.code} ${JSON.stringify(r.data?.result ?? "").slice(0, 400)}`);
  } catch (e: any) {
    console.log(`[${url.split("/").pop()} ${JSON.stringify(body)}] ERR ${e.message}`);
  }
}
