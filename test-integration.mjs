#!/usr/bin/env node
// Integration test against real vLLM endpoint
// Run with: npx tsx test-integration.mjs

import { buildJevGraph } from "./src/graph/jev-graph.js";
import { buildModel, configFromRoute } from "./src/providers/factory.js";
import { MemoryCredentialStore } from "./src/auth/credentials.js";
import { callJevJudge } from "./src/jev/client.js";
import { GENERIC_CODING_RUBRIC } from "./src/v1/contracts.js";

const VLLM_BASE_URL = process.env.OPENAI_BASE_URL || "http://192.168.2.106:8000/v1";
const VLLM_API_KEY = process.env.OPENAI_API_KEY || "dummy";
const JEV_API_ENDPOINT = process.env.JEV_API_ENDPOINT || VLLM_BASE_URL;
const JEV_MODEL = process.env.JEV_MODEL || "Qwen/Qwen3-1.7B";

const credentials = new MemoryCredentialStore();
await credentials.set("openai", VLLM_API_KEY);

const REAL_MODEL = process.env.VLLM_MODEL || "Qwen/Qwen3-1.7B";

async function testSingleRequest() {
  console.log(`Testing single request to ${VLLM_BASE_URL}...`);

  const model = await buildModel(
    { ...configFromRoute({
      logicalModel: "gpt-4o",
      provider: "openai",
      upstreamModel: REAL_MODEL,
      priority: 0,
      enabled: true,
    }, VLLM_API_KEY), baseUrl: VLLM_BASE_URL },
    new MemoryCredentialStore()
  );

  console.log(`  Model created: ${model.provider}/${model.id}`);

  // NOTE: this previously omitted `model` here entirely - JSON.stringify silently
  // drops an undefined field, so the request body never actually carried a model
  // name. It "worked" only because this vLLM box falls back to its one loaded
  // model when none is specified; against a real multi-model endpoint it would
  // have 404'd, same as testFanout did before this file matched its model name
  // to what's actually served here.
  const result = await model.complete({
    model: REAL_MODEL,
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
  console.log(`\nTesting 5x fanout to ${VLLM_BASE_URL}...`);

  // A single registration fanned out 5x for the "fast" logical model - this is what
  // was pre-existing here as `defaultModelRoutes(["gpt-4o"]).slice(0, 5)` with each
  // route's logicalModel renamed to `gpt-4o-${i}`, which never matched
  // `state.models: ["gpt-4o"]` below and silently resolved to 0 routes every run.
  // The upstream model must be the one this box actually serves (REAL_MODEL) -
  // "gpt-4o" was a placeholder name and gets a real 404 from vLLM, not a silent pass.
  const routes = [
    {
      name: "vllm-box",
      provider: "openai",
      model: REAL_MODEL,
      fanout: { fast: 5 },
    },
  ];

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
  console.log(`\nTesting Jev judging (${JEV_MODEL} @ ${JEV_API_ENDPOINT})...`);

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

  const result = await callJevJudge(jevRequest, {
    endpoint: JEV_API_ENDPOINT,
    model: JEV_MODEL,
    apiKey: process.env.JEV_API_KEY,
  });

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