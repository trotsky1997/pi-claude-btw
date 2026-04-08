import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { SideQuestionResult } from "./side-question-runner.js";

type BtwOverlayOptions = {
  question: string;
  onCancel: () => void;
  onDismiss: () => void;
  onSendToMain: (answer: string) => void;
};

const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const MAX_BODY_LINES = 16;

function formatUsage(result: SideQuestionResult): string {
  const parts: string[] = [];
  if (result.usage.input) parts.push(`in ${result.usage.input}`);
  if (result.usage.output) parts.push(`out ${result.usage.output}`);
  if (result.usage.cacheRead) parts.push(`cacheR ${result.usage.cacheRead}`);
  if (result.usage.cacheWrite) parts.push(`cacheW ${result.usage.cacheWrite}`);
  if (result.usage.totalTokens) parts.push(`total ${result.usage.totalTokens}`);
  if (result.model) parts.push(result.model);
  return parts.join(" | ");
}

export class BtwOverlay {
  readonly focused = true;

  private frame = 0;
  private running = true;
  private answer = "";
  private error = "";
  private usage = "";
  private sentToMain = false;
  private scrollOffset = 0;
  private cachedLines: string[] | undefined;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: BtwOverlayOptions,
  ) {
    this.timer = setInterval(() => {
      if (!this.running || this.disposed) return;
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.refresh();
    }, 90);
  }

  setAnswer(text: string): void {
    if (this.disposed) return;
    this.answer = text;
    this.refresh();
  }

  setError(text: string): void {
    if (this.disposed) return;
    this.error = text.trim();
    this.running = false;
    this.refresh();
  }

  finish(result: SideQuestionResult): void {
    if (this.disposed) return;
    this.running = false;
    this.answer = result.answer ?? this.answer;
    this.usage = formatUsage(result);

    if (!this.answer && result.aborted) {
      this.error = "Cancelled.";
    } else if (!this.answer && (result.errorMessage || result.stderr)) {
      this.error = (result.errorMessage || result.stderr || "No answer received.").trim();
    } else if (!this.answer) {
      this.error = "No answer received.";
    }

    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      if (this.running) this.options.onCancel();
      else this.options.onDismiss();
      return;
    }

    if (!this.running && !this.error && this.answer && !this.sentToMain && data.toLowerCase() === "s") {
      this.sentToMain = true;
      this.options.onSendToMain(this.answer);
      this.refresh();
      return;
    }

    if (!this.running && (matchesKey(data, Key.enter) || matchesKey(data, " "))) {
      this.options.onDismiss();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;

    const boxWidth = Math.min(Math.max(62, width - 4), 92);
    const innerWidth = boxWidth - 4;
    const lines: string[] = [];
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const row = (text = "") => `| ${pad(truncateToWidth(text, innerWidth, "...", false))} |`;

    const title = this.theme.fg("accent", "/btw") + this.theme.fg("dim", this.running ? "  side question running" : "  side question done");
    const status = this.running
      ? `${this.theme.fg("warning", SPINNER_FRAMES[this.frame]!)} ${this.theme.fg("warning", "Answering...")}`
      : this.error
        ? this.theme.fg("error", "Finished with an error")
        : this.theme.fg("success", "Answer ready");

    lines.push(`+${"-".repeat(boxWidth - 2)}+`);
    lines.push(row(title));
    lines.push(row(status));
    lines.push(row());

    for (const questionLine of wrapTextWithAnsi(`${this.theme.fg("dim", "Question:")} ${this.options.question}`, innerWidth)) {
      lines.push(row(questionLine));
    }

    lines.push(row());

    const bodySource = this.error
      ? this.theme.fg("error", this.error)
      : this.answer
        ? this.answer
        : this.theme.fg("dim", "Waiting for the side-question worker to answer...");

    const wrappedBody = bodySource
      .split(/\r?\n/)
      .flatMap((part: string) => wrapTextWithAnsi(part || " ", innerWidth));
    const maxOffset = Math.max(0, wrappedBody.length - MAX_BODY_LINES);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const visibleBody = wrappedBody.slice(this.scrollOffset, this.scrollOffset + MAX_BODY_LINES);

    if (visibleBody.length === 0) {
      lines.push(row());
    } else {
      for (const bodyLine of visibleBody) lines.push(row(bodyLine));
    }

    const remaining = MAX_BODY_LINES - visibleBody.length;
    for (let index = 0; index < remaining; index += 1) lines.push(row());

    if (wrappedBody.length > MAX_BODY_LINES) {
      lines.push(row(this.theme.fg("dim", `Scroll ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + MAX_BODY_LINES, wrappedBody.length)} of ${wrappedBody.length}`)));
    }

    if (this.usage) {
      lines.push(row(this.theme.fg("dim", this.usage)));
    }

    if (this.sentToMain) {
      lines.push(row(this.theme.fg("success", "Sent to the main session as a follow-up.")));
    }

    lines.push(row());
    lines.push(
      row(
        this.theme.fg(
          "dim",
          this.running
            ? "Esc cancels and closes. Up/Down scroll if output has started."
            : this.error || !this.answer
              ? "Enter, Space, or Esc dismisses. Up/Down scroll long answers."
              : this.sentToMain
                ? "Enter, Space, or Esc dismisses. Up/Down scroll long answers."
                : "Press S to send to main session. Enter, Space, or Esc dismisses.",
        ),
      ),
    );
    lines.push(`+${"-".repeat(boxWidth - 2)}+`);

    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  private refresh(): void {
    this.cachedLines = undefined;
    this.tui.requestRender();
  }
}
