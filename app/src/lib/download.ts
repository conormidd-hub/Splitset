import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Hand the user a text file (a GPX export). On a phone the file is written to the app's cache and
 * offered through the share sheet, so it can go to Garmin Connect, Files, Mail or AirDrop; the web
 * build has its own version of this module (download.web.ts) that downloads it.
 */
export async function saveTextFile(filename: string, text: string, mimeType: string): Promise<void> {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename, UTI: 'public.xml' });
}
