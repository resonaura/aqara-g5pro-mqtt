import { login, api } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);

async function get(url: string, params: any) {
  const r = await api.get(url, { params });
  return r.data;
}
async function post(url: string, body: any) {
  const r = await api.post(url, body);
  return r.data;
}

const tries: Array<{ label: string; run: () => Promise<any> }> = [
  { label: "GET info?did", run: () => get("/app/v1.0/lumi/devex/camera/p2p/info", { did }) },
  { label: "GET info?deviceId", run: () => get("/app/v1.0/lumi/devex/camera/p2p/info", { deviceId: did }) },
  { label: "GET sign?did", run: () => get("/app/v1.0/lumi/devex/camera/p2p/sign", { did }) },
  { label: "POST sign data:[{did}]", run: () => post("/app/v1.0/lumi/devex/camera/p2p/sign", { data: [{ did }] }) },
  { label: "POST info data:[{did}]", run: () => post("/app/v1.0/lumi/devex/camera/p2p/info", { data: [{ did }] }) },
];
for (const t of tries) {
  try {
    const j = await t.run();
    console.log(`[${t.label}] code=${j?.code} ${j?.message}`, JSON.stringify(j?.result ?? "").slice(0, 500));
  } catch (e: any) {
    console.log(`[${t.label}] ERR ${e.message} ${JSON.stringify(e.response?.data ?? "").slice(0, 80)}`);
  }
}
