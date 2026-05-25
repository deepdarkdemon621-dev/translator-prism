export async function readJsonOrText<T>(
  response: Response,
): Promise<T | { error: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  const text = await response.text();
  return { error: text.trim() || response.statusText || "Request failed" };
}
