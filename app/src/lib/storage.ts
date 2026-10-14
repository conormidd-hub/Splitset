import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The one place persisted app state touches device storage. AsyncStorage runs everywhere
 * (native, web via localStorage, Expo Go). Swap for MMKV here when a dev client is adopted.
 */
export const storage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

/** Where the connect wizard keeps which step a person reached, per account. */
export const connectProgressKey = (uid: string) => `splitset-connect-steps:${uid}`;
/** The home screen layout as last saved on this device, per account. */
export const homeLayoutKey = (uid: string) => `splitset-home-layout:${uid}`;
