import { login, api } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);

const info = (await api.get("/app/v1.0/lumi/devex/camera/p2p/info", { params: { did } })).data.result;
console.log("p2pId:", info.p2pId);

const variants: Array<[string, any]> = [
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { did, uid: info.p2pId } }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { did, p2pId: info.p2pId } }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { did, type: 1 } }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { dids: [did] } }],
  ["/app/v1.0/lumi/devex/camera/p2p/sign", { data: { did, key: info.devP2pPublicKey } }],
];
for (const [url, body] of variants) {
  try {
    const r = await api.post(url, body);
    console.log(`[${JSON.stringify(body).slice(0,60)}] code=${r.data?.code}`, JSON.stringify(r.data?.result ?? "").slice(0, 300));
    if (r.data?.code === 0) break;
  } catch (e: any) { console.log(`ERR ${e.message}`); }
}
