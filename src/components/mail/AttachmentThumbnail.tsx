import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

// Raster formats an <img> shows in every current browser. Not SVG: it may be an attachment someone else sent (a forward).
const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

export function isPreviewableImage(contentType: string | null | undefined): boolean {
  return !!contentType && PREVIEWABLE.has(contentType.toLowerCase().split(";")[0]!.trim());
}

/** Where an attachment's bytes are: a file just picked in the browser, or one already stored on the server. */
export type AttachmentSource = { file: File } | { accountEmail: string; emailId: number; attachmentId: number; contentType: string | null };

/** A small preview of an image attachment, or the paperclip for anything else (and for an image that fails to load). */
export function AttachmentThumbnail({ source }: { source: AttachmentSource }) {
  const { token } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const file = "file" in source ? source.file : null;
  const stored = "file" in source ? null : source;
  const image = isPreviewableImage(file ? file.type : stored!.contentType);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!image) return;
    if (file) {
      const objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    if (!token || !stored) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .attachmentBlob(token, stored.accountEmail, stored.emailId, stored.attachmentId)
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image, file, token, stored?.accountEmail, stored?.emailId, stored?.attachmentId]);

  if (!image || failed) return <Paperclip className="size-3" />;
  return (
    <span className="size-8 shrink-0 overflow-hidden rounded-sm bg-muted">
      {url && <img src={url} alt="" className="size-full object-cover" onError={() => setFailed(true)} />}
    </span>
  );
}
