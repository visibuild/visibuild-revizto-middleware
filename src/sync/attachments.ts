/**
 * sync/attachments.ts – carry a Visibuild attachment across to Revizto.
 *
 * Visibuild serves attachments from its CDN over a plain (already-signed) URL,
 * and Revizto takes them as a `file` comment whose bytes ride in a
 * `file_<comment uuid>` multipart part. There is no streaming path between the
 * two, so each file is held in memory once – which is why the caller caps both
 * the file size and the number of files per run.
 */

/** Revizto's own hard limit on a comment attachment. */
export const REVIZTO_MAX_ATTACHMENT_BYTES = 38 * 1024 * 1024;

/** Revizto refuses these outright. */
const BLOCKED_EXTENSIONS = /\.(exe|dmg)$/i;

export interface FetchedAttachment {
  blob: Blob;
  filename: string;
}

export class AttachmentSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSkipped";
  }
}

/** Best-effort filename from a URL or storage key, falling back to a title. */
export function attachmentFilename(url: string, title: string): string {
  let candidate = "";
  try {
    const path = new URL(url).pathname;
    candidate = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  } catch {
    candidate = url.split("/").filter(Boolean).pop() ?? "";
  }
  candidate = candidate.split("?")[0];
  if (/\.[a-z0-9]{2,5}$/i.test(candidate)) return candidate;
  const cleanTitle = (title || "attachment").replace(/[/\\?%*:|"<>]/g, "-").trim();
  return candidate || cleanTitle || "attachment";
}

/**
 * Download one attachment, refusing anything Revizto would reject anyway.
 *
 * Throws `AttachmentSkipped` for the expected refusals (too large, blocked
 * type, gone) so the caller can log a reason and move on rather than failing
 * the whole visi.
 */
export async function fetchAttachment(
  url: string,
  title: string,
  maxBytes: number,
): Promise<FetchedAttachment> {
  const filename = attachmentFilename(url, title);
  if (BLOCKED_EXTENSIONS.test(filename)) {
    throw new AttachmentSkipped(`Revizto does not accept ${filename.split(".").pop()} files.`);
  }

  const cap = Math.min(maxBytes, REVIZTO_MAX_ATTACHMENT_BYTES);

  // Ask for the size first where the CDN offers it, so an oversized file costs
  // a HEAD rather than a full download.
  try {
    const head = await fetch(url, { method: "HEAD" });
    const declared = Number(head.headers.get("content-length") ?? 0);
    if (declared > cap) {
      throw new AttachmentSkipped(`File is ${Math.round(declared / 1024 / 1024)} MB, over the ${Math.round(cap / 1024 / 1024)} MB limit.`);
    }
  } catch (e) {
    if (e instanceof AttachmentSkipped) throw e;
    /* HEAD is not always allowed; fall through to the GET */
  }

  const res = await fetch(url);
  if (!res.ok) throw new AttachmentSkipped(`Could not download the file (HTTP ${res.status}).`);

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > cap) {
    throw new AttachmentSkipped(
      `File is ${Math.round(buffer.byteLength / 1024 / 1024)} MB, over the ${Math.round(cap / 1024 / 1024)} MB limit.`,
    );
  }

  const type = res.headers.get("content-type") ?? "application/octet-stream";
  return { blob: new Blob([buffer], { type }), filename };
}
