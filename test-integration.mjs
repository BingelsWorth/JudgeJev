#!/usr/bin/env node
// Integration test against real vLLM endpoint
// Run with: npx tsx test-integration.mjs

import { buildJevGraph } from "./src/graph/jev-graph.js";
import { buildModel, configFromRoute } from "./src/providers/factory.js";
import { defaultModelRoutes } from "./src/providers/router.js";
import { MemoryCredentialStore } from "./src/auth/credentials.js";

const VLLM_BASE_URL = process.env.OPENAI_BASE_URL || "http://192.168.2.106:8000/v1";
const VLLM_API_KEY = process.env.OPENAI_API_KEY || "dummy";

const credentials = new MemoryCredentialStore();
await credentials.set("openai", VLLM_API_KEY);

async function testSingleRequest() {
  console.log(`Testing single request to ${VLLM_BASE_URL}...`);
  
  const model = await buildModel(
    { ...configFromRoute({
      logicalModel: "gpt-4o",
      provider: "openai",
      upstreamModel: "gpt-4o",
      priority: 0,
      enabled: true,
    }, VLLM_API_KEY), baseUrl: VLLM_BASE_URL },
    new MemoryCredentialStore()
  );

  console.log(`  Model created: ${model.provider}/${model.id}`);
  
  const result = await model.complete({
    messages: [{ role: "user", content: "Say hello in one word" }],
    temperature: 0,
    max_tokens: 10,
  });
  
  console.log("✓ Single request works");
  console.log(`  Response: ${result.content}`);
  console.log(`  Usage: ${JSON.stringify(result.usage)}`);
  return result;
}

async function testFanout() {
  console.log(`\nTesting 5x fanout to ${VLLM_BASE_URL}...`);
  
  const routes = defaultModelRoutes(["gpt-4o"]).slice(0, 5).map((r, i) => ({
    ...r,
    logicalModel: `gpt-4o-${i}`,
  }));

  const graph = buildJevGraph({
    modelFactory: async (route) => {
      return buildModel({ ...configFromRoute(route, VLLM_API_KEY), baseUrl: VLLM_BASE_URL }, new MemoryCredentialStore());
    },
  });

  const state = {
    request: JSON.stringify({
      requestId: crypto.randomUUID(),
      endpoint: "chat/completions",
      protocol: "openai_chat_completions",
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "Count to 3" }],
      temperature: 0,
      max_tokens: 20,
    }),
    models: ["gpt-4o"],
    modelConfigs: routes,
    workers: [],
    candidates: [],
    winner: null,
    judgeNotes: [],
    interventionCycles: 0,
  };

  const result = await graph.invoke(state, { configurable: { thread_id: crypto.randomUUID() } });
  
  console.log(`✓ Fanout complete: ${result.candidates.length} candidates, winner: ${result.winner ? "yes" : "no"}`);
  
  result.candidates.forEach((c, i) => {
    console.log(`  Candidate ${i}: ${c.provider}/${c.upstreamModel} - ${c.content?.slice(0, 50)}...`);
  });
  
  if (result.winner) {
    console.log(`  Winner: ${result.winner.provider}/${result.winner.upstreamModel}`);
  }
  
  return result;
}

async function main() {
  try {
    await testSingleRequest();
    await testFanout();
    console.log("\n✓ All integration tests passed!");
  } catch (err) {
    console.error("\n✗ Integration test failed:", err.message);
    if (err.cause) console.error("  Cause:", err.cause);
    process.exit(1);
  }
}

main();