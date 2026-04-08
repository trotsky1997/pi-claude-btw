import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SIDE_QUESTION_SYSTEM_PROMPT = [
  "You are answering a side question inside a coding session.",
  "The main conversation continues elsewhere and is not interrupted.",
  "Answer directly in one response using the supplied transcript and your own reasoning.",
  "Do not use tools, do not claim that you will inspect files later, and do not promise any action.",
  "If the transcript does not contain enough information, say that plainly.",
].join(" ");

export type SideQuestionUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type SideQuestionProgress =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "stderr"; text: string };

export type SideQuestionResult = {
  answer: string | null;
  exitCode: number;
  aborted: boolean;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  model?: string;
  usage: SideQuestionUsage;
};

export type RunSideQuestionParams = {
  cwd: string;
  question: string;
  transcript: string;
  model?: { provider: string; id: string };
  thinking?: string;
  signal?: AbortSignal;
  onProgress?: (progress: SideQuestionProgress) => void;
};

function createEmptyUsage(): SideQuestionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    })
    .join("\n")
    .trim();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptFile(question: string, transcript: string): Promise<{ dir: string; promptPath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-claude-btw-"));
  const promptPath = path.join(dir, "side-question.md");
  const content = [
    "# Current Branch Transcript",
    "",
    transcript || "(No branch transcript was available.)",
    "",
    "# Side Question",
    "",
    question,
  ].join("\n");
  await fs.promises.writeFile(promptPath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir, promptPath };
}

export async function runSideQuestion(params: RunSideQuestionParams): Promise<SideQuestionResult> {
  const usage = createEmptyUsage();
  const { dir, promptPath } = await writePromptFile(params.question, params.transcript);
  let stderr = "";
  let partialAnswer = "";
  let finalAnswer: string | null = null;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let model: string | undefined;
  let aborted = false;

  const args = [
    "--mode",
    "json",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--system-prompt",
    SIDE_QUESTION_SYSTEM_PROMPT,
  ];

  if (params.model) {
    args.push("--provider", params.model.provider, "--model", params.model.id);
  }

  if (params.thinking) {
    args.push("--thinking", params.thinking);
  }

  args.push(`@${promptPath}`);

  params.onProgress?.({ type: "status", text: "Spawning side-question worker..." });

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: params.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";

      const handleLine = (line: string) => {
        if (!line.trim()) return;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_update") {
          const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
            partialAnswer += assistantEvent.delta;
            params.onProgress?.({ type: "delta", text: partialAnswer });
          }
          return;
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          const message = event.message as {
            content?: unknown;
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
            stopReason?: string;
            errorMessage?: string;
            model?: string;
          };

          const text = extractText(message.content);
          if (text) {
            finalAnswer = text;
            partialAnswer = text;
            params.onProgress?.({ type: "delta", text: partialAnswer });
          }

          usage.input += message.usage?.input ?? 0;
          usage.output += message.usage?.output ?? 0;
          usage.cacheRead += message.usage?.cacheRead ?? 0;
          usage.cacheWrite += message.usage?.cacheWrite ?? 0;
          usage.totalTokens = message.usage?.totalTokens ?? usage.totalTokens;
          usage.cost += message.usage?.cost?.total ?? 0;
          stopReason = message.stopReason ?? stopReason;
          errorMessage = message.errorMessage ?? errorMessage;
          model = message.model ?? model;
          return;
        }
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        params.onProgress?.({ type: "stderr", text: stderr });
      });

      proc.on("close", (code: number | null) => {
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
        resolve(code ?? 0);
      });

      proc.on("error", (error: Error) => {
        stderr += `${error.message}\n`;
        resolve(1);
      });

      if (params.signal) {
        const killProc = () => {
          aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 2000);
        };

        if (params.signal.aborted) killProc();
        else params.signal.addEventListener("abort", killProc, { once: true });
      }
    });

    return {
      answer: finalAnswer ?? (partialAnswer.trim() || null),
      exitCode,
      aborted,
      stopReason,
      errorMessage,
      stderr: stderr.trim(),
      model,
      usage,
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
