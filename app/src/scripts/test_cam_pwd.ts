import { login, api } from "../aqara.js";
const did = process.env.DID!;
await login(process.env.AQARA_USER!, process.env.AQARA_PASS!);

const tries: Array<{ label: string; run: () => Promise<any> }> = [
  { label: "data:{did}", run: async () => (await api.post("/app/v1.0/lumi/devex/camera/pwd", { data: { did } })).data },
  { label: "deviceId", run: async () => (await api.post("/app/v1.0/lumi/devex/camera/pwd", { deviceId: did })).data },
  { label: "subjectId", run: async () => (await api.post("/app/v1.0/lumi/devex/camera/pwd", { subjectId: did })).data },
  { label: "data:[{subjectId}]", run: async () => (await api.post("/app/v1.0/lumi/devex/camera/pwd", { data: [{ subjectId: did }] })).data },
];
for (const t of tries) {
  try {
    const j = await t.run();
    console.log(`[${t.label}] code=${j?.code} ${j?.message}`, JSON.stringify(j?.result ?? "").slice(0, 300));
    if (j?.code === 0) break;
  } catch (e: any) { console.log(`[${t.label}] ERR ${e.message} ${JSON.stringify(e.response?.data ?? "").slice(0, 100)}`); }
}
