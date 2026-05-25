import { readJsonOrText } from "@/lib/http";

export interface UploadedBook {
  id: string;
  title: string;
}

interface UploadEpubFileOptions {
  file: File;
  isAdmin: boolean;
  visibility: "public" | "private";
  targetCollectionId: string;
  fetchImpl?: typeof fetch;
}

interface PreparedUpload {
  bookId: string;
  key: string;
  uploadUrl: string;
}

const DIRECT_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

export async function uploadEpubFile({
  file,
  isAdmin,
  visibility,
  targetCollectionId,
  fetchImpl = fetch,
}: UploadEpubFileOptions): Promise<UploadedBook> {
  if (file.size > DIRECT_UPLOAD_THRESHOLD) {
    return uploadDirect({
      file,
      isAdmin,
      visibility,
      targetCollectionId,
      fetchImpl,
    });
  }

  const formData = new FormData();
  formData.append("file", file);
  if (isAdmin) formData.append("visibility", visibility);
  if (targetCollectionId) formData.append("collectionId", targetCollectionId);

  const res = await fetchImpl("/api/books/upload", {
    method: "POST",
    body: formData,
  });

  return readUploadResponse(res);
}

async function uploadDirect({
  file,
  isAdmin,
  visibility,
  targetCollectionId,
  fetchImpl,
}: Required<UploadEpubFileOptions>): Promise<UploadedBook> {
  const contentType = file.type || "application/epub+zip";
  const prepareRes = await fetchImpl("/api/books/upload/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      size: file.size,
      contentType,
    }),
  });
  const prepared = await readJsonOrText<PreparedUpload>(prepareRes);
  if (!prepareRes.ok || "error" in prepared) {
    throw new Error("error" in prepared ? prepared.error : "Upload prepare failed");
  }

  const putRes = await fetchImpl(prepared.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Direct upload failed (${putRes.status})`);
  }

  const completeRes = await fetchImpl("/api/books/upload/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bookId: prepared.bookId,
      key: prepared.key,
      fileName: file.name,
      visibility: isAdmin ? visibility : undefined,
      collectionId: targetCollectionId || undefined,
    }),
  });

  return readUploadResponse(completeRes);
}

async function readUploadResponse(response: Response): Promise<UploadedBook> {
  const data = await readJsonOrText<UploadedBook>(response);
  if (!response.ok) {
    throw new Error("error" in data ? data.error : "Upload failed");
  }
  if ("error" in data) {
    throw new Error(data.error);
  }
  return data;
}
