// Stub for the Files API attachment uploader: no network in unit tests, so it
// uploads nothing and returns an empty { attachmentId: fileId } map.
export async function resolveAttachmentFileIds() {
  return {}
}
