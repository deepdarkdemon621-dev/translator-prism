import { uploadEpubFile, type UploadedBook } from "@/lib/upload/client";

interface UploadEpubFilesSequentiallyOptions {
  files: File[];
  isAdmin: boolean;
  visibility: "public" | "private";
  targetCollectionId: string;
  fetchImpl?: typeof fetch;
  onFileStart?: (fileName: string, index: number, total: number) => void;
  onFileSuccess?: (
    book: UploadedBook,
    fileName: string,
    index: number,
    total: number,
  ) => void;
  onFileError?: (
    error: string,
    fileName: string,
    index: number,
    total: number,
  ) => void;
}

export interface BatchUploadSuccess {
  fileName: string;
  book: UploadedBook;
}

export interface BatchUploadFailure {
  fileName: string;
  error: string;
}

export interface BatchUploadResult {
  successes: BatchUploadSuccess[];
  failures: BatchUploadFailure[];
}

export async function uploadEpubFilesSequentially({
  files,
  isAdmin,
  visibility,
  targetCollectionId,
  fetchImpl,
  onFileStart,
  onFileSuccess,
  onFileError,
}: UploadEpubFilesSequentiallyOptions): Promise<BatchUploadResult> {
  const successes: BatchUploadSuccess[] = [];
  const failures: BatchUploadFailure[] = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const index = i + 1;
    onFileStart?.(file.name, index, total);

    try {
      const book = await uploadEpubFile({
        file,
        isAdmin,
        visibility,
        targetCollectionId,
        fetchImpl,
      });
      successes.push({ fileName: file.name, book });
      onFileSuccess?.(book, file.name, index, total);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Upload failed";
      failures.push({ fileName: file.name, error });
      onFileError?.(error, file.name, index, total);
    }
  }

  return { successes, failures };
}
