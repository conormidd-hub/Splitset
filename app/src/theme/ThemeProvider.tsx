import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { palettes, type Palette, type ThemeName } from './tokens';

export type ThemeChoice = 'auto' | ThemeName;

type ThemeState = {
  name: ThemeName;
  palette: Palette;
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
};

const STORAGE_KEY = 'splitset-theme';
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>('auto');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (v === 'race' || v === 'night' || v === 'auto') setChoiceState(v);
      })
      .catch(() => {});
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const name: ThemeName = choice === 'auto' ? (system === 'dark' ? 'night' : 'race') : choice;
  const value = useMemo(() => ({ name, palette: palettes[name], choice, setChoice }), [name, choice, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
