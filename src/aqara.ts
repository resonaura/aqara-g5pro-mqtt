import axios from "axios";

const api = axios.create({
  baseURL: process.env.AQUARA_URL,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Sys-Type": "1",
    Appid: process.env.APPID!,
    Token: process.env.TOKEN!,
  },
});

export async function queryAttrs(attrs: string[], subjectId: string) {
  const res = await api.post("/app/v1.0/lumi/res/query", {
    data: [{ options: attrs, subjectId }],
  });
  return res.data;
}

export async function writeAttr(attr: string, value: any, subjectId: string) {
  const res = await api.post("/app/v1.0/lumi/res/write", {
    subjectId,
    data: { [attr]: value },
  });
  return res.data;
}
