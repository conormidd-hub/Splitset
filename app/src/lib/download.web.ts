/**
 * The web version of lib/download: the browser downloads the file. Metro picks this file over
 * download.ts for web builds; both export the same function.
 */
export async function saveTextFile(filename: string, text: string, mimeType: string): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Downloads need a browser');
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has the blob by now; a short grace period for slow browsers
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
