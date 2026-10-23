import type { TodoRecordings } from '@zero/agent-core';
import { Directory, File, Paths } from 'expo-file-system';

const library = () => new Directory(Paths.document, 'recordings');
const audioFile = (id: string) => new File(library(), `${id}.m4a`);

export function localAudio(id: string): string | null {
  const file = audioFile(id);
  return file.exists ? file.uri : null;
}

export function keepAudio(recordedUri: string, id: string): void {
  library().create({ idempotent: true, intermediates: true });
  new File(recordedUri).moveSync(audioFile(id));
}

function deleteAudio(id: string): void {
  try {
    const file = audioFile(id);
    if (file.exists) file.delete();
  } catch {
    return;
  }
}

export function cleanUpDeletedAudio(recordings: Pick<TodoRecordings, 'deleted' | 'onDeleted'>): () => void {
  const stop = recordings.onDeleted(deleteAudio);
  recordings.deleted().forEach(deleteAudio);
  return stop;
}
