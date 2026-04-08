import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { BtwOverlay } from "./btw-overlay.js";
import { serializeBranchContext } from "./context-serialize.js";
import { runSideQuestion } from "./side-question-runner.js";

function buildErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a side question without interrupting the main conversation",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        console.error("Usage: /btw <question>");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        console.error("/btw requires interactive mode");
        return;
      }

      const serialized = serializeBranchContext(ctx.sessionManager.getBranch());
      const abortController = new AbortController();

      await ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb: unknown, done: () => void) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          done();
        };

        const overlay = new BtwOverlay(tui, theme, {
          question,
          onCancel: () => {
            abortController.abort();
            close();
          },
          onDismiss: close,
          onSendToMain: (answer: string) => {
            const followUp = [
              `Side question: ${question}`,
              "",
              answer,
            ].join("\n");
            pi.sendUserMessage(followUp, { deliverAs: "followUp" });
            ctx.ui.notify("Sent /btw result to the main session", "info");
          },
        });

        void runSideQuestion({
          cwd: ctx.cwd,
          question,
          transcript: serialized.transcript,
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          thinking: pi.getThinkingLevel(),
          signal: abortController.signal,
          onProgress: (progress) => {
            if (closed) return;
            if (progress.type === "delta") overlay.setAnswer(progress.text);
            if (progress.type === "status") overlay.setAnswer("");
          },
        })
          .then((result) => {
            if (closed) return;
            overlay.finish(result);
          })
          .catch((error) => {
            if (closed) return;
            overlay.setError(buildErrorMessage(error));
          });

        return overlay;
      }, { overlay: true });
    },
  });
}
