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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadOne(file: SlackFile, botToken: string): Promise<DownloadedFile | undefined> {
  const url = file.url_private_download ?? file.url_private;
  if (!url || !file.mimetype) return undefined;
  if (!SUPPORTED_IMAGE_MIMETYPES.has(file.mimetype)) {
    if (debug) console.log(`[file-downloader] skipping unsupported mimetype: ${file.mimetype}`);
    return undefined;
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });

  if (!response.ok) {
    console.error(`[file-downloader] failed to download ${file.id}: ${response.status} ${response.statusText}`);
    return undefined;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const originalName = file.name ?? `${file.id ?? 'unnamed'}.${file.filetype ?? 'bin'}`;
  const ext = extname(originalName) || `.${file.filetype ?? 'bin'}`;
  const safeName = sanitizeFilename(originalName.replace(ext, ''));
  const filename = `${Date.now()}-${file.id ?? 'unnamed'}-${safeName}${ext}`;
  const localPath = join(paths.UPLOADS_DIR, filename);

  await writeFile(localPath, buffer);

  if (debug) console.log(`[file-downloader] saved ${file.id} -> ${localPath} (${buffer.length} bytes)`);

  return { path: localPath, name: originalName, mimetype: file.mimetype };
}

export async function downloadSlackFiles(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<DownloadedFile[]> {
  if (!files || files.length === 0) return [];
  const results = await Promise.all(files.map((f) => downloadOne(f, botToken)));
  return results.filter((r): r is DownloadedFile => r !== undefined);
}

export function buildFilesPromptSection(files: DownloadedFile[]): string {
  if (files.length === 0) return '';
  const list = files.map((f) => `- ${f.path} (${f.name}, ${f.mimetype})`).join('\n');
  return `\n\n[attached files — use the Read tool to view them]\n${list}\n`;
}
