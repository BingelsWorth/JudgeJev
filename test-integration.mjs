#!/usr/bin/env node
// Integration test against a real, locally reachable vLLM endpoint.
// Run with: npx tsx --env-file=.env test-integration.mjs

import { buildJevGraph } from "./src/graph/jev-graph.js";
import { buildModel, configFromRoute } from "./src/providers/factory.js";
import { MemoryCredentialStore } from "./src/credentials.js";
import { callJevJudge } from "./src/jev-client.js";
import { GENERIC_CODING_RUBRIC } from "./src/contracts.js";
import { parseModelConfigsEnv, routeUpstreamModel } from "./src/providers/router.js";

// Same MODEL_CONFIGS array format the app itself reads from the environment
// (see .env / env.template). Falls back to this example registration - a real,
// locally reachable, unauthenticated vLLM box - when MODEL_CONFIGS isn't set.
const DEFAULT_ROUTE = {
  name: "local-qwen",
  provider: "openai",
  model: "Qwen/Qwen3-1.7B",
  endpoint: "http://192.168.2.106:8000/v1",
  apiKey: "unauthenticated",
  fanout: { fast: 1 },
};

const [route] = parseModelConfigsEnv(process.env.MODEL_CONFIGS).length
  ? parseModelConfigsEnv(process.env.MODEL_CONFIGS)
  : [DEFAULT_ROUTE];

// Jev is TypeSafe's decision model (docs.typesafe.ai) at a fixed public endpoint -
// there's no stand-in for it at the vLLM box above, and nothing to configure besides
// the API key, which is what actually gates this step.
const JEV_API_KEY = process.env.JEV_API_KEY;

async function testSingleRequest() {
  const upstreamModel = routeUpstreamModel(route);
  console.log(`Testing single request to ${route.endpoint} (${upstreamModel})...`);

  const model = await buildModel(configFromRoute(route), new MemoryCredentialStore());
  console.log(`  Model created: ${model.provider}/${model.id}`);

  const result = await model.complete({
    model: upstreamModel,
    messages: [{ role: "user", content: "Say hello in one word" }],
    temperature: 0,
    max_tokens: 300,
  });

  console.log("✓ Single request works");
  console.log(`  Response: ${result.content}`);
  console.log(`  Usage: ${JSON.stringify(result.usage)}`);
  return result;
}

async function testFanout() {
  console.log(`\nTesting 5x fanout to ${route.endpoint}...`);

  const routes = [{ ...route, fanout: { fast: 5 } }];

  const graph = buildJevGraph({
    modelFactory: async (r) => buildModel(configFromRoute(r), new MemoryCredentialStore()),
  });

  const state = {
    request: JSON.stringify({
      requestId: crypto.randomUUID(),
      endpoint: "chat/completions",
      protocol: "openai_chat_completions",
      model: "fast",
      stream: false,
      messages: [{ role: "user", content: "Count to 3" }],
      temperature: 0,
      max_tokens: 300,
    }),
    models: ["fast"],
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

async function testJevJudging() {
  if (!JEV_API_KEY) {
    console.log("\nSkipping Jev judging test: JEV_API_KEY is not set.");
    return;
  }

  console.log("\nTesting Jev judging (https://api.typesafe.ai/v1/systemone)...");

  const requestId = crypto.randomUUID();
  const downstreamRequest = {
    requestId,
    endpoint: "chat/completions",
    protocol: "openai_chat_completions",
    model: "gpt-4o",
    stream: false,
    messages: [{ role: "user", content: "Write a one-line TypeScript function that adds two numbers." }],
  };

  const candidates = [
    {
      requestId,
      id: "candidate-a",
      endpoint: "chat/completions",
      protocol: "openai_chat_completions",
      status: "succeeded",
      model: { logicalModel: "gpt-4o", upstreamModel: "gpt-4o", provider: "openai" },
      response: { id: "chatcmpl-a", object: "chat.completion", created: 0, model: "gpt-4o", choices: [] },
      content: "const add = (a, b) => a + b;",
      finishReason: "stop",
    },
    {
      requestId,
      id: "candidate-b",
      endpoint: "chat/completions",
      protocol: "openai_chat_completions",
      status: "succeeded",
      model: { logicalModel: "gpt-4o", upstreamModel: "gpt-4o", provider: "openai" },
      response: { id: "chatcmpl-b", object: "chat.completion", created: 0, model: "gpt-4o", choices: [] },
      content: "function add(a: number, b: number): number { return a + b; }",
      finishReason: "stop",
    },
  ];

  const jevRequest = {
    requestId,
    endpoint: "chat/completions",
    request: downstreamRequest,
    attempts: candidates,
    candidates,
    rubric: GENERIC_CODING_RUBRIC,
  };

  const result = await callJevJudge(jevRequest, { apiKey: JEV_API_KEY });

  if (!result.ok) {
    throw new Error(`Jev judging failed: ${result.error.code} - ${result.error.message}`);
  }

  console.log("✓ Jev judging works");
  console.log(`  Winner: ${result.response.winnerCandidateId}`);
  if (result.response.notes?.length) {
    console.log(`  Notes: ${result.response.notes.join("; ")}`);
  }
  return result;
}

async function main() {
  try {
    await testSingleRequest();
    await testFanout();
    await testJevJudging();
    console.log("\n✓ All integration tests passed!");
  } catch (err) {
    console.error("\n✗ Integration test failed:", err.message);
    if (err.cause) console.error("  Cause:", err.cause);
    process.exit(1);
  }
}

main();
