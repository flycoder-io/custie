import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { paths } from '../paths';

const debug = process.env['DEBUG'] === 'true';

const SUPPORTED_IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface DownloadedFile {
  path: string;
  name: string;
  mimetype: string;
}

export interface SkippedFile {
  name: string;
  mimetype?: string;
  reason: 'unsupported' | 'download_failed' | 'no_url';
}

export interface DownloadResult {
  succeeded: DownloadedFile[];
  skipped: SkippedFile[];
}

function describeFile(file: SlackFile): string {
  return file.name ?? file.id ?? 'attachment';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

type DownloadOutcome =
  | { kind: 'ok'; file: DownloadedFile }
  | { kind: 'skip'; skipped: SkippedFile };

async function downloadOne(file: SlackFile, botToken: string): Promise<DownloadOutcome> {
  const url = file.url_private_download ?? file.url_private;
  if (!url || !file.mimetype) {
    return { kind: 'skip', skipped: { name: describeFile(file), reason: 'no_url' } };
  }
  if (!SUPPORTED_IMAGE_MIMETYPES.has(file.mimetype)) {
    if (debug) console.log(`[file-downloader] skipping unsupported mimetype: ${file.mimetype}`);
    return {
      kind: 'skip',
      skipped: { name: describeFile(file), mimetype: file.mimetype, reason: 'unsupported' },
    };
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });

    if (!response.ok) {
      console.error(
        `[file-downloader] failed to download ${file.id}: ${response.status} ${response.statusText}`,
      );
      return {
        kind: 'skip',
        skipped: { name: describeFile(file), mimetype: file.mimetype, reason: 'download_failed' },
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const originalName = file.name ?? `${file.id ?? 'unnamed'}.${file.filetype ?? 'bin'}`;
    const ext = extname(originalName) || `.${file.filetype ?? 'bin'}`;
    const safeName = sanitizeFilename(originalName.replace(ext, ''));
    const filename = `${Date.now()}-${file.id ?? 'unnamed'}-${safeName}${ext}`;
    const localPath = join(paths.UPLOADS_DIR, filename);

    await writeFile(localPath, buffer);

    if (debug)
      console.log(`[file-downloader] saved ${file.id} -> ${localPath} (${buffer.length} bytes)`);

    return { kind: 'ok', file: { path: localPath, name: originalName, mimetype: file.mimetype } };
  } catch (err) {
    console.error(`[file-downloader] threw downloading ${file.id}:`, (err as Error).message);
    return {
      kind: 'skip',
      skipped: { name: describeFile(file), mimetype: file.mimetype, reason: 'download_failed' },
    };
  }
}

export async function downloadSlackFiles(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<DownloadResult> {
  if (!files || files.length === 0) return { succeeded: [], skipped: [] };
  const outcomes = await Promise.all(files.map((f) => downloadOne(f, botToken)));
  const succeeded: DownloadedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'ok') succeeded.push(outcome.file);
    else skipped.push(outcome.skipped);
  }
  return { succeeded, skipped };
}

export function buildFilesPromptSection(result: DownloadResult): string {
  const parts: string[] = [];
  if (result.succeeded.length > 0) {
    const list = result.succeeded
      .map((f) => `- ${f.path} (${f.name}, ${f.mimetype})`)
      .join('\n');
    parts.push(`[attached files — use the Read tool to view them]\n${list}`);
  }
  if (result.skipped.length > 0) {
    const list = result.skipped
      .map((f) => `- ${f.name}${f.mimetype ? ` (${f.mimetype})` : ''} — ${f.reason}`)
      .join('\n');
    parts.push(
      `[attached files that I could NOT access — do NOT try to Read them]\n${list}\n` +
        `Reply asking the user to describe these attachments in plain text (or paste relevant excerpts) so you can help. Keep it short.`,
    );
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}\n`;
}
