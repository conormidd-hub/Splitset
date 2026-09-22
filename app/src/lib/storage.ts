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
