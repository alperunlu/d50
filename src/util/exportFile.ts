/**
 * Metni önbellek dizinine yazıp iOS paylaşım sayfasını açan küçük yardımcı.
 *
 * expo-file-system SDK 54+ ile eski `FileSystem.cacheDirectory` +
 * `writeAsStringAsync` API'sini kaldırdı; yeni API `File`/`Paths` sınıflarını
 * kullanır (bkz. https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/).
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function writeAndShare(
  fileName: string,
  content: string,
  mimeType: string,
  dialogTitle: string,
): Promise<{ uri: string; shared: boolean }> {
  const file = new File(Paths.cache, fileName);
  file.write(content);

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle });
  }
  return { uri: file.uri, shared: canShare };
}
