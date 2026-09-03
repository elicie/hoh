/**
 * Minimal OpenAI-compatible chat-completions server for exercising the real
 * pi SDK tool loop offline. Each request is answered by a role script that
 * decides, from the conversation so far, whether to call a tool or finish.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
export type FakeStep = { tool: FakeToolCall } | { text: string };

export interface FakeRequestView {
  role: "planner" | "developer" | "tester" | "unknown";
  /** model id requested by the client */
  model: string;
  /** number of assistant messages already in the conversation */
  step: number;
  toolNames: string[];
  systemPrompt: string;
  lastToolResult: string | null;
  messages: any[];
}

export type FakeScript = (view: FakeRequestView) => FakeStep;

export interface FakeServer {
  baseUrl: string;
  requests: FakeRequestView[];
  close(): Promise<void>;
}

function detectRole(system: string): FakeRequestView["role"] {
  if (/You are the Project Planner/.test(system)) return "planner";
  if (/You are the Developer/.test(system)) return "developer";
  if (/You are the QA Tester/.test(system)) return "tester";
  return "unknown";
}

export async function startFakeOpenAI(script: FakeScript, opts: { models?: string[]; apiKey?: string } = {}): Promise<FakeServer> {
  const requests: FakeRequestView[] = [];
  const server = http.createServer((req, res) => {
    if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: (opts.models ?? ["fake-model"]).map((id) => ({ id, object: "model", owned_by: "fake" })) }));
      return;
    }
    if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url ?? "")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const payload = JSON.parse(body);
      const messages: any[] = payload.messages ?? [];
      const system = messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const step = messages.filter((m) => m.role === "assistant").length;
      const lastTool = [...messages].reverse().find((m) => m.role === "tool");
      const view: FakeRequestView = {
        role: detectRole(system),
        model: String(payload.model),
        step,
        toolNames: (payload.tools ?? []).map((t: any) => t.function?.name ?? t.name),
        systemPrompt: system,
        lastToolResult: lastTool ? (typeof lastTool.content === "string" ? lastTool.content : JSON.stringify(lastTool.content)) : null,
        messages,
      };
      requests.push(view);
      const out = script(view);
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      const chunk = (delta: any, finish: string | null, withUsage = false) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: payload.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(withUsage ? { usage } : {}),
        })}\n\n`;

      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(chunk({ role: "assistant", content: "" }, null));
        if ("tool" in out) {
          res.write(
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${step}_${Math.random().toString(16).slice(2, 8)}`,
                    type: "function",
                    function: { name: out.tool.name, arguments: JSON.stringify(out.tool.arguments) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(chunk({}, "tool_calls", true));
        } else {
          res.write(chunk({ content: out.text }, null));
          res.write(chunk({}, "stop", true));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const message =
          "tool" in out
            ? {
                role: "assistant",
                content: null,
                tool_calls: [{ id: `call_${step}`, type: "function", function: { name: out.tool.name, arguments: JSON.stringify(out.tool.arguments) } }],
              }
            : { role: "assistant", content: out.text };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: payload.model,
            choices: [{ index: 0, message, finish_reason: "tool" in out ? "tool_calls" : "stop" }],
            usage,
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
