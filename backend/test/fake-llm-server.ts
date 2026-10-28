/**
 * Fake OpenAI-compatible chat-completions server (001 T5.1/T5.4).
 *
 * Lets us exercise the *real* adapter — SDK, HTTP, `parseModelJson` — without a
 * key, a network, or cost: the provider swap that ADR-0006 promises is only a
 * `baseUrl` change, so a local host is a legitimate second provider. Responses
 * are wrapped in a `<think>` block and markdown fences on purpose, because that
 * is what the live reasoning models actually send.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLlm {
  baseUrl: string;
  /** Bodies of every request the adapter sent, in order. */
  requests: Array<{
    model: string;
    authorization?: string;
    messages: Array<{ role: string; content: string }>;
    thinking?: { type?: string };
    max_completion_tokens?: number;
  }>;
  close(): Promise<void>;
}

/**
 * @param drafts one response per call; the last is repeated once exhausted.
 * @param opts.delayMs hold each response back (worker-deadline path).
 * @param opts.failAll reply 500 to every call (provider-outage path). Not
 *   "fail the first call": the OpenAI SDK retries transport errors itself, so a
 *   single failure never reaches the pipeline.
 */
export async function startFakeLlm(
  drafts: unknown[],
  opts: { failAll?: boolean; delayMs?: number } = {},
): Promise<FakeLlm> {
  const requests: FakeLlm["requests"] = [];
  let calls = 0;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end("{}");
        return;
      }
      const parsed = JSON.parse(body || "{}");
      requests.push({
        model: parsed.model,
        authorization: req.headers.authorization as string | undefined,
        messages: parsed.messages ?? [],
        thinking: parsed.thinking,
        max_completion_tokens: parsed.max_completion_tokens,
      });
      const index = calls;
      calls += 1;
      if (opts.failAll) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({ error: { message: "fake upstream failure" } }),
        );
        return;
      }
      const draft = drafts[Math.min(index, drafts.length - 1)];
      const content = `<think>fake reasoning</think>\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``;
      const reply = () =>
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: `fake-${index}`,
            object: "chat.completion",
            model: parsed.model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
          }),
        );
      if (opts.delayMs) setTimeout(reply, opts.delayMs).unref();
      else reply();
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
