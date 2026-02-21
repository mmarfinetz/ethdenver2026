"use client";

import { useEffect, useState } from "react";

export type CopyableTextProps = {
  fullValue: string;
  shortLabel: string;
  href?: string;
};

type CopyState = "idle" | "copied" | "error";

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("Copy command failed");
  }
}

export function CopyableText({ fullValue, shortLabel, href }: CopyableTextProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyState("idle");
    }, 1400);

    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function handleCopy() {
    try {
      await copyText(fullValue);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const buttonLabel = copyState === "copied" ? "copied" : copyState === "error" ? "retry" : "copy";

  return (
    <span className="copyable">
      <span className="label" title={fullValue}>
        {shortLabel}
      </span>
      {href ? (
        <a
          className="link"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open external link for ${shortLabel}`}
        >
          open
        </a>
      ) : null}
      <button
        type="button"
        className={`button ${copyState}`}
        onClick={handleCopy}
        aria-label={copyState === "copied" ? `${shortLabel} copied` : `Copy ${shortLabel}`}
      >
        {buttonLabel}
      </button>
      <span className="srOnly" aria-live="polite">
        {copyState === "copied"
          ? `${shortLabel} copied`
          : copyState === "error"
            ? `Failed to copy ${shortLabel}`
            : ""}
      </span>

      <style jsx>{`
        .copyable {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .label {
          font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
          font-size: 0.82rem;
          word-break: break-all;
        }

        .link {
          font-size: 0.76rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .button {
          border: 1px solid var(--line);
          background: rgba(0, 0, 0, 0.2);
          color: var(--ink);
          border-radius: 999px;
          font-size: 0.68rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          line-height: 1;
          padding: 5px 8px;
          cursor: pointer;
        }

        .button:hover {
          border-color: rgba(77, 226, 188, 0.45);
        }

        .button.copied {
          border-color: rgba(77, 226, 188, 0.55);
          color: var(--accent);
        }

        .button.error {
          border-color: rgba(255, 139, 139, 0.45);
          color: var(--bad);
        }

        .srOnly {
          border: 0;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          height: 1px;
          margin: -1px;
          overflow: hidden;
          padding: 0;
          position: absolute;
          width: 1px;
          white-space: nowrap;
        }
      `}</style>
    </span>
  );
}
