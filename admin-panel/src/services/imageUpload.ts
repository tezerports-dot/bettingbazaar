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

  const put = await fetch(presign.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  if (!put.ok) throw new Error(`Storage refused the upload (HTTP ${put.status})`);

  if (kind === 'branding') {
    await api.post('/api/admin/branding/confirm-upload', {
      fileKey: presign.fileKey, cdnUrl: presign.cdnUrl, category, title: file.name, fileSize: file.size,
    });
  }
  return presign.cdnUrl as string;
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
