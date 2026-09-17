import { createTimezoneSync, type TimezoneSync } from '@zero/agent-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCalendars } from 'expo-localization';

import { patchTimezone, type TokenGetter } from './api';
import { RUNTIME_PROFILE } from './runtime-profile';

// Mobile adapters for the shared timezone sync core. The clock uses
// expo-localization's IANA zone; Hermes Intl can return "UTC" and pin the wrong
// day. The store is AsyncStorage, RN's small unencrypted KV. See docs/timezone.md.

const STORE_KEY = RUNTIME_PROFILE.persistence.timezoneKey;

export function createMobileTimezoneSync(getToken: TokenGetter): TimezoneSync {
  return createTimezoneSync({
    clock: {
      zone: () => {
        try {
          return getCalendars()[0]?.timeZone ?? null;
        } catch {
          return null;
        }
      },
    },
    store: {
      read: async () => {
        try {
          return await AsyncStorage.getItem(STORE_KEY);
        } catch {
          return null;
        }
      },
      write: async (zone) => {
        try {
          await AsyncStorage.setItem(STORE_KEY, zone);
        } catch {
          // A failed write just re-evaluates next foreground; the PATCH already ran.
        }
      },
    },
    gateway: {
      setTimezone: (zone) => patchTimezone(getToken, zone),
    },
  });
}
