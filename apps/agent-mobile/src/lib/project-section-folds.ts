import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ProjectDisplayStatus } from '@zero/agent-core';
import { useCallback, useEffect, useState } from 'react';

import { RUNTIME_PROFILE } from './runtime-profile';

export type ProjectSectionFolds = Partial<Record<ProjectDisplayStatus, boolean>>;

export const PROJECT_SECTION_FOLDS_KEY = RUNTIME_PROFILE.hermetic
  ? 'zero.e2e.project-section-folds.v1'
  : 'zero.project-section-folds.v1';
const STORAGE_KEY = PROJECT_SECTION_FOLDS_KEY;

const read = async (): Promise<ProjectSectionFolds> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as ProjectSectionFolds : {};
  } catch {
    return {};
  }
};

let writes: Promise<void> = Promise.resolve();

const remember = (status: ProjectDisplayStatus, collapsed: boolean) => {
  writes = writes
    .then(async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...await read(), [status]: collapsed }));
    })
    .catch(() => {});
};

export function useProjectSectionFolds() {
  const [folds, setFolds] = useState<ProjectSectionFolds>({});
  useEffect(() => {
    let live = true;
    void read().then((stored) => {
      if (live) setFolds((current) => ({ ...stored, ...current }));
    });
    return () => {
      live = false;
    };
  }, []);
  const toggle = useCallback((status: ProjectDisplayStatus, collapsed: boolean) => {
    setFolds((current) => ({ ...current, [status]: !collapsed }));
    remember(status, !collapsed);
  }, []);
  return { folds, toggle };
}
