"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useI18n } from "@/lib/i18n";
import { normalizeDisplayMath, useMarkdownPlugins } from "../lib/markdown";
import { CodeBlock } from "./MermaidBlock";

/** 公式预览沿用 Markdown 的 KaTeX 管线，源码和复制始终保留原文。 */
export function LatexBlock({ code, lang, isStreaming }: { code: string; lang: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  const [showPreview, setShowPreview] = useState(true);
  const markdown = useMemo(() => {
    const trimmed = code.trim();
    // 已包含数学分隔符的内容直接解析；裸 LaTeX 按独立公式处理。
    return /^(?:\$|\\\(|\\\[)/.test(trimmed)
      ? normalizeDisplayMath(trimmed)
      : `$$\n${trimmed}\n$$`;
  }, [code]);
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(markdown);
  // 流式输出期间显示源码，避免不完整的公式短暂报错。
  const previewVisible = showPreview && !isStreaming;
  const toggle = (
    <button
      type="button"
      className={previewVisible ? "markdown-code-action is-active" : "markdown-code-action"}
      disabled={isStreaming}
      onClick={() => setShowPreview((value) => !value)}
    >
      {previewVisible ? t("latexBlock.source") : t("latexBlock.preview")}
    </button>
  );

  if (!previewVisible) {
    return <CodeBlock code={code} lang={lang} headerAction={toggle} isStreaming={isStreaming} />;
  }
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang}</span>
        <div className="markdown-code-actions">
          {toggle}
          <button type="button" onClick={() => copy(code)} className={copied ? "markdown-code-action is-copied" : "markdown-code-action"}>
            {copied ? t("codeBlock.copied") : t("codeBlock.copy")}
          </button>
        </div>
      </div>
      <div className="latex-block-preview">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
