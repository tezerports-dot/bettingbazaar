// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One upload for every image on the Images page: ask the backend for a
 * presigned URL, PUT the bytes straight to S3, and get back the CDN URL to
 * preview and then save. The file never passes through the API server.
 *
 *   'promo'    — home promo cards and page slides (`/api/admin/promo/upload-url`)
 *   'branding' — the board's card images and the logo set
 *                (`/api/admin/branding/upload-url`, then `confirm-upload`,
 *                which records it in the CDN library)
 *
 * The S3 PUT does not go through `api`: a presigned URL rejects an unexpected
 * Authorization header.
 */
import api from './api';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type UploadKind = 'promo' | 'branding';

export async function uploadImage(file: File, kind: UploadKind, category = 'image'): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be uploaded.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('An image can be at most 5 MB.');
  const body = { fileName: file.name, contentType: file.type, fileSize: file.size, category };
  const presignPath = kind === 'branding' ? '/api/admin/branding/upload-url' : '/api/admin/promo/upload-url';
  const { data: presign } = await api.post<any>(presignPath, body);
  if (!presign?.uploadUrl) throw new Error(presign?.message || 'Could not get an upload URL');

  await putToStorage(presign.uploadUrl, file);

  if (kind === 'branding') {
    await api.post('/api/admin/branding/confirm-upload', {
      fileKey: presign.fileKey, cdnUrl: presign.cdnUrl, category, title: file.name, fileSize: file.size,
    });
  }
  return presign.cdnUrl as string;
}

/**
 * What an S3 error code means for the person who has to fix it. The storage
 * answers in XML (`<Code>`, `<Message>`); these are the codes a wrong setting
 * produces, named by the server setting to check.
 */
const STORAGE_CODES: Record<string, string> = {
  SignatureDoesNotMatch: 'the storage keys are wrong: check S3_SECRET_KEY on the server',
  InvalidAccessKeyId: 'the storage key is wrong: check S3_ACCESS_KEY on the server',
  AccessDenied: 'the storage keys are not allowed to write to this bucket',
  NoSuchBucket: 'the bucket does not exist: check S3_BUCKET_NAME on the server',
  RequestTimeTooSkewed: "the server's clock is wrong, so the upload link it signed was refused",
  AccessDeniedExpired: 'the upload link expired; try again',
  EntityTooLarge: 'the file is larger than the storage allows',
};

/** PUT the bytes to a presigned URL, or throw a reason someone can act on. */
export async function putToStorage(uploadUrl: string, file: File): Promise<void> {
  let put: Response;
  try {
    put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  } catch {
    // The browser hides the storage's answer when its CORS rules do not allow
    // this site, and a wrong storage address fails the same way.
    throw new Error(
      `The file storage could not be reached from this page. Usually its CORS rules do not allow uploads (PUT) from ${window.location.origin}; otherwise S3_ENDPOINT on the server is wrong.`,
    );
  }
  if (put.ok) return;
  const xml = await put.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? '';
  const said = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1] ?? '';
  const meaning = STORAGE_CODES[code] ?? (said || 'no reason given');
  throw new Error(`The file storage refused the upload (HTTP ${put.status}${code ? `, ${code}` : ''}): ${meaning}.`);
}

/** The most specific message a failed request or upload carries. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  return (
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
    (err as Error)?.message ||
    fallback
  );
}

/** An image's own pixel size, read in the browser, for the size check. */
export function naturalSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Whether an image's shape matches the frame it will be drawn in, within 3%.
 * A mismatched image is shown cropped to the frame, so the page says so before
 * it is saved.
 */
export function shapeFits(size: { w: number; h: number } | null, ratio: { w: number; h: number }): boolean | null {
  if (!size || !size.w || !size.h) return null;
  const want = ratio.w / ratio.h;
  const got = size.w / size.h;
  return Math.abs(got - want) / want <= 0.03;
}
