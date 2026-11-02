// Bounds public dependency metadata/downloads before allocating the complete body.
export async function publicBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (!response.ok || !response.body || declared > limit)
    throw new Error(`Unexpected public response: ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("Public response exceeded its byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, total);
}
