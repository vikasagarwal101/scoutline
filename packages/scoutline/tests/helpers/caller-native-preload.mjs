// Synthetic public protocol fixtures only; every other HTTP route refuses.
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

globalThis.fetch = async (url, init) => {
  const target = String(url), method = init?.method ?? "GET";
  let body, invalidBody = false;
  try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = {}; invalidBody = true; }
  if (body === null || typeof body !== "object" || Array.isArray(body)) { body = {}; invalidBody = true; }
  const profiles = {
    "https://openrouter.ai/api/v1/systemone": { "typesafe/jev-1.14": "typesafe/jev-1.14-20261014", "typesafe/jev-1.13": "typesafe/jev-1.13-20260917" },
    "https://api.typesafe.ai/v1/systemone": { "jev-1.13.0": "jev-1.13.0", "jev-1.14.0": "jev-1.14.0" },
  };
  const routeProfiles = Object.hasOwn(profiles, target) ? profiles[target] : undefined;
  const legacyDirectDefault = target === "https://api.typesafe.ai/v1/systemone" && method === "POST" && !invalidBody && !Object.hasOwn(body, "model");
  const requestedModel = legacyDirectDefault ? "jev-1.13.0" : Object.hasOwn(body, "model") ? body.model : undefined;
  const resolved = routeProfiles && typeof requestedModel === "string" && Object.hasOwn(routeProfiles, requestedModel) ? routeProfiles[requestedModel] : undefined;
  const knownTarget = routeProfiles || target === "https://api.tavily.com/search" || target === "https://api.tavily.com/extract";
  if (process.env.CALLER_DEMO_TRACE) {
    const authorization = new Headers(init?.headers).get("authorization");
    await appendFile(process.env.CALLER_DEMO_TRACE, JSON.stringify({ url: knownTarget ? target : "[unapproved]", method: method === "POST" ? method : "[unapproved]", requestedModel: resolved && !legacyDirectDefault ? body.model : undefined, resolvedModel: resolved, allowFallbacks: typeof body.provider?.allow_fallbacks === "boolean" ? body.provider.allow_fallbacks : undefined, authSha256: authorization === null ? null : createHash("sha256").update(authorization).digest("hex") }) + "\n");
  }
  if (method !== "POST" || invalidBody) throw new Error("Unexpected synthetic HTTP route: method or body");
  if (target === "https://api.tavily.com/search") return Response.json({results:[{url:"https://example.test/release",title:"Synthetic release",content:"Public release page"}]});
  if (target === "https://api.tavily.com/extract") return Response.json({results:(body.urls??[]).map(url=>({url,raw_content:"Example package version 1.2.3. License MIT. CSV export is supported."})),failed_results:[]});
  if (!resolved || (target === "https://openrouter.ai/api/v1/systemone" ? body.provider?.allow_fallbacks !== false : body.provider !== undefined)) throw new Error("Unexpected synthetic HTTP route: route or model");
  return Response.json({model:resolved,answers:Object.fromEntries(Object.keys(body.questions??{}).map(k=>[k,{type:"noul",noul:/[fc]$/.test(k)?0.01:0.99}])),usage:{input_tokens:2,output_tokens:1}});
};
