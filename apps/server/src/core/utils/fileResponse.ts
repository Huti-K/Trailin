export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase().replace(/^\./, "")) {
    case "pdf":
      return "application/pdf";
    case "md":
    case "markdown":
    case "txt":
    case "csv":
      return "text/plain; charset=utf-8";
    case "html":
    case "htm":
      // Never text/html: sender-controlled content, so inline HTML on the app
      // origin could script every /api endpoint.
      return "text/plain; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

/** SVG can carry script, so it's excluded and downloads instead of rendering. */
export function inlineForMime(mime: string): boolean {
  return /^(application\/pdf|text\/plain|image\/(png|jpeg|gif|webp|avif|bmp))/.test(mime);
}

/** Non-Latin1/quote filenames throw in Node's header serializer; ships an ASCII
 *  `filename` plus the exact name via RFC 5987/6266 `filename*`. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[\\"]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
