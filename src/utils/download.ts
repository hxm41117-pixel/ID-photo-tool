import JSZip from 'jszip';

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadFilesAsZip(
  files: Array<{ fileName: string; blob: Blob }>,
  zipName: string
): Promise<void> {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  for (const item of files) {
    let finalName = item.fileName;
    if (usedNames.has(finalName)) {
      const dotIdx = finalName.lastIndexOf('.');
      const base = dotIdx > 0 ? finalName.slice(0, dotIdx) : finalName;
      const ext = dotIdx > 0 ? finalName.slice(dotIdx) : '';
      let counter = 2;
      while (usedNames.has(`${base}_${counter}${ext}`)) {
        counter++;
      }
      finalName = `${base}_${counter}${ext}`;
    }
    usedNames.add(finalName);
    zip.file(finalName, item.blob);
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  triggerBlobDownload(zipBlob, zipName);
}
