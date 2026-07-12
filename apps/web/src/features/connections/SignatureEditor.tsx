import type { AccountVoice } from "@trailin/shared";
import { Bold, Italic, Link, Loader2, Smile } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";

const EMOJIS = ["🙂", "😊", "👍", "🙏", "✨", "📞", "📧", "🌐"];

/** Keep useful mail-client formatting while dropping active/unsafe content. */
function sanitizeSignature(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,input,button").forEach((el) => {
    el.remove();
  });
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "contenteditable" ||
        ((name === "href" || name === "src") && value.startsWith("javascript:"))
      ) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  return doc.body.innerHTML.trim();
}

export function SignatureEditor({
  voice,
  onSave,
  onCancel,
}: {
  voice?: AccountVoice;
  onSave: (signature: string, signatureHtml: string) => Promise<void>;
  onCancel: () => void;
}) {
  const editor = React.useRef<HTMLDivElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);

  React.useEffect(() => {
    if (!editor.current) return;
    const plainHtml = voice?.signature
      ?.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/\n/g, "<br>");
    editor.current.innerHTML = sanitizeSignature(voice?.signatureHtml ?? plainHtml ?? "");
  }, [voice]);

  const command = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
  };
  const addLink = () => {
    const url = window.prompt("Link URL", "https://");
    if (url && /^https?:\/\//i.test(url)) command("createLink", url);
  };
  const save = async () => {
    const html = sanitizeSignature(editor.current?.innerHTML ?? "");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    setSaving(true);
    try {
      await onSave(parsed.body.textContent?.trim() ?? "", html);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="mb-2 text-xs font-medium">Email signature</p>
      <div className="mb-2 flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Bold"
          onClick={() => command("bold")}
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Italic"
          onClick={() => command("italic")}
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" title="Create link" onClick={addLink}>
          <Link className="h-4 w-4" />
        </Button>
        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Emoji"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile className="h-4 w-4" />
          </Button>
          {emojiOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 grid grid-cols-4 gap-1 rounded-lg border border-border bg-background p-2 shadow-lg">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded p-1 hover:bg-surface-2"
                  onClick={() => {
                    command("insertText", emoji);
                    setEmojiOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        className="min-h-28 rounded-md border border-border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/40 [&_img]:max-w-full"
      />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Paste an existing Gmail or Outlook signature here—formatting, links, and images are
        preserved.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="animate-spin" />}Save signature
        </Button>
      </div>
    </div>
  );
}
